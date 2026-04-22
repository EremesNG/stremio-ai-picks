const { GoogleGenAI } = require("@google/genai");
const logger = require("./logger");
const { withRetry } = require("./apiRetry");
const { parseTurnResponse } = require("./agent-parse");
const {
  AGENT_ITEM_SCHEMA,
  validateAgentItems,
  buildCorrectiveFeedback,
} = require("./agent-validate");
const { handleBatchSearchTmdb } = require("./agent-tools");
const {
  buildAgentSystemPrompt,
  buildTurnMessage,
} = require("./prompts");
const { normalizeMediaKey } = require("./trakt");
const { buildMediaIdentityKeys, setHasIdentity } = require("./mediaIdentity");

const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MAX_TOOL_ROUNDS_PER_TURN = 8;
const OVERFETCH_FACTOR = 1.5;

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

function normalizeNumResults(value) {
  const parsed = parseStrictInteger(value);
  return parsed && parsed > 0 ? parsed : DEFAULT_MAX_TURNS;
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
    }
  });

  return titles;
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

function formatTurnTitleWithYear(item) {
  const title = getTurnTitle(item);
  if (!title) {
    return null;
  }

  const year = getTurnItemYear(item);
  return year !== null ? `${title} (${year})` : title;
}

function normalizeTitle(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035`´']/g, "")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036"]/g, "")
    .replace(/[.,:;!?\-_/]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTmdbMatchType(match, fallbackType) {
  return (
    normalizeRecommendationType(match?.type) ||
    normalizeRecommendationType(match?.media_type) ||
    normalizeRecommendationType(fallbackType) ||
    null
  );
}

function extractTmdbMatchYear(match, matchedType) {
  if (!match || typeof match !== "object") {
    return null;
  }

  const directYear = parseStrictInteger(match?.year);
  if (directYear !== null && directYear > 0) {
    return directYear;
  }

  const releaseYear = parseStrictInteger(String(match?.release_date || "").slice(0, 4));
  const firstAirYear = parseStrictInteger(String(match?.first_air_date || "").slice(0, 4));

  if (matchedType === "movie") {
    return releaseYear !== null && releaseYear > 0 ? releaseYear : null;
  }

  if (matchedType === "series") {
    return firstAirYear !== null && firstAirYear > 0
      ? firstAirYear
      : releaseYear !== null && releaseYear > 0
        ? releaseYear
        : null;
  }

  return releaseYear !== null && releaseYear > 0
    ? releaseYear
    : firstAirYear !== null && firstAirYear > 0
      ? firstAirYear
      : null;
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
  const minTmdbRating =
    typeof ctx.minTmdbRating === "number" && Number.isFinite(ctx.minTmdbRating)
      ? ctx.minTmdbRating
      : null;
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
  let droppedHistoryCount = 0;
  let droppedTypeMismatchCount = 0;
  let droppedNotFoundCount = 0;
  let droppedLowRatingCount = 0;
  const seenThisTurnIdentitySet = new Set();
  const rejectedTitles = {
    watched: [],
    rated: [],
    history: [],
    duplicate: [],
    typeMismatch: [],
    notFound: [],
    lowRating: [],
  };

  (Array.isArray(items) ? items : []).forEach((item) => {
    const proposalTokens = getTurnProposalTokens(item, requestedType);
    const currentTitle = getTurnTitle(item);
    const currentYear = getTurnItemYear(item);
    const resolution = typeof item?.resolution === "string" ? item.resolution : "none";
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
    const rejectionLabel =
      formatTurnTitleWithYear({ title: currentTitle, year: currentYear }) || currentTitle || null;

    function recordRejection(bucketName, label = rejectionLabel) {
      if (!label || !Array.isArray(rejectedTitles[bucketName])) {
        return;
      }
      rejectedTitles[bucketName].push(label);
    }

    addProposedTokens(proposedTitles, proposalTokens);
    proposedIdentityTokens.forEach((token) => {
      proposedIdentitySet.add(token);
      seenThisTurnIdentitySet.add(token);
    });

    if (primaryKey && collectedIdentitySet.has(primaryKey)) {
      rejectedCount += 1;
      droppedCollectedCount += 1;
      recordRejection("duplicate");
      return;
    }

    if (isDuplicateProposed) {
      rejectedCount += 1;
      droppedProposedCount += 1;
      recordRejection("duplicate");
      return;
    }

    if (resolution === "typeMismatch") {
      rejectedCount += 1;
      droppedTypeMismatchCount += 1;
      recordRejection("typeMismatch");
      return;
    }

    if (resolution === "none") {
      rejectedCount += 1;
      droppedNotFoundCount += 1;
      recordRejection("notFound");
      return;
    }

    if (watchedIdentitySet && setHasIdentity(watchedIdentitySet, ...itemKeys)) {
      rejectedCount += 1;
      droppedWatchedCount += 1;
      recordRejection("watched");
      return;
    }

    if (historyIdentitySet && setHasIdentity(historyIdentitySet, ...itemKeys)) {
      rejectedCount += 1;
      droppedHistoryCount += 1;
      recordRejection("history");
      return;
    }

    if (ratedIdentitySet && setHasIdentity(ratedIdentitySet, ...itemKeys)) {
      rejectedCount += 1;
      droppedRatedCount += 1;
      recordRejection("rated");
      return;
    }

    const itemTmdbRating =
      typeof item?.tmdbRating === "number" && Number.isFinite(item.tmdbRating)
        ? item.tmdbRating
        : null;

    if (
      minTmdbRating !== null &&
      itemTmdbRating !== null &&
      itemTmdbRating < minTmdbRating
    ) {
      rejectedCount += 1;
      droppedLowRatingCount += 1;
      recordRejection(
        "lowRating",
        `lowRating: TMDB rating ${itemTmdbRating} below minimum ${minTmdbRating}`
      );
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
    droppedHistoryCount,
    droppedTypeMismatchCount,
    droppedNotFoundCount,
    droppedLowRatingCount,
    rejectedTitles,
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
    minTmdbRating = undefined,
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
  let acceptedSoFar = [];
  let lastTurnRejectedTitles = {
    watched: [],
    rated: [],
    history: [],
    duplicate: [],
    typeMismatch: [],
    notFound: [],
    lowRating: [],
  };
  let droppedWatchedTotal = 0;
  let droppedNoIdTotal = 0;
  let droppedMissingTitleTotal = 0;
  let droppedCollectedTotal = 0;
  let droppedProposedTotal = 0;
  let droppedDuplicatesTotal = 0;
  let droppedRatedTotal = 0;
  let droppedLowRatingTotal = 0;

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
      droppedLowRating: droppedLowRatingTotal,
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
        droppedLowRating: droppedLowRatingTotal,
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
        droppedLowRating: droppedLowRatingTotal,
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
      acceptedSoFar,
      rejectedThisTurn: lastTurnRejectedTitles,
      proposedTitles,
gap: Math.ceil((resolvedNumResults - collected.length) * OVERFETCH_FACTOR),
      remainingGap: Math.ceil((resolvedNumResults - collected.length) * OVERFETCH_FACTOR),
      discoveredGenres: dependencies.discoveredGenres,
      genreAnalysis: dependencies.genreAnalysis,
      favoritesContext: dependencies.favoritesContext,
      minTmdbRating,
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
        violationsBeforeRetry,
        violationsAfterRetry,
      };
    }

    function buildNudgeMessage(_reason, gap) {
      return [
        "The previous response was empty. You already received the tool results.",
        `Return now the JSON array with exactly ${gap} items conforming to the schema.`,
        "Do not call more tools. Do not include prose or markdown. JSON array only.",
      ].join(" ");
    }

    function selectTmdbMatchForCandidate(candidate, resolvedEntry) {
      const requestedType = getTurnItemType(candidate, type);
      const requestedTitle = normalizeTitle(getTurnTitle(candidate) || "");
      const requestedYear = getTurnItemYear(candidate);
      const matchList = Array.isArray(resolvedEntry?.matches) ? resolvedEntry.matches : [];

      function selectByType(targetType, fallbackType) {
        const tierA = matchList.find((match) => {
          const matchedType = extractTmdbMatchType(match, fallbackType);
          if (matchedType !== targetType) {
            return false;
          }

          const matchedTitle = normalizeTitle(getTurnTitle(match) || "");
          if (!matchedTitle || matchedTitle !== requestedTitle) {
            return false;
          }

          const matchedYear = extractTmdbMatchYear(match, matchedType);
          return requestedYear !== null && matchedYear === requestedYear;
        });

        if (tierA) {
          return {
            match: tierA,
            matchedType: extractTmdbMatchType(tierA, fallbackType) || undefined,
            matchedTmdbId: undefined,
            resolution: "exact",
          };
        }

        const tierB = matchList.find((match) => {
          const matchedType = extractTmdbMatchType(match, fallbackType);
          if (matchedType !== targetType) {
            return false;
          }

          const matchedTitle = normalizeTitle(getTurnTitle(match) || "");
          return !!matchedTitle && matchedTitle === requestedTitle;
        });

        if (tierB) {
          return {
            match: tierB,
            matchedType: extractTmdbMatchType(tierB, fallbackType) || undefined,
            matchedTmdbId: undefined,
            resolution: "title+type",
          };
        }

        const tierC = matchList.find((match) => {
          const matchedType = extractTmdbMatchType(match, fallbackType);
          return matchedType === targetType;
        });

        if (tierC) {
          return {
            match: tierC,
            matchedType: extractTmdbMatchType(tierC, fallbackType) || undefined,
            matchedTmdbId: undefined,
            resolution: "type-only",
          };
        }

        return {
          match: null,
          matchedType: undefined,
          matchedTmdbId: undefined,
          resolution: "none",
        };
      }

      const primarySelection = selectByType(requestedType, resolvedEntry?.type || requestedType);
      if (primarySelection.resolution !== "none") {
        return primarySelection;
      }

      const oppositeType = requestedType === "movie"
        ? "series"
        : requestedType === "series"
          ? "movie"
          : null;

      if (!oppositeType) {
        return primarySelection;
      }

      // Cross-type diagnostic fallback runs once and only after primary resolution is "none".
      const oppositeSelection = selectByType(oppositeType, undefined);
      if (oppositeSelection.resolution !== "none") {
        const matchedTmdbId = parseStrictInteger(
          oppositeSelection.match?.tmdb_id ?? oppositeSelection.match?.id ?? null
        );
        if (matchedTmdbId === null || matchedTmdbId <= 0) {
          return primarySelection;
        }
        return {
          match: null,
          matchedType: oppositeSelection.matchedType || oppositeType,
          matchedTmdbId,
          resolution: "typeMismatch",
        };
      }

      return primarySelection;
    }

    async function resolveValidatedItems(validItems) {
      if (!Array.isArray(validItems) || validItems.length === 0) {
        return [];
      }

      const queries = validItems.map((item) => {
        const year = getTurnItemYear(item);
        return {
          type: getTurnItemType(item, type),
          query: getTurnTitle(item) || "",
          ...(year !== null ? { year } : {}),
        };
      });

      const tmdbBatchStartedAt = Date.now();
      let tmdbBatchDurationMs = 0;
      let resolution;
      let tmdbBatchFailed = false;

      try {
        resolution = await handleBatchSearchTmdb({ queries }, turnRuntime);
        tmdbBatchDurationMs = Date.now() - tmdbBatchStartedAt;
      } catch (error) {
        tmdbBatchDurationMs = Date.now() - tmdbBatchStartedAt;
        tmdbBatchFailed = true;
        logger.warn("Orchestrator TMDB batch resolution failed", {
          turn: turnNumber,
          queryCount: queries.length,
          durationMs: tmdbBatchDurationMs,
          error: error instanceof Error ? error.message : String(error),
        });
        resolution = { results: [] };
      }

      const resolvedEntries = Array.isArray(resolution?.results) ? resolution.results : [];

      return validItems.map((item, index) => {
        const title = getTurnTitle(item) || "";
        const year = getTurnItemYear(item);
        const requestedType = getTurnItemType(item, type);
        const resolvedEntry = resolvedEntries[index] || {};
        const hasEntryError = !!resolvedEntry?.error;
        const hasUsableMatches = Array.isArray(resolvedEntry?.matches);
        const selection =
          tmdbBatchFailed || hasEntryError || !hasUsableMatches
            ? {
                match: null,
                matchedType: undefined,
                matchedTmdbId: undefined,
                resolution: "none",
              }
            : selectTmdbMatchForCandidate(item, resolvedEntry);
        const selectedMatch = selection.match;
        // Hook for Task 2.6: map per-query TMDB misses/errors and resolution==="typeMismatch" to rejection buckets.
        const tmdb_id = parseStrictInteger(selectedMatch?.tmdb_id ?? selectedMatch?.id ?? null);
        const hasResolvedTmdbId = tmdb_id !== null && tmdb_id > 0;
        const matchedTmdbId = hasResolvedTmdbId ? tmdb_id : selection.matchedTmdbId;
        const matchedType = selection.matchedType;
        const resolutionValue = hasResolvedTmdbId ? selection.resolution : selection.resolution || "none";

        // handleBatchSearchTmdb currently exposes batch timing only, so each per-query
        // telemetry event intentionally reuses the same batch wall-clock duration.
        logger.agent("ORCHESTRATOR_TMDB_RESOLVE_RESULT", {
          title,
          year,
          requestedType,
          matchedTmdbId,
          matchedType,
          resolution: resolutionValue,
          durationMs: tmdbBatchDurationMs,
        });

        return {
          ...item,
          tmdb_id: hasResolvedTmdbId ? tmdb_id : undefined,
          matchedType,
          matchedTmdbId,
          resolution: resolutionValue,
          tmdbRating: selectedMatch?.tmdbRating ?? undefined,
        };
      });
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
        const resolvedRetryItems = await resolveValidatedItems(retryEvaluation.validItems);

        violationsAfterRetry = retryEvaluation.violations;

        return buildTurnResult({
          rawText: retryRawText,
          parseResult: retryEvaluation.parseResult,
          parsedRawItems: retryEvaluation.parsedItems,
          parsedItems: resolvedRetryItems,
          endedByText: retryHasText,
          toolLoopExhausted: false,
        });
      }

      const resolvedItems = await resolveValidatedItems(firstEvaluation.validItems);

      return buildTurnResult({
        rawText: firstEvaluation.rawText,
        parseResult: firstEvaluation.parseResult,
        parsedRawItems: firstEvaluation.parsedItems,
        parsedItems: resolvedItems,
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
        // Only fires for empty non-tool response after at least one favorites round.
        // toolRoundsUsed reflects favorites-only rounds by construction (batch_search_tmdb
        // removed from tool declarations in Phase 3; no other tool surface exists).
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

      const currentToolRound = toolRoundsUsed;

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
      minTmdbRating,
    });

    collected.push(...turnFilter.accepted);
    acceptedSoFar.push(
      ...turnFilter.accepted
        .map((item) => formatTurnTitleWithYear(item))
        .filter(Boolean)
    );
    lastTurnRejectedTitles =
      turnFilter.rejectedTitles && typeof turnFilter.rejectedTitles === "object"
        ? turnFilter.rejectedTitles
        : {
            watched: [],
            rated: [],
            history: [],
            duplicate: [],
            typeMismatch: [],
            notFound: [],
            lowRating: [],
          };
    droppedNoIdTotal += 0;
    droppedMissingTitleTotal += 0;
    droppedCollectedTotal += turnFilter.droppedCollectedCount || 0;
    droppedProposedTotal += turnFilter.droppedProposedCount || 0;
    droppedWatchedTotal += turnFilter.droppedWatchedCount || 0;
    droppedRatedTotal += turnFilter.droppedRatedCount || 0;
    droppedLowRatingTotal += turnFilter.droppedLowRatingCount || 0;
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
      violationsBeforeRetry: Array.isArray(turnResult.violationsBeforeRetry)
        ? turnResult.violationsBeforeRetry
        : [],
      violationsAfterRetry: Array.isArray(turnResult.violationsAfterRetry)
        ? turnResult.violationsAfterRetry
        : [],
      acceptedCount: turnFilter.accepted.length,
      rejectedCount: turnFilter.rejectedCount,
      droppedLowRating: turnFilter.droppedLowRatingCount || 0,
      rejectedBreakdown: {
        missingTmdb: 0,
        missingTitle: 0,
        duplicateCollected: turnFilter.droppedCollectedCount || 0,
        duplicateProposed: turnFilter.droppedProposedCount || 0,
        watched: turnFilter.droppedWatchedCount || 0,
        rated: turnFilter.droppedRatedCount || 0,
        history: turnFilter.droppedHistoryCount || 0,
        typeMismatch: turnFilter.droppedTypeMismatchCount || 0,
        notFound: turnFilter.droppedNotFoundCount || 0,
        lowRating: turnFilter.droppedLowRatingCount || 0,
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
      droppedLowRating: droppedLowRatingTotal,
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
