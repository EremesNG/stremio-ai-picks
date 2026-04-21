const BATCH_SEARCH_TOOL_NAME = ["batch_search_", "tmdb"].join("");

function getQuery(ctx = {}) {
  return ctx.query || ctx.searchQuery || "";
}

function getType(ctx = {}) {
  return ctx.type || "movie";
}

function getNumResults(ctx = {}) {
  return ctx.numResults ?? ctx.N ?? 0;
}

function buildAgentOutputContract(numResults, { includeWatchedRule = false } = {}) {
  const { formatSchemaForPrompt } = require("./agent-validate");
  const lines = [
    `You MUST return exactly ${numResults} items. Do not return fewer. If you cannot find enough candidates, call your tools again to search for more before finalizing. Return as a valid JSON array of objects with exactly these required fields: type, title, year, tmdb_id.`,
    "Each item must include all required fields with the correct types:",
    formatSchemaForPrompt(),
  ];

  if (includeWatchedRule) {
    lines.push("Always exclude any item the user has already watched or rated.");
  }

  lines.push("Do not include markdown, prose, code fences, or commentary.");
  return lines;
}

function buildAgentSystemPrompt(ctx = {}) {
  const type = getType(ctx);
  const numResults = getNumResults(ctx);

  return [
    `You are a ${type} recommendation agent.`,
    "Act as a pure candidate generator for the current turn.",
    `Produce exactly ${numResults} new candidate recommendations and return only a JSON array.`,
    `Resolve candidate titles with one ${BATCH_SEARCH_TOOL_NAME} call, using a single batch instead of one title at a time.`,
    "The orchestrator handles watched and rated filtering locally; do not call a watch-status tool or try to filter by watch history yourself.",
    "Do not re-propose any title already accepted or already proposed.",
    "Do not include markdown, prose, code fences, numbered steps, or commentary.",
    ...buildAgentOutputContract(numResults),
  ].join("\n");
}

function buildSimilarContentPrompt(ctx = {}) {
  const sourceTitle = ctx.sourceTitle || "Unknown title";
  const sourceYear = ctx.sourceYear || "N/A";
  const type = getType(ctx);
  const numResults = getNumResults(ctx);

  return [
    "You are an expert recommendation engine for movies and TV shows.",
    `Your task is to generate a list of exactly ${numResults} recommendations that are highly similar to "${sourceTitle} (${sourceYear})".`,
    "",
    "Your final list must be constructed in two parts:",
    "",
    "**PART 1: FRANCHISE ENTRIES**",
    `First, list all other official movies/series from the same franchise as "${sourceTitle}". This is your highest priority.`,
    "*   This part of the list **MUST** be sorted chronologically by release year.",
    "",
    "**PART 2: SIMILAR RECOMMENDATIONS**",
    `After the franchise entries (if any), fill the remaining slots to reach ${numResults} total recommendations with unrelated titles that are highly similar in mood, theme, and genre.`,
    `*   This part of the list **MUST** be sorted by relevance to "${sourceTitle}", with the most similar item first.`,
    "",
    "**CRITICAL RULES:**",
    `1.  **Exclusion:** You **MUST NOT** include the original item, "${sourceTitle} (${sourceYear})", in your list.`,
    "2.  **Final Output:** Provide **ONLY** the combined list of recommendations. Do not include any headers (like \"PART 1\"), introductory text, or explanations.",
    "",
"OUTPUT CONTRACT:",
    `You MUST return exactly ${numResults} items. Do not return fewer. If you cannot find enough candidates, call your tools again to search for more before finalizing. Return as a valid JSON object with a recommendations array of { type, name, year } objects.`,
    "Do not include markdown, prose, code fences, or commentary.",
    "",
    "FEW-SHOT EXAMPLE:",
    `{"recommendations":[{"type":"${type}","name":"The Dark Knight","year":2008}]}`,
  ].join("\n");
}

function toArray(value) {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (value instanceof Set) {
    return Array.from(value);
  }

  if (value && typeof value[Symbol.iterator] === "function") {
    return Array.from(value);
  }

  return [];
}

function formatTitleList(items = []) {
  return toArray(items)
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }

      return (item && (item.title || item.name || item.original_title || item.original_name)) || "";
    })
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(", ");
}

function formatContextValue(value) {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildTurnMessage(ctx = {}) {
  const { formatSchemaForPrompt } = require("./agent-validate");
  const query = getQuery(ctx);
  const type = getType(ctx);
  const numResults = getNumResults(ctx);
  const gap = typeof ctx.gap === "number"
    ? ctx.gap
    : Math.max(0, numResults - toArray(ctx.collected).length);
  const collectedTitles = formatTitleList(ctx.collected);
  const proposedTitles = formatTitleList(ctx.proposedTitles);
  const discoveredGenres = formatTitleList(ctx.discoveredGenres);
  const genreAnalysis = formatContextValue(ctx.genreAnalysis);
  const favoritesContext = formatContextValue(ctx.favoritesContext);

  const lines = [
    "Generate the next recommendation candidates for this query.",
    `Query: ${query}`,
    `Type: ${type}`,
    `Requested count: ${numResults}`,
    `Remaining gap: ${gap}`,
    `Collected titles: ${collectedTitles || "none"}`,
    `Already proposed titles: ${proposedTitles || "none"}`,
    collectedTitles || proposedTitles
      ? "Do not re-propose any title already listed above."
      : "Do not re-propose any previously accepted or proposed title.",
  ];

  if (discoveredGenres) {
    lines.push(`Discovered genres: ${discoveredGenres}`);
  }

  if (genreAnalysis) {
    lines.push(`Genre analysis: ${genreAnalysis}`);
  }

  if (favoritesContext) {
    lines.push(`Favorites context: ${favoritesContext}`);
  }

  lines.push(
    `Resolve the candidate titles by calling ${BATCH_SEARCH_TOOL_NAME} in one batch, not one title at a time.`,
    "Return exactly gap new candidates as a JSON array only.",
    "Each candidate must include exactly these required fields: type, title, year, tmdb_id.",
    "Each candidate must include all required fields with the correct types:",
    formatSchemaForPrompt(),
    "Use only new candidates that are not already in collected or proposed titles.",
    "Do not include markdown, code fences, explanations, or any text outside the JSON array."
  );

  return lines.join("\n");
}

function buildClassificationPrompt(query) {
  return `
Analyze this recommendation query: "${query}"

Determine:
1. What type of content is being requested (movie, series, or ambiguous)
2. What genres are relevant to this query (be specific and use standard genre names)

Respond with a single JSON object matching this shape:
{
  "type": "movie|series|ambiguous",
  "genres": ["genre1", "genre2", "genre3"]
}

Where:
- type is one of: movie, series, ambiguous
- genres is an array of standard genre names, or ["all"] if no specific genres are discovered in the query

Do not include any explanatory text before or after your response. Return only JSON.
`;
}

module.exports = {
  buildAgentSystemPrompt,
  buildTurnMessage,
  buildSimilarContentPrompt,
  buildClassificationPrompt,
};
