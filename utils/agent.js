const { GoogleGenAI } = require("@google/genai");
const logger = require("./logger");
const { withRetry } = require("./apiRetry");
const { parseTurnResponse } = require("./agent-parse");
const {
  AGENT_ITEM_SCHEMA,
  validateAgentItems,
  buildCorrectiveFeedback,
} = require("./agent-validate");
const {
  buildAgentSystemPrompt,
  buildTurnMessage,
} = require("./prompts");
const { normalizeMediaKey } = require("./trakt");
const { buildMediaIdentityKeys, setHasIdentity } = require("./mediaIdentity");

const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MAX_TOOL_ROUNDS_PER_TURN = 8;

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

function normalizeProposedTitle(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function addProposedTitles(target, titles) {
  if (!Array.isArray(target)) {
    return;
  }

  titles.forEach((title) => {
    const normalized = normalizeProposedTitle(title);
    if (normalized) {
      target.push(normalized);
    }
  });
}

function collectProposedTitlesFromFunctionCalls(functionCalls) {
  const titles = [];

  functionCalls.forEach((call) => {
    const args = call?.args && typeof call.args === "object" ? call.args : {};

    if (call?.name === "batch_search_tmdb" && Array.isArray(args.queries)) {
      addProposedTitles(
        titles,
        args.queries.map((query) => query?.query)
      );
      return;
    }
  });

  return titles;
}

function normalizeBatchSearchQueryForSignature(query) {
  const source = query && typeof query === "object" ? query : {};
  const normalizedYear = parseStrictInteger(source.year);

  return {
    query:
      typeof source.query === "string"
        ? source.query.trim().toLowerCase()
        : source.query == null
          ? ""
          : String(source.query).trim().toLowerCase(),
    type:
      typeof source.type === "string"
        ? source.type.trim().toLowerCase()
        : source.type == null
          ? ""
          : String(source.type).trim().toLowerCase(),
    year:
      normalizedYear !== null
        ? normalizedYear
        : source.year == null
          ? null
          : String(source.year).trim().toLowerCase(),
  };
}

function computeToolBatchSignature(functionCalls) {
  if (!Array.isArray(functionCalls) || functionCalls.length === 0) {
    return "";
  }

  const callSignatures = functionCalls
    .map((call) => {
      if (call?.name === "batch_search_tmdb") {
        const queries = Array.isArray(call?.args?.queries) ? call.args.queries : [];
        const normalizedQueries = queries
          .map((query) => normalizeBatchSearchQueryForSignature(query))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

        return JSON.stringify({
          toolName: call.name,
          queries: normalizedQueries,
        });
      }

      return JSON.stringify({
        toolName: call?.name || "",
        args: call?.args,
      });
    })
    .sort();

  return callSignatures.join("|");
}

function recordProposedTitlesFromRecommendations(recommendations, proposedTitles) {
  if (!Array.isArray(recommendations)) {
    return;
  }

  addProposedTitles(
    proposedTitles,
    recommendations
      .filter(
        (item) =>
          Object.prototype.toString.call(item) === "[object Object]" &&
          typeof item.title === "string" &&
          item.title.trim().length > 0
      )
      .map((item) => item.title)
  );
}

function getTurnTitle(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return normalizeProposedTitle(
    item.title || item.name || item.original_title || item.original_name
  );
}

function getTurnTitleKey(item) {
  const title = getTurnTitle(item);
  return title ? title.toLowerCase() : "";
}

function normalizeIdentityToken(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function getTurnItemType(item, fallbackType = "movie") {
  return (
    normalizeRecommendationType(item?.type) ||
    normalizeRecommendationType(fallbackType) ||
    "movie"
  );
}

function getTurnItemYear(item) {
  const year = parseStrictInteger(item?.year);
  return year !== null && year > 0 ? year : null;
}

function getTurnPrimaryKey(item, fallbackType) {
  const tmdb_id = parseStrictInteger(item?.tmdb_id ?? item?.tmdbId ?? item?.ids?.tmdb ?? null);
  if (tmdb_id === null || tmdb_id <= 0) {
    return null;
  }

  return `${getTurnItemType(item, fallbackType)}:${tmdb_id}`;
}

function getTurnProposalTokens(item, fallbackType) {
  const tokens = [];
  const title = getTurnTitle(item);
  const normalizedTitle = normalizeIdentityToken(title);
  const year = getTurnItemYear(item);
  const type = getTurnItemType(item, fallbackType);
  const tmdbKey = getTurnPrimaryKey(item, fallbackType);

  if (tmdbKey) {
    tokens.push(tmdbKey);
  }

  if (normalizedTitle) {
    tokens.push(`${type}:${normalizedTitle}${year !== null ? `:${year}` : ""}`);
  }

  return [...new Set(tokens.filter(Boolean))];
}

function buildProposedIdentitySet(values) {
  const identitySet = new Set();

  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = normalizeIdentityToken(
      typeof value === "string"
        ? value
        : value && (value.title || value.name || value.original_title || value.original_name)
    );

    if (normalized) {
      identitySet.add(normalized);
    }
  });

  return identitySet;
}

function addProposedTokens(target, tokens) {
  addProposedTitles(target, tokens);
}

function applyTurnFilter(items, ctx = {}) {
  const collected = Array.isArray(ctx.collected) ? ctx.collected : [];
  const proposedTitles = Array.isArray(ctx.proposedTitles) ? ctx.proposedTitles : [];
  const filterWatched = ctx.filterWatched !== false;
  const requestedType = ctx.type;
  const collectedIdentitySet = new Set(
    collected.map((item) => getTurnPrimaryKey(item, requestedType)).filter(Boolean)
  );
  const proposedIdentitySet = buildProposedIdentitySet(proposedTitles);
  const watchedIdentitySet =
    filterWatched && ctx.traktWatchedIdSet instanceof Set && ctx.traktWatchedIdSet.size > 0
      ? ctx.traktWatchedIdSet
      : null;
  const ratedIdentitySet =
    filterWatched && ctx.traktRatedIdSet instanceof Set && ctx.traktRatedIdSet.size > 0
      ? ctx.traktRatedIdSet
      : null;
  const historyIdentitySet =
    filterWatched && ctx.traktHistoryIdSet instanceof Set && ctx.traktHistoryIdSet.size > 0
      ? ctx.traktHistoryIdSet
      : null;

  const accepted = [];
  let rejectedCount = 0;
  let droppedCollectedCount = 0;
  let droppedProposedCount = 0;
  let droppedWatchedCount = 0;
  let droppedRatedCount = 0;
  const seenThisTurnIdentitySet = new Set();

  (Array.isArray(items) ? items : []).forEach((item) => {
    const proposalTokens = getTurnProposalTokens(item, requestedType);
    const currentTitle = getTurnTitle(item);
    const currentYear = getTurnItemYear(item);
    const tmdb_id = parseStrictInteger(item?.tmdb_id ?? item?.tmdbId ?? item?.ids?.tmdb ?? null);
    const type = getTurnItemType(item, requestedType);
    const primaryKey = tmdb_id !== null && tmdb_id > 0 ? `${type}:${tmdb_id}` : null;
    const itemKeys = buildMediaIdentityKeys({
      type,
      tmdb_id,
      imdb_id: item?.imdb_id ?? item?.imdbId ?? item?.ids?.imdb ?? null,
      title: currentTitle,
      year: currentYear,
    });
    const comparisonTokens = [...proposalTokens];
    const normalizedTitle = normalizeIdentityToken(currentTitle);
    if (normalizedTitle && currentYear === null) {
      comparisonTokens.push(normalizedTitle);
    }
    const proposedIdentityTokens = comparisonTokens
      .map(normalizeIdentityToken)
      .filter(Boolean);
    const isDuplicateProposed = proposedIdentityTokens.some(
      (token) => proposedIdentitySet.has(token) || seenThisTurnIdentitySet.has(token)
    );

    addProposedTokens(proposedTitles, proposalTokens);
    proposedIdentityTokens.forEach((token) => {
      proposedIdentitySet.add(token);
      seenThisTurnIdentitySet.add(token);
    });

    if (primaryKey && collectedIdentitySet.has(primaryKey)) {
      rejectedCount += 1;
      droppedCollectedCount += 1;
      return;
    }

    if (isDuplicateProposed) {
      rejectedCount += 1;
      droppedProposedCount += 1;
      return;
    }

    if (watchedIdentitySet && setHasIdentity(watchedIdentitySet, ...itemKeys)) {
      rejectedCount += 1;
      droppedWatchedCount += 1;
      return;
    }

    if (historyIdentitySet && setHasIdentity(historyIdentitySet, ...itemKeys)) {
      rejectedCount += 1;
      droppedWatchedCount += 1;
      return;
    }

    if (ratedIdentitySet && setHasIdentity(ratedIdentitySet, ...itemKeys)) {
      rejectedCount += 1;
      droppedRatedCount += 1;
      return;
    }

    accepted.push({
      ...item,
      type,
      title: item?.title || item?.name || currentTitle,
      name: item?.name || item?.title || currentTitle,
      tmdb_id,
    });

    if (primaryKey) {
      collectedIdentitySet.add(primaryKey);
    }
  });

  return {
    accepted,
    proposedTitles,
    droppedCollectedCount,
    droppedProposedCount,
    droppedWatchedCount,
    droppedRatedCount,
    rejectedCount,
  };
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
          toolRound: meta.toolRound ?? 0,
          hasText: !!text,
          hasFunctionCalls: !!functionCalls?.length,
          functionCallNames: functionCalls?.map((fc) => fc.name),
          tokenCount: response.usageMetadata,
          responseTextLength: text?.length,
        });
        logger.agent("AGENT_RAW_RESPONSE", {
          turn: meta.turn ?? 0,
          toolRound: meta.toolRound ?? 0,
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
          toolRound: meta.toolRound ?? 0,
          error: error.message,
          stack: error.stack,
        });
        error.status = error.httpStatus || error.status || 500;
        error.fromGemini = true;
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
    maxTurns: requestedMaxTurns = DEFAULT_MAX_TURNS,
    filterWatched: requestedFilterWatched = true,
    numResults,
    traktWatchedIdSet,
    traktRatedIdSet,
    traktHistoryIdSet,
    filterCandidates,
    toolDeclarations = [],
    executeTools,
    searchTMDB,
    fetchTraktWatchedAndRated,
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

  const filterWatched = requestedFilterWatched !== false;
  const parsedMaxTurns = parseStrictInteger(requestedMaxTurns);
  const maxTurns = Math.min(
    12,
    Math.max(4, parsedMaxTurns ?? DEFAULT_MAX_TURNS)
  );
  const resolvedNumResults = normalizeNumResults(numResults);

  logger.agent("LOOP_START", {
    query: userQuery,
    model: modelName,
    numResults: resolvedNumResults,
    traktWatchedKeysCount:
      traktWatchedIdSet instanceof Set
        ? traktWatchedIdSet.size
        : Array.isArray(traktWatchedIdSet)
          ? traktWatchedIdSet.length
          : traktWatchedIdSet?.length,
    traktRatedKeysCount:
      traktRatedIdSet instanceof Set
        ? traktRatedIdSet.size
        : Array.isArray(traktRatedIdSet)
          ? traktRatedIdSet.length
          : traktRatedIdSet?.length,
    traktHistoryKeysCount:
      traktHistoryIdSet instanceof Set
        ? traktHistoryIdSet.size
        : Array.isArray(traktHistoryIdSet)
          ? traktHistoryIdSet.length
          : traktHistoryIdSet?.length,
    maxTurns,
    filterWatched,
  });

  const startTime = Date.now();
  let turns = 0;
  let toolCalls = 0;
  let collected = [];
  let proposedTitles = [];
  let droppedWatchedTotal = 0;
  let droppedNoIdTotal = 0;
  let droppedMissingTitleTotal = 0;
  let droppedCollectedTotal = 0;
  let droppedProposedTotal = 0;
  let droppedDuplicatesTotal = 0;
  let droppedRatedTotal = 0;

  function logSummary(success, reason, recommendations) {
    const summary = {
      event: "agent_loop_complete",
      success,
      turns,
      toolCalls,
      collectedCount: collected.length,
      droppedWatched: droppedWatchedTotal,
      droppedNoId: droppedNoIdTotal,
      droppedMissingTitle: droppedMissingTitleTotal,
      droppedCollected: droppedCollectedTotal,
      droppedProposed: droppedProposedTotal,
      droppedDuplicates: droppedDuplicatesTotal,
      droppedRated: droppedRatedTotal,
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
        droppedWatched: droppedWatchedTotal,
        droppedNoId: droppedNoIdTotal,
        droppedMissingTitle: droppedMissingTitleTotal,
        droppedCollected: droppedCollectedTotal,
        droppedProposed: droppedProposedTotal,
        droppedRated: droppedRatedTotal,
        elapsed: Date.now() - startTime,
      });
      logger.info("Agent loop complete", summary);
    } else {
      logger.agent("LOOP_END", {
        totalTurns: turns,
        terminationReason: reason || "error",
        collectedCount: collected.length,
        droppedWatched: droppedWatchedTotal,
        droppedNoId: droppedNoIdTotal,
        droppedMissingTitle: droppedMissingTitleTotal,
        droppedCollected: droppedCollectedTotal,
        droppedProposed: droppedProposedTotal,
        droppedRated: droppedRatedTotal,
        elapsed: Date.now() - startTime,
      });
      logger.warn("Agent loop complete", summary);
    }
  }

  function finalizeResult(success, recommendations, reason) {
    const result = { success, recommendations, reason };
    logSummary(result.success, result.reason, result.recommendations);
    return result;
  }

  function buildTurnContext() {
    return {
      type,
      query: userQuery,
      numResults: resolvedNumResults,
      collected,
      proposedTitles,
      gap: resolvedNumResults - collected.length,
      discoveredGenres: dependencies.discoveredGenres,
      genreAnalysis: dependencies.genreAnalysis,
      favoritesContext: dependencies.favoritesContext,
    };
  }

  function buildNextTurnMessage() {
    return buildTurnMessage(buildTurnContext());
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
    filterWatched,
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
    processPreferencesInParallel,
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
    traktWatchedIdSet,
    traktRatedIdSet,
    traktHistoryIdSet,
  };

  async function executeAgentTurn({
    chat: turnChat,
    turnNumber,
    turnContext,
    runtime: turnRuntime,
    maxToolRoundsPerTurn = DEFAULT_MAX_TOOL_ROUNDS_PER_TURN,
  }) {
    function buildParseViolation(parseError) {
      return {
        type: "parse_error",
        code: typeof parseError === "string" ? parseError : "unknown_parse_error",
      };
    }

    function evaluateTextResponse(rawText, gap) {
      const parseResult = parseTurnResponse(rawText);

      if (parseResult.error) {
        return {
          rawText,
          parseResult,
          parsedItems: [],
          validItems: [],
          violations: [buildParseViolation(parseResult.error)],
        };
      }

      const parsedItems = Array.isArray(parseResult.items) ? parseResult.items : [];
      const validation = validateAgentItems(parsedItems, {
        gap,
        schema: AGENT_ITEM_SCHEMA,
      });

      return {
        rawText,
        parseResult,
        parsedItems,
        validItems: validation.validItems,
        violations: Array.isArray(validation.violations) ? validation.violations : [],
      };
    }

    const effectiveMaxToolRoundsPerTurn = Math.max(
      1,
      parseStrictInteger(maxToolRoundsPerTurn) ?? DEFAULT_MAX_TOOL_ROUNDS_PER_TURN
    );
    let toolRoundsUsed = 0;
    let message = buildTurnMessage(turnContext);
    let contractRetryUsed = false;
    let emptyResponseNudgeUsed = false;
    let nudgeReason = null;
    let toolLoopDetected = false;
    let lastToolBatchSignature = null;
    let violationsBeforeRetry = [];
    let violationsAfterRetry = [];

    function buildTurnResult({
      rawText = "",
      parseResult = parseTurnResponse(rawText),
      parsedRawItems = [],
      parsedItems = [],
      endedByText = false,
      toolLoopExhausted = false,
    }) {
      return {
        rawText,
        parseResult,
        parsedRawItems,
        parsedItems,
        toolRoundsUsed,
        endedByText,
        toolLoopExhausted,
        contractRetryUsed,
        emptyResponseNudgeUsed,
        nudgeReason,
        toolLoopDetected,
        violationsBeforeRetry,
        violationsAfterRetry,
      };
    }

    function buildNudgeMessage(reason, gap) {
      if (reason === "repeated_batch") {
        return [
          "You repeated the same tool batch as the previous round.",
          "You already have enough information from previous tool calls.",
          `Return now the JSON array with exactly ${gap} items conforming to the schema.`,
          "Do not call more tools. Do not include prose or markdown. JSON array only.",
        ].join(" ");
      }

      if (reason === "cap_reached") {
        return [
          "You have executed too many tool calls without producing a result.",
          "You already have enough information from previous tool calls.",
          `Return now the JSON array with exactly ${gap} items conforming to the schema.`,
          "Do not call more tools. Do not include prose or markdown. JSON array only.",
        ].join(" ");
      }

      return [
        "The previous response was empty. You already received the tool results.",
        `Return now the JSON array with exactly ${gap} items conforming to the schema.`,
        "Do not call more tools. Do not include prose or markdown. JSON array only.",
      ].join(" ");
    }

    async function handleTextResponse(rawText, gap) {
      const firstEvaluation = evaluateTextResponse(rawText, gap);

      if (firstEvaluation.violations.length > 0 && !contractRetryUsed) {
        contractRetryUsed = true;
        violationsBeforeRetry = firstEvaluation.violations;
        toolRoundsUsed += 1;

        if (toolRoundsUsed > effectiveMaxToolRoundsPerTurn) {
          return buildTurnResult({
            rawText: firstEvaluation.rawText,
            parseResult: firstEvaluation.parseResult,
            parsedRawItems: firstEvaluation.parsedItems,
            parsedItems: firstEvaluation.validItems,
            endedByText: true,
            toolLoopExhausted: true,
          });
        }

        const correctiveMessage = buildCorrectiveFeedback({
          violations: firstEvaluation.violations,
          gap,
          schema: AGENT_ITEM_SCHEMA,
        });
        const retryResponse = await callGemini(turnChat, correctiveMessage, {
          turn: turnNumber,
          toolRound: toolRoundsUsed,
        });
        const retryRawText = extractModelText(retryResponse);
        const retryHasText = typeof retryRawText === "string" && retryRawText.trim().length > 0;
        const retryEvaluation = evaluateTextResponse(retryRawText, gap);

        violationsAfterRetry = retryEvaluation.violations;

        return buildTurnResult({
          rawText: retryRawText,
          parseResult: retryEvaluation.parseResult,
          parsedRawItems: retryEvaluation.parsedItems,
          parsedItems: retryEvaluation.validItems,
          endedByText: retryHasText,
          toolLoopExhausted: false,
        });
      }

      return buildTurnResult({
        rawText: firstEvaluation.rawText,
        parseResult: firstEvaluation.parseResult,
        parsedRawItems: firstEvaluation.parsedItems,
        parsedItems: firstEvaluation.validItems,
        endedByText: true,
        toolLoopExhausted: false,
      });
    }

    async function runNudge(reason, gap, options = {}) {
      if (emptyResponseNudgeUsed) {
        return null;
      }

      emptyResponseNudgeUsed = true;
      nudgeReason = reason;
      toolRoundsUsed += 1;

      logger.agent("NUDGE_DISPATCHED", {
        turn: turnNumber,
        reason,
        toolRoundsUsed,
      });

      const enforceCap = options.enforceCap !== false;

      if (enforceCap && toolRoundsUsed > effectiveMaxToolRoundsPerTurn) {
        return buildTurnResult({
          rawText: "",
          parseResult: parseTurnResponse(""),
          parsedRawItems: [],
          parsedItems: [],
          endedByText: false,
          toolLoopExhausted: true,
        });
      }

      const response = await callGemini(
        turnChat,
        { text: buildNudgeMessage(reason, gap) },
        {
          turn: turnNumber,
          toolRound: toolRoundsUsed,
        }
      );
      const nudgeRawText = extractModelText(response);
      const nudgeHasText = typeof nudgeRawText === "string" && nudgeRawText.trim().length > 0;

      if (nudgeHasText) {
        return handleTextResponse(nudgeRawText, gap);
      }

      return buildTurnResult({
        rawText: "",
        parseResult: parseTurnResponse(""),
        parsedRawItems: [],
        parsedItems: [],
        endedByText: false,
        toolLoopExhausted: options.exhaustOnNonText === true,
      });
    }

    while (true) {
      let response;

      try {
        response = await callGemini(turnChat, message, {
          turn: turnNumber,
          toolRound: toolRoundsUsed,
        });
      } catch (error) {
        throw error;
      }

      const functionCalls = extractFunctionCalls(response);
      const rawText = extractModelText(response);
      const hasText = typeof rawText === "string" && rawText.trim().length > 0;
      const isToolOnly = functionCalls.length > 0 && !hasText;

      if (hasText) {
        const gap = Math.max(0, parseStrictInteger(turnContext?.gap) ?? 0);
        return handleTextResponse(rawText, gap);
      }

      if (!isToolOnly) {
        if (toolRoundsUsed > 0) {
          const gap = Math.max(0, parseStrictInteger(turnContext?.gap) ?? 0);
          const nudgeResult = await runNudge("empty_response_post_tool", gap, {
            exhaustOnNonText: false,
          });
          if (nudgeResult) {
            return nudgeResult;
          }
        }

        return buildTurnResult({
          rawText: "",
          parseResult: parseTurnResponse(""),
          parsedRawItems: [],
          parsedItems: [],
          endedByText: false,
          toolLoopExhausted: false,
        });
      }

      if (typeof executeTools !== "function") {
        throw new Error(
          "Agent tool executor is required when Gemini returns function calls"
        );
      }

      const currentSignature = computeToolBatchSignature(functionCalls);
      const currentToolRound = toolRoundsUsed;

      if (lastToolBatchSignature !== null && currentSignature === lastToolBatchSignature) {
        toolLoopDetected = true;
        logger.agent("TOOL_LOOP_DETECTED", {
          turn: turnNumber,
          toolRound: currentToolRound,
          signature: currentSignature.slice(0, 200),
        });

        const gap = Math.max(0, parseStrictInteger(turnContext?.gap) ?? 0);
        const nudgeResult = await runNudge("repeated_batch", gap, {
          exhaustOnNonText: true,
        });
        if (nudgeResult) {
          return nudgeResult;
        }

        return buildTurnResult({
          rawText: "",
          parseResult: parseTurnResponse(""),
          parsedRawItems: [],
          parsedItems: [],
          endedByText: false,
          toolLoopExhausted: false,
        });
      }

      toolCalls += functionCalls.length;
      functionCalls.forEach((call) => {
        logger.agent("TOOL_CALL_REQUEST", {
          turn: turnNumber,
          toolRound: currentToolRound,
          toolName: call.name,
          args: call.args,
        });
      });

      addProposedTitles(
        proposedTitles,
        collectProposedTitlesFromFunctionCalls(functionCalls)
      );

      let toolResults;

      try {
        toolResults = await executeTools(functionCalls, turnRuntime);
      } catch (error) {
        logger.error("Agent tool execution failed", {
          error: error.message,
          turn: turnNumber,
          toolRound: currentToolRound,
        });
        logger.agent("LOOP_ERROR", {
          turn: turnNumber,
          toolRound: currentToolRound,
          error: error.message,
          stack: error.stack,
        });

        if (collected.length > 0) {
          logger.agent("LOOP_ERROR_PARTIAL", {
            turn: turnNumber,
            toolRound: currentToolRound,
            error: error.message,
            stack: error.stack,
            collectedSoFar: collected.length,
          });
          const partialError = error instanceof Error ? error : new Error(String(error));
          partialError.reason = "api_error_partial";
          throw partialError;
        }

        const toolError = error instanceof Error ? error : new Error(String(error));
        toolError.reason = "all_tools_failed";
        throw toolError;
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
          turn: turnNumber,
          toolRound: currentToolRound,
          toolCount: functionCalls.length,
        });
        const toolError = new Error("All tool invocations failed for this turn");
        toolError.reason = "all_tools_failed";
        throw toolError;
      }

      lastToolBatchSignature = currentSignature;

      logger.agent("TOOL_CALL_RESPONSE", {
        turn: turnNumber,
        toolRound: currentToolRound,
        toolName:
          functionCalls.length === 1
            ? functionCalls[0].name
            : functionCalls.map((call) => call.name),
        resultSummary: {
          count: normalizedToolParts.length,
          failedToolCount,
          result: normalizedToolParts,
        },
      });

      toolRoundsUsed += 1;

      if (toolRoundsUsed >= effectiveMaxToolRoundsPerTurn) {
        const gap = Math.max(0, parseStrictInteger(turnContext?.gap) ?? 0);
        const nudgeResult = await runNudge("cap_reached", gap, {
          exhaustOnNonText: true,
          enforceCap: false,
        });
        if (nudgeResult) {
          return nudgeResult;
        }

        return buildTurnResult({
          rawText: "",
          parseResult: parseTurnResponse(""),
          parsedRawItems: [],
          parsedItems: [],
          endedByText: false,
          toolLoopExhausted: true,
        });
      }

      message = [
        ...normalizedToolParts,
        {
          text: buildTurnMessage(turnContext),
        },
      ];
    }
  }

  const initialMessage = buildTurnMessage(buildTurnContext());
  logger.agent("INITIAL_MESSAGE", initialMessage);

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turns = turn;
    logger.debug("Agent turn", { turn: turns, maxTurns });
    logger.agent("TURN_START", { turn: turns, collectedSoFar: collected.length });

    let turnResult;

    try {
      turnResult = await executeAgentTurn({
        chat,
        turnNumber: turns,
        turnContext: buildTurnContext(),
        runtime,
        maxToolRoundsPerTurn: DEFAULT_MAX_TOOL_ROUNDS_PER_TURN,
      });
    } catch (error) {
      if (isFunctionCallingUnsupportedError(error)) {
        logger.warn("Agent model does not support function calling", {
          modelName,
          error: error.message,
        });
        return finalizeResult(false, [], "function_calling_unsupported");
      }

      if (error?.reason === "api_error_partial") {
        return finalizeResult(true, collected, "api_error_partial");
      }

      if (error?.reason === "all_tools_failed") {
        return finalizeResult(false, [], "all_tools_failed");
      }

      if (error?.fromGemini && collected.length > 0) {
        logger.error("Agent turn failed after collecting partial results", {
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
        return finalizeResult(true, collected, "api_error_partial");
      }

      throw error;
    }

    recordProposedTitlesFromRecommendations(turnResult.parsedRawItems, proposedTitles);

    const turnFilter = applyTurnFilter(turnResult.parsedItems, {
      collected,
      proposedTitles,
      type,
      filterWatched,
      traktWatchedIdSet,
      traktRatedIdSet,
      traktHistoryIdSet,
    });

    collected.push(...turnFilter.accepted);
    droppedNoIdTotal += 0;
    droppedMissingTitleTotal += 0;
    droppedCollectedTotal += turnFilter.droppedCollectedCount || 0;
    droppedProposedTotal += turnFilter.droppedProposedCount || 0;
    droppedWatchedTotal += turnFilter.droppedWatchedCount || 0;
    droppedRatedTotal += turnFilter.droppedRatedCount || 0;
    droppedDuplicatesTotal +=
      (turnFilter.droppedCollectedCount || 0) + (turnFilter.droppedProposedCount || 0);

    const gap = resolvedNumResults - collected.length;
    logger.agent("TURN_RESULT", {
      turn: turns,
      toolRoundsUsed: turnResult.toolRoundsUsed,
      parsedCount: Array.isArray(turnResult.parsedItems) ? turnResult.parsedItems.length : 0,
      rawTextLength: turnResult.rawText.length,
      rawTextSnippet: turnResult.rawText.slice(0, 240),
      parseError: turnResult.parseResult?.error || null,
      endedByText: turnResult.endedByText,
      toolLoopExhausted: turnResult.toolLoopExhausted,
      contractRetryUsed: !!turnResult.contractRetryUsed,
      emptyResponseNudgeUsed: !!turnResult.emptyResponseNudgeUsed,
      nudgeReason: turnResult.nudgeReason || null,
      toolLoopDetected: !!turnResult.toolLoopDetected,
      violationsBeforeRetry: Array.isArray(turnResult.violationsBeforeRetry)
        ? turnResult.violationsBeforeRetry
        : [],
      violationsAfterRetry: Array.isArray(turnResult.violationsAfterRetry)
        ? turnResult.violationsAfterRetry
        : [],
      acceptedCount: turnFilter.accepted.length,
      rejectedCount: turnFilter.rejectedCount,
      rejectedBreakdown: {
        missingTmdb: 0,
        missingTitle: 0,
        duplicateCollected: turnFilter.droppedCollectedCount || 0,
        duplicateProposed: turnFilter.droppedProposedCount || 0,
        watched: turnFilter.droppedWatchedCount || 0,
        rated: turnFilter.droppedRatedCount || 0,
      },
      gap,
    });

    if (collected.length >= resolvedNumResults) {
      return finalizeResult(true, collected.slice(0, resolvedNumResults), "success");
    }

    if (turnResult.toolLoopExhausted) {
      if (turns >= maxTurns) {
        return finalizeResult(collected.length > 0, collected, "tool_loop_exhausted");
      }

      continue;
    }

    if (!turnResult.endedByText) {
      continue;
    }
  }

  if (collected.length > 0) {
    logger.warn("Agent loop exhausted max turns", {
      type,
      maxTurns,
      collectedCount: collected.length,
      droppedWatched: droppedWatchedTotal,
      droppedNoId: droppedNoIdTotal,
      droppedMissingTitle: droppedMissingTitleTotal,
      droppedCollected: droppedCollectedTotal,
      droppedProposed: droppedProposedTotal,
      droppedRated: droppedRatedTotal,
    });
  }

  return finalizeResult(
    collected.length > 0,
    collected,
    "max_turns_exceeded"
  );
}

module.exports = {
  runAgentLoop,
  DEFAULT_MAX_TURNS,
};
