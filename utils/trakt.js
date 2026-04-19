const { withRetry } = require("./apiRetry");
const defaultLogger = require("./logger");

const TRAKT_API_BASE = "https://api.trakt.tv";
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const PAGINATION_LIMIT = 1000;
const PAGINATION_MAX_PAGES = 20;
const PAGINATION_CONCURRENCY = 4;

function getLogger(deps = {}) {
  return deps.logger || defaultLogger || console;
}

function getUserId(deps = {}) {
  return deps.traktUsername || "me";
}

function buildTraktHeaders(deps = {}) {
  const headers = {
    "User-Agent": "stremio-ai-search",
    "trakt-api-version": "2",
    "trakt-api-key": deps.traktClientId,
    "Content-Type": "application/json",
  };

  if (deps.traktAccessToken) {
    headers.Authorization = `Bearer ${deps.traktAccessToken}`;
  }

  return headers;
}

function buildCacheEntry(data) {
  return {
    timestamp: Date.now(),
    data,
  };
}

function readCache(cache, key, ttlMs = DEFAULT_CACHE_TTL_MS) {
  if (!cache || typeof cache.get !== "function") {
    return null;
  }

  const cached = cache.get(key);
  if (!cached) {
    return null;
  }

  if (Array.isArray(cached)) {
    return cached;
  }

  if (typeof cached === "object" && cached.timestamp) {
    if (Date.now() - cached.timestamp > ttlMs) {
      return null;
    }

    return cached.data;
  }

  return cached;
}

function writeCache(cache, key, data) {
  if (!cache || typeof cache.set !== "function") {
    return;
  }

  cache.set(key, buildCacheEntry(data));
}

async function fetchResponse(url, headers, logger, operationName) {
  return withRetry(
    async () => {
      const response = await fetch(url, { headers });

      if (!response.ok) {
        const error = new Error(`Trakt request failed with status ${response.status}`);
        error.status = response.status;
        error.body = await response.text().catch(() => "");
        throw error;
      }

      return response;
    },
    {
      maxRetries: 3,
      initialDelay: 1000,
      maxDelay: 10000,
      shouldRetry: (error) => !error.status || error.status === 429 || error.status >= 500,
      operationName,
    }
  );
}

async function fetchJson(url, headers, logger, operationName) {
  const response = await fetchResponse(url, headers, logger, operationName);
  return response.json();
}

function buildTraktUrl(pathname, params = {}) {
  const url = new URL(`${TRAKT_API_BASE}${pathname}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

function normalizeTraktType(type) {
  if (type === "movie") {
    return "movies";
  }

  if (type === "show") {
    return "shows";
  }

  return type || "movies";
}

function extractMedia(item) {
  return item?.movie || item?.show || null;
}

function normalizeMediaType(type) {
  const normalizedType = String(type || "").toLowerCase();

  if (normalizedType === "movie") {
    return "movie";
  }

  if (normalizedType === "show" || normalizedType === "series") {
    return "series";
  }

  return null;
}

function toIntegerOrNull(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMediaKey(item) {
  const media = extractMedia(item) || item || {};
  const rawType = media.type || item?.type || (item?.movie ? "movie" : item?.show ? "show" : null);
  const title = media.title || media.name || item?.title || item?.name || null;
  const year = toIntegerOrNull(media.year ?? item?.year);
  const tmdbId =
    media.ids?.tmdb ?? item?.ids?.tmdb ?? media.tmdb_id ?? media.tmdbId ?? item?.tmdb_id ?? item?.tmdbId ?? null;
  const imdbId =
    media.ids?.imdb ?? item?.ids?.imdb ?? media.imdb_id ?? media.imdbId ?? item?.imdb_id ?? item?.imdbId ?? null;

  return {
    type: normalizeMediaType(rawType),
    tmdb_id: toIntegerOrNull(tmdbId),
    imdb_id: imdbId === undefined || imdbId === null || imdbId === "" ? null : String(imdbId),
    title: title === undefined || title === null || title === "" ? null : String(title),
    year,
  };
}

function normalizeTraktMedia(item) {
  const media = extractMedia(item);
  if (!media) {
    return null;
  }

  const ids = media.ids || {};

  return {
    type: item.movie ? "movie" : "show",
    tmdbId: ids.tmdb ?? null,
    imdbId: ids.imdb ?? null,
    traktId: ids.trakt ?? null,
    title: media.title || media.name || null,
    year: media.year ?? null,
    rank: item.rank ?? null,
    listed_at: item.listed_at ?? item.listedAt ?? null,
  };
}

function getPageCount(response) {
  const pageCountHeader = response?.headers?.get("X-Pagination-Page-Count");
  const pageCount = Number.parseInt(pageCountHeader, 10);
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1;
}

async function fetchTraktCollectionPage(url, deps, operationName) {
  const response = await fetchResponse(url, buildTraktHeaders(deps), getLogger(deps), operationName);
  const data = await response.json().catch(() => []);
  return { response, data: Array.isArray(data) ? data : [] };
}

async function fetchTraktCollection(pathname, deps, operationName) {
  const userId = getUserId(deps);
  const baseUrl = buildTraktUrl(pathname.replace("{userId}", encodeURIComponent(userId)), {
    extended: "full",
  });
  const logger = getLogger(deps);

  const firstPageUrl = new URL(baseUrl);
  firstPageUrl.searchParams.set("page", "1");
  firstPageUrl.searchParams.set("limit", String(PAGINATION_LIMIT));

  const firstPageResult = await fetchTraktCollectionPage(firstPageUrl.toString(), deps, operationName);
  const totalPages = getPageCount(firstPageResult.response);
  const pageCount = Math.min(totalPages, PAGINATION_MAX_PAGES);

  if (totalPages > PAGINATION_MAX_PAGES) {
    logger.warn("Trakt pagination cap reached", {
      operation: operationName,
      pathname,
      pageCount: totalPages,
      cappedAt: PAGINATION_MAX_PAGES,
    });
  }

  if (pageCount <= 1) {
    return firstPageResult.data;
  }

  const pages = [];
  for (let page = 2; page <= pageCount; page += 1) {
    pages.push(page);
  }

  const additionalPages = [];
  for (let index = 0; index < pages.length; index += PAGINATION_CONCURRENCY) {
    const batch = pages.slice(index, index + PAGINATION_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((page) => {
        const pageUrl = new URL(baseUrl);
        pageUrl.searchParams.set("page", String(page));
        pageUrl.searchParams.set("limit", String(PAGINATION_LIMIT));
        return fetchTraktCollectionPage(pageUrl.toString(), deps, operationName);
      })
    );

    additionalPages.push(...batchResults.map((result) => result.data));
  }

  return [firstPageResult.data, ...additionalPages].flat();
}

async function fetchTraktWatchedAndRatedImpl(deps = {}) {
  const logger = getLogger(deps);
  const userId = getUserId(deps);
  const traktClientId = deps.traktClientId;
  const type = normalizeTraktType(deps.type);
  const cacheKey = `trakt:watched-rated:${userId}:${type}`;
  const cached = readCache(deps.traktCache, cacheKey, deps.traktCacheTtlMs || DEFAULT_CACHE_TTL_MS);

  if (cached) {
    return cached;
  }

  if (!traktClientId) {
    logger.warn("Missing Trakt client ID for watched/rated fetch", { userId });
    return { watched: [], rated: [], history: [] };
  }

  try {
    const [watched, rated, history] = await Promise.all([
      fetchTraktCollection(`/users/{userId}/watched/${type}`, deps, "Trakt watched fetch"),
      fetchTraktCollection(`/users/{userId}/ratings/${type}`, deps, "Trakt rated fetch"),
      fetchTraktCollection(`/users/{userId}/history/${type}`, deps, "Trakt history fetch"),
    ]);

    const result = {
      watched: Array.isArray(watched) ? watched : [],
      rated: Array.isArray(rated) ? rated : [],
      history: Array.isArray(history) ? history : [],
    };

    writeCache(deps.traktCache, cacheKey, result);

    return result;
  } catch (error) {
    logger.error("Failed to fetch Trakt watched/rated/history", {
      error: error.message,
      status: error.status,
      userId,
    });

    return { watched: [], rated: [], history: [] };
  }
}

function isItemWatchedOrRatedImpl(deps = {}, item) {
  if (!item) {
    return false;
  }

  const normalizedItem = normalizeMediaKey(item);
  const normalizedName = String(normalizedItem.title || "").toLowerCase().trim();
  const itemYear = normalizedItem.year;
  const itemType = normalizedItem.type;
  const watchHistory = deps.watchHistory || [];
  const ratedItems = deps.ratedItems || [];

  const matches = (collection) =>
    Array.isArray(collection) &&
    collection.some((entry) => {
      const media = normalizeMediaKey(entry);
      if (!media.title) {
        return false;
      }

      if (itemType && media.type && itemType !== media.type) {
        return false;
      }

      const historyName = String(media.title).toLowerCase().trim();
      const historyYear = media.year;

      return normalizedName === historyName && (!itemYear || !historyYear || itemYear === historyYear);
    });

  return matches(watchHistory) || matches(ratedItems);
}

async function fetchTraktWatchedAndRated(deps = {}) {
  if (typeof deps.fetchTraktWatchedAndRated === "function" && deps.fetchTraktWatchedAndRated !== fetchTraktWatchedAndRated) {
    return deps.fetchTraktWatchedAndRated(deps);
  }

  return fetchTraktWatchedAndRatedImpl(deps);
}

function isItemWatchedOrRated(deps = {}, item) {
  if (typeof deps.isItemWatchedOrRated === "function" && deps.isItemWatchedOrRated !== isItemWatchedOrRated) {
    return deps.isItemWatchedOrRated(deps, item);
  }

  return isItemWatchedOrRatedImpl(deps, item);
}

async function fetchTraktFavorites(deps = {}) {
  const logger = getLogger(deps);
  const userId = getUserId(deps);
  const traktClientId = deps.traktClientId;
  const cacheKey = `trakt:favorites:${userId}`;
  const cached = readCache(deps.favoritesCache, cacheKey, deps.favoritesCacheTtlMs || DEFAULT_CACHE_TTL_MS);

  if (cached) {
    return cached;
  }

  if (!traktClientId) {
    logger.warn("Missing Trakt client ID for favorites fetch", { userId });
    return [];
  }

  try {
    const favorites = await fetchTraktCollection(
      `/users/{userId}/favorites/media`,
      {
        ...deps,
        traktUsername: userId,
      },
      "Trakt favorites fetch"
    );

    const normalized = (Array.isArray(favorites) ? favorites : [])
      .map(normalizeTraktMedia)
      .filter(Boolean);

    writeCache(deps.favoritesCache, cacheKey, normalized);

    return normalized;
  } catch (error) {
    logger.error("Failed to fetch Trakt favorites", {
      error: error.message,
      status: error.status,
      userId,
    });

    return [];
  }
}

module.exports = {
  fetchTraktWatchedAndRated,
  isItemWatchedOrRated,
  fetchTraktFavorites,
  normalizeMediaKey,
};
