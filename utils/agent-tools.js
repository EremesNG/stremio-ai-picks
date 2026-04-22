const logger = require("./logger");
const { normalizeMediaKey } = require("./trakt");
const { withRetry } = require("./apiRetry");

const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";

const toolDeclarations = [
  {
    name: "get_user_favorites",
    description:
      "Fetch the user's Trakt favorites (curated list of strongest preferences). Returns normalized items with tmdb/imdb/trakt ids, title, year, type, and rank.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: {
          type: "STRING",
          enum: ["movie", "series", "both"],
          default: "both",
        },
      },
    },
  },
  {
    name: "discover_content",
    description:
      "Discover TMDB movies or TV series using filters (genres, year, ratings, keywords, language, cast, providers). Use when you need targeted discovery beyond generic trending lists.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: {
          type: "STRING",
          enum: ["movie", "tv"],
          description: "Media type to discover.",
        },
        sort_by: {
          type: "STRING",
          description:
            "TMDB sort order, e.g. popularity.desc, vote_average.desc, primary_release_date.desc.",
        },
        with_genres: {
          type: "STRING",
          description: "Comma-separated genre IDs.",
        },
        primary_release_year: {
          type: "INTEGER",
          description:
            "Release year for movies; mapped to first_air_date_year for TV.",
        },
        vote_average_gte: {
          type: "NUMBER",
          description: "Minimum vote average (0-10).",
        },
        vote_average_lte: {
          type: "NUMBER",
          description: "Maximum vote average (0-10).",
        },
        vote_count_gte: {
          type: "INTEGER",
          description: "Minimum vote count.",
        },
        with_keywords: {
          type: "STRING",
          description: "Comma-separated keyword IDs.",
        },
        with_original_language: {
          type: "STRING",
          description: "ISO 639-1 language code.",
        },
        with_cast: {
          type: "STRING",
          description: "Comma-separated person IDs.",
        },
        with_watch_providers: {
          type: "STRING",
          description: "Comma-separated watch provider IDs.",
        },
        watch_region: {
          type: "STRING",
          description:
            "ISO 3166-1 country code. Required when with_watch_providers is used.",
        },
        page: {
          type: "INTEGER",
          description: "Results page number (1-5).",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "trending_content",
    description:
      "Fetch curated TMDB lists for movies or TV series (trending day/week, popular, top rated). Use for current momentum/popularity snapshots.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: {
          type: "STRING",
          enum: ["movie", "tv"],
          description: "Media type for the list.",
        },
        list: {
          type: "STRING",
          enum: ["trending_day", "trending_week", "popular", "top_rated"],
          description: "Curated list source to fetch.",
        },
        page: {
          type: "INTEGER",
          description: "Results page number (1-5).",
        },
      },
      required: ["type", "list"],
    },
  },
];

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeMediaType(value) {
  const type = String(value || "").trim().toLowerCase();

  if (type === "movie") {
    return "movie";
  }

  if (type === "series" || type === "show" || type === "tv") {
    return "series";
  }

  return "";
}

function normalizeOptionalYear(value) {
  const year = Number(value);
  return Number.isInteger(year) ? year : undefined;
}

function normalizeId(value) {
  const id = Number(value);
  return Number.isInteger(id) ? id : undefined;
}

function normalizeString(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function toInt(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sanitizePage(value) {
  const parsed = toInt(value);
  return clamp(parsed || 1, 1, 5);
}

function sanitizeDiscoverArgs(args) {
  const source = isObject(args) ? args : {};
  const type = normalizeString(source.type)?.toLowerCase();
  if (type !== "movie" && type !== "tv") {
    throw new Error("discover_content requires type to be 'movie' or 'tv'");
  }

  const page = sanitizePage(source.page);
  const sortBy = normalizeString(source.sort_by);
  const withGenres = normalizeString(source.with_genres);
  const primaryReleaseYear = toInt(source.primary_release_year);
  const voteAverageGte = toNumber(source.vote_average_gte);
  const voteAverageLte = toNumber(source.vote_average_lte);
  const voteCountGte = toInt(source.vote_count_gte);
  const withKeywords = normalizeString(source.with_keywords);
  const withOriginalLanguage = normalizeString(source.with_original_language);
  const withCast = normalizeString(source.with_cast);
  const withWatchProviders = normalizeString(source.with_watch_providers);
  const watchRegion = normalizeString(source.watch_region);

  if (withWatchProviders && !watchRegion) {
    throw new Error(
      "discover_content requires watch_region when with_watch_providers is provided"
    );
  }

  const sanitized = {
    type,
    page,
  };

  if (sortBy) sanitized.sort_by = sortBy;
  if (withGenres) sanitized.with_genres = withGenres;
  if (primaryReleaseYear) sanitized.primary_release_year = primaryReleaseYear;
  if (voteAverageGte != null) sanitized.vote_average_gte = clamp(voteAverageGte, 0, 10);
  if (voteAverageLte != null) sanitized.vote_average_lte = clamp(voteAverageLte, 0, 10);
  if (voteCountGte != null && voteCountGte >= 0) sanitized.vote_count_gte = voteCountGte;
  if (withKeywords) sanitized.with_keywords = withKeywords;
  if (withOriginalLanguage) sanitized.with_original_language = withOriginalLanguage;
  if (withCast) sanitized.with_cast = withCast;
  if (withWatchProviders) sanitized.with_watch_providers = withWatchProviders;
  if (watchRegion) sanitized.watch_region = watchRegion;

  return sanitized;
}

function sanitizeTrendingArgs(args) {
  const source = isObject(args) ? args : {};
  const type = normalizeString(source.type)?.toLowerCase();
  if (type !== "movie" && type !== "tv") {
    throw new Error("trending_content requires type to be 'movie' or 'tv'");
  }

  const list = normalizeString(source.list)?.toLowerCase();
  const allowedLists = new Set([
    "trending_day",
    "trending_week",
    "popular",
    "top_rated",
  ]);
  if (!allowedLists.has(list)) {
    throw new Error(
      "trending_content requires list to be one of: trending_day, trending_week, popular, top_rated"
    );
  }

  return {
    type,
    list,
    page: sanitizePage(source.page),
  };
}

function buildDiscoverFilterSummary(sanitized = {}) {
  const filters = {};
  const keys = [
    "sort_by",
    "with_genres",
    "primary_release_year",
    "vote_average_gte",
    "vote_average_lte",
    "vote_count_gte",
    "with_keywords",
    "with_original_language",
    "with_cast",
    "with_watch_providers",
    "watch_region",
  ];

  for (const key of keys) {
    if (sanitized[key] != null) {
      filters[key] = sanitized[key];
    }
  }

  return filters;
}

function buildTrendingTelemetryEndpoint({ type, list }) {
  if (list === "trending_day") {
    return `trending_${type}_day`;
  }

  if (list === "trending_week") {
    return `trending_${type}_week`;
  }

  if (list === "popular") {
    return `${type}_popular`;
  }

  if (list === "top_rated") {
    return `${type}_top_rated`;
  }

  return `${type}_${list}`;
}

function pickYear(item) {
  return (
    normalizeOptionalYear(item?.year) ||
    normalizeOptionalYear(item?.release_year) ||
    normalizeOptionalYear(String(item?.release_date || "").slice(0, 4)) ||
    normalizeOptionalYear(String(item?.first_air_date || "").slice(0, 4))
  );
}

function normalizeSearchResult(item, fallbackType) {
  if (!isObject(item)) {
    return null;
  }

  const title = normalizeString(item.title || item.name);
  if (!title) {
    return null;
  }

  return {
    tmdb_id: normalizeId(item.tmdb_id ?? item.tmdbId ?? item.id),
    imdb_id: normalizeString(item.imdb_id ?? item.imdbId),
    title,
    year: pickYear(item),
    overview: normalizeString(item.overview),
    popularity:
      typeof item.popularity === "number"
        ? item.popularity
        : Number.isFinite(Number(item.popularity))
          ? Number(item.popularity)
          : undefined,
    tmdbRating:
      typeof (item.tmdbRating ?? item.vote_average) === "number"
        ? item.tmdbRating ?? item.vote_average
        : Number.isFinite(Number(item.tmdbRating ?? item.vote_average))
          ? Number(item.tmdbRating ?? item.vote_average)
          : undefined,
    type: normalizeMediaType(item.type || fallbackType) || undefined,
  };
}

function normalizeDiscoveryResult(item, mediaType) {
  if (!isObject(item)) {
    return null;
  }

  const rawType = normalizeString(mediaType || item.media_type)?.toLowerCase();
  const normalizedType =
    rawType === "movie"
      ? "movie"
      : rawType === "tv" || rawType === "series" || rawType === "show"
        ? "series"
        : "";

  const type = normalizedType || (item.title ? "movie" : item.name ? "series" : "");
  if (!type) {
    return null;
  }

  const tmdbId = normalizeId(item.id ?? item.tmdb_id ?? item.tmdbId);
  const title = normalizeString(type === "movie" ? item.title : item.name) ||
    normalizeString(item.title || item.name);

  if (!tmdbId || !title) {
    return null;
  }

  const year = pickYear(item) ?? null;
  const voteAverage = toNumber(item.vote_average) ?? 0;
  const voteCount = toInt(item.vote_count) ?? 0;
  const popularity = toNumber(item.popularity) ?? 0;
  const genreIds = Array.isArray(item.genre_ids)
    ? item.genre_ids.map((value) => toInt(value)).filter(Number.isInteger)
    : [];

  return {
    type,
    title,
    year,
    tmdb_id: tmdbId,
    overview: normalizeString(item.overview) || "",
    vote_average: voteAverage,
    vote_count: voteCount,
    popularity,
    genre_ids: genreIds,
  };
}

function normalizeFavoriteItem(item) {
  if (!isObject(item)) {
    return null;
  }

  const title = normalizeString(item.title || item.name);
  if (!title) {
    return null;
  }

  return {
    tmdb_id: normalizeId(item.tmdbId ?? item.tmdb_id ?? item.tmdbID),
    imdb_id: normalizeString(item.imdbId ?? item.imdb_id ?? item.imdbID),
    trakt_id: normalizeId(item.traktId ?? item.trakt_id ?? item.traktID),
    title,
    year: pickYear(item),
    type: normalizeMediaType(item.type),
    rank: normalizeId(item.rank),
  };
}

function makeItemKey(item) {
  const tmdbId = item?.tmdb_id != null ? `tmdb:${item.tmdb_id}` : "";
  const imdbId = item?.imdb_id ? `imdb:${item.imdb_id}` : "";
  const title = normalizeString(item?.title)?.toLowerCase() || "";
  const year = item?.year || "";
  const type = item?.type || "";
  return tmdbId || imdbId || `${type}:${title}:${year}`;
}

function dedupeItems(items) {
  const map = new Map();

  items.forEach((item) => {
    if (!item) {
      return;
    }

    const key = makeItemKey(item);
    if (!key) {
      return;
    }

    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...item });
      return;
    }

    const merged = { ...existing, ...item };
    if (existing.status || item.status) {
      merged.status = Array.from(
        new Set([].concat(existing.status || [], item.status || []))
      );
    }

    if (
      existing.rank != null &&
      item.rank != null &&
      Number(item.rank) < Number(existing.rank)
    ) {
      merged.rank = item.rank;
    }

    map.set(key, merged);
  });

  return [...map.values()];
}

function normalizeToolCall(call) {
  const source = isObject(call?.functionCall) ? call.functionCall : call;
  const name = normalizeString(source?.name);
  if (!name) {
    return null;
  }

  let args = source?.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (error) {
      args = {};
    }
  }

  return {
    id: normalizeString(call?.id ?? call?.functionCallId ?? source?.id),
    name,
    args: isObject(args) ? args : {},
  };
}

function toFunctionResponse(result) {
  return {
    ...result,
    parts: [
      {
        functionResponse: {
          name: result.name,
          response: result.response,
        },
      },
    ],
  };
}

function getLogger(deps = {}) {
  return deps.logger || logger || console;
}

async function callSearchTMDB(searchTMDB, args) {
  if (typeof searchTMDB !== "function") {
    throw new Error("searchTMDB dependency is required");
  }

  if (searchTMDB.length <= 1) {
    return searchTMDB({
      query: args.query,
      type: args.type,
      year: args.year,
    });
  }

  return searchTMDB(args.query, args.type, args.year);
}

function collectArrayLike(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value?.items)) {
    return value.items;
  }

  if (Array.isArray(value?.results)) {
    return value.results;
  }

  if (isObject(value)) {
    return [value];
  }

  return [];
}

async function handleBatchSearchTmdb(args, deps) {
  const queries = Array.isArray(args.queries) ? args.queries.slice(0, 20) : [];

  const settled = await Promise.allSettled(
    queries.map(async (queryArgs) => {
      const type = normalizeMediaType(queryArgs?.type);
      const query = normalizeString(queryArgs?.query);
      const year = normalizeOptionalYear(queryArgs?.year);

      const results = await callSearchTMDB(deps.searchTMDB, {
        query,
        type,
        year,
      });

      const matches = dedupeItems(
        collectArrayLike(results)
          .map((item) => normalizeSearchResult(item, type))
          .filter(Boolean)
      ).map(({ type: _type, ...item }) => item);

      return {
        query,
        type,
        matches,
      };
    })
  );

  return {
    results: settled.map((entry, index) => {
      const source = queries[index] || {};
      const query = normalizeString(source.query);
      const type = normalizeMediaType(source.type);

      if (entry.status === "fulfilled") {
        return entry.value;
      }

      return {
        query,
        type,
        matches: [],
        error: entry.reason?.message || "tool execution failed",
      };
    }),
  };
}

async function handleGetUserFavorites(args, deps) {
  const fetcher = deps.traktFavoritesFetcher;
  if (typeof fetcher !== "function") {
    throw new Error("traktFavoritesFetcher dependency is required");
  }

  const type = normalizeMediaType(args.type) || "";
  const payload = await fetcher({ ...deps, type: type || "both" });
  const items = collectArrayLike(payload)
    .map((item) => normalizeFavoriteItem(item))
    .filter(Boolean)
    .filter((item) => !type || item.type === type)
    .sort((left, right) => {
      const leftRank = left.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.rank ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });

  return {
    items: dedupeItems(items),
  };
}

function buildTmdbToolQuery({ language, includeAdult, page }) {
  const query = new URLSearchParams();

  query.set("language", normalizeString(language) || "en-US");
  query.set("page", String(sanitizePage(page)));

  if (typeof includeAdult === "boolean") {
    query.set("include_adult", includeAdult ? "true" : "false");
  }

  return query;
}

function buildTmdbToolError(prefix, status, message) {
  const statusPart = status ? ` (${status})` : "";
  return `${prefix}${statusPart}: ${message || "request failed"}`;
}

async function executeTmdbToolRequest({
  endpoint,
  query,
  tmdbApiKey,
  operationName,
  log,
}) {
  if (!tmdbApiKey) {
    throw new Error("TMDB API key is required");
  }

  query.set("api_key", tmdbApiKey);
  const url = `${TMDB_API_BASE_URL}${endpoint}?${query.toString()}`;

  return withRetry(
    async () => {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(
          buildTmdbToolError(
            "TMDB request failed",
            response.status,
            errorData?.status_message
          )
        );
        error.status = response.status;
        error.isRateLimit = response.status === 429;
        error.isInvalidKey = response.status === 401;
        throw error;
      }

      return response.json();
    },
    {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 8000,
      operationName,
      shouldRetry: (error) =>
        !error?.isInvalidKey &&
        (!error?.status || error.status >= 500 || error.isRateLimit),
    }
  );
}

async function executeDiscoverContent(args, deps = {}) {
  const log = getLogger(deps);

  try {
    const sanitized = sanitizeDiscoverArgs(args);
    const mediaType = sanitized.type;
    const endpoint = mediaType === "movie" ? "/discover/movie" : "/discover/tv";
    const query = buildTmdbToolQuery({
      language: deps.language,
      includeAdult: !!deps.includeAdult,
      page: sanitized.page,
    });

    if (sanitized.sort_by) query.set("sort_by", sanitized.sort_by);
    if (sanitized.with_genres) query.set("with_genres", sanitized.with_genres);
    if (sanitized.primary_release_year != null) {
      query.set(
        mediaType === "movie" ? "primary_release_year" : "first_air_date_year",
        String(sanitized.primary_release_year)
      );
    }
    if (sanitized.vote_average_gte != null) {
      query.set("vote_average.gte", String(sanitized.vote_average_gte));
    }
    if (sanitized.vote_average_lte != null) {
      query.set("vote_average.lte", String(sanitized.vote_average_lte));
    }
    if (sanitized.vote_count_gte != null) {
      query.set("vote_count.gte", String(sanitized.vote_count_gte));
    }
    if (sanitized.with_keywords) query.set("with_keywords", sanitized.with_keywords);
    if (sanitized.with_original_language) {
      query.set("with_original_language", sanitized.with_original_language);
    }
    if (sanitized.with_cast) query.set("with_cast", sanitized.with_cast);
    if (sanitized.with_watch_providers) {
      query.set("with_watch_providers", sanitized.with_watch_providers);
    }
    if (sanitized.watch_region) query.set("watch_region", sanitized.watch_region);

    log?.info?.("Executing discover_content", {
      endpoint,
      type: mediaType,
      page: sanitized.page,
    });

    const telemetryEndpoint = mediaType === "movie" ? "discover_movie" : "discover_tv";
    const telemetryFilters = buildDiscoverFilterSummary(sanitized);
    let payload;
    let requestError = null;
    const requestStartedAt = Date.now();

    try {
      payload = await executeTmdbToolRequest({
        endpoint,
        query,
        tmdbApiKey: deps.tmdbApiKey,
        operationName: "TMDB discover_content API call",
        log,
      });
    } catch (error) {
      requestError = error;
      throw error;
    } finally {
      if (deps.logger) {
        deps.logger.info(
          JSON.stringify({
            event: "DISCOVERY_TOOL_CALL",
            tool: "discover_content",
            endpoint: telemetryEndpoint,
            page: sanitized.page,
            filters: telemetryFilters,
            resultCount: collectArrayLike(payload).length,
            error: requestError?.message || null,
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }
    }

    const results = collectArrayLike(payload)
      .map((item) => normalizeDiscoveryResult(item, mediaType))
      .filter(Boolean);

    return {
      results,
      page: toInt(payload?.page) ?? sanitized.page,
      total_pages: toInt(payload?.total_pages) ?? 0,
      total_results: toInt(payload?.total_results) ?? results.length,
    };
  } catch (error) {
    const message = error?.message || "discover_content failed";
    log?.warn?.("discover_content failed", { error: message });
    return { error: message, results: [] };
  }
}

async function executeTrendingContent(args, deps = {}) {
  const log = getLogger(deps);

  try {
    const sanitized = sanitizeTrendingArgs(args);
    const mediaType = sanitized.type;

    const endpointMap = {
      trending_day: `/trending/${mediaType}/day`,
      trending_week: `/trending/${mediaType}/week`,
      popular: `/${mediaType}/popular`,
      top_rated: `/${mediaType}/top_rated`,
    };
    const endpoint = endpointMap[sanitized.list];

    const includeAdultAllowed =
      sanitized.list === "popular" || sanitized.list === "top_rated";

    const query = buildTmdbToolQuery({
      language: deps.language,
      includeAdult: includeAdultAllowed ? !!deps.includeAdult : undefined,
      page: sanitized.page,
    });

    log?.info?.("Executing trending_content", {
      endpoint,
      type: mediaType,
      list: sanitized.list,
      page: sanitized.page,
    });

    const telemetryEndpoint = buildTrendingTelemetryEndpoint({
      type: mediaType,
      list: sanitized.list,
    });
    let payload;
    let requestError = null;
    const requestStartedAt = Date.now();

    try {
      payload = await executeTmdbToolRequest({
        endpoint,
        query,
        tmdbApiKey: deps.tmdbApiKey,
        operationName: "TMDB trending_content API call",
        log,
      });
    } catch (error) {
      requestError = error;
      throw error;
    } finally {
      if (deps.logger) {
        deps.logger.info(
          JSON.stringify({
            event: "DISCOVERY_TOOL_CALL",
            tool: "trending_content",
            endpoint: telemetryEndpoint,
            page: sanitized.page,
            resultCount: collectArrayLike(payload).length,
            error: requestError?.message || null,
            durationMs: Date.now() - requestStartedAt,
          })
        );
      }
    }

    const results = collectArrayLike(payload)
      .map((item) => normalizeDiscoveryResult(item, mediaType))
      .filter(Boolean);

    return {
      results,
      page: toInt(payload?.page) ?? sanitized.page,
      total_pages: toInt(payload?.total_pages) ?? 0,
      total_results: toInt(payload?.total_results) ?? results.length,
    };
  } catch (error) {
    const message = error?.message || "trending_content failed";
    log?.warn?.("trending_content failed", { error: message });
    return { error: message, results: [] };
  }
}

const handlers = {
  get_user_favorites: handleGetUserFavorites,
  discover_content: executeDiscoverContent,
  trending_content: executeTrendingContent,
};

async function executeTools(toolCalls, deps = {}) {
  const calls = Array.isArray(toolCalls) ? toolCalls : toolCalls ? [toolCalls] : [];
  const results = [];
  const log = getLogger(deps);

  for (const rawCall of calls) {
    const call = normalizeToolCall(rawCall);
    if (!call) {
      continue;
    }

    const handler = handlers[call.name];
    if (!handler) {
      const response = { error: `Unknown tool: ${call.name}` };
      results.push(toFunctionResponse({ id: call.id, name: call.name, response }));
      continue;
    }

    try {
      logger.agent("TOOL_EXEC_START", {
        toolName: call.name,
        args: call.args,
      });

      const startedAt = Date.now();
      const response = await handler(call.args, deps);
      const durationMs = Date.now() - startedAt;

      logger.agent("TOOL_EXEC_RESULT", {
        toolName: call.name,
        resultCount: Array.isArray(response?.results)
          ? response.results.length
          : Array.isArray(response?.items)
            ? response.items.length
            : 0,
        durationMs,
      });

      results.push(toFunctionResponse({ id: call.id, name: call.name, response }));
    } catch (error) {
      logger.agent("TOOL_EXEC_ERROR", {
        toolName: call.name,
        error: error.message,
        args: call.args,
      });

      log?.warn?.("Agent tool failed", {
        tool: call.name,
        error: error.message,
      });
      results.push(
        toFunctionResponse({
          id: call.id,
          name: call.name,
          response: { error: error.message || "tool execution failed" },
        })
      );
    }
  }

  return results;
}

module.exports = {
  toolDeclarations,
  executeTools,
  handleBatchSearchTmdb,
  sanitizeDiscoverArgs,
  sanitizeTrendingArgs,
  normalizeDiscoveryResult,
};
