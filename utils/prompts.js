const DEFAULT_CURRENT_YEAR = new Date().getFullYear();

function getQuery(ctx = {}) {
  return ctx.query || ctx.searchQuery || "";
}

function getType(ctx = {}) {
  return ctx.type || "movie";
}

function getNumResults(ctx = {}) {
  return ctx.numResults ?? ctx.N ?? 0;
}

function formatInitialResult(item = {}) {
  const year = (item.release_date || item.first_air_date || "N/A").substring(0, 4);
  return `${item.title || item.name} (${year})`;
}

function buildLinearPrompt(ctx = {}) {
  const query = getQuery(ctx);
  const type = getType(ctx);
  const numResults = getNumResults(ctx);
  const discoveredGenres = Array.isArray(ctx.discoveredGenres) ? ctx.discoveredGenres : [];
  const genreCriteria = ctx.genreCriteria || null;
  const traktData = ctx.traktData || null;
  const tmdbInitialResults = Array.isArray(ctx.tmdbInitialResults) ? ctx.tmdbInitialResults : [];

  const promptText = [
    `You are a ${type} recommendation expert. Analyze this query: "${query}"`,
    "",
    "QUERY ANALYSIS:",
    ctx.isRecommendation && discoveredGenres.length > 0
      ? `Discovered genres: ${discoveredGenres.join(", ")}`
      : genreCriteria?.include?.length > 0
        ? `Requested genres: ${genreCriteria.include.join(", ")}`
        : "",
    genreCriteria?.mood?.length > 0 ? `Mood/Style: ${genreCriteria.mood.join(", ")}` : "",
    traktData ? "Use Trakt history and preferences to avoid repeats." : "",
    tmdbInitialResults.length > 0
      ? `Initial database search results: ${tmdbInitialResults.slice(0, 15).map(formatInitialResult).join(" | ")}`
      : "",
    `Return up to ${numResults} ${type} recommendations as JSON only.`,
    type === "movie"
      ? '{"recommendations":[{"type":"movie","name":"The Matrix","year":1999},{"type":"movie","name":"Inception","year":2010}]}'
      : '{"recommendations":[{"type":"series","name":"Breaking Bad","year":2008},{"type":"series","name":"Game of Thrones","year":2011}]}'
  ].filter(Boolean).join("\n");

  return promptText;
}

function buildAgentSystemPrompt(ctx = {}) {
  const type = getType(ctx);
  const numResults = getNumResults(ctx);
  const filterWatched = ctx.filterWatched !== false; // default true if missing

  const toolProtocol = [
    "TURN EFFICIENCY PROTOCOL:",
    "- You have a LIMITED number of turns. Maximize every turn by making MULTIPLE tool calls.",
    "- NEVER call search_tmdb for a single title. ALWAYS use batch_search_tmdb to search multiple titles at once (up to 20).",
    "- NEVER call check_if_watched for a single item. ALWAYS batch up to 10 items per call.",
    "- Prefer proposing MORE candidates than needed (overshoot by 50%) to account for watched items being filtered out.",
    "- Every title you propose MUST be unique. Never re-propose a title from a previous turn.",
    "- When you receive progress feedback, it will list already-accepted items. Do NOT include those in your final answer — they are already counted.",
    "- Optionally call get_user_favorites when the signal is low or you need more preference context.",
    "OPTIMAL WORKFLOW:",
    "- Turn 1: Think of 25-30 candidate titles → call batch_search_tmdb with all of them.",
    "- Turn 2: Take the resolved results → call check_if_watched in batches of 10 (2-3 calls).",
    "- Turn 3: Collect unwatched items. If you have enough (≥ requested count), return final JSON. If not enough, think of MORE new candidates and repeat from Turn 1.",
  ];

  if (filterWatched) {
    toolProtocol.push("WATCHED-FILTER RULES:");
    toolProtocol.push("- Use the `check_if_watched` tool to verify whether items have been watched or rated before recommending them. Do not recommend items that the user has already watched or rated.");
  } else {
    toolProtocol.push("WATCHED-FILTER RULES:");
    toolProtocol.push("- The user has opted out of watched-item filtering. Recommend freely without checking watch history.");
  }

  toolProtocol.push("OUTPUT RULES:");
  toolProtocol.push("- Final answer MUST be a valid JSON array of objects shaped like { type, name, year, tmdb_id, imdb_id? }.");
  toolProtocol.push(`- Return exactly ${numResults} items unless the available evidence cannot support that many safe recommendations.`);
  toolProtocol.push("- Do not include markdown, prose, code fences, or commentary.");

  return [
    `You are a ${type} recommendation agent.`,
    `Use the available tools to produce exactly ${numResults} recommendations when possible.`,
    "",
    "Tool-use protocol:",
    ...toolProtocol,
  ].join("\n");
}

function buildAgentInitialMessage(ctx = {}) {
  const query = getQuery(ctx);
  const type = getType(ctx);
  const numResults = getNumResults(ctx);
  const currentYear = ctx.currentYear || DEFAULT_CURRENT_YEAR;
  const discoveredGenres = Array.isArray(ctx.discoveredGenres) ? ctx.discoveredGenres : [];
  const genreCriteria = ctx.genreCriteria || null;
  const filterWatched = ctx.filterWatched !== false; // default true if missing

  const guidance = [
    "- Focus on the specific requirements from the query (genres, time period, mood).",
    "- Use the user's preferences to refine choices within those requirements.",
    "- Consider rating patterns to gauge quality preferences.",
    "- Prioritize content with preferred actors/directors when relevant.",
    "- Include variety while staying within the requested criteria.",
    "- For genre-specific queries, prioritize acclaimed or popular content in that genre that the user hasn't seen.",
    "- Include a mix of well-known classics and hidden gems in the requested genre.",
    "- If the user has watched many content in the requested genre, look for similar but less obvious choices.",
    `- Current year is ${currentYear}. For time-based queries: past year = ${currentYear - 1} to ${currentYear}; recent = ${currentYear - 2} to ${currentYear}; new/latest = ${currentYear}.`,
    "- For franchise/series queries, list the full franchise first in strict chronological order, then add official spin-offs or highly similar titles only if needed.",
    "- For actor/director/studio filmography queries, return notable works chronologically across the career.",
    "- For general recommendations, order by relevance to the query.",
  ];

  const examples = type === "movie"
    ? '[{"type":"movie","name":"The Matrix","year":1999,"tmdb_id":603,"imdb_id":"tt0133093"}]'
    : '[{"type":"series","name":"Breaking Bad","year":2008,"tmdb_id":1396,"imdb_id":"tt0903747"}]';

  const queryBits = [
    `User query: ${query}`,
    `Requested type: ${type}`,
    `Requested count: ${numResults}`,
    discoveredGenres.length > 0 ? `Discovered genres: ${discoveredGenres.join(", ")}` : "",
    genreCriteria?.include?.length > 0 ? `Requested genres: ${genreCriteria.include.join(", ")}` : "",
    genreCriteria?.mood?.length > 0 ? `Mood/Style: ${genreCriteria.mood.join(", ")}` : "",
  ].filter(Boolean);

  const outputContract = [
    `Return exactly ${numResults} items as a valid JSON array of { type, name, year, tmdb_id, imdb_id? } objects.`,
  ];

  if (filterWatched) {
    outputContract.push("Always exclude any item the user has already watched or rated.");
  }

  return [
    "USER REQUEST:",
    ...queryBits,
    "",
    "GUIDANCE:",
    ...guidance,
    "",
    "OUTPUT CONTRACT:",
    ...outputContract,
    "",
    "FEW-SHOT EXAMPLE:",
    examples,
  ].join("\n");
}

function buildProgressFeedback({ acceptedItems = [], neededCount = 0, alreadyProposedTitles = [] } = {}) {
  const acceptedText = acceptedItems.length > 0
    ? acceptedItems.map((item) => {
        const name = item?.name || "Unknown";
        const year = item?.year ? ` (${item.year})` : "";
        return `${name}${year}`;
      }).join(", ")
    : "None";

  const proposedText = alreadyProposedTitles.length > 0
    ? alreadyProposedTitles.join(", ")
    : "None";

  return [
    "PROGRESS UPDATE:",
    `Accepted so far (DO NOT re-propose these): ${acceptedText}`,
    `Still needed: ${neededCount} more unwatched items.`,
    `Already proposed (avoid these): ${proposedText}`,
    "Think of NEW titles not listed above. Use batch_search_tmdb to search them all at once.",
  ].join("\n");
}

module.exports = {
  buildLinearPrompt,
  buildAgentSystemPrompt,
  buildAgentInitialMessage,
  buildProgressFeedback,
};
