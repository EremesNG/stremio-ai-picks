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
    `You MUST return exactly ${numResults} items. Do not return fewer. If you cannot find enough candidates, call your tools again to search for more before finalizing. Return as a valid JSON array of objects with exactly these required fields: type, title, year.`,
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
  const requestCount = Math.ceil(numResults * 1.5);

  return [
    `You are a ${type} recommendation agent.`,
    "Act as a pure candidate generator for the current turn.",
    `Produce exactly ${requestCount} new candidate recommendations and return only a JSON array.`,
    "Tools available: get_user_favorites, discover_content, trending_content. Use get_user_favorites when you need to check the user's favorites.",
    "Strategy: start with discover_content filters that match the query. If rejections rise (especially watched/duplicate), you MUST change discover filters significantly (different genre combo, year range, sort, keywords) and MUST NOT repeat the same filter set. If discover is exhausted, use trending_content; if trending is exhausted, use pages 2-5 from prior queries. Combine tool results with your own knowledge and output only { type, title, year }.",
    "The orchestrator handles TMDB disambiguation and will resolve title+year+type to a TMDB identity. Do not emit tmdb_id — the orchestrator owns that resolution.",
    "Do not re-propose any title already accepted or already proposed. The orchestrator tracks every proposed title across turns and auto-rejects duplicates, so duplicates waste your turn budget.",
    "Do not include markdown, prose, code fences, numbered steps, or commentary.",
    ...buildAgentOutputContract(requestCount),
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

const MAX_REFINEMENT_LIST_ENTRIES = 50;

function normalizeFeedbackYear(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^\d{4}$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function toTitleYearLabel(item) {
  if (typeof item === "string") {
    const normalized = item.trim();
    return normalized || null;
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const title = String(
    item.title || item.name || item.original_title || item.original_name || ""
  ).trim();
  if (!title) {
    return null;
  }

  const year = normalizeFeedbackYear(item.year);
  return year !== null ? `${title} (${year})` : title;
}

function formatRefinementList(items, { limit = MAX_REFINEMENT_LIST_ENTRIES } = {}) {
  const labels = toArray(items)
    .map((item) => toTitleYearLabel(item))
    .filter(Boolean);

  if (labels.length === 0) {
    return {
      count: 0,
      text: "none",
    };
  }

  if (labels.length <= limit) {
    return {
      count: labels.length,
      text: labels.join(", "),
    };
  }

  const shown = labels.slice(0, limit);
  return {
    count: labels.length,
    text: `${shown.join(", ")}, ... (+${labels.length - shown.length} more)`,
  };
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

const MAX_FAVORITES_SUMMARY_ENTRIES = 5;
const FALLBACK_CONTEXT_MAX_CHARS = 700;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value) {
  const normalized = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(normalized) ? normalized : null;
}

function formatOneDecimal(value) {
  const normalized = toFiniteNumber(value);
  return normalized === null ? null : normalized.toFixed(1);
}

function truncateText(text, maxChars = FALLBACK_CONTEXT_MAX_CHARS) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}... (truncated)`;
}

function parseJsonIfPossible(value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toPreferenceEntries(source, labelKey) {
  if (!source) {
    return [];
  }

  if (source instanceof Map) {
    return Array.from(source.entries())
      .map(([label, count]) => {
        const normalizedLabel = String(label || "").trim();
        const normalizedCount = toFiniteNumber(count);
        if (!normalizedLabel || normalizedCount === null || normalizedCount <= 0) {
          return null;
        }

        return {
          label: normalizedLabel,
          count: normalizedCount,
          avgRating: null,
        };
      })
      .filter(Boolean);
  }

  if (Array.isArray(source)) {
    return source
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const label = String(entry[labelKey] || entry.name || entry.label || "").trim();
        const count = toFiniteNumber(entry.count) ?? 0;
        const avgRating =
          toFiniteNumber(entry.avgRating) ??
          toFiniteNumber(entry.averageRating) ??
          (toFiniteNumber(entry.totalRating) !== null && count > 0
            ? toFiniteNumber(entry.totalRating) / count
            : null);

        if (!label || count <= 0) {
          return null;
        }

        return { label, count, avgRating };
      })
      .filter(Boolean);
  }

  if (!isPlainObject(source)) {
    return [];
  }

  return Object.entries(source)
    .map(([label, details]) => {
      const normalizedLabel = String(label || "").trim();
      if (!normalizedLabel) {
        return null;
      }

      if (typeof details === "number") {
        if (!Number.isFinite(details) || details <= 0) {
          return null;
        }

        return { label: normalizedLabel, count: details, avgRating: null };
      }

      if (!details || typeof details !== "object") {
        return null;
      }

      const count = toFiniteNumber(details.count) ?? 0;
      const avgRating =
        toFiniteNumber(details.avgRating) ??
        toFiniteNumber(details.averageRating) ??
        (toFiniteNumber(details.totalRating) !== null && count > 0
          ? toFiniteNumber(details.totalRating) / count
          : null);

      if (count <= 0) {
        return null;
      }

      return { label: normalizedLabel, count, avgRating };
    })
    .filter(Boolean);
}

function summarizeTopPreferenceEntries(source, {
  labelKey,
  includeAvgRating = false,
  maxEntries = MAX_FAVORITES_SUMMARY_ENTRIES,
} = {}) {
  const entries = toPreferenceEntries(source, labelKey)
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }

      return a.label.localeCompare(b.label);
    })
    .slice(0, maxEntries);

  if (!entries.length) {
    return "";
  }

  return entries
    .map((entry) => {
      const countLabel = `${entry.count} ${entry.count === 1 ? "title" : "titles"}`;
      if (!includeAvgRating) {
        return `${entry.label} (${countLabel})`;
      }

      const avgRating = formatOneDecimal(entry.avgRating);
      return avgRating
        ? `${entry.label} (avg ${avgRating}, ${countLabel})`
        : `${entry.label} (${countLabel})`;
    })
    .join(", ");
}

function summarizeYearRange(yearRange, fallbackYears = []) {
  const yearValues = fallbackYears
    .map((value) => normalizeFeedbackYear(value))
    .filter((value) => value !== null);

  const minFromYears = yearValues.length ? Math.min(...yearValues) : null;
  const maxFromYears = yearValues.length ? Math.max(...yearValues) : null;

  const minYear =
    isPlainObject(yearRange) && toFiniteNumber(yearRange.min) !== null
      ? Math.trunc(toFiniteNumber(yearRange.min))
      : isPlainObject(yearRange) && toFiniteNumber(yearRange.start) !== null
        ? Math.trunc(toFiniteNumber(yearRange.start))
        : minFromYears;

  const maxYear =
    isPlainObject(yearRange) && toFiniteNumber(yearRange.max) !== null
      ? Math.trunc(toFiniteNumber(yearRange.max))
      : isPlainObject(yearRange) && toFiniteNumber(yearRange.end) !== null
        ? Math.trunc(toFiniteNumber(yearRange.end))
        : maxFromYears;

  const preferredYear =
    isPlainObject(yearRange) && toFiniteNumber(yearRange.preferred) !== null
      ? Math.trunc(toFiniteNumber(yearRange.preferred))
      : null;

  if (!minYear && !maxYear && !preferredYear) {
    return "";
  }

  const rangeLabel =
    minYear && maxYear
      ? minYear === maxYear
        ? String(minYear)
        : `${minYear}-${maxYear}`
      : minYear
        ? `${minYear}+`
        : maxYear
          ? `up to ${maxYear}`
          : "";

  if (rangeLabel && preferredYear) {
    return `${rangeLabel} (peak around ${preferredYear})`;
  }

  return rangeLabel || String(preferredYear);
}

function toRatingsEntries(ratings) {
  if (!ratings) {
    return [];
  }

  if (Array.isArray(ratings)) {
    return ratings
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const rating = toFiniteNumber(entry.rating);
        const count = toFiniteNumber(entry.count);
        if (rating === null || count === null || count <= 0) {
          return null;
        }

        return { rating, count };
      })
      .filter(Boolean);
  }

  if (!isPlainObject(ratings)) {
    return [];
  }

  return Object.entries(ratings)
    .map(([rating, countOrDetails]) => {
      const normalizedRating = toFiniteNumber(rating);
      if (normalizedRating === null) {
        return null;
      }

      const count =
        typeof countOrDetails === "number"
          ? toFiniteNumber(countOrDetails)
          : toFiniteNumber(countOrDetails?.count);

      if (count === null || count <= 0) {
        return null;
      }

      return { rating: normalizedRating, count };
    })
    .filter(Boolean);
}

function summarizeRatingsDistribution(ratings) {
  const entries = toRatingsEntries(ratings);
  if (!entries.length) {
    return "";
  }

  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (!total) {
    return "";
  }

  const weightedAvg =
    entries.reduce((sum, entry) => sum + entry.rating * entry.count, 0) / total;
  const weightedAvgLabel = formatOneDecimal(weightedAvg) || "n/a";
  const distribution = entries
    .sort((a, b) => b.rating - a.rating)
    .slice(0, MAX_FAVORITES_SUMMARY_ENTRIES)
    .map((entry) => `${entry.rating}: ${entry.count}`)
    .join(", ");

  return `avg ${weightedAvgLabel}; distribution ${distribution}`;
}

function extractRawFavoritesItems(favoritesContext) {
  if (Array.isArray(favoritesContext)) {
    return favoritesContext;
  }

  if (!isPlainObject(favoritesContext)) {
    return [];
  }

  const candidates = [
    favoritesContext.recentlyWatched,
    favoritesContext.highlyRated,
    favoritesContext.lowRated,
    favoritesContext.watched,
    favoritesContext.rated,
    favoritesContext.history,
    favoritesContext.items,
  ];

  return candidates.flatMap((value) => (Array.isArray(value) ? value : []));
}

function summarizeRawFavoritesContext(favoritesContext) {
  const items = extractRawFavoritesItems(favoritesContext);
  if (!items.length) {
    return "";
  }

  const genres = new Map();
  const actors = new Map();
  const directors = new Map();
  const years = [];
  const ratings = [];

  items.forEach((item) => {
    const media = item?.movie || item?.show || item;
    if (!media || typeof media !== "object") {
      return;
    }

    toArray(media.genres).forEach((genre) => {
      const normalized = String(genre || "").trim();
      if (!normalized) {
        return;
      }
      genres.set(normalized, (genres.get(normalized) || 0) + 1);
    });

    toArray(media.cast)
      .map((actor) => (actor && typeof actor === "object" ? actor.name : actor))
      .forEach((actorName) => {
        const normalized = String(actorName || "").trim();
        if (!normalized) {
          return;
        }
        actors.set(normalized, (actors.get(normalized) || 0) + 1);
      });

    toArray(media.crew)
      .filter(
        (person) =>
          person &&
          typeof person === "object" &&
          String(person.job || "").toLowerCase() === "director"
      )
      .forEach((person) => {
        const normalized = String(person.name || "").trim();
        if (!normalized) {
          return;
        }
        directors.set(normalized, (directors.get(normalized) || 0) + 1);
      });

    const year = normalizeFeedbackYear(media.year);
    if (year !== null) {
      years.push(year);
    }

    const rating = toFiniteNumber(item?.rating);
    if (rating !== null) {
      ratings.push(rating);
    }
  });

  const ratingsDistribution = ratings.reduce((acc, rating) => {
    const key = String(Math.round(rating));
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const lines = [];
  const genreSummary = summarizeTopPreferenceEntries(genres, {
    labelKey: "genre",
    includeAvgRating: false,
  });
  const actorSummary = summarizeTopPreferenceEntries(actors, {
    labelKey: "actor",
  });
  const directorSummary = summarizeTopPreferenceEntries(directors, {
    labelKey: "director",
  });
  const yearSummary = summarizeYearRange(null, years);
  const ratingSummary = summarizeRatingsDistribution(ratingsDistribution);

  if (genreSummary) {
    lines.push(`Favorite genres: ${genreSummary}`);
  }

  if (actorSummary) {
    lines.push(`Preferred actors: ${actorSummary}`);
  }

  if (directorSummary) {
    lines.push(`Preferred directors: ${directorSummary}`);
  }

  if (yearSummary) {
    lines.push(`Preferred year range: ${yearSummary}`);
  }

  if (ratingSummary) {
    lines.push(`Rating profile: ${ratingSummary}`);
  }

  if (lines.length) {
    return lines.join(" | ");
  }

  try {
    return truncateText(JSON.stringify(items));
  } catch {
    return truncateText(String(favoritesContext));
  }
}

function summarizeFavoritesPreferences(favoritesContext) {
  if (!isPlainObject(favoritesContext)) {
    return "";
  }

  const hasPreferenceShape =
    favoritesContext.genres ||
    favoritesContext.actors ||
    favoritesContext.directors ||
    favoritesContext.yearRange ||
    favoritesContext.ratings;

  if (!hasPreferenceShape) {
    return "";
  }

  const lines = [];
  const genreSummary = summarizeTopPreferenceEntries(favoritesContext.genres, {
    labelKey: "genre",
    includeAvgRating: true,
  });
  const actorSummary = summarizeTopPreferenceEntries(favoritesContext.actors, {
    labelKey: "actor",
  });
  const directorSummary = summarizeTopPreferenceEntries(favoritesContext.directors, {
    labelKey: "director",
  });
  const yearSummary = summarizeYearRange(favoritesContext.yearRange);
  const ratingSummary = summarizeRatingsDistribution(favoritesContext.ratings);

  if (genreSummary) {
    lines.push(`Favorite genres: ${genreSummary}`);
  }

  if (actorSummary) {
    lines.push(`Preferred actors: ${actorSummary}`);
  }

  if (directorSummary) {
    lines.push(`Preferred directors: ${directorSummary}`);
  }

  if (yearSummary) {
    lines.push(`Preferred year range: ${yearSummary}`);
  }

  if (ratingSummary) {
    lines.push(`Rating profile: ${ratingSummary}`);
  }

  return lines.join(" | ");
}

function summarizeFavoritesContext(value) {
  const normalized = parseJsonIfPossible(value);

  if (normalized == null || normalized === "") {
    return "";
  }

  if (typeof normalized === "string") {
    return truncateText(normalized);
  }

  const preferenceSummary = summarizeFavoritesPreferences(normalized);
  if (preferenceSummary) {
    return preferenceSummary;
  }

  const rawSummary = summarizeRawFavoritesContext(normalized);
  if (rawSummary) {
    return rawSummary;
  }

  try {
    return truncateText(JSON.stringify(normalized));
  } catch {
    return truncateText(String(normalized));
  }
}

function formatContextValue(value, { contextType = "generic" } = {}) {
  if (value == null || value === "") {
    return "";
  }

  if (contextType === "favorites") {
    return summarizeFavoritesContext(value);
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
  const query = getQuery(ctx);
  const type = getType(ctx);
  const numResults = getNumResults(ctx);
  const gap = typeof ctx.gap === "number"
    ? ctx.gap
    : Math.max(0, numResults - toArray(ctx.collected).length);
  const remainingGap = typeof ctx.remainingGap === "number"
    ? Math.max(0, Math.trunc(ctx.remainingGap))
    : Math.max(0, Math.trunc(gap));
  const acceptedSoFar = formatRefinementList(
    toArray(ctx.acceptedSoFar).length > 0 ? ctx.acceptedSoFar : ctx.collected
  );
  const proposedTitles = formatTitleList(ctx.proposedTitles);
  const rejectedBuckets =
    ctx.rejectedThisTurn && typeof ctx.rejectedThisTurn === "object"
      ? ctx.rejectedThisTurn
      : {};
  const discoveredGenres = formatTitleList(ctx.discoveredGenres);
  const genreAnalysis = formatContextValue(ctx.genreAnalysis);
  const favoritesContext = formatContextValue(ctx.favoritesContext, {
    contextType: "favorites",
  });
  const rejectionBucketOrder = [
    "watched",
    "rated",
    "history",
    "duplicate",
    "typeMismatch",
    "notFound",
    "lowRating",
  ];

  const lines = [
    "Generate the next recommendation candidates for this query.",
    `Query: ${query}`,
    `Type: ${type}`,
    `Requested count: ${numResults}`,
    `Accepted so far (${acceptedSoFar.count}): ${acceptedSoFar.text}`,
    "Rejected this turn:",
    `Remaining gap: ${remainingGap}`,
    `Already proposed titles: ${proposedTitles || "none"}`,
    acceptedSoFar.count > 0 || proposedTitles
      ? "Do not re-propose any title already listed above."
      : "Do not re-propose any previously accepted or proposed title.",
  ];

  // Add soft guidance for minimum TMDB rating if configured
  if (typeof ctx.minTmdbRating === "number" && !Number.isNaN(ctx.minTmdbRating)) {
    lines.push(`Prefer titles with a TMDB rating of at least ${ctx.minTmdbRating}. Avoid recommending poorly-rated content below this threshold.`);
  }

  let hasRejectedBucket = false;
  rejectionBucketOrder.forEach((bucketName) => {
    const rendered = formatRefinementList(rejectedBuckets[bucketName]);
    if (!rendered.count) {
      return;
    }
    hasRejectedBucket = true;
    lines.push(`- ${bucketName}: ${rendered.text}`);
  });

  if (!hasRejectedBucket) {
    lines.push("- none");
  }

  const duplicateCount = toArray(rejectedBuckets.duplicate).length;
  const watchedCount = toArray(rejectedBuckets.watched).length;
  const proposedCount = toArray(ctx.proposedTitles).length;
  const largeRemainingGap =
    remainingGap >= Math.max(4, Math.ceil((numResults || 0) * 0.4));

  if (duplicateCount > 0) {
    lines.push("Many of your proposals were duplicates. You MUST propose entirely new titles. If using discover_content, change your filters significantly (different genres, years, sort order, or keywords).");
  }

  if (watchedCount > 0) {
    lines.push("Many proposals were already watched by the user. Try less mainstream or more niche content. Consider using different discover filters or trending_content for fresh options.");
  }

  if (largeRemainingGap && proposedCount >= Math.max(numResults || 0, 8)) {
    lines.push("Gap is still large after multiple rounds. Consider using trending_content or discover_content with completely different parameters to find fresh candidates.");
  }

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
    "Tools available: get_user_favorites, discover_content, trending_content. Use get_user_favorites when you need to check the user's favorites.",
    "Use discover_content for filter-driven queries and trending_content for what is popular/trending/highly rated; each discover_content call should use a meaningfully different filter combination.",
    "The orchestrator resolves TMDB identity from title+year+type; do not emit tmdb_id or call TMDB yourself.",
    ...buildAgentOutputContract(remainingGap),
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
