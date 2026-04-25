const { withRetry } = require("./apiRetry");
const defaultLogger = require("./logger");

const TRAKT_API_BASE = "https://api.trakt.tv";
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
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
    "User-Agent": "stremio-ai-picks",
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

function normalizeCheckerType(type) {
  const normalizedType = String(type || "").toLowerCase();

  if (normalizedType === "movie" || normalizedType === "movies") {
    return "movie";
  }

  if (
    normalizedType === "show" ||
    normalizedType === "shows" ||
    normalizedType === "series"
  ) {
    return "show";
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

function normalizeLookupItem(item = {}) {
  const normalizedItem = normalizeMediaKey(item);
  const normalizedType = normalizeCheckerType(normalizedItem.type || item?.type);

  return {
    type: normalizedType,
    tmdb_id: toIntegerOrNull(normalizedItem.tmdb_id),
    imdb_id:
      normalizedItem.imdb_id === undefined || normalizedItem.imdb_id === null || normalizedItem.imdb_id === ""
        ? null
        : String(normalizedItem.imdb_id).toLowerCase().trim(),
    title:
      normalizedItem.title === undefined || normalizedItem.title === null || normalizedItem.title === ""
        ? null
        : String(normalizedItem.title).toLowerCase().trim(),
    year: toIntegerOrNull(normalizedItem.year),
  };
}

function buildStatusCacheKey(type, tmdbId, imdbId, title, year) {
  const normalizedType = normalizeCheckerType(type) || "unknown";
  const normalizedTmdb = toIntegerOrNull(tmdbId);
  const normalizedImdb =
    imdbId === undefined || imdbId === null || imdbId === ""
      ? ""
      : String(imdbId).toLowerCase().trim();
  const normalizedTitle =
    title === undefined || title === null || title === ""
      ? ""
      : String(title).toLowerCase().trim();
  const normalizedYear = toIntegerOrNull(year);

  if (normalizedTmdb !== null && normalizedTmdb > 0) {
    return `${normalizedType}:tmdb:${normalizedTmdb}`;
  }

  if (normalizedImdb) {
    return `${normalizedType}:imdb:${normalizedImdb}`;
  }

  if (normalizedTitle) {
    return `${normalizedType}:title:${normalizedTitle}:${normalizedYear ?? ""}`;
  }

  return `${normalizedType}:unknown`;
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
  // Extract type from pathname (e.g., /users/{userId}/watched/shows -> shows)
  const typeMatch = pathname.match(/\/(watched|ratings|history)\/(\w+)/);
  const type = typeMatch ? typeMatch[2] : null;
  // Use noseasons for shows to avoid massive season/episode payloads
  const extendedParam = type === 'shows' ? 'noseasons' : 'full';
  const baseUrl = buildTraktUrl(pathname.replace("{userId}", encodeURIComponent(userId)), {
    extended: extendedParam,
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



async function fetchTraktIdFromTmdb(deps = {}, normalizedType, tmdbId) {
  const logger = getLogger(deps);
  const traktClientId = deps.traktClientId;
  const normalizedTmdbId = toIntegerOrNull(tmdbId);

  if (!traktClientId || !normalizedType || normalizedTmdbId === null || normalizedTmdbId <= 0) {
    return null;
  }

  const url = buildTraktUrl(`/search/tmdb/${normalizedTmdbId}`, {
    type: normalizedType,
  });

  try {
    const responseData = await fetchJson(
      url,
      buildTraktHeaders(deps),
      logger,
      "Trakt TMDB->Trakt ID lookup"
    );

    const rows = Array.isArray(responseData) ? responseData : [];
    for (const row of rows) {
      const media = normalizedType === "movie" ? row?.movie : row?.show;
      const traktId = toIntegerOrNull(media?.ids?.trakt);
      if (traktId !== null && traktId > 0) {
        return traktId;
      }
    }

    return null;
  } catch (error) {
    logger.warn("Failed Trakt TMDB->Trakt lookup", {
      error: error?.message,
      status: error?.status,
      type: normalizedType,
      tmdbId: normalizedTmdbId,
    });
    return null;
  }
}

function normalizeHistoryType(type) {
  if (type === "movie") {
    return "movies";
  }

  if (type === "show") {
    return "shows";
  }

  return null;
}

async function fetchHistoryStatusByTraktId(deps = {}, normalizedType, traktId) {
  const logger = getLogger(deps);
  const traktClientId = deps.traktClientId;
  const normalizedTraktId = toIntegerOrNull(traktId);
  const historyType = normalizeHistoryType(normalizedType);

  if (!traktClientId || !historyType || normalizedTraktId === null || normalizedTraktId <= 0) {
    return false;
  }

  const url = buildTraktUrl(`/sync/history/${historyType}/${normalizedTraktId}`);

  try {
    const responseData = await fetchJson(
      url,
      buildTraktHeaders(deps),
      logger,
      "Trakt per-item history check"
    );

    return Array.isArray(responseData) && responseData.length > 0;
  } catch (error) {
    logger.warn("Failed Trakt per-item history check", {
      error: error?.message,
      status: error?.status,
      type: normalizedType,
      traktId: normalizedTraktId,
    });
    return false;
  }
}

async function resolveTraktIdForLookup(deps = {}, lookup = {}) {
  const normalizedType = normalizeCheckerType(lookup.type);
  const tmdbId = toIntegerOrNull(lookup.tmdb_id);

  if (!normalizedType || tmdbId === null || tmdbId <= 0) {
    return null;
  }

  const idCache = deps.tmdbToTraktIdCache;
  const idPromiseCache = deps.tmdbToTraktIdPromiseCache;
  const cacheKey = `${normalizedType}:tmdb:${tmdbId}`;

  if (idCache && idCache.has(cacheKey)) {
    return idCache.get(cacheKey);
  }

  if (idPromiseCache && idPromiseCache.has(cacheKey)) {
    return idPromiseCache.get(cacheKey);
  }

  const lookupPromise = fetchTraktIdFromTmdb(deps, normalizedType, tmdbId).finally(() => {
    if (idPromiseCache) {
      idPromiseCache.delete(cacheKey);
    }
  });

  if (idPromiseCache) {
    idPromiseCache.set(cacheKey, lookupPromise);
  }

  const traktId = await lookupPromise;

  if (idCache) {
    idCache.set(cacheKey, traktId);
  }

  return traktId;
}

function normalizeCheckerInput(tmdbIdOrItem, imdbId, type) {
  if (tmdbIdOrItem && typeof tmdbIdOrItem === "object" && !Array.isArray(tmdbIdOrItem)) {
    const item = tmdbIdOrItem;
    const sourceItem = item.item && typeof item.item === "object" ? item.item : item;
    const normalized = normalizeLookupItem({
      ...sourceItem,
      type: item.type ?? sourceItem.type,
      title: item.title ?? sourceItem.title,
      year: item.year ?? sourceItem.year,
      tmdb_id: item.tmdb_id ?? item.tmdbId ?? sourceItem.tmdb_id ?? sourceItem.tmdbId,
      imdb_id: item.imdb_id ?? item.imdbId ?? sourceItem.imdb_id ?? sourceItem.imdbId,
      ids: item.ids || sourceItem.ids,
      movie: item.movie || sourceItem.movie,
      show: item.show || sourceItem.show,
    });

    return {
      type: normalizeCheckerType(item.type || normalized.type),
      tmdb_id: normalized.tmdb_id,
      imdb_id: normalized.imdb_id,
      title: normalized.title,
      year: normalized.year,
    };
  }

  return {
    type: normalizeCheckerType(type),
    tmdb_id: toIntegerOrNull(tmdbIdOrItem),
    imdb_id:
      imdbId === undefined || imdbId === null || imdbId === ""
        ? null
        : String(imdbId).toLowerCase().trim(),
    title: null,
    year: null,
  };
}



async function getTraktItemStatusImpl(deps = {}, input = {}) {
  const lookup = normalizeCheckerInput(input);
  const normalizedType = normalizeCheckerType(lookup.type);

  if (!normalizedType) {
    return { history: false };
  }

  const cacheStore = deps.statusCache && typeof deps.statusCache.get === "function" && typeof deps.statusCache.set === "function"
    ? deps.statusCache
    : null;
  const promiseCache =
    deps.statusPromiseCache &&
    typeof deps.statusPromiseCache.get === "function" &&
    typeof deps.statusPromiseCache.set === "function" &&
    typeof deps.statusPromiseCache.delete === "function"
      ? deps.statusPromiseCache
      : null;

  const cacheKey = buildStatusCacheKey(
    normalizedType,
    lookup.tmdb_id,
    lookup.imdb_id,
    lookup.title,
    lookup.year
  );

  if (cacheStore && cacheStore.has(cacheKey)) {
    return cacheStore.get(cacheKey);
  }

  if (promiseCache && promiseCache.has(cacheKey)) {
    return promiseCache.get(cacheKey);
  }

  const statusPromise = (async () => {
    const traktId = await resolveTraktIdForLookup(deps, lookup);
    const history = await fetchHistoryStatusByTraktId(deps, normalizedType, traktId);
    const status = { history };

    if (cacheStore) {
      cacheStore.set(cacheKey, status);
    }

    return status;
  })().finally(() => {
    if (promiseCache) {
      promiseCache.delete(cacheKey);
    }
  });

  if (promiseCache) {
    promiseCache.set(cacheKey, statusPromise);
  }

  return statusPromise;
}

function createTraktStatusChecker(deps = {}) {
  const statusCache = deps.statusCache || new Map();
  const statusPromiseCache = deps.statusPromiseCache || new Map();
  const tmdbToTraktIdCache = deps.tmdbToTraktIdCache || new Map();
  const tmdbToTraktIdPromiseCache = deps.tmdbToTraktIdPromiseCache || new Map();
  const checkerDeps = {
    ...deps,
    statusCache,
    statusPromiseCache,
    tmdbToTraktIdCache,
    tmdbToTraktIdPromiseCache,
  };

  const checkStatus = async (tmdbIdOrInput, imdbId, type) => {
    const input = normalizeCheckerInput(tmdbIdOrInput, imdbId, type);
    return getTraktItemStatusImpl(checkerDeps, input);
  };

  checkStatus.checkStatus = checkStatus;
  checkStatus.getStatus = checkStatus;
  return checkStatus;
}

async function getTraktItemStatus(tmdbId, imdbId, type, traktAccessToken, deps = {}) {
  const checker = createTraktStatusChecker({
    ...deps,
    traktAccessToken: traktAccessToken || deps.traktAccessToken,
  });

  return checker(tmdbId, imdbId, type);
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
  fetchTraktFavorites,
  createTraktStatusChecker,
  getTraktItemStatus,
  normalizeMediaKey,
};
