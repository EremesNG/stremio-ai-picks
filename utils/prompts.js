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

  return [
    `You are a ${type} recommendation agent.`,
    `Use the available tools to produce exactly ${numResults} recommendations when possible.`,
    "",
    "Tool-use protocol:",
    "1. ALWAYS call search_tmdb to resolve each proposed title into a tmdb_id before answering.",
    "2. Optionally call get_user_favorites when the signal is low or you need more preference context.",
    "3. Use the `check_if_watched` tool to verify whether items have been watched or rated before recommending them. Do not recommend items that the user has already watched or rated.",
    "4. Final answer MUST be a valid JSON array of objects shaped like { type, name, year, tmdb_id, imdb_id? }.",
    `5. Return exactly ${numResults} items unless the available evidence cannot support that many safe recommendations.`,
    "6. Do not include markdown, prose, code fences, or commentary.",
  ].join("\n");
}

function buildAgentInitialMessage(ctx = {}) {
  const query = getQuery(ctx);
  const type = getType(ctx);
  const numResults = getNumResults(ctx);
  const currentYear = ctx.currentYear || DEFAULT_CURRENT_YEAR;
  const discoveredGenres = Array.isArray(ctx.discoveredGenres) ? ctx.discoveredGenres : [];
  const genreCriteria = ctx.genreCriteria || null;

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

  return [
    "USER REQUEST:",
    ...queryBits,
    "",
    "GUIDANCE:",
    ...guidance,
    "",
    "OUTPUT CONTRACT:",
    `Return exactly ${numResults} items as a valid JSON array of { type, name, year, tmdb_id, imdb_id? } objects.`,
    "Always exclude any item the user has already watched or rated.",
    "",
    "FEW-SHOT EXAMPLE:",
    examples,
  ].join("\n");
}

module.exports = {
  buildLinearPrompt,
  buildAgentSystemPrompt,
  buildAgentInitialMessage,
};
