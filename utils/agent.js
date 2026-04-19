const { GoogleGenAI } = require("@google/genai");
const logger = require("./logger");
const { withRetry } = require("./apiRetry");
const {
  buildAgentSystemPrompt,
  buildAgentInitialMessage,
} = require("./prompts");
const { normalizeMediaKey } = require("./trakt");

const DEFAULT_MAX_TURNS = 6;

const FUNCTION_CALLING_UNSUPPORTED_PATTERNS = [
  /function calling/i,
  /tool calling/i,
  /tools? are not supported/i,
  /does not support function calling/i,
  /unsupported.*function/i,
  /capabilit(y|ies)/i,
  /invalid argument/i,
];

function parseStrictInteger(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && Number.isInteger(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[-]?\d+$/.test(trimmed)) {
      return null;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
  }

  return null;
}

function normalizeRecommendationType(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "movie") {
    return "movie";
  }

  if (normalized === "show" || normalized === "series") {
    return "series";
  }

  return null;
}

function normalizeRecommendationList(value) {
  if (!Array.isArray(value)) {
    logger.info("Agent recommendations were not an array", {
      receivedType: typeof value,
    });
    return [];
  }

  const normalized = [];

  value.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      logger.debug("Dropped invalid recommendation item", {
        index,
        reason: "not_an_object",
      });
      return;
    }

    const type = normalizeRecommendationType(item.type);
    if (!type) {
      logger.debug("Dropped invalid recommendation item", {
        index,
        reason: "invalid_type",
        type: item.type,
      });
      return;
    }

    const rawName = typeof item.name === "string" ? item.name : item.title;
    if (typeof rawName !== "string") {
      logger.debug("Dropped invalid recommendation item", {
        index,
        reason: "missing_name",
      });
      return;
    }

    const name = rawName.trim();
    if (!name) {
      logger.debug("Dropped invalid recommendation item", {
        index,
        reason: "missing_name",
      });
      return;
    }

    const tmdbIdSource =
      item.tmdb_id ?? item.tmdbId ?? item.ids?.tmdb ?? null;
    const tmdb_id = parseStrictInteger(tmdbIdSource);
    if (tmdb_id === null) {
      logger.debug("Dropped invalid recommendation item", {
        index,
        reason: tmdbIdSource == null ? "missing_tmdb_id" : "invalid_tmdb_id",
        tmdb_id: tmdbIdSource,
      });
      return;
    }

    const year = parseStrictInteger(item.year);
    const imdbIdSource = item.imdb_id ?? item.imdbId ?? item.ids?.imdb;
    const imdb_id =
      typeof imdbIdSource === "string" && imdbIdSource.trim()
        ? imdbIdSource.trim()
        : null;

    const normalizedItem = { type, name, year: year === null ? null : year, tmdb_id };

    if (imdb_id) {
      normalizedItem.imdb_id = imdb_id;
    }

    normalized.push(normalizedItem);
  });

  return normalized;
}

function normalizeNumResults(value) {
  const parsed = parseStrictInteger(value);
  return parsed && parsed > 0 ? parsed : DEFAULT_MAX_TURNS;
}

function normalizeIterable(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (value instanceof Map || value instanceof Set) {
    return [...value.values()];
  }

  if (typeof value[Symbol.iterator] === "function") {
    return [...value];
  }

  return [value];
}

function getMediaIdentityKeys(item) {
  const normalized = normalizeMediaKey(item);
  const keys = [];

  if (normalized.type && normalized.tmdb_id != null) {
    keys.push(`${normalized.type}:${normalized.tmdb_id}`);
  }

  if (normalized.imdb_id) {
    keys.push(`imdb:${normalized.imdb_id}`);
  }

  if (normalized.title) {
    keys.push(
      `${normalized.type || ""}:${normalized.title.trim().toLowerCase()}:${normalized.year ?? ""}`
    );
  }

  return keys.filter(Boolean);
}

function getPrimaryMediaIdentityKey(item) {
  return getMediaIdentityKeys(item)[0] || "";
}

function isDuplicateAcrossTurns(item, proposedIdSet) {
  if (!(proposedIdSet instanceof Set) || proposedIdSet.size === 0) {
    return false;
  }

  return getMediaIdentityKeys(item).some((key) => proposedIdSet.has(key));
}

function addMediaIdentityKeys(targetSet, item) {
  if (!(targetSet instanceof Set)) {
    return;
  }

  getMediaIdentityKeys(item).forEach((key) => targetSet.add(key));
}

function normalizeDroppedItems(value) {
  return normalizeIterable(value).filter(Boolean);
}

function countDroppedItems(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return normalizeDroppedItems(value).length;
}

function formatDroppedIdentity(item) {
  if (typeof item === "string") {
    return item;
  }

  if (typeof item === "number" && Number.isInteger(item)) {
    return String(item);
  }

  const normalized = normalizeMediaKey(item);
  if (normalized.type && normalized.tmdb_id != null) {
    return `${normalized.type}:${normalized.tmdb_id}`;
  }

  if (normalized.imdb_id) {
    return `imdb:${normalized.imdb_id}`;
  }

  if (normalized.title) {
    return `${normalized.type || ""}:${normalized.title.toLowerCase()}:${normalized.year ?? ""}`;
  }

  return "unknown";
}

function getRecentProposedIds(proposedIdSet, limit = 50) {
  if (!(proposedIdSet instanceof Set) || proposedIdSet.size === 0) {
    return [];
  }

  return [...proposedIdSet].slice(-limit);
}

function buildRefinementMessage({
  neededCount,
  droppedWatched,
  droppedNoId,
  droppedDuplicates,
  recentProposedIds,
}) {
  const watchedIds = normalizeDroppedItems(droppedWatched).map(formatDroppedIdentity);

  return [
    `Need ${neededCount} more unwatched items.`,
    `Already watched this turn: ${watchedIds.length > 0 ? watchedIds.join(", ") : "(none)"}`,
    `No tmdb_id this turn: ${countDroppedItems(droppedNoId)}`,
    `Duplicate proposals this turn: ${countDroppedItems(droppedDuplicates)}`,
    `Recent proposed IDs: ${recentProposedIds.length > 0 ? recentProposedIds.join(", ") : "(none)"}`,
    "Refine the next proposal set and avoid repeating any IDs above.",
  ].join("\n");
}

function extractModelText(response) {
  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const candidateText = parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (candidateText) {
    return candidateText;
  }

  return typeof response?.text === "string" ? response.text.trim() : "";
}

function extractFunctionCalls(response) {
  const fromResponse = Array.isArray(response?.functionCalls)
    ? response.functionCalls
    : [];

  const fromCandidates =
    response?.candidates?.flatMap((candidate) =>
      Array.isArray(candidate?.content?.parts)
        ? candidate.content.parts
            .map((part) => part?.functionCall)
            .filter(Boolean)
        : []
    ) || [];

  const deduped = new Map();

  [...fromResponse, ...fromCandidates].forEach((call) => {
    if (!call || typeof call.name !== "string") {
      return;
    }

    const key = `${call.name}:${JSON.stringify(call.args || {})}`;
    if (!deduped.has(key)) {
      deduped.set(key, call);
    }
  });

  return [...deduped.values()];
}

function hasCallableShape(response) {
  return (
    Array.isArray(response?.functionCalls) ||
    Array.isArray(response?.candidates)
  );
}

function isFunctionCallingUnsupportedError(error) {
  const message = String(error?.message || error?.error || "");
  return FUNCTION_CALLING_UNSUPPORTED_PATTERNS.some((pattern) =>
    pattern.test(message)
  );
}

function buildFunctionResponseParts(functionCalls, errorMessage) {
  return functionCalls.map((call) => ({
    functionResponse: {
      name: call.name,
      response: {
        error: errorMessage,
      },
    },
  }));
}

function normalizeToolResultParts(toolResults) {
  if (!toolResults) {
    return [];
  }

  if (Array.isArray(toolResults)) {
    return toolResults.flatMap((result) =>
      result?.parts && Array.isArray(result.parts) ? result.parts : [result]
    );
  }

  if (toolResults?.parts && Array.isArray(toolResults.parts)) {
    return toolResults.parts;
  }

  return [toolResults];
}

function countToolFailures(parts) {
  return parts.filter((part) => {
    const response = part?.functionResponse?.response;
    return (
      response &&
      (response.error || response.success === false || response.ok === false)
    );
  }).length;
}

function isEmptyTurn(response, functionCalls, text) {
  return hasCallableShape(response) && functionCalls.length === 0 && !text;
}

async function callGemini(chat, message, meta = {}) {
  // Keep the same retry policy as the old generateContent path: retry transient
  // 429/5xx failures, but let 400 INVALID_ARGUMENT surface immediately because
  // those are contract bugs (for example, malformed tool history).
  return withRetry(
    async () => {
      try {
        const response = await chat.sendMessage({
          message,
        });
        const text = extractModelText(response);
        const functionCalls = extractFunctionCalls(response);
        logger.agent("RESPONSE_RECEIVED", {
          turn: meta.turn ?? 0,
          hasText: !!text,
          hasFunctionCalls: !!functionCalls?.length,
          functionCallNames: functionCalls?.map((fc) => fc.name),
          tokenCount: response.usageMetadata,
          responseTextLength: text?.length,
        });
        logger.agent("AGENT_RAW_RESPONSE", {
          turn: meta.turn ?? 0,
          rawText: text,
        });
        return response;
      } catch (error) {
        logger.error("Gemini agent call failed", {
          error: error.message,
          status: error.httpStatus || error.status || 500,
        });
        logger.agent("LOOP_ERROR", {
          turn: meta.turn ?? 0,
          error: error.message,
          stack: error.stack,
        });
        error.status = error.httpStatus || error.status || 500;
        throw error;
      }
    },
    {
      maxRetries: 3,
      initialDelay: 2000,
      maxDelay: 10000,
      shouldRetry: (error) => !error.status || error.status !== 400,
      operationName: "Gemini agent call",
    }
  );
}

async function runAgentLoop(dependencies = {}) {
  const {
    userQuery = "",
    type = "movie",
    geminiApiKey,
    modelName = "gemini-flash-lite-latest",
    maxTurns = DEFAULT_MAX_TURNS,
    numResults,
    traktWatchedIdSet,
    traktRatedIdSet,
    filterCandidates,
    toolDeclarations = [],
    executeTools,
    searchTMDB,
    fetchTraktWatchedAndRated,
    isItemWatchedOrRated,
    processPreferencesInParallel,
    tmdbCache,
    traktCache,
    traktRawDataCache,
    tmdbDetailsCache,
    aiRecommendationsCache,
    traktAuth,
    traktUsername,
    traktAccessToken,
  } = dependencies;

  const resolvedNumResults = normalizeNumResults(numResults);

  logger.agent("LOOP_START", {
    query: userQuery,
    model: modelName,
    numResults: resolvedNumResults,
    traktWatchedCount:
      traktWatchedIdSet instanceof Set
        ? traktWatchedIdSet.size
        : Array.isArray(traktWatchedIdSet)
          ? traktWatchedIdSet.length
          : traktWatchedIdSet?.length,
    traktRatedCount:
      traktRatedIdSet instanceof Set
        ? traktRatedIdSet.size
        : Array.isArray(traktRatedIdSet)
          ? traktRatedIdSet.length
          : traktRatedIdSet?.length,
    maxTurns,
  });

  const startTime = Date.now();
  let turns = 0;
  let toolCalls = 0;
  let collected = [];
  let proposedIdSet = new Set();
  let droppedWatchedTotal = 0;
  let droppedNoIdTotal = 0;
  let droppedDuplicatesTotal = 0;
  let loopTerminationReason = "max_turns_exceeded";

  function logSummary(success, reason, recommendations) {
    const summary = {
      event: "agent_loop_complete",
      success,
      turns,
      toolCalls,
      collectedCount: collected.length,
      droppedWatched: droppedWatchedTotal,
      droppedNoId: droppedNoIdTotal,
      droppedDuplicates: droppedDuplicatesTotal,
      durationMs: Date.now() - startTime,
      model: modelName,
    };

    if (typeof reason === "string" && reason) {
      summary.reason = reason;
    }

    if (success && Array.isArray(recommendations)) {
      summary.recommendationCount = recommendations.length;
    }

    if (success) {
      logger.agent("LOOP_END", {
        totalTurns: turns,
        terminationReason: reason || "success",
        collectedCount: collected.length,
        elapsed: Date.now() - startTime,
      });
      logger.info("Agent loop complete", summary);
    } else {
      logger.agent("LOOP_END", {
        totalTurns: turns,
        terminationReason: reason || "error",
        collectedCount: collected.length,
        elapsed: Date.now() - startTime,
      });
      logger.warn("Agent loop complete", summary);
    }
  }

  function processFinalTextResponse(textResponse, turn) {
    const text = extractModelText(textResponse);

    if (!text) {
      logger.warn("Agent returned an empty turn", { turn });
      return { success: false, reason: "empty_turn" };
    }

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      logger.warn("Agent final output was not valid JSON", {
        error: error.message,
        turn,
      });
      logger.agent("LOOP_ERROR", {
        turn,
        error: error.message,
        stack: error.stack,
      });
      return { success: false, reason: "invalid_final_json" };
    }

    const recommendations = normalizeRecommendationList(parsed);

    if (typeof filterCandidates !== "function") {
      return {
        success: true,
        recommendations: recommendations.slice(0, resolvedNumResults),
      };
    }

    let filtered;

    try {
      filtered = filterCandidates(recommendations);
    } catch (error) {
      logger.error("Agent candidate filtering failed", {
        error: error.message,
        turn,
      });
      logger.agent("LOOP_ERROR", {
        turn,
        error: error.message,
        stack: error.stack,
      });
      return { success: false, reason: "filter_candidates_failed" };
    }

    logger.agent("FILTER_RESULT", {
      turn,
      candidatesProposed: recommendations.length,
      candidatesAccepted: normalizeDroppedItems(filtered?.unwatched).length,
      candidatesRejected:
        recommendations.length - normalizeDroppedItems(filtered?.unwatched).length,
      rejectionReasons: {
        droppedWatched: filtered?.droppedWatched,
        droppedNoId: filtered?.droppedNoId,
        droppedDuplicates: filtered?.droppedDuplicates,
        rejectionReasons: filtered?.rejectionReasons || filtered?.reasons,
      },
    });

    const rawUnwatched = normalizeDroppedItems(filtered?.unwatched);
    const turnDroppedWatched = normalizeDroppedItems(filtered?.droppedWatched);
    const turnDroppedWatchedCount =
      typeof filtered?.droppedWatched === "number"
        ? filtered.droppedWatched
        : turnDroppedWatched.length;
    const turnDroppedNoIdCount = countDroppedItems(filtered?.droppedNoId);
    let turnDroppedDuplicateCount = countDroppedItems(filtered?.droppedDuplicates);

    const novelUnwatched = [];
    let crossTurnDuplicateCount = 0;

    rawUnwatched.forEach((item) => {
      if (isDuplicateAcrossTurns(item, proposedIdSet)) {
        crossTurnDuplicateCount += 1;
        return;
      }

      novelUnwatched.push(item);
    });

    turnDroppedDuplicateCount += crossTurnDuplicateCount;
    droppedWatchedTotal += turnDroppedWatchedCount;
    droppedNoIdTotal += turnDroppedNoIdCount;
    droppedDuplicatesTotal += turnDroppedDuplicateCount;

    recommendations.forEach((item) => addMediaIdentityKeys(proposedIdSet, item));

    if (novelUnwatched.length > 0) {
      const remainingSlots = Math.max(0, resolvedNumResults - collected.length);
      collected.push(...novelUnwatched.slice(0, remainingSlots));
    }

    if (collected.length >= resolvedNumResults) {
      return {
        success: true,
        recommendations: collected.slice(0, resolvedNumResults),
      };
    }

    if (novelUnwatched.length === 0) {
      return { success: true, recommendations: collected, reason: "agent_stuck" };
    }

    return { success: true, recommendations: collected, reason: "max_turns_exceeded" };
  }

  logger.info("Starting agent recommendation loop", {
    type,
    modelName,
    maxTurns,
    numResults: resolvedNumResults,
    hasTraktAuth: !!(traktAuth || traktUsername || traktAccessToken),
  });

  const ai = new GoogleGenAI({ apiKey: geminiApiKey });
  const systemPrompt = buildAgentSystemPrompt({
    type,
    query: userQuery,
    numResults: resolvedNumResults,
  });

  logger.agent("SYSTEM_PROMPT", systemPrompt);

  const chat = ai.chats.create({
    model: modelName,
    config: {
      systemInstruction: systemPrompt,
      tools: [{ functionDeclarations: toolDeclarations }],
    },
  });

  const runtime = {
    searchTMDB,
    fetchTraktWatchedAndRated,
    isItemWatchedOrRated,
    processPreferencesInParallel,
    traktWatchedIdSet,
    traktRatedIdSet,
    caches: {
      tmdbCache,
      traktCache,
      traktRawDataCache,
      tmdbDetailsCache,
      aiRecommendationsCache,
    },
    traktAuth,
    traktUsername,
    traktAccessToken,
  };

  const initialMessage = buildAgentInitialMessage({
    type,
    query: userQuery,
    numResults: resolvedNumResults,
    // Keep common prompt-builder inputs available if callers already pass them.
    currentYear: dependencies.currentYear,
    discoveredGenres: dependencies.discoveredGenres,
    genreCriteria: dependencies.genreCriteria,
  });

  logger.agent("INITIAL_MESSAGE", initialMessage);

  let response;
  try {
    response = await callGemini(chat, initialMessage, { turn: 0 });
  } catch (error) {
    if (isFunctionCallingUnsupportedError(error)) {
      logger.warn("Agent model does not support function calling", {
        modelName,
        error: error.message,
      });
      const result = { success: false, reason: "function_calling_unsupported" };
      logSummary(result.success, result.reason);
      return result;
    }

    throw error;
  }

  for (let turn = 0; turn < maxTurns; turn += 1) {
    turns += 1;
    logger.debug("Agent turn", { turn: turns, maxTurns });
    logger.agent("TURN_START", { turn: turns, collectedSoFar: collected.length });

    const functionCalls = extractFunctionCalls(response);

    if (functionCalls.length === 0) {
      const text = extractModelText(response);

      if (!text) {
        logger.warn("Agent returned an empty turn", { turn: turns });
        const result = { success: false, reason: "empty_turn" };
        logSummary(result.success, result.reason);
        return result;
      }

      let parsed;

      try {
        parsed = JSON.parse(text);
      } catch (error) {
        logger.warn("Agent final output was not valid JSON", {
          error: error.message,
          turn: turns,
        });
        logger.agent("LOOP_ERROR", {
          turn: turns,
          error: error.message,
          stack: error.stack,
        });
        const result = { success: false, reason: "invalid_final_json" };
        logSummary(result.success, result.reason);
        return result;
      }

      const recommendations = normalizeRecommendationList(parsed);

      if (typeof filterCandidates !== "function") {
        const legacyResult = { success: true, recommendations: recommendations.slice(0, resolvedNumResults) };
        logSummary(legacyResult.success, undefined, legacyResult.recommendations);
        return legacyResult;
      }

      let filtered;
      try {
        filtered = filterCandidates(recommendations);
      } catch (error) {
        logger.error("Agent candidate filtering failed", {
          error: error.message,
          turn: turns,
        });
        logger.agent("LOOP_ERROR", {
          turn: turns,
          error: error.message,
          stack: error.stack,
        });
        const result = { success: false, reason: "filter_candidates_failed" };
        logSummary(result.success, result.reason);
        return result;
      }

      logger.agent("FILTER_RESULT", {
        turn: turns,
        candidatesProposed: recommendations.length,
        candidatesAccepted: normalizeDroppedItems(filtered?.unwatched).length,
        candidatesRejected:
          recommendations.length - normalizeDroppedItems(filtered?.unwatched).length,
        rejectionReasons: {
          droppedWatched: filtered?.droppedWatched,
          droppedNoId: filtered?.droppedNoId,
          droppedDuplicates: filtered?.droppedDuplicates,
          rejectionReasons: filtered?.rejectionReasons || filtered?.reasons,
        },
      });

      const rawUnwatched = normalizeDroppedItems(filtered?.unwatched);
      const turnDroppedWatched = normalizeDroppedItems(filtered?.droppedWatched);
      const turnDroppedWatchedCount =
        typeof filtered?.droppedWatched === "number"
          ? filtered.droppedWatched
          : turnDroppedWatched.length;
      const turnDroppedNoIdCount = countDroppedItems(filtered?.droppedNoId);
      let turnDroppedDuplicateCount = countDroppedItems(filtered?.droppedDuplicates);

      const novelUnwatched = [];
      let crossTurnDuplicateCount = 0;

      rawUnwatched.forEach((item) => {
        if (isDuplicateAcrossTurns(item, proposedIdSet)) {
          crossTurnDuplicateCount += 1;
          return;
        }

        novelUnwatched.push(item);
      });

      turnDroppedDuplicateCount += crossTurnDuplicateCount;
      droppedWatchedTotal += turnDroppedWatchedCount;
      droppedNoIdTotal += turnDroppedNoIdCount;
      droppedDuplicatesTotal += turnDroppedDuplicateCount;

      recommendations.forEach((item) => addMediaIdentityKeys(proposedIdSet, item));

      if (novelUnwatched.length > 0) {
        const remainingSlots = Math.max(0, resolvedNumResults - collected.length);
        collected.push(...novelUnwatched.slice(0, remainingSlots));
      }

      if (collected.length >= resolvedNumResults) {
        const result = {
          success: true,
          recommendations: collected.slice(0, resolvedNumResults),
        };
        logSummary(result.success, undefined, result.recommendations);
        return result;
      }

      const usefulItemsThisTurn = novelUnwatched.length;
      if (usefulItemsThisTurn === 0) {
        const result = { success: true, recommendations: collected, reason: "agent_stuck" };
        logSummary(result.success, result.reason, result.recommendations);
        return result;
      }

      if (turn + 1 >= maxTurns) {
        const result = {
          success: true,
          recommendations: collected,
          reason: "max_turns_exceeded",
        };
        logSummary(result.success, result.reason, result.recommendations);
        return result;
      }

      const refinementMessage = buildRefinementMessage({
        neededCount: Math.max(0, resolvedNumResults - collected.length),
        droppedWatched: turnDroppedWatched,
        droppedNoId: turnDroppedNoIdCount,
        droppedDuplicates: turnDroppedDuplicateCount,
        recentProposedIds: getRecentProposedIds(proposedIdSet, 50),
      });

      logger.agent("REFINEMENT_SENT", refinementMessage);

      try {
        response = await callGemini(chat, refinementMessage, { turn: turns });
      } catch (error) {
        if (isFunctionCallingUnsupportedError(error)) {
          logger.warn("Agent model does not support function calling", {
            modelName,
            error: error.message,
          });
          const result = { success: false, reason: "function_calling_unsupported" };
          logSummary(result.success, result.reason);
          return result;
        }

        if (collected.length > 0) {
          logger.error("Agent refinement call failed after collecting partial results", {
            error: error.message,
            turn: turns,
            collectedSoFar: collected.length,
          });
          logger.agent("LOOP_ERROR_PARTIAL", {
            turn: turns,
            error: error.message,
            stack: error.stack,
            collectedSoFar: collected.length,
          });
          loopTerminationReason = "api_error_partial";
          break;
        }

        throw error;
      }

      continue;
    }

    if (turn + 1 >= maxTurns) {
      logger.agent("FINALIZATION_FORCED", {
        turn,
        reason: "last_turn_had_tool_calls",
      });

      const finalizationMessage =
        "You have used all available tool turns. Based on the information you have gathered so far, return your final recommendations now as a JSON array. Do not call any more tools.";

      logger.agent("REFINEMENT_SENT", finalizationMessage);

      let finalizationResponse;

      try {
        finalizationResponse = await callGemini(chat, finalizationMessage, { turn: turns });
      } catch (error) {
        if (isFunctionCallingUnsupportedError(error)) {
          logger.warn("Agent model does not support function calling", {
            modelName,
            error: error.message,
          });
          const result = { success: false, reason: "function_calling_unsupported" };
          logSummary(result.success, result.reason);
          return result;
        }

        if (collected.length > 0) {
          logger.error("Agent finalization call failed after collecting partial results", {
            error: error.message,
            turn: turns,
            collectedSoFar: collected.length,
          });
          logger.agent("LOOP_ERROR_PARTIAL", {
            turn: turns,
            error: error.message,
            stack: error.stack,
            collectedSoFar: collected.length,
          });
          loopTerminationReason = "api_error_partial";
          break;
        }

        throw error;
      }

      const finalizationFunctionCalls = extractFunctionCalls(finalizationResponse);

      if (finalizationFunctionCalls.length > 0) {
        logger.warn("Agent finalization response still requested tools", {
          turn: turns,
          toolCount: finalizationFunctionCalls.length,
        });
        break;
      }

      const result = processFinalTextResponse(finalizationResponse, turns);
      if (result.success) {
        logSummary(result.success, result.reason, result.recommendations);
      } else {
        logSummary(result.success, result.reason);
      }
      return result;
    }

    toolCalls += functionCalls.length;

    functionCalls.forEach((call) => {
      logger.agent("TOOL_CALL_REQUEST", {
        turn: turns,
        toolName: call.name,
        args: call.args,
      });
    });

    if (typeof executeTools !== "function") {
      throw new Error("Agent tool executor is required when Gemini returns function calls");
    }

    let toolResults;

    try {
      toolResults = await executeTools(functionCalls, runtime);
    } catch (error) {
      logger.error("Agent tool execution failed", {
        error: error.message,
        turn: turns,
      });
      logger.agent("LOOP_ERROR", {
        turn: turns,
        error: error.message,
        stack: error.stack,
      });
      const result = { success: false, reason: "all_tools_failed" };
      logSummary(result.success, result.reason);
      return result;
    }

    const normalizedToolParts = normalizeToolResultParts(toolResults);
    const failedToolCount = countToolFailures(normalizedToolParts);
    const hasSuccessfulToolResponse = normalizedToolParts.some((part) => {
      const response = part?.functionResponse?.response;
      return (
        response &&
        !(response.error || response.success === false || response.ok === false)
      );
    });

    if (!hasSuccessfulToolResponse || failedToolCount === normalizedToolParts.length) {
      logger.warn("All tool invocations failed for this turn", {
        turn: turns,
        toolCount: functionCalls.length,
      });
      const result = { success: false, reason: "all_tools_failed" };
      logSummary(result.success, result.reason);
      return result;
    }

    logger.agent("TOOL_CALL_RESPONSE", {
      turn: turns,
      toolName: functionCalls.length === 1 ? functionCalls[0].name : functionCalls.map((call) => call.name),
      resultSummary: {
        count: normalizedToolParts.length,
        failedToolCount,
        result: normalizedToolParts,
      },
    });

    try {
      response = await callGemini(chat, normalizedToolParts, { turn: turns });
    } catch (error) {
      if (isFunctionCallingUnsupportedError(error)) {
        logger.warn("Agent model does not support function calling", {
          modelName,
          error: error.message,
        });
        logger.agent("LOOP_ERROR", {
          turn: turns,
          error: error.message,
          stack: error.stack,
        });
        const result = { success: false, reason: "function_calling_unsupported" };
        logSummary(result.success, result.reason);
        return result;
      }

      if (collected.length > 0) {
        logger.error("Agent tool response call failed after collecting partial results", {
          error: error.message,
          turn: turns,
          collectedSoFar: collected.length,
        });
        logger.agent("LOOP_ERROR_PARTIAL", {
          turn: turns,
          error: error.message,
          stack: error.stack,
          collectedSoFar: collected.length,
        });
        loopTerminationReason = "api_error_partial";
        break;
      }

      throw error;
    }
  }

  if (loopTerminationReason === "max_turns_exceeded") {
    logger.warn("Agent loop exhausted max turns", { type, maxTurns });
  }
  const result = {
    success: true,
    recommendations: collected,
    reason: loopTerminationReason,
  };
  logSummary(result.success, result.reason, result.recommendations);
  return result;
}

module.exports = {
  runAgentLoop,
  DEFAULT_MAX_TURNS,
};
