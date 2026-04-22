const { addonBuilder } = require("stremio-addon-sdk");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@libsql/client/web");
const fetch = require("node-fetch").default;
const logger = require("./utils/logger");
const { decryptConfig } = require("./utils/crypto");
const { withRetry } = require("./utils/apiRetry");
const { runAgentLoop } = require("./utils/agent");
const { toolDeclarations, executeTools: executeAgentTools } = require("./utils/agent-tools");
const { fetchTraktFavorites, normalizeMediaKey } = require("./utils/trakt");
const { buildMediaIdentityKeys, buildMediaIdentitySet } = require("./utils/mediaIdentity");
const { buildSimilarContentPrompt, buildClassificationPrompt } = require("./utils/prompts");
const {
  getStatValue,
  incrementStat,
  setStatValue,
  getAiCache,
  setAiCache,
  deleteAiCache,
  purgeExpiredAiCache,
  clearAiCache: clearAiCacheDb,
  getTraktCache,
  setTraktCache,
  deleteTraktCache,
  purgeExpiredTraktCache,
  clearTraktCache: clearTraktCacheDb,
} = require("./database");
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for TMDB
const TMDB_DISCOVER_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for TMDB discover (was 12 hours)
const AUXILIARY_AI_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hour cache for non-recommendation AI helpers
const RPDB_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 day cache for RPDB
const DEFAULT_RPDB_KEY = process.env.RPDB_API_KEY;
const DEFAULT_FANART_KEY = process.env.FANART_API_KEY;
const ENABLE_LOGGING = process.env.ENABLE_LOGGING === "true" || false;
const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_RAW_DATA_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const MAX_AI_RECOMMENDATIONS = 30;
const MAX_DO_NOT_RECOMMEND_ITEMS = 200;
const TRAKT_PAGINATION_LIMIT = 1000;
const TRAKT_PAGINATION_MAX_PAGES = 20;
const TRAKT_PAGINATION_CONCURRENCY = 4;

// Stats counter for tracking total queries
let queryCounter = 0;

const tursoClient = createClient({
  url: process.env.TURSO_URI,
  authToken: process.env.TURSO_TOKEN,
});

async function hydrateQueryCounter() {
  try {
    const dbValue = await getStatValue('recommendations_served');
    if (dbValue > queryCounter) {
      queryCounter = dbValue;
      logger.info('Query counter hydrated from database', { count: queryCounter });
    }
  } catch (error) {
    logger.error('Failed to hydrate query counter from database', { error: error.message });
  }
}

class SimpleLRUCache {
  constructor(options = {}) {
    this.max = options.max || 1000;
    this.ttl = options.ttl || Infinity;
    this.cache = new Map();
    this.timestamps = new Map();
    this.expirations = new Map();
  }

  set(key, value) {
    if (this.cache.size >= this.max) {
      const oldestKey = this.timestamps.keys().next().value;
      this.delete(oldestKey);
    }

    this.cache.set(key, value);
    this.timestamps.set(key, Date.now());

    if (this.ttl !== Infinity) {
      const expiration = Date.now() + this.ttl;
      this.expirations.set(key, expiration);
    }

    return this;
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return undefined;
    }

    this.timestamps.delete(key);
    this.timestamps.set(key, Date.now());

    return this.cache.get(key);
  }

  has(key) {
    if (!this.cache.has(key)) {
      return false;
    }

    const expiration = this.expirations.get(key);
    if (expiration && Date.now() > expiration) {
      this.delete(key);
      return false;
    }

    return true;
  }

  delete(key) {
    this.cache.delete(key);
    this.timestamps.delete(key);
    this.expirations.delete(key);
    return true;
  }

  clear() {
    this.cache.clear();
    this.timestamps.clear();
    this.expirations.clear();
    return true;
  }

  get size() {
    return this.cache.size;
  }

  keys() {
    return Array.from(this.cache.keys());
  }

  // Serialize cache data to a JSON-friendly format
  serialize() {
    const entries = [];
    for (const [key, value] of this.cache.entries()) {
      const timestamp = this.timestamps.get(key);
      const expiration = this.expirations.get(key);
      entries.push({
        key,
        value,
        timestamp,
        expiration,
      });
    }

    return {
      max: this.max,
      ttl: this.ttl,
      entries,
    };
  }

  // Load data from serialized format
  deserialize(data) {
    if (!data || !data.entries) {
      return false;
    }

    this.max = data.max || this.max;
    this.ttl = data.ttl || this.ttl;

    // Clear existing data
    this.clear();

    // Load entries
    for (const entry of data.entries) {
      // Skip expired entries
      if (entry.expiration && Date.now() > entry.expiration) {
        continue;
      }

      this.cache.set(entry.key, entry.value);
      this.timestamps.set(entry.key, entry.timestamp);
      if (entry.expiration) {
        this.expirations.set(entry.key, entry.expiration);
      }
    }

    return true;
  }
}

const tmdbCache = new SimpleLRUCache({
  max: 25000,
  ttl: TMDB_CACHE_DURATION,
});

// Add a separate cache for TMDB details to avoid redundant API calls
const tmdbDetailsCache = new SimpleLRUCache({
  max: 25000,
  ttl: TMDB_CACHE_DURATION,
});

const rpdbCache = new SimpleLRUCache({
  max: 25000,
  ttl: RPDB_CACHE_DURATION,
});

const fanartCache = new SimpleLRUCache({
  max: 5000,
  ttl: RPDB_CACHE_DURATION,
});

const similarContentCache = new SimpleLRUCache({
  max: 5000,
  ttl: AUXILIARY_AI_CACHE_DURATION,
});

const HOST = process.env.HOST
  ? `https://${process.env.HOST}`
  : "https://github.com/EremesNG/stremio-ai-picks";
const BASE_PATH = "";

setInterval(() => {
  const tmdbStats = {
    size: tmdbCache.size,
    maxSize: tmdbCache.max,
    usagePercentage: ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbCache.size,
  };

  const tmdbDetailsStats = {
    size: tmdbDetailsCache.size,
    maxSize: tmdbDetailsCache.max,
    usagePercentage:
      ((tmdbDetailsCache.size / tmdbDetailsCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbDetailsCache.size,
  };

  const tmdbDiscoverStats = {
    size: tmdbDiscoverCache.size,
    maxSize: tmdbDiscoverCache.max,
    usagePercentage:
      ((tmdbDiscoverCache.size / tmdbDiscoverCache.max) * 100).toFixed(2) + "%",
    itemCount: tmdbDiscoverCache.size,
  };

  const rpdbStats = {
    size: rpdbCache.size,
    maxSize: rpdbCache.max,
    usagePercentage: ((rpdbCache.size / rpdbCache.max) * 100).toFixed(2) + "%",
    itemCount: rpdbCache.size,
  };

  logger.info("Cache statistics", {
    tmdbCache: tmdbStats,
    tmdbDetailsCache: tmdbDetailsStats,
    tmdbDiscoverCache: tmdbDiscoverStats,
    aiCache: { backend: "turso", inMemory: false },
    traktCache: { backend: "turso", inMemory: false },
    rpdbCache: rpdbStats,
  });
}, 60 * 60 * 1000);

const DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest";

// Add separate caches for raw and processed Trakt data
const traktRawDataCache = new SimpleLRUCache({
  max: 1000,
  ttl: TRAKT_RAW_DATA_CACHE_DURATION,
});

// In-flight Trakt fetch locks to prevent cache stampedes
const traktFetchLocks = new Map();

// Cache for TMDB discover API results
const tmdbDiscoverCache = new SimpleLRUCache({
  max: 1000,
  ttl: TMDB_DISCOVER_CACHE_DURATION,
});

// Cache for query analysis results
const queryAnalysisCache = new SimpleLRUCache({
  max: 1000,
  ttl: AUXILIARY_AI_CACHE_DURATION,
});

/**
 * Scans the AI recommendations cache and removes any entries that contain no results.
 * This is useful for cleaning up previously cached empty responses.
 * @returns {object} An object containing the statistics of the purge operation.
 */
function purgeEmptyAiCacheEntries() {
  logger.info("Starting AI cache expiration purge (Turso-backed)...");
  purgeExpiredAiCache()
    .then((purgedCount) => {
      logger.info("Completed AI cache expiration purge.", {
        backend: "turso",
        purged: purgedCount,
      });
    })
    .catch((error) => {
      logger.error("Failed AI cache expiration purge.", {
        backend: "turso",
        error: error.message,
      });
    });

  return {
    scanned: null,
    purged: 0,
    remaining: null,
    pending: true,
    backend: "turso",
  };
}

// Helper function to merge and deduplicate Trakt items
function mergeAndDeduplicate(newItems, existingItems) {
  // Create a map of existing items by ID for quick lookup
  const existingMap = new Map();
  existingItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      existingMap.set(id, item);
    }
  });

  // Add new items, replacing existing ones if newer
  newItems.forEach((item) => {
    const media = item.movie || item.show;
    const id = item.id || media?.ids?.trakt;
    if (id) {
      // If item exists, keep the newer one based on last_activity or just replace
      if (
        !existingMap.has(id) ||
        (item.last_activity &&
          existingMap.get(id).last_activity &&
          new Date(item.last_activity) >
            new Date(existingMap.get(id).last_activity))
      ) {
        existingMap.set(id, item);
      }
    }
  });

  // Convert map back to array
  return Array.from(existingMap.values());
}

// Modular functions for processing different aspects of Trakt data
function processGenres(watchedItems, ratedItems) {
  const genres = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.genres?.forEach((genre) => {
      genres.set(genre, (genres.get(genre) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(genres.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre, count]) => ({ genre, count }));
}

function processActors(watchedItems, ratedItems) {
  const actors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + 1);
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.cast?.forEach((actor) => {
      actors.set(actor.name, (actors.get(actor.name) || 0) + weight);
    });
  });

  // Convert to sorted array
  return Array.from(actors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([actor, count]) => ({ actor, count }));
}

function processDirectors(watchedItems, ratedItems) {
  const directors = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + 1);
      }
    });
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const weight = item.rating / 5; // normalize rating to 0-1
    media.crew?.forEach((person) => {
      if (person.job === "Director") {
        directors.set(person.name, (directors.get(person.name) || 0) + weight);
      }
    });
  });

  // Convert to sorted array
  return Array.from(directors.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([director, count]) => ({ director, count }));
}

function processYears(watchedItems, ratedItems) {
  const years = new Map();

  // Process watched items
  watchedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    if (year) {
      years.set(year, (years.get(year) || 0) + 1);
    }
  });

  // Process rated items with weights
  ratedItems?.forEach((item) => {
    const media = item.movie || item.show;
    const year = parseInt(media.year);
    const weight = item.rating / 5; // normalize rating to 0-1
    if (year) {
      years.set(year, (years.get(year) || 0) + weight);
    }
  });

  // If no years data, return null
  if (years.size === 0) {
    return null;
  }

  // Create year range object
  return {
    start: Math.min(...years.keys()),
    end: Math.max(...years.keys()),
    preferred: Array.from(years.entries()).sort((a, b) => b[1] - a[1])[0]?.[0],
  };
}

function processRatings(ratedItems) {
  const ratings = new Map();

  // Process ratings distribution
  ratedItems?.forEach((item) => {
    ratings.set(item.rating, (ratings.get(item.rating) || 0) + 1);
  });

  // Convert to sorted array
  return Array.from(ratings.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([rating, count]) => ({ rating, count }));
}

// Process all preferences in parallel
async function processPreferencesInParallel(watched, rated, _history) {
  const processingStart = Date.now();

  // Run all processing functions in parallel
  const [genres, actors, directors, yearRange, ratings] = await Promise.all([
    Promise.resolve(processGenres(watched, rated)),
    Promise.resolve(processActors(watched, rated)),
    Promise.resolve(processDirectors(watched, rated)),
    Promise.resolve(processYears(watched, rated)),
    Promise.resolve(processRatings(rated)),
  ]);

  const processingTime = Date.now() - processingStart;
  logger.debug("Trakt preference processing completed", {
    processingTimeMs: processingTime,
    genresCount: genres.length,
    actorsCount: actors.length,
    directorsCount: directors.length,
    hasYearRange: !!yearRange,
    ratingsCount: ratings.length,
  });

  return {
    genres,
    actors,
    directors,
    yearRange,
    ratings,
  };
}

/**
 * Creates a Stremio meta object with a dynamically generated SVG poster for displaying errors.
 * @param {string} title - The title of the error message.
 * @param {string} message - The main body of the error message.
 * @returns {object} A Stremio meta object.
 */
function createErrorMeta(title, message) {
  // Simple text wrapping for the message
  const words = message.split(' ');
  let lines = [];
  let currentLine = words[0] || '';
  for (let i = 1; i < words.length; i++) {
    let testLine = currentLine + ' ' + words[i];
    if (testLine.length > 35) { // Approx characters per line
      lines.push(currentLine);
      currentLine = words[i];
    } else {
      currentLine = testLine;
    }
  }
  lines.push(currentLine);

  // Generate tspan elements for each line
  const messageTspans = lines.map((line, index) => `<tspan x="250" y="${560 + index * 30}">${line}</tspan>`).join('');

  const svg = `
    <svg width="500" height="750" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#2d2d2d" />
      <path d="M250 50 L450 400 L50 400 Z" fill="#c0392b"/>
      <path d="M250 120 L400 380 L100 380 Z" fill="#e74c3c"/>
      <text fill="white" font-size="60" font-family="Arial, sans-serif" x="250" y="270" text-anchor="middle" font-weight="bold">!</text>
      <text fill="white" font-size="32" font-family="Arial, sans-serif" x="250" y="500" text-anchor="middle" font-weight="bold">${title}</text>
      <text fill="white" font-size="24" font-family="Arial, sans-serif" text-anchor="middle">
        ${messageTspans}
      </text>
      <text fill="#bdc3c7" font-size="20" font-family="Arial, sans-serif" x="250" y="700" text-anchor="middle">Please check the addon configuration.</text>
    </svg>
  `;

  const posterDataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

  return {
    id: `error:${title.replace(/\s+/g, '_')}`,
    type: 'movie',
    name: title,
    description: message,
    poster: posterDataUri,
    posterShape: 'regular',
  };
}

async function makeApiCall(url, headers) {
  return await withRetry(
    async () => {
      const response = await fetch(url, { headers });

      logger.agent('TRAKT_HTTP_CALL', {
        url: url
          .replace(/access_token=[^&]+/, 'access_token=REDACTED')
          .replace(/api_key=[^&]+/, 'api_key=REDACTED'),
        status: response.status,
        ok: response.ok,
      });

      if (response.status === 401) {
        logger.warn(
          "Trakt access token is expired. Personalized recommendations will be unavailable until the user updates their configuration."
        );
      }

      return response;
    },
    {
      maxRetries: 3,
      baseDelay: 1000,
      shouldRetry: (error) => !error.status || (error.status !== 401 && error.status !== 403),
      operationName: "Trakt API call",
    }
  );
}

function getTraktPageCount(response) {
  const pageCountHeader = response?.headers?.get("X-Pagination-Page-Count");
  const pageCount = Number.parseInt(pageCountHeader, 10);
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : 1;
}

async function fetchTraktPaginatedCollection(endpoint, headers, operationLabel) {
  const firstPageUrl = new URL(endpoint);
  firstPageUrl.searchParams.set("page", "1");
  firstPageUrl.searchParams.set("limit", String(TRAKT_PAGINATION_LIMIT));

  const firstResponse = await makeApiCall(firstPageUrl.toString(), headers);
  logger.agent('TRAKT_API_RESPONSE', {
    url: firstPageUrl.toString().replace(/access_token=[^&]+/, 'access_token=REDACTED'),
    status: firstResponse.status,
    statusText: firstResponse.statusText,
    pageCount: firstResponse.headers.get('X-Pagination-Page-Count'),
    itemCount: firstResponse.headers.get('X-Pagination-Item-Count'),
    ok: firstResponse.ok,
  });

  if (!firstResponse.ok) {
    const errorBody = await firstResponse.text().catch(() => 'unable to read body');
    logger.agent('TRAKT_API_ERROR', {
      url: firstPageUrl.toString().replace(/access_token=[^&]+/, 'access_token=REDACTED'),
      status: firstResponse.status,
      body: errorBody,
      label: operationLabel,
    });
    throw new Error(`Trakt API error: ${firstResponse.status} ${firstResponse.statusText}`);
  }

  const firstPage = await firstResponse.json().catch(() => []);
  logger.agent('TRAKT_FIRST_PAGE', {
    isArray: Array.isArray(firstPage),
    itemCount: Array.isArray(firstPage) ? firstPage.length : 0,
    type: typeof firstPage,
    sample: Array.isArray(firstPage) ? (firstPage[0] ? Object.keys(firstPage[0]) : []) : Object.keys(firstPage || {}),
    label: operationLabel,
  });
  const totalPages = getTraktPageCount(firstResponse);
  const pageCount = Math.min(totalPages, TRAKT_PAGINATION_MAX_PAGES);

  if (totalPages > TRAKT_PAGINATION_MAX_PAGES) {
    logger.warn("Trakt pagination cap reached", {
      operation: operationLabel,
      endpoint,
      pageCount: totalPages,
      cappedAt: TRAKT_PAGINATION_MAX_PAGES,
    });
  }

  if (pageCount <= 1) {
    return Array.isArray(firstPage) ? firstPage : [];
  }

  const pages = [];
  for (let page = 2; page <= pageCount; page += 1) {
    pages.push(page);
  }

  const additionalPages = [];
  for (let index = 0; index < pages.length; index += TRAKT_PAGINATION_CONCURRENCY) {
    const batch = pages.slice(index, index + TRAKT_PAGINATION_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (page) => {
        const pageUrl = new URL(endpoint);
        pageUrl.searchParams.set("page", String(page));
        pageUrl.searchParams.set("limit", String(TRAKT_PAGINATION_LIMIT));

        const pageResponse = await makeApiCall(pageUrl.toString(), headers);
        if (!pageResponse.ok) {
          const errorBody = await pageResponse.text().catch(() => 'unable to read body');
          logger.agent('TRAKT_API_ERROR', {
            url: pageUrl.toString().replace(/access_token=[^&]+/, 'access_token=REDACTED'),
            status: pageResponse.status,
            body: errorBody,
            label: operationLabel,
            page,
          });
          return [];
        }

        const pageData = await pageResponse.json().catch(() => []);
        return Array.isArray(pageData) ? pageData : [];
      })
    );

    additionalPages.push(...batchResults);
  }

  return [
    ...(Array.isArray(firstPage) ? firstPage : []),
    ...additionalPages.flat(),
  ];
}

// Function to fetch incremental Trakt data
async function fetchTraktIncrementalData(
  clientId,
  accessToken,
  type,
  lastUpdate
) {
  // Format date for Trakt API (ISO string without milliseconds)
  const startDate = new Date(lastUpdate).toISOString().split(".")[0] + "Z";

  const endpoints = [
    `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full&start_at=${startDate}`,
    `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full&start_at=${startDate}`,
    `${TRAKT_API_BASE}/users/me/history/${type}?extended=full&start_at=${startDate}`,
  ];

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "stremio-ai-picks",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    Authorization: `Bearer ${accessToken}`,
  };

  // Fetch all data in parallel
  const responses = await Promise.all(
    endpoints.map((endpoint) =>
      fetchTraktPaginatedCollection(endpoint, headers, "Trakt incremental fetch")
        .catch((err) => {
          logger.error("Trakt API Error:", { endpoint, error: err.message });
          return [];
        })
    )
  );

  return {
    watched: responses[0] || [],
    rated: responses[1] || [],
    history: responses[2] || [],
  };
}

// Main function to fetch Trakt data with optimizations
async function fetchTraktWatchedAndRated(
  clientId,
  accessToken,
  type = "movies",
  configData = null
) {
  logger.agent('TRAKT_FETCH_START', { mediaType: type, hasClientId: !!clientId, hasAccessToken: !!accessToken });

  logger.info("fetchTraktWatchedAndRated called", {
    hasClientId: !!clientId,
    clientIdLength: clientId?.length,
    hasAccessToken: !!accessToken,
    accessTokenLength: accessToken?.length,
    type,
  });

  if (!clientId || !accessToken) {
    logger.agent('TRAKT_FETCH_FAILED', { reason: 'missing_credentials', error: 'clientId or accessToken is missing' });
    logger.error("Missing Trakt credentials", {
      hasClientId: !!clientId,
      hasAccessToken: !!accessToken,
    });
    return null;
  }

  const traktUsername = configData?.traktUsername || configData?.TraktUsername || '';
  const rawCacheKey = `trakt_raw_${accessToken}_${type}`;
  const processedCacheKey = `trakt_${traktUsername}_${type}`;
  const fetchLockKey = processedCacheKey;

  if (traktFetchLocks.has(fetchLockKey)) {
    logger.info("Waiting for in-flight Trakt fetch", {
      cacheKey: fetchLockKey,
      type,
    });
    return await traktFetchLocks.get(fetchLockKey);
  }

  const fetchPromise = (async () => {
    // Check if we have processed data in cache
    const tursoTraktCache = await getTraktCache(processedCacheKey);
    if (tursoTraktCache) {
      const cached = tursoTraktCache;
      logger.agent('TRAKT_CACHE_HIT', { cacheKey: processedCacheKey, watchedCount: cached?.data?.watched?.length, ratedCount: cached?.data?.rated?.length });
      logger.info("Trakt processed cache hit", {
        cacheKey: processedCacheKey,
        type,
        watchedCount: cached.data?.watched?.length || 0,
        ratedCount: cached.data?.rated?.length || 0,
        cachedAt: new Date(cached.timestamp).toISOString(),
        age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      });
      return cached.data;
    }

    // Check if we have raw data that needs updating
    let rawData;
    let isIncremental = false;

    if (traktRawDataCache.has(rawCacheKey)) {
      const cachedRaw = traktRawDataCache.get(rawCacheKey);
      const lastUpdate = cachedRaw.lastUpdate || cachedRaw.timestamp;

      // Always do incremental updates when cache exists, regardless of age
      logger.info("Performing incremental Trakt update", {
        cacheKey: rawCacheKey,
        lastUpdate: new Date(lastUpdate).toISOString(),
        age: `${Math.round((Date.now() - lastUpdate) / 1000)}s`,
      });

      try {
        // Fetch only new data since last update
        const newData = await fetchTraktIncrementalData(
          clientId,
          accessToken,
          type,
          lastUpdate
        );

        // Merge with existing data
        rawData = {
          watched: mergeAndDeduplicate(newData.watched, cachedRaw.data.watched),
          rated: mergeAndDeduplicate(newData.rated, cachedRaw.data.rated),
          history: mergeAndDeduplicate(newData.history, cachedRaw.data.history),
          lastUpdate: Date.now(),
        };

        isIncremental = true;

        // Update raw data cache
        traktRawDataCache.set(rawCacheKey, {
          timestamp: Date.now(),
          lastUpdate: Date.now(),
          data: rawData,
        });

        logger.info("Incremental Trakt update completed", {
          newWatchedCount: newData.watched.length,
          newRatedCount: newData.rated.length,
          newHistoryCount: newData.history.length,
          totalWatchedCount: rawData.watched.length,
          totalRatedCount: rawData.rated.length,
          totalHistoryCount: rawData.history.length,
        });
      } catch (error) {
        logger.error(
          "Incremental Trakt update failed, falling back to full refresh",
          {
            error: error.message,
          }
        );
        isIncremental = false;
      }
    }

    // If we don't have raw data or incremental update failed, do a full refresh
    if (!rawData) {
      logger.info("Performing full Trakt data refresh", { type });

      try {
        const fetchStart = Date.now();
        // Use the original fetch logic for a full refresh but without limits
        const endpoints = [
          `${TRAKT_API_BASE}/users/me/watched/${type}?extended=full`,
          `${TRAKT_API_BASE}/users/me/ratings/${type}?extended=full`,
          `${TRAKT_API_BASE}/users/me/history/${type}?extended=full`,
        ];

        const headers = {
          "Content-Type": "application/json",
          "User-Agent": "stremio-ai-picks",
          "trakt-api-version": "2",
          "trakt-api-key": clientId,
          Authorization: `Bearer ${accessToken}`,
        };

        const responses = await Promise.all(
          endpoints.map((endpoint) =>
            fetchTraktPaginatedCollection(endpoint, headers, "Trakt full refresh")
              .catch((err) => {
                logger.error("Trakt API Error:", {
                  endpoint,
                  error: err.message,
                });
                return [];
              })
          )
        );

        const fetchTime = Date.now() - fetchStart;
        const [watched, rated, history] = responses;

        rawData = {
          watched: watched || [],
          rated: rated || [],
          history: history || [],
          lastUpdate: Date.now(),
        };

        // Update raw data cache
        traktRawDataCache.set(rawCacheKey, {
          timestamp: Date.now(),
          lastUpdate: Date.now(),
          data: rawData,
        });

        logger.info("Full Trakt refresh completed", {
          fetchTimeMs: fetchTime,
          watchedCount: rawData.watched.length,
          ratedCount: rawData.rated.length,
          historyCount: rawData.history.length,
        });
      } catch (error) {
        logger.agent('TRAKT_FETCH_FAILED', { reason: 'api_error_during_full_refresh', error: error?.message });
        logger.error("Trakt API Error:", {
          error: error.message,
          stack: error.stack,
        });
        return null;
      }
    }

    // Process the data (raw or incrementally updated) in parallel
    const processingStart = Date.now();
    const preferences = await processPreferencesInParallel(
      rawData.watched,
      rawData.rated,
      rawData.history
    );
    const processingTime = Date.now() - processingStart;

    // Create the final result
    const result = {
      watched: rawData.watched,
      rated: rawData.rated,
      history: rawData.history,
      preferences,
      lastUpdate: rawData.lastUpdate,
      isIncrementalUpdate: isIncremental,
    };

    // Cache the processed result
    await setTraktCache(processedCacheKey, result);

    logger.info("Trakt data processing and caching completed", {
      processingTimeMs: processingTime,
      isIncremental: isIncremental,
      cacheKey: processedCacheKey,
    });

    return result;
  })();

  traktFetchLocks.set(fetchLockKey, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    traktFetchLocks.delete(fetchLockKey);
  }
}

async function searchTMDB(title, type, year, tmdbKey, language = "en-US", includeAdult = false) {
  const startTime = Date.now();
  logger.debug("Starting TMDB search", { title, type, year, includeAdult });
  const cacheKey = `${title}-${type}-${year}-${language}-adult:${includeAdult}`;

  if (tmdbCache.has(cacheKey)) {
    const cached = tmdbCache.get(cacheKey);
    logger.info("TMDB cache hit", {
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      responseTime: `${Date.now() - startTime}ms`,
      title,
      type,
      year,
      language,
      hasImdbId: !!cached.data?.imdb_id,
      tmdbId: cached.data?.tmdb_id,
    });
    return cached.data;
  }

  logger.info("TMDB cache miss", { cacheKey, title, type, year, language });

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      year: year,
      include_adult: includeAdult,
      language: language,
    });

    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;

    logger.info("Making TMDB API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: {
        type: searchType,
        query: title,
        year,
        language,
      },
    });

    // Use withRetry for the search API call
    const responseData = await withRetry(
      async () => {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) {
          const errorData = await searchResponse.json().catch(() => ({}));
          let errorMessage;

          // Handle specific error cases
          if (searchResponse.status === 401) {
            errorMessage = "Invalid TMDB API key";
          } else if (searchResponse.status === 429) {
            errorMessage = "TMDB API rate limit exceeded";
          } else {
            errorMessage = `TMDB API error: ${searchResponse.status} ${
              errorData?.status_message || ""
            }`;
          }

          const error = new Error(errorMessage);
          error.status = searchResponse.status;
          error.isRateLimit = searchResponse.status === 429;
          error.isInvalidKey = searchResponse.status === 401;
          throw error;
        }
        return searchResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB search API call",
        // Don't retry on invalid API key errors
        shouldRetry: (error) =>
          !error.isInvalidKey &&
          (!error.status || error.status >= 500 || error.isRateLimit),
      }
    );

    // Log response with error status if applicable
    if (responseData.status_code) {
      logger.error("TMDB API error response", {
        duration: `${Date.now() - startTime}ms`,
        status_code: responseData.status_code,
        status_message: responseData.status_message,
        query: title,
        year: year,
      });
    } else {
      // Log successful response (even if no results found)
      logger.info("TMDB API response", {
        duration: `${Date.now() - startTime}ms`,
        resultCount: responseData?.results?.length,
        status: "success",
        query: title,
        year: year,
        firstResult: responseData?.results?.[0]
          ? {
              id: responseData.results[0].id,
              title:
                responseData.results[0].title || responseData.results[0].name,
              year:
                responseData.results[0].release_date ||
                responseData.results[0].first_air_date,
              hasExternalIds: !!responseData.results[0].external_ids,
            }
          : null,
      });
    }

    if (responseData?.results?.[0]) {
      const result = responseData.results[0];

      const tmdbData = {
        poster: result.poster_path
          ? `https://image.tmdb.org/t/p/w500${result.poster_path}`
          : null,
        backdrop: result.backdrop_path
          ? `https://image.tmdb.org/t/p/original${result.backdrop_path}`
          : null,
        tmdbRating: result.vote_average,
        genres: result.genre_ids,
        overview: result.overview || "",
        tmdb_id: result.id,
        title: result.title || result.name,
        release_date: result.release_date || result.first_air_date,
      };

      // Only fetch details if we don't have an IMDB ID
      if (!tmdbData.imdb_id) {
        const detailsCacheKey = `details_${searchType}_${result.id}_${language}`;
        let detailsData;

        // Check if details are in cache
        if (tmdbDetailsCache.has(detailsCacheKey)) {
          const cachedDetails = tmdbDetailsCache.get(detailsCacheKey);
          logger.info("TMDB details cache hit", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            cachedAt: new Date(cachedDetails.timestamp).toISOString(),
            age: `${Math.round(
              (Date.now() - cachedDetails.timestamp) / 1000
            )}s`,
            hasImdbId: !!(
              cachedDetails.data?.imdb_id ||
              cachedDetails.data?.external_ids?.imdb_id
            ),
          });
          detailsData = cachedDetails.data;
        } else {
          // Not in cache, need to make API call
          const detailsUrl = `${TMDB_API_BASE}/${searchType}/${result.id}?api_key=${tmdbKey}&append_to_response=external_ids&language=${language}`;

          logger.info("TMDB details cache miss", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
          });

          logger.info("Making TMDB details API call", {
            url: detailsUrl.replace(tmdbKey, "***"),
            movieId: result.id,
            type: searchType,
          });

          // Use withRetry for the details API call
          detailsData = await withRetry(
            async () => {
              const detailsResponse = await fetch(detailsUrl);
              if (!detailsResponse.ok) {
                const errorData = await detailsResponse
                  .json()
                  .catch(() => ({}));
                const error = new Error(
                  `TMDB details API error: ${detailsResponse.status} ${
                    errorData?.status_message || ""
                  }`
                );
                error.status = detailsResponse.status;
                throw error;
              }
              return detailsResponse.json();
            },
            {
              maxRetries: 3,
              initialDelay: 1000,
              maxDelay: 8000,
              operationName: "TMDB details API call",
            }
          );

          logger.info("TMDB details response", {
            duration: `${Date.now() - startTime}ms`,
            hasImdbId: !!(
              detailsData?.imdb_id || detailsData?.external_ids?.imdb_id
            ),
            tmdbId: detailsData?.id,
            type: searchType,
          });

          // Cache the details response
          tmdbDetailsCache.set(detailsCacheKey, {
            timestamp: Date.now(),
            data: detailsData,
          });

          logger.debug("TMDB details result cached", {
            cacheKey: detailsCacheKey,
            tmdbId: result.id,
            hasImdbId: !!(
              detailsData?.imdb_id || detailsData?.external_ids?.imdb_id
            ),
          });
        }

        // Extract IMDb ID from details data
        if (detailsData) {
          tmdbData.imdb_id =
            detailsData.imdb_id || detailsData.external_ids?.imdb_id;

          logger.debug("IMDB ID extraction result", {
            title,
            type,
            tmdbId: result.id,
            hasImdbId: !!tmdbData.imdb_id,
            imdbId: tmdbData.imdb_id || "not_found",
          });
        }
      }

      tmdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: tmdbData,
      });

      logger.debug("TMDB result cached", {
        cacheKey,
        duration: Date.now() - startTime,
        hasData: !!tmdbData,
        hasImdbId: !!tmdbData.imdb_id,
        title,
        type,
        tmdbId: tmdbData.tmdb_id,
      });
      return tmdbData;
    }

    logger.debug("No TMDB results found", {
      title,
      type,
      year,
      duration: Date.now() - startTime,
    });

    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null,
    });
    return null;
  } catch (error) {
    logger.error("TMDB Search Error:", {
      error: error.message,
      stack: error.stack,
      errorType: error.isRateLimit
        ? "rate_limit"
        : error.isInvalidKey
        ? "invalid_key"
        : error.status
        ? `http_${error.status}`
        : "unknown",
      params: { title, type, year, tmdbKeyLength: tmdbKey?.length },
      retryAttempts: error.retryCount || 0,
    });
    return null;
  }
}

async function searchTMDBExactMatch(title, type, tmdbKey, language = "en-US", includeAdult = false) {
  const startTime = Date.now();
  logger.debug("Starting TMDB exact match search", { title, type, includeAdult });
  const cacheKey = `tmdb_search_${title}-${type}-${language}-adult:${includeAdult}`;
  logger.debug("Starting TMDB search", { title, type, includeAdult });
  if (tmdbCache.has(cacheKey)) {
    const cached = tmdbCache.get(cacheKey);
    logger.info("TMDB search cache hit", {
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      resultCount: cached.data?.length || 0,
    });
    const responseData = cached.data;
    if (responseData && responseData.length > 0) {
        const normalizedTitle = title.toLowerCase().trim();
        const exactMatch = responseData.find((result) => {
            const resultTitle = (result.title || result.name || "").toLowerCase().trim();
            return resultTitle === normalizedTitle;
        });
        return { isExactMatch: !!exactMatch, results: responseData };
    }
    return { isExactMatch: false, results: [] };
  }
  
  logger.info("TMDB search cache miss", { cacheKey, title, type, language });

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const searchParams = new URLSearchParams({
      api_key: tmdbKey,
      query: title,
      include_adult: includeAdult,
      language: language,
    });
    const searchUrl = `${TMDB_API_BASE}/search/${searchType}?${searchParams.toString()}`;
    logger.info("Making TMDB search API call", {
      url: searchUrl.replace(tmdbKey, "***"),
      params: { type: searchType, query: title, language },
    });
    const responseData = await withRetry(
      async () => {
        const searchResponse = await fetch(searchUrl);
        if (!searchResponse.ok) {
          const errorData = await searchResponse.json().catch(() => ({}));
          let errorMessage;
          if (searchResponse.status === 401) {
            errorMessage = "Invalid TMDB API key";
          } else if (searchResponse.status === 429) {
            errorMessage = "TMDB API rate limit exceeded";
          } else {
            errorMessage = `TMDB API error: ${searchResponse.status} ${
              errorData?.status_message || ""
            }`;
          }
          const error = new Error(errorMessage);
          error.status = searchResponse.status;
          error.isRateLimit = searchResponse.status === 429;
          error.isInvalidKey = searchResponse.status === 401;
          throw error;
        }
        return searchResponse.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB search API call",
        shouldRetry: (error) =>
          !error.isInvalidKey &&
          (!error.status || error.status >= 500 || error.isRateLimit),
      }
    );

    const results = responseData?.results || [];
    tmdbCache.set(cacheKey, {
      timestamp: Date.now(),
      data: results,
    });
    logger.info("TMDB search results cached", { cacheKey, count: results.length });

    if (results.length > 0) {
      const normalizedTitle = title.toLowerCase().trim();
      const exactMatch = responseData.results.find((result) => {
        const resultTitle = (result.title || result.name || "")
          .toLowerCase()
          .trim();
        return resultTitle === normalizedTitle;
      });
      if (exactMatch) {
        logger.info("TMDB exact match found within results", { title, exactMatchTitle: exactMatch.title || exactMatch.name });
      }
      return { isExactMatch: !!exactMatch, results: results };
    }
    logger.debug("No TMDB exact match found", {
      title,
      type,
      duration: Date.now() - startTime
    });
    return { isExactMatch: false, results: [] };
  } catch (error) {
    logger.error("TMDB Search Error:", {
        error: error.message,
        stack: error.stack,
        params: { title, type },
    });
    return { isExactMatch: false, results: [] };
  }
}

const manifest = {
  id: "eremesng.aipicks",
  version: "1.0.0",
  name: "AI Picks",
  description: "AI-powered movie and series recommendations",
  resources: [
    "catalog",
    "meta",
    {
      name: "stream",
      types: ["movie", "series"],
      idPrefixes: ["tt"]
    }
  ],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "aipicks.top",
      name: "AI Movie Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
    {
      type: "series",
      id: "aipicks.top",
      name: "AI Series Search",
      extra: [{ name: "search", isRequired: true }],
      isSearch: true,
    },
    {
      type: "movie",
      id: "aipicks.recommend",
      name: "AI Movie Recommendations",
    },
    {
      type: "series",
      id: "aipicks.recommend",
      name: "AI Series Recommendations",
    },
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
    searchable: true,
  },
  logo: `${HOST}${BASE_PATH}/logo.png`,
  background: `${HOST}${BASE_PATH}/bg.jpg`,
  contactEmail: "eremesng@gmail.com",
};

const builder = new addonBuilder(manifest);

/**
 * Determines the intent of a search query based on keywords
 * @param {string} query
 * @returns {"movie"|"series"|"ambiguous"}
 */
function determineIntentFromKeywords(query) {
  if (!query) return "ambiguous";

  const normalizedQuery = query.toLowerCase().trim();

  const movieKeywords = {
    strong: [
      /\bmovie(s)?\b/,
      /\bfilm(s)?\b/,
      /\bcinema\b/,
      /\bfeature\b/,
      /\bmotion picture\b/,
    ],
    medium: [
      /\bdirector\b/,
      /\bscreenplay\b/,
      /\bboxoffice\b/,
      /\btheater\b/,
      /\btheatre\b/,
      /\bcinematic\b/,
    ],
    weak: [
      /\bwatch\b/,
      /\bactor\b/,
      /\bactress\b/,
      /\bscreenwriter\b/,
      /\bproducer\b/,
    ],
  };

  const seriesKeywords = {
    strong: [
      /\bseries\b/,
      /\btv show(s)?\b/,
      /\btelevision\b/,
      /\bshow(s)?\b/,
      /\bepisode(s)?\b/,
      /\bseason(s)?\b/,
      /\bdocumentary?\b/,
      /\bdocumentaries?\b/,
    ],
    medium: [
      /\bnetflix\b/,
      /\bhbo\b/,
      /\bhulu\b/,
      /\bamazon prime\b/,
      /\bdisney\+\b/,
      /\bapple tv\+\b/,
      /\bpilot\b/,
      /\bfinale\b/,
    ],
    weak: [
      /\bcharacter\b/,
      /\bcast\b/,
      /\bplot\b/,
      /\bstoryline\b/,
      /\bnarrative\b/,
    ],
  };

  let movieScore = 0;
  let seriesScore = 0;

  for (const pattern of movieKeywords.strong) {
    if (pattern.test(normalizedQuery)) movieScore += 3;
  }

  for (const pattern of movieKeywords.medium) {
    if (pattern.test(normalizedQuery)) movieScore += 2;
  }

  for (const pattern of movieKeywords.weak) {
    if (pattern.test(normalizedQuery)) movieScore += 1;
  }

  for (const pattern of seriesKeywords.strong) {
    if (pattern.test(normalizedQuery)) seriesScore += 3;
  }

  for (const pattern of seriesKeywords.medium) {
    if (pattern.test(normalizedQuery)) seriesScore += 2;
  }

  for (const pattern of seriesKeywords.weak) {
    if (pattern.test(normalizedQuery)) seriesScore += 1;
  }

  if (/\b(netflix|hulu|hbo|disney\+|apple tv\+)\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  if (/\b(cinema|theatrical|box office|imax)\b/.test(normalizedQuery)) {
    movieScore += 1;
  }

  if (/\b\d{4}-\d{4}\b/.test(normalizedQuery)) {
    seriesScore += 1;
  }

  logger.debug("Intent detection scores", {
    query: normalizedQuery,
    movieScore,
    seriesScore,
    difference: Math.abs(movieScore - seriesScore),
  });

  const scoreDifference = Math.abs(movieScore - seriesScore);
  const scoreThreshold = 2;

  if (scoreDifference < scoreThreshold) {
    return "ambiguous";
  } else if (movieScore > seriesScore) {
    return "movie";
  } else {
    return "series";
  }
}

function extractGenreCriteria(query) {
  const q = query.toLowerCase();

  const basicGenres = {
    action: /\b(action)\b/i,
    comedy: /\b(comedy|comedies|funny)\b/i,
    drama: /\b(drama|dramas|dramatic)\b/i,
    horror: /\b(horror|scary|frightening)\b/i,
    thriller: /\b(thriller|thrillers|suspense)\b/i,
    romance: /\b(romance|romantic|love)\b/i,
    scifi: /\b(sci-?fi|science\s*fiction)\b/i,
    fantasy: /\b(fantasy|magical)\b/i,
    documentary: /\b(documentary|documentaries)\b/i,
    animation: /\b(animation|animations|animated|anime)\b/i,
    adventure: /\b(adventure|adventures)\b/i,
    crime: /\b(crime|criminal|detective|detectives)\b/i,
    mystery: /\b(mystery|mysteries|detective|detectives)\b/i,
    family: /\b(family|kid-friendly|children|childrens)\b/i,
    biography: /\b(biography|biopic|biographical|biopics)\b/i,
    history: /\b(history|historical)\b/i,
    gore: /\b(gore|gory|bloody)\b/i,
    // TV specific genres
    reality: /\b(reality|realty)\s*(tv|show|series)?\b/i,
    "talk show": /\b(talk\s*show|talk\s*series)\b/i,
    soap: /\b(soap\s*opera?|soap\s*series|soap)\b/i,
    news: /\b(news|newscast|news\s*program)\b/i,
    kids: /\b(kids?|children|childrens|youth)\b/i,
  };

  const subGenres = {
    cyberpunk: /\b(cyberpunk|cyber\s*punk)\b/i,
    noir: /\b(noir|neo-noir)\b/i,
    psychological: /\b(psychological)\b/i,
    superhero: /\b(superhero|comic\s*book|marvel|dc)\b/i,
    musical: /\b(musical|music)\b/i,
    war: /\b(war|military)\b/i,
    western: /\b(western|cowboy)\b/i,
    sports: /\b(sports?|athletic)\b/i,
  };

  const moods = {
    feelGood: /\b(feel-?good|uplifting|heartwarming)\b/i,
    dark: /\b(dark|gritty|disturbing)\b/i,
    thoughtProvoking: /\b(thought-?provoking|philosophical|deep)\b/i,
    intense: /\b(intense|gripping|edge.*seat)\b/i,
    lighthearted: /\b(light-?hearted|fun|cheerful)\b/i,
  };

  // Create a set of all supported genres for quick lookup
  const supportedGenres = new Set([
    ...Object.keys(basicGenres),
    ...Object.keys(subGenres),
  ]);

  // Add common genre aliases that might appear in exclusions
  const genreAliases = {
    "sci-fi": "scifi",
    "science fiction": "scifi",
    "rom-com": "comedy",
    "romantic comedy": "comedy",
    "rom com": "comedy",
    "super hero": "superhero",
    "super-hero": "superhero",
  };

  // Add aliases to supported genres
  Object.keys(genreAliases).forEach((alias) => {
    supportedGenres.add(alias);
  });

  const combinedPattern =
    /(?:action[- ]comedy|romantic[- ]comedy|sci-?fi[- ]horror|dark[- ]comedy|romantic[- ]thriller)/i;

  // First, find all negated genres
  const notPattern = /\b(?:not|no|except|excluding)\s+(\w+(?:\s+\w+)?)/gi;
  const excludedGenres = new Set();
  let match;
  while ((match = notPattern.exec(q)) !== null) {
    const negatedTerm = match[1].toLowerCase().trim();
    // Check if it's a direct genre or has an alias
    if (supportedGenres.has(negatedTerm)) {
      excludedGenres.add(genreAliases[negatedTerm] || negatedTerm);
    } else {
      // Check against genre patterns
      for (const [genre, pattern] of Object.entries(basicGenres)) {
        if (pattern.test(negatedTerm)) {
          excludedGenres.add(genre);
          break;
        }
      }
      for (const [genre, pattern] of Object.entries(subGenres)) {
        if (pattern.test(negatedTerm)) {
          excludedGenres.add(genre);
          break;
        }
      }
    }
  }

  const genres = {
    include: [],
    exclude: Array.from(excludedGenres),
    mood: [],
    style: [],
  };

  // Handle combined genres
  const combinedMatch = q.match(combinedPattern);
  if (combinedMatch) {
    genres.include.push(combinedMatch[0].toLowerCase().replace(/\s+/g, "-"));
  }

  // After processing exclusions, check for genres to include
  // but make sure they're not in the excluded set
  for (const [genre, pattern] of Object.entries(basicGenres)) {
    if (pattern.test(q) && !excludedGenres.has(genre)) {
      // Don't include if it appears in a negation context
      const genreIndex = q.search(pattern);
      const beforeGenre = q.substring(0, genreIndex);
      if (!beforeGenre.match(/\b(not|no|except|excluding)\s+$/)) {
        genres.include.push(genre);
      }
    }
  }

  for (const [subgenre, pattern] of Object.entries(subGenres)) {
    if (pattern.test(q) && !excludedGenres.has(subgenre)) {
      // Don't include if it appears in a negation context
      const genreIndex = q.search(pattern);
      const beforeGenre = q.substring(0, genreIndex);
      if (!beforeGenre.match(/\b(not|no|except|excluding)\s+$/)) {
        genres.include.push(subgenre);
      }
    }
  }

  for (const [mood, pattern] of Object.entries(moods)) {
    if (pattern.test(q)) {
      genres.mood.push(mood);
    }
  }

  return Object.values(genres).some((arr) => arr.length > 0) ? genres : null;
}

// Add this function to better detect recommendation queries
function isRecommendationQuery(query) {
  return query.toLowerCase().trim().startsWith("recommend");
}

/**
 * Checks if an item is in the user's watch history or rated items
 * @param {Object} item - The item to check
 * @param {Array} watchHistory - The user's watch history from Trakt
 * @param {Array} ratedItems - The user's rated items from Trakt
 * @returns {boolean} - True if the item is in the watch history or rated items
 */
function isItemWatchedOrRated(item, watchHistory, ratedItems) {
  if (!item) {
    return false;
  }

  // Normalize the item name for comparison
  const normalizedName = item.name.toLowerCase().trim();
  const itemYear = parseInt(item.year);

  // Debug logging for specific items (uncomment for troubleshooting)
  // if (normalizedName.includes("specific movie title")) {
  //   logger.debug("Checking specific item", {
  //     item: { name: item.name, year: item.year },
  //     watchHistoryCount: watchHistory?.length || 0,
  //     ratedItemsCount: ratedItems?.length || 0
  //   });
  // }

  // Check if the item exists in watch history
  const isWatched =
    watchHistory &&
    watchHistory.length > 0 &&
    watchHistory.some((historyItem) => {
      const media = historyItem.movie || historyItem.show;
      if (!media) return false;

      const historyName = media.title.toLowerCase().trim();
      const historyYear = parseInt(media.year);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in watch history", {
      //     recommendation: { name: item.name, year: item.year },
      //     watchedItem: { title: media.title, year: media.year }
      //   });
      // }

      return (
        normalizedName === historyName &&
        (!itemYear || !historyYear || itemYear === historyYear)
      );
    });

  // Check if the item exists in rated items
  const isRated =
    ratedItems &&
    ratedItems.length > 0 &&
    ratedItems.some((ratedItem) => {
      const media = ratedItem.movie || ratedItem.show;
      if (!media) return false;

      const ratedName = media.title.toLowerCase().trim();
      const ratedYear = parseInt(media.year);

      // Debug logging for specific items (uncomment for troubleshooting)
      // if (normalizedName.includes("specific movie title") && isMatch) {
      //   logger.debug("Found match in rated items", {
      //     recommendation: { name: item.name, year: item.year },
      //     ratedItem: { title: media.title, year: media.year, rating: ratedItem.rating }
      //   });
      // }

      return (
        normalizedName === ratedName &&
        (!itemYear || !ratedYear || itemYear === ratedYear)
      );
    });

  return isWatched || isRated;
}

/**
 * Fetches the best available landscape thumbnail for recommendations.
 * Priority: 1) Fanart.tv moviethumb, 2) TMDB backdrop, 3) Fallback to portrait poster
 */
async function getLandscapeThumbnail(tmdbData, imdbId, fanartApiKey, _tmdbKey) {
  // 1. Try Fanart.tv first (best quality landscape thumbnails)
  if (fanartApiKey && imdbId) {
    try {
      const fanartThumb = await fetchFanartThumbnail(imdbId, fanartApiKey);
      if (fanartThumb) {
        logger.debug("Using Fanart.tv thumbnail", { imdbId, thumbnail: fanartThumb });
        return fanartThumb;
      }
    } catch (error) {
      logger.debug("Fanart.tv thumbnail fetch failed", { imdbId, error: error.message });
    }
  }
  
  // 2. Fallback to TMDB backdrop (convert to landscape-optimized size)
  if (tmdbData.backdrop) {
    const landscapeBackdrop = tmdbData.backdrop.replace('/original', '/w780');
    logger.debug("Using TMDB backdrop as thumbnail", { imdbId, thumbnail: landscapeBackdrop });
    return landscapeBackdrop;
  }
  
  // 3. Final fallback to portrait poster (better than nothing)
  logger.debug("Using portrait poster as thumbnail fallback", { imdbId, thumbnail: tmdbData.poster });
  return tmdbData.poster;
}

/**
 * Fetches landscape movie thumbnails from Fanart.tv
 */
async function fetchFanartThumbnail(imdbId, fanartApiKey) {
  if (!imdbId) return null;
  
  // Use provided key or fall back to default
  const effectiveFanartKey = fanartApiKey || DEFAULT_FANART_KEY;
  if (!effectiveFanartKey) {
    logger.debug("No Fanart.tv API key available", { imdbId });
    return null;
  }
  
  const cacheKey = `fanart_thumb_${imdbId}`;
  
  // Check cache first (using dedicated fanartCache)
  if (fanartCache.has(cacheKey)) {
    const cached = fanartCache.get(cacheKey);
    logger.debug("Fanart thumbnail cache hit", { 
      imdbId, 
      cacheKey,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      keyType: fanartApiKey ? "user" : "default"
    });
    return cached.data;
  }
  
  logger.debug("Fanart thumbnail cache miss", { 
    imdbId, 
    cacheKey,
    keyType: fanartApiKey ? "user" : "default"
  });
  
  try {
    // Optional dependency: Try to require fanart.tv package
    let fanart;
    try {
      const FanartApi = require("fanart.tv");
      fanart = new FanartApi(effectiveFanartKey);
    } catch (requireError) {
      logger.debug("Fanart.tv package not installed", { 
        imdbId, 
        error: "Package 'fanart.tv' not found. Install with: npm install fanart.tv" 
      });
      return null;
    }
    
    logger.info("Making Fanart.tv API call", {
      imdbId,
      keyType: fanartApiKey ? "user" : "default",
      apiKeyPrefix: effectiveFanartKey.substring(0, 4) + "..."
    });
    
    const data = await withRetry(
      async () => {
        return await fanart.movies.get(imdbId);
      },
      {
        maxRetries: 3,
        baseDelay: 1000,
        shouldRetry: (error) => !error.status || error.status !== 401,
        operationName: "Fanart.tv API call"
      }
    );
    
    const thumbnail = data?.moviethumb
      ?.filter(thumb => thumb.lang === 'en' || !thumb.lang || thumb.lang.trim() === '')
      ?.sort((a, b) => b.likes - a.likes)[0]?.url;
    
    // Cache the result
    fanartCache.set(cacheKey, {
      timestamp: Date.now(),
      data: thumbnail
    });
    
    logger.info("Fanart thumbnail API response", { 
      imdbId, 
      thumbnail: thumbnail ? "found" : "not_found",
      url: thumbnail ? thumbnail.substring(0, 50) + "..." : null,
      keyType: fanartApiKey ? "user" : "default"
    });
    
    return thumbnail;
  } catch (error) {
    logger.error("Fanart.tv API error", { 
      imdbId, 
      error: error.message,
      keyType: fanartApiKey ? "user" : "default"
    });
    
    // Cache null result to avoid repeated API calls for non-existent data
    fanartCache.set(cacheKey, {
      timestamp: Date.now(),
      data: null
    });
    
    return null;
  }
}

async function fetchRpdbPoster(
  imdbId,
  rpdbKey,
  posterType = "poster-default",
  isTier0User = false
) {
  if (!imdbId || !rpdbKey) {
    return null;
  }

  const cacheKey = `rpdb_${imdbId}_${posterType}`;
  const userTier = getRpdbTierFromApiKey(rpdbKey);
  const isDefaultKey = rpdbKey === DEFAULT_RPDB_KEY;
  const keyType = isDefaultKey ? "default" : "user";

  if (isTier0User && rpdbCache.has(cacheKey)) {
    const cached = rpdbCache.get(cacheKey);
    logger.info("RPDB poster cache hit", {
      cacheKey,
      imdbId,
      posterType,
      cachedAt: new Date(cached.timestamp).toISOString(),
      age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
      userTier: isDefaultKey
        ? "default-key"
        : userTier === 0
        ? "tier0"
        : `tier${userTier}`,
      keyType: keyType,
      cacheAccess: "enabled",
    });
    return cached.data;
  }

  if (!isTier0User) {
    logger.info("RPDB poster cache skipped (non-tier 0 user)", {
      imdbId,
      posterType,
      userTier: isDefaultKey
        ? "default-key"
        : userTier === 0
        ? "tier0"
        : `tier${userTier}`,
      keyType: keyType,
      cacheAccess: "disabled",
      apiKeyPrefix: rpdbKey.substring(0, 4) + "...",
    });
  } else {
    logger.info("RPDB poster cache miss", {
      cacheKey,
      imdbId,
      posterType,
      userTier: isDefaultKey ? "default-key" : "tier0",
      keyType: keyType,
      cacheAccess: "enabled",
      apiKeyPrefix: rpdbKey.substring(0, 4) + "...",
    });
  }

  try {
    const url = `https://api.ratingposterdb.com/${rpdbKey}/imdb/${posterType}/${imdbId}.jpg`;

    logger.info("Making RPDB API call", {
      imdbId,
      posterType,
      url: url.replace(rpdbKey, "***"),
      userTier: isDefaultKey
        ? "default-key"
        : userTier === 0
        ? "tier0"
        : `tier${userTier}`,
      keyType: keyType,
      cacheAccess: isTier0User ? "enabled" : "disabled",
    });
    const posterUrl = await withRetry(
      async () => {
        const response = await fetch(url);
        if (response.status === 404) {
          if (isTier0User) {
            rpdbCache.set(cacheKey, {
              timestamp: Date.now(),
              data: null,
            });
          }
          return null;
        }

        if (!response.ok) {
          const error = new Error(`RPDB API error: ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return url;
      },
      {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 5000,
        shouldRetry: (error) =>
          error.status !== 404 && (!error.status || error.status >= 500),
        operationName: "RPDB poster API call",
      }
    );
    if (isTier0User) {
      rpdbCache.set(cacheKey, {
        timestamp: Date.now(),
        data: posterUrl,
      });
      logger.debug("RPDB poster result cached", {
        cacheKey,
        imdbId,
        posterType,
        found: !!posterUrl,
        userTier: "tier0",
      });
    }

    return posterUrl;
  } catch (error) {
    logger.error("RPDB API Error:", {
      error: error.message,
      stack: error.stack,
      imdbId,
      posterType,
    });
    return null;
  }
}

async function toStremioMeta(
  item,
  platform = "unknown",
  tmdbKey,
  rpdbKey,
  rpdbPosterType = "poster-default",
  language = "en-US",
  config,
  includeAdult = false
) {
  if (!item.id || !item.name) {
    return null;
  }

  const type = item.type || (item.id.includes("movie") ? "movie" : "series");

  const enableRpdb =
    config?.EnableRpdb !== undefined ? config.EnableRpdb : false;
  const userRpdbKey = config?.RpdbApiKey;
  const usingUserKey = !!userRpdbKey;
  const usingDefaultKey = !userRpdbKey && !!DEFAULT_RPDB_KEY;
  const userTier = usingUserKey ? getRpdbTierFromApiKey(userRpdbKey) : -1;
  const isTier0User = (usingUserKey && userTier === 0) || usingDefaultKey;

  const normalizedTmdbId = Number.parseInt(item.tmdb_id, 10);
  let tmdbData = null;

  if (Number.isFinite(normalizedTmdbId)) {
    tmdbData = await getTmdbDetailsByTmdbId(
      normalizedTmdbId,
      type,
      tmdbKey,
      language
    );
  }

  if (!tmdbData) {
    tmdbData = await searchTMDB(
      item.name,
      type,
      item.year,
      tmdbKey,
      language,
      includeAdult
    );
  }

  if (tmdbData && item.imdb_id && !tmdbData.imdb_id) {
    tmdbData.imdb_id = item.imdb_id;
  }

  if (!tmdbData || !tmdbData.imdb_id) {
    return null;
  }

  // Start with TMDB poster as the default
  let poster = tmdbData.poster;
  let posterSource = "tmdb";

  // Only try RPDB if RPDB is enabled AND (a user key is provided OR a default key exists)
  const effectiveRpdbKey = userRpdbKey || DEFAULT_RPDB_KEY;
  if (enableRpdb && effectiveRpdbKey && tmdbData.imdb_id) {
    try {
      const rpdbPoster = await fetchRpdbPoster(
        tmdbData.imdb_id,
        effectiveRpdbKey,
        rpdbPosterType,
        isTier0User
      );
      if (rpdbPoster) {
        poster = rpdbPoster;
        posterSource = "rpdb";
        logger.debug("Using RPDB poster", {
          imdbId: tmdbData.imdb_id,
          posterType: rpdbPosterType,
          poster: rpdbPoster,
          userTier: usingUserKey
            ? userTier === 0
              ? "tier0"
              : `tier${userTier}`
            : "default-key",
          isTier0User: isTier0User,
          keyType: usingUserKey ? "user" : "default",
        });
      } else {
        logger.debug("No RPDB poster available, using TMDB poster", {
          imdbId: tmdbData.imdb_id,
          tmdbPoster: poster ? "available" : "unavailable",
          userTier: usingUserKey
            ? userTier === 0
              ? "tier0"
              : `tier${userTier}`
            : "default-key",
          isTier0User: isTier0User,
          keyType: usingUserKey ? "user" : "default",
        });
      }
    } catch (error) {
      logger.debug("RPDB poster fetch failed, using TMDB poster", {
        imdbId: tmdbData.imdb_id,
        error: error.message,
        tmdbPoster: poster ? "available" : "unavailable",
        userTier: usingUserKey
          ? userTier === 0
            ? "tier0"
            : `tier${userTier}`
          : "default-key",
        isTier0User: isTier0User,
        keyType: usingUserKey ? "user" : "default",
      });
    }
  }

  if (!poster) {
    logger.debug("No poster available from either source", {
      title: item.name,
      year: item.year,
      imdbId: tmdbData.imdb_id,
    });
    return null;
  }

  const meta = {
    id: tmdbData.imdb_id,
    type: type,
    name: tmdbData.title || tmdbData.name,
    description:
      platform === "android-tv"
        ? (tmdbData.overview || "").slice(0, 200)
        : tmdbData.overview || "",
    year: parseInt(item.year) || 0,
    poster:
      platform === "android-tv" && poster.includes("/w500/")
        ? poster.replace("/w500/", "/w342/")
        : poster,
    background: tmdbData.backdrop,
    posterShape: "regular",
    posterSource,
  };

  if (tmdbData.genres && tmdbData.genres.length > 0) {
    meta.genres = tmdbData.genres
      .map((id) => (type === "series" ? TMDB_TV_GENRES[id] : TMDB_GENRES[id]))
      .filter(Boolean);
  }

  return meta;
}

function detectPlatform(extra = {}) {
  if (extra.headers?.["stremio-platform"]) {
    return extra.headers["stremio-platform"];
  }

  const userAgent = (
    extra.userAgent ||
    extra.headers?.["stremio-user-agent"] ||
    ""
  ).toLowerCase();

  if (
    userAgent.includes("android tv") ||
    userAgent.includes("chromecast") ||
    userAgent.includes("androidtv")
  ) {
    return "android-tv";
  }

  if (
    userAgent.includes("android") ||
    userAgent.includes("mobile") ||
    userAgent.includes("phone")
  ) {
    return "mobile";
  }

  if (
    userAgent.includes("windows") ||
    userAgent.includes("macintosh") ||
    userAgent.includes("linux")
  ) {
    return "desktop";
  }

  return "unknown";
}

async function getTmdbDetailsByImdbId(imdbId, type, tmdbKey, language = "en-US") {
  const cacheKey = `details_imdb_${imdbId}_${type}_${language}`;
  if (tmdbDetailsCache.has(cacheKey)) {
    return tmdbDetailsCache.get(cacheKey).data;
  }

  try {
    const findUrl = `${TMDB_API_BASE}/find/${imdbId}?api_key=${tmdbKey}&language=${language}&external_source=imdb_id`;
    const response = await fetch(findUrl);
    if (!response.ok) {
      throw new Error(`TMDB find API error: ${response.status}`);
    }
    const data = await response.json();
    
    const results = type === 'movie' ? data.movie_results : data.tv_results;
    if (results && results.length > 0) {
      const details = results[0];
      tmdbDetailsCache.set(cacheKey, { timestamp: Date.now(), data: details });
      return details;
    }
    return null;
  } catch (error) {
    logger.error("Error fetching TMDB details by IMDB ID", { imdbId, error: error.message });
    return null;
  }
}

async function getTmdbDetailsByTmdbId(tmdbId, type, tmdbKey, language = "en-US") {
  const cacheKey = `details_tmdb_${tmdbId}_${type}_${language}`;
  if (tmdbDetailsCache.has(cacheKey)) {
    return tmdbDetailsCache.get(cacheKey).data;
  }

  try {
    const searchType = type === "movie" ? "movie" : "tv";
    const detailsUrl = `${TMDB_API_BASE}/${searchType}/${tmdbId}?api_key=${tmdbKey}&append_to_response=external_ids&language=${language}`;

    const detailsData = await withRetry(
      async () => {
        const response = await fetch(detailsUrl);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const error = new Error(
            `TMDB details API error: ${response.status} ${
              errorData?.status_message || ""
            }`
          );
          error.status = response.status;
          throw error;
        }
        return response.json();
      },
      {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 8000,
        operationName: "TMDB details API call by TMDB ID",
      }
    );

    const normalizedDetails = {
      poster: detailsData.poster_path
        ? `https://image.tmdb.org/t/p/w500${detailsData.poster_path}`
        : null,
      backdrop: detailsData.backdrop_path
        ? `https://image.tmdb.org/t/p/original${detailsData.backdrop_path}`
        : null,
      tmdbRating: detailsData.vote_average,
      genres: Array.isArray(detailsData.genres)
        ? detailsData.genres.map((genre) => genre.id).filter(Boolean)
        : [],
      overview: detailsData.overview || "",
      tmdb_id: detailsData.id,
      title: detailsData.title || detailsData.name,
      release_date: detailsData.release_date || detailsData.first_air_date,
      imdb_id: detailsData.imdb_id || detailsData.external_ids?.imdb_id || null,
    };

    tmdbDetailsCache.set(cacheKey, { timestamp: Date.now(), data: normalizedDetails });
    return normalizedDetails;
  } catch (error) {
    logger.error("Error fetching TMDB details by TMDB ID", {
      tmdbId,
      type,
      error: error.message,
    });
    return null;
  }
}

const TMDB_GENRES = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
};

// TV specific genres
const TMDB_TV_GENRES = {
  10759: "Action & Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  10762: "Kids",
  9648: "Mystery",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
  37: "Western",
};

function clearTmdbCache() {
  const size = tmdbCache.size;
  tmdbCache.clear();
  logger.info("TMDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTmdbDetailsCache() {
  const size = tmdbDetailsCache.size;
  tmdbDetailsCache.clear();
  logger.info("TMDB details cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTmdbDiscoverCache() {
  const size = tmdbDiscoverCache.size;
  tmdbDiscoverCache.clear();
  logger.info("TMDB discover cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

/**
 * Removes a specific item from the TMDB discover cache
 * @param {string} cacheKey - The cache key to remove
 * @returns {Object} - Result of the operation
 */
function removeTmdbDiscoverCacheItem(cacheKey) {
  if (!cacheKey) {
    return {
      success: false,
      message: "No cache key provided",
    };
  }

  if (!tmdbDiscoverCache.has(cacheKey)) {
    return {
      success: false,
      message: "Cache key not found",
      key: cacheKey,
    };
  }

  tmdbDiscoverCache.delete(cacheKey);
  logger.info("TMDB discover cache item removed", { cacheKey });

  return {
    success: true,
    message: "Cache item removed successfully",
    key: cacheKey,
  };
}

/**
 * Lists all keys in the TMDB discover cache
 * @returns {Object} - Object containing all cache keys
 */
function listTmdbDiscoverCacheKeys() {
  const keys = Array.from(tmdbDiscoverCache.cache.keys());
  logger.info("TMDB discover cache keys listed", { count: keys.length });

  return {
    success: true,
    count: keys.length,
    keys: keys,
  };
}

function clearAiCache() {
  clearAiCacheDb().catch((error) => {
    logger.error("Failed to clear Turso AI recommendations cache", {
      error: error.message,
    });
  });
  logger.info("AI recommendations cache clear requested", { backend: "turso" });
  return { cleared: true, previousSize: null, pending: true, backend: "turso" };
}

function removeAiCacheByKeywords(keywords) {
  try {
    if (!keywords || typeof keywords !== "string") {
      throw new Error("Invalid keywords parameter");
    }

    const searchPhrase = keywords.toLowerCase().trim();
    const escapedPhrase = searchPhrase.replace(/[\\%_]/g, "\\$&");
    const likePattern = `%${escapedPhrase}%`;

    (async () => {
      const matchedRows = await tursoClient.execute({
        sql: `
          SELECT cache_key, created_at
          FROM ai_cache
          WHERE LOWER(SUBSTR(cache_key, 1, INSTR(cache_key || '_', '_') - 1)) LIKE ? ESCAPE '\\'
        `,
        args: [likePattern],
      });

      const removedEntries = matchedRows.rows.map((row) => ({
        key: row.cache_key,
        timestamp: new Date(Number(row.created_at)).toISOString(),
        query: String(row.cache_key).split("_")[0],
      }));

      const deleteResult = await tursoClient.execute({
        sql: `
          DELETE FROM ai_cache
          WHERE LOWER(SUBSTR(cache_key, 1, INSTR(cache_key || '_', '_') - 1)) LIKE ? ESCAPE '\\'
        `,
        args: [likePattern],
      });

      logger.info("AI recommendations cache entries removed by keywords", {
        backend: "turso",
        keywords: searchPhrase,
        totalRemoved: Number(deleteResult.rowsAffected ?? 0),
        removedEntries,
      });
    })().catch((error) => {
      logger.error("Error in removeAiCacheByKeywords async delete", {
        error: error.message,
        stack: error.stack,
        keywords: searchPhrase,
      });
    });

    return {
      removed: 0,
      entries: [],
      pending: true,
      backend: "turso",
    };
  } catch (error) {
    logger.error("Error in removeAiCacheByKeywords:", {
      error: error.message,
      stack: error.stack,
      keywords,
    });
    throw error;
  }
}

function clearRpdbCache() {
  const size = rpdbCache.size;
  rpdbCache.clear();
  logger.info("RPDB cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearFanartCache() {
  const size = fanartCache.size;
  fanartCache.clear();
  logger.info("Fanart.tv cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearTraktCache() {
  clearTraktCacheDb().catch((error) => {
    logger.error("Failed to clear Turso Trakt cache", {
      error: error.message,
    });
  });
  logger.info("Trakt cache clear requested", { backend: "turso" });
  return { cleared: true, previousSize: null, pending: true, backend: "turso" };
}

function clearTraktRawDataCache() {
  const size = traktRawDataCache.size;
  traktRawDataCache.clear();
  logger.info("Trakt raw data cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearQueryAnalysisCache() {
  const size = queryAnalysisCache.size;
  queryAnalysisCache.clear();
  logger.info("Query analysis cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function clearSimilarContentCache() {
  const size = similarContentCache.size;
  similarContentCache.clear();
  logger.info("Similar content cache cleared", { previousSize: size });
  return { cleared: true, previousSize: size };
}

function getCacheStats() {
  return {
    tmdbCache: {
      size: tmdbCache.size,
      maxSize: tmdbCache.max,
      usagePercentage:
        ((tmdbCache.size / tmdbCache.max) * 100).toFixed(2) + "%",
    },
    tmdbDetailsCache: {
      size: tmdbDetailsCache.size,
      maxSize: tmdbDetailsCache.max,
      usagePercentage:
        ((tmdbDetailsCache.size / tmdbDetailsCache.max) * 100).toFixed(2) + "%",
    },
    tmdbDiscoverCache: {
      size: tmdbDiscoverCache.size,
      maxSize: tmdbDiscoverCache.max,
      usagePercentage:
        ((tmdbDiscoverCache.size / tmdbDiscoverCache.max) * 100).toFixed(2) +
        "%",
    },
    aiCache: {
      backend: "turso",
      inMemory: false,
      size: null,
      maxSize: null,
      usagePercentage: null,
    },
    rpdbCache: {
      size: rpdbCache.size,
      maxSize: rpdbCache.max,
      usagePercentage:
        ((rpdbCache.size / rpdbCache.max) * 100).toFixed(2) + "%",
    },
    fanartCache: {
      size: fanartCache.size,
      maxSize: fanartCache.max,
      usagePercentage:
        ((fanartCache.size / fanartCache.max) * 100).toFixed(2) + "%",
    },
    traktCache: {
      backend: "turso",
      inMemory: false,
      size: null,
      maxSize: null,
      usagePercentage: null,
    },
    traktRawDataCache: {
      size: traktRawDataCache.size,
      maxSize: traktRawDataCache.max,
      usagePercentage:
        ((traktRawDataCache.size / traktRawDataCache.max) * 100).toFixed(2) +
        "%",
    },
    queryAnalysisCache: {
      size: queryAnalysisCache.size,
      maxSize: queryAnalysisCache.max,
      usagePercentage:
        ((queryAnalysisCache.size / queryAnalysisCache.max) * 100).toFixed(2) +
        "%",
    },
    similarContentCache: {
      size: similarContentCache.size,
      maxSize: similarContentCache.max,
      usagePercentage:
        ((similarContentCache.size / similarContentCache.max) * 100).toFixed(2) + "%",
    },
  };
}

// Function to serialize all caches
function serializeAllCaches() {
  return {
    tmdbCache: tmdbCache.serialize(),
    tmdbDetailsCache: tmdbDetailsCache.serialize(),
    tmdbDiscoverCache: tmdbDiscoverCache.serialize(),
    rpdbCache: rpdbCache.serialize(),
    fanartCache: fanartCache.serialize(),
    traktRawDataCache: traktRawDataCache.serialize(),
    queryAnalysisCache: queryAnalysisCache.serialize(),
    similarContentCache: similarContentCache.serialize(),
    stats: {
      queryCounter: queryCounter,
    },
  };
}

// Function to load data into all caches
function deserializeAllCaches(data) {
  const results = {};

  if (data.tmdbCache) {
    results.tmdbCache = tmdbCache.deserialize(data.tmdbCache);
  }

  if (data.tmdbDetailsCache) {
    results.tmdbDetailsCache = tmdbDetailsCache.deserialize(
      data.tmdbDetailsCache
    );
  }

  if (data.tmdbDiscoverCache) {
    results.tmdbDiscoverCache = tmdbDiscoverCache.deserialize(
      data.tmdbDiscoverCache
    );
  }

  if (data.rpdbCache) {
    results.rpdbCache = rpdbCache.deserialize(data.rpdbCache);
  }

  if (data.fanartCache) {
    results.fanartCache = fanartCache.deserialize(data.fanartCache);
  }

  if (data.traktRawDataCache) {
    results.traktRawDataCache = traktRawDataCache.deserialize(
      data.traktRawDataCache
    );
  }

  if (data.queryAnalysisCache) {
    results.queryAnalysisCache = queryAnalysisCache.deserialize(
      data.queryAnalysisCache
    );
  }

  if (data.similarContentCache) {
    results.similarContentCache = similarContentCache.deserialize(
      data.similarContentCache
    );
  }

  if (data.stats && typeof data.stats.queryCounter === "number") {
    queryCounter = data.stats.queryCounter;
    logger.info("Query counter restored from cache", {
      totalQueries: queryCounter,
    });
  }

  return results;
}

/**
 * Makes an AI call to determine the content type and genres for a recommendation query
 * @param {string} query - The user's search query
 * @param {string} geminiKey - The Gemini API key
 * @param {string} geminiModel - The Gemini model to use
 * @returns {Promise<{type: string, genres: string[]}>} - The discovered type and genres
 */
async function discoverTypeAndGenres(query, geminiKey, geminiModel) {
  const ai = new GoogleGenAI({ apiKey: geminiKey });
  let classifyTokenUsage = null;

  const promptText = buildClassificationPrompt(query);

  logger.agent("CLASSIFY_PROMPT", {
    query,
    model: geminiModel,
    promptText,
  });

  try {
    logger.info("Making genre discovery API call", {
      query,
      model: geminiModel,
    });

    // Use withRetry for the Gemini API call
    const rawText = await withRetry(
      async () => {
        try {
          const config = {
            responseMimeType: "application/json",
            responseJsonSchema: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["movie", "series", "ambiguous"],
                },
                genres: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["type", "genres"],
              propertyOrdering: ["type", "genres"],
            },
          };

           if (/2\.5|[3-9]\./i.test(geminiModel) && !/-lite/i.test(geminiModel)) {
             config.thinkingConfig = { thinkingBudget: 256 };
          }

          const aiResult = await ai.models.generateContent({
            model: geminiModel,
            config,
            contents: promptText,
          });
          const responseText = aiResult.text.trim();
          classifyTokenUsage =
            aiResult.usageMetadata || {
              promptTokenCount: aiResult.promptFeedback?.tokenCount ?? null,
            };

          // Log successful response with more details
          logger.info("Genre discovery API response", {
            promptTokens: aiResult.promptFeedback?.tokenCount,
            candidates: aiResult.candidates?.length,
            safetyRatings: aiResult.candidates?.[0]?.safetyRatings,
            responseTextLength: responseText.length,
            responseTextSample: responseText,
          });

          return aiResult.text;
        } catch (error) {
          // Enhance error with status for retry logic
          logger.agent("CLASSIFY_ERROR", {
            query,
            model: geminiModel,
            error: {
              message: error.message,
              status: error.httpStatus || 500,
              stack: error.stack,
            },
          });
          logger.error("Genre discovery API call failed", {
            error: error.message,
            status: error.httpStatus || 500,
            stack: error.stack,
          });
          error.status = error.httpStatus || 500;
          throw error;
        }
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        // Don't retry 400 errors (bad requests)
        shouldRetry: (error) => !error.status || error.status !== 400,
        operationName: "Genre discovery API call",
      }
    );

    // Try to parse the JSON format
    try {
      const parsed = JSON.parse(rawText);
      const type =
        parsed && typeof parsed.type === "string"
          ? parsed.type.trim().toLowerCase()
          : "ambiguous";
      const genres = Array.isArray(parsed?.genres)
        ? parsed.genres
            .map((g) => (typeof g === "string" ? g.trim() : ""))
            .filter((g) => g.length > 0 && g.toLowerCase() !== "ambiguous")
        : [];

      const normalizedGenres =
        genres.length === 1 && genres[0].toLowerCase() === "all" ? [] : genres;

      logger.agent("CLASSIFY_RESPONSE", {
        query,
        model: geminiModel,
        responseText: rawText,
        classification: {
          type,
          genres: normalizedGenres,
        },
        tokenUsage: classifyTokenUsage,
      });

      // If the only genre is "all", clear the genres array to use all genres
      if (normalizedGenres.length === 0 && genres.length === 1) {
        logger.info(
          "'All' genres specified, will use all genres for recommendations",
          {
            query,
            type,
          }
        );
        return {
          type: type,
          genres: [],
        };
      }

      logger.info("Successfully parsed genre discovery response", {
        type: type,
        genresCount: normalizedGenres.length,
        genres: normalizedGenres,
      });

      return {
        type: type,
        genres: normalizedGenres,
      };
    } catch (error) {
      logger.agent("CLASSIFY_ERROR", {
        query,
        model: geminiModel,
        error: {
          message: error.message,
          stack: error.stack,
        },
      });
      logger.error("Failed to parse genre discovery response", {
        error: error.message,
        fullResponse: rawText,
      });
      throw error;
    }
  } catch (error) {
    logger.error("Genre discovery API error", {
      error: error.message,
      stack: error.stack,
    });
    return { type: "ambiguous", genres: [] };
  }
}

/**
 * Filters Trakt data based on specified genres
 * @param {Object} traktData - The complete Trakt data
 * @param {string[]} genres - The genres to filter by
 * @returns {Object} - The filtered Trakt data
 */
function filterTraktDataByGenres(traktData, genres) {
  if (!traktData || !genres || genres.length === 0) {
    return {
      recentlyWatched: [],
      highlyRated: [],
      lowRated: [],
    };
  }

  const { watched, rated } = traktData;
  const genreSet = new Set(genres.map((g) => g.toLowerCase()));

  // Helper function to check if an item has any of the specified genres
  const hasMatchingGenre = (item) => {
    const media = item.movie || item.show;
    if (!media || !media.genres || media.genres.length === 0) return false;

    return media.genres.some((g) => genreSet.has(g.toLowerCase()));
  };

  // Filter watched items by genre
  const recentlyWatched = (watched || []).filter(hasMatchingGenre).slice(0, 100);

  // Filter highly rated items (4-5 stars)
  const highlyRated = (rated || [])
    .filter((item) => item.rating >= 4)
    .filter(hasMatchingGenre)
    .slice(0, 100); // Top 100 highly rated

  // Filter low rated items (1-2 stars)
  const lowRated = (rated || [])
    .filter((item) => item.rating <= 2)
    .filter(hasMatchingGenre)
    .slice(0, 100); // Top 100 low rated

  return {
    recentlyWatched,
    highlyRated,
    lowRated,
  };
}

// Function to increment and get the query counter
function incrementQueryCounter(amount = 1) {
  queryCounter += amount;
  logger.info("Query counter incremented", { added: amount, totalQueries: queryCounter });
  incrementStat('recommendations_served', amount).catch(err => {
    logger.error('Failed to persist counter increment', { error: err.message });
  });
  return queryCounter;
}

// Function to get the current query count
function getQueryCount() {
  return queryCounter;
}

// Function to set the query counter to a specific value
function setQueryCount(count) {
  queryCounter = count;
  setStatValue('recommendations_served', count).catch(err => {
    logger.error('Failed to persist counter set', { error: err.message });
  });
  return queryCounter;
}

function getRpdbTierFromApiKey(apiKey) {
  if (!apiKey) return -1;
  try {
    const tierMatch = apiKey.match(/^t(\d+)-/);
    if (tierMatch && tierMatch[1] !== undefined) {
      return parseInt(tierMatch[1]);
    }
    return -1;
  } catch (error) {
    logger.error("Error parsing RPDB tier from API key", {
      error: error.message,
    });
    return -1;
  }
}

function getTraktItemTimestamp(item, fallbackIndex = 0) {
  const candidates = [
    item?.listed_at,
    item?.rated_at,
    item?.watched_at,
    item?.last_watched_at,
    item?.updated_at,
    item?.collected_at,
  ];

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  return Number.MAX_SAFE_INTEGER - fallbackIndex;
}

function buildDoNotRecommendList(watchedItems = [], ratedItems = []) {
  const combined = [];
  let order = 0;

  (Array.isArray(watchedItems) ? watchedItems : []).forEach((item, index) => {
    combined.push({ item, index, order: order += 1 });
  });

  (Array.isArray(ratedItems) ? ratedItems : []).forEach((item, index) => {
    combined.push({ item, index, order: order += 1 });
  });

  combined.sort((left, right) => {
    const leftTs = getTraktItemTimestamp(left.item, left.index);
    const rightTs = getTraktItemTimestamp(right.item, right.index);

    if (leftTs !== rightTs) {
      return rightTs - leftTs;
    }

    return left.order - right.order;
  });

  const deduped = new Map();

  combined.forEach(({ item }) => {
    const normalized = normalizeMediaKey(item);
    if (!normalized.type && normalized.tmdb_id == null && !normalized.imdb_id && !normalized.title) {
      return;
    }

    const key = buildMediaIdentityKeys(normalized)[0] || [
      normalized.type || "",
      normalized.tmdb_id ?? "",
      normalized.imdb_id || "",
      normalized.title || "",
      normalized.year ?? "",
    ].join("|");

    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  });

  const withTmdb = [];
  const withoutTmdb = [];

  for (const normalized of deduped.values()) {
    if (normalized.tmdb_id != null) {
      withTmdb.push(normalized);
    } else {
      withoutTmdb.push(normalized);
    }
  }

  return [...withTmdb, ...withoutTmdb].slice(0, MAX_DO_NOT_RECOMMEND_ITEMS);
}

function createFilterCandidates({ traktWatchedIdSet, traktRatedIdSet }) {
  const seenTmdb = new Set();

  const hasMatch = (candidate) => {
    const normalized = normalizeMediaKey(candidate);
    const keys = buildMediaIdentityKeys(normalized);

    return keys.some((key) => traktWatchedIdSet.has(key) || traktRatedIdSet.has(key));
  };

  return function filterCandidates(rawItems = []) {
    const unwatched = [];
    const droppedWatched = [];
    const droppedNoId = [];
    const droppedDuplicates = [];

    (Array.isArray(rawItems) ? rawItems : []).forEach((item) => {
      const normalized = normalizeMediaKey(item);

      if (!normalized.tmdb_id) {
        droppedNoId.push(item);
        return;
      }

      const tmdbKey = `tmdb:${normalized.type || ""}:${normalized.tmdb_id}`;
      if (seenTmdb.has(tmdbKey)) {
        droppedDuplicates.push(item);
        return;
      }

      if (hasMatch(normalized)) {
        droppedWatched.push(item);
        seenTmdb.add(tmdbKey);
        return;
      }

      unwatched.push(item);
      seenTmdb.add(tmdbKey);
    });

    return {
      unwatched,
      droppedWatched,
      droppedNoId,
      droppedDuplicates,
    };
  };
}

const catalogHandler = async function (args, req) {
  const startTime = Date.now();
  const { id, type, extra } = args;
  let isHomepageQuery = false;

  try {
    const configData = args.config;

    if (!configData || Object.keys(configData).length === 0) {
      logger.error('Configuration Missing', { reason: 'The addon has not been configured yet. Please set your API keys.' });
      const errorMeta = createErrorMeta('Configuration Missing', 'The addon has not been configured yet. Please set your API keys.');
      return { metas: [errorMeta] };
    }

    const geminiKey = configData.GeminiApiKey;
    const tmdbKey = configData.TmdbApiKey;

    if (configData.traktConnectionError) {
      logger.error('Trakt Connection Failed', { reason: 'User access to Trakt.tv has expired or was revoked.' });
      const errorMeta = createErrorMeta('Trakt Connection Failed', 'Your access to Trakt.tv has expired or was revoked. Please log in again via the addon configuration page.');
      return { metas: [errorMeta] };
    }
    if (!tmdbKey || tmdbKey.length < 10) {
      logger.error('TMDB API Key Invalid', { reason: 'Your TMDB API key is missing or invalid.' });
      const errorMeta = createErrorMeta('TMDB API Key Invalid', 'Your TMDB API key is missing or invalid. Please correct it in the addon settings.');
      return { metas: [errorMeta] };
    }
    const tmdbValidationUrl = `https://api.themoviedb.org/3/configuration?api_key=${tmdbKey}`;
    const tmdbResponse = await fetch(tmdbValidationUrl);
    if (!tmdbResponse.ok) {
      logger.error('TMDB API Key Validation Failed', { reason: `The key failed validation (Status: ${tmdbResponse.status}).`, keyUsed: tmdbKey.substring(0, 4) + '...' });
      const errorMeta = createErrorMeta('TMDB API Key Invalid', `The key failed validation (Status: ${tmdbResponse.status}). Please check your TMDB key in the addon settings.`);
      return { metas: [errorMeta] };
    }
    if (!geminiKey || geminiKey.length < 10) {
      logger.error('Gemini API Key Invalid', { reason: 'Your Gemini API key is missing or invalid.' });
      const errorMeta = createErrorMeta('Gemini API Key Invalid', 'Your Gemini API key is missing or invalid. Please correct it in the addon settings.');
      return { metas: [errorMeta] };
    }

    let searchQuery = "";
    if (typeof extra === "string" && extra.includes("search=")) {
      searchQuery = decodeURIComponent(extra.split("search=")[1]);
    } else if (extra?.search) {
      searchQuery = extra.search;
    }

    if (!configData || Object.keys(configData).length === 0) {
      logger.error("Missing configuration - Please configure the addon first");
      logger.emptyCatalog("Missing configuration", { type, extra });
      return {
        metas: [],
        error: "Please configure the addon with valid API keys first",
      };
    }

    if (!searchQuery) {
      if (id.startsWith("aipicks.home.")) {
        isHomepageQuery = true;
        let homepageQueries = configData.HomepageQuery;

        if (!homepageQueries || homepageQueries.trim() === '') {
            homepageQueries = "AI Recommendations:recommend a hidden gem movie, AI Recommendations:recommend a binge-worthy series";
        }

        const catalogEntries = homepageQueries.split("|||").map(q => q.trim()).filter(Boolean);

        const idParts = id.split(".");
        
        if (idParts.length === 4 && homepageQueries) {
          const queryIndex = parseInt(idParts[2], 10);
          if (!isNaN(queryIndex) && catalogEntries[queryIndex]) {
            const entry = catalogEntries[queryIndex];
            const parts = entry.split(/:(.*)/s);
            if (parts.length > 1 && parts[1].trim()) {
                searchQuery = parts[1].trim();
            } else {
                searchQuery = entry;
            }
            logger.info("Using custom homepage query from list", { type, query: searchQuery, index: queryIndex });
          }
        }

        // If after all that, we still don't have a search query, it's an error.
        if (!searchQuery) {
          logger.error("Failed to resolve homepage query from ID and config", { id });
          const errorMeta = createErrorMeta('Configuration Error', 'Could not find the matching homepage query for this catalog.');
          return { metas: [errorMeta] };
        }
      } else {
        logger.error("No search query provided");
        logger.emptyCatalog("No search query provided", { type, extra });
        const errorMeta = createErrorMeta('Search Required', 'Please enter a search term to get AI recommendations.');
        return { metas: [errorMeta] }
      }
    }

    // Log the Trakt configuration
    logger.info("Trakt configuration", {
      hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
      traktClientIdLength: DEFAULT_TRAKT_CLIENT_ID?.length || 0,
      hasTraktAccessToken: !!configData.TraktAccessToken,
      traktAccessTokenLength: configData.TraktAccessToken?.length || 0,
    });

    const geminiModel = configData.GeminiModel || DEFAULT_GEMINI_MODEL;
    const language = configData.TmdbLanguage || "en-US";
    const traktUsername = configData.traktUsername || configData.TraktUsername || "";
    const traktAccessToken = configData.TraktAccessToken || "";
    const traktClientId = DEFAULT_TRAKT_CLIENT_ID;
    const filterWatched =
      configData.FilterWatched !== undefined ? configData.FilterWatched !== false : true;
    const parsedMaxTurns = Number.parseInt(configData.MaxTurns, 10);
    const maxTurns = Number.isFinite(parsedMaxTurns)
      ? Math.min(12, Math.max(4, parsedMaxTurns))
      : 6;

    if (!geminiKey || geminiKey.length < 10) {
      logger.error("Invalid or missing Gemini API key");
      return {
        metas: [],
        error:
          "Invalid Gemini API key. Please reconfigure the addon with a valid key.",
      };
    }

    if (!tmdbKey || tmdbKey.length < 10) {
      logger.error("Invalid or missing TMDB API key");
      return {
        metas: [],
        error:
          "Invalid TMDB API key. Please reconfigure the addon with a valid key.",
      };
    }

    const rpdbKey = configData.RpdbApiKey || DEFAULT_RPDB_KEY;
    const rpdbPosterType = configData.RpdbPosterType || "poster-default";
    let numResults = parseInt(configData.NumResults) || 20;
    // Limit numResults to a maximum of 30
    if (numResults > 30) {
      numResults = MAX_AI_RECOMMENDATIONS;
    }
    const enableAiCache =
      configData.EnableAiCache !== undefined ? configData.EnableAiCache : true;
    // NEW: Read the EnableRpdb flag
    const enableRpdb =
      configData.EnableRpdb !== undefined ? configData.EnableRpdb : false;
    const includeAdult = configData.IncludeAdult === true;

    if (ENABLE_LOGGING) {
      logger.debug("Catalog handler config", {
        numResults,
        rawNumResults: configData.NumResults,
        type,
        hasGeminiKey: !!geminiKey,
        hasTmdbKey: !!tmdbKey,
        hasRpdbKey: !!rpdbKey,
        isDefaultRpdbKey: rpdbKey === DEFAULT_RPDB_KEY,
        rpdbPosterType: rpdbPosterType,
        enableAiCache: enableAiCache,
        enableRpdb: enableRpdb,
        includeAdult: includeAdult,
        geminiModel: geminiModel,
        language: language,
        hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
        hasTraktAccessToken: !!configData.TraktAccessToken,
      });
    }

    if (!geminiKey || !tmdbKey) {
      logger.error("Missing API keys in catalog handler");
      logger.emptyCatalog("Missing API keys", { type, extra });
      return { metas: [] };
    }

    const platform = detectPlatform(extra);
    logger.debug("Platform detected", { platform, extra });

    // Only increment the counter and log for initial search queries, not for clicks on individual items
    const isSearchRequest =
      (typeof extra === "string" && extra.includes("search=")) ||
      !!extra?.search;
    if (isSearchRequest) {
      logger.query(searchQuery);
      logger.info("Processing search query", { searchQuery, type });
    }

    // First, determine the intent for ALL queries
    const intent = determineIntentFromKeywords(searchQuery);

    // If the intent is specific (not ambiguous) and doesn't match the requested type,
    // return empty results regardless of whether it's a recommendation or search
    if (intent !== "ambiguous" && intent !== type) {
      logger.error("Intent mismatch - returning empty results", {
        intent,
        type,
        searchQuery,
        message: `This ${
          isRecommendationQuery(searchQuery) ? "recommendation" : "search"
        } appears to be for ${intent}, not ${type}`,
      });
      return { metas: [] };
    }

    let exactMatchMeta = null;
    let tmdbInitialResults = [];
    let matchResult = null; 

    if (!isRecommendationQuery(searchQuery)) {
      logger.info("Checking for TMDB exact match and gathering initial results", {
        searchQuery,
        type,
      });
      
      matchResult = await searchTMDBExactMatch(
        searchQuery,
        type,
        tmdbKey,
        language,
        includeAdult
      );

      if (matchResult) {
        tmdbInitialResults = matchResult.results;
        if (matchResult.isExactMatch) {
          const normalizedTitle = searchQuery.toLowerCase().trim();
          const exactMatchData = matchResult.results.find(r => (r.title || r.name || "").toLowerCase().trim() === normalizedTitle);
          if (exactMatchData) {
            const details = await getTmdbDetailsByImdbId(exactMatchData.id, type, tmdbKey);
            if (details && details.imdb_id) {
              const exactMatchItem = {
                id: `exact_${exactMatchData.id}`,
                name: exactMatchData.title || exactMatchData.name,
                year: (exactMatchData.release_date || exactMatchData.first_air_date || 'N/A').substring(0,4),
                type: type,
              };
            exactMatchMeta = await toStremioMeta(
              exactMatchItem,
              platform,
              tmdbKey,
              rpdbKey,
              rpdbPosterType,
              language,
              configData,
              includeAdult
            );
            if (exactMatchMeta) {
              logger.info("TMDB exact match found and converted to meta", {
                searchQuery,
                exactMatchTitle: exactMatchMeta.name,
              });
            }
          }
        }
      }
    }
    logger.info(`Found ${tmdbInitialResults.length} initial TMDB results for context.`, { searchQuery });
  }

    // Now check if it's a recommendation query
    const isRecommendation = isRecommendationQuery(searchQuery);
    let discoveredGenres = [];
    let traktData = null;
    let filteredTraktData = null;

    // For recommendation queries, use the new workflow with genre discovery
    if (isRecommendation) {

      // Make the genre discovery API call
      try {
        const discoveryResult = await discoverTypeAndGenres(
          searchQuery,
          geminiKey,
          geminiModel
        );
        discoveredGenres = discoveryResult.genres;
      } catch (error) {
        logger.warn("Genre discovery failed, continuing with defaults", {
          error: error.message,
          searchQuery,
        });
        // Defaults already set: discoveredType = type, discoveredGenres = []
      }

      // Log if we couldn't discover any genres for a recommendation query
      if (discoveredGenres.length === 0) {
        if (ENABLE_LOGGING) {
          logger.emptyCatalog("No genres discovered for recommendation query", {
            type,
            searchQuery,
            isRecommendation: true,
          });
        }
      }

      logger.info("Genre discovery results", {
        query: searchQuery,
        discoveredGenres,
        originalType: type,
      });

      // If Trakt is configured, get user data ONLY for recommendation queries
      if (DEFAULT_TRAKT_CLIENT_ID && configData.TraktAccessToken) {
        logger.info("Fetching Trakt data for recommendation query", {
          hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
          traktClientIdLength: DEFAULT_TRAKT_CLIENT_ID?.length,
          hasTraktAccessToken: !!configData.TraktAccessToken,
          traktAccessTokenLength: configData.TraktAccessToken?.length,
          isRecommendation: isRecommendation,
          query: searchQuery,
        });

        traktData = await fetchTraktWatchedAndRated(
          DEFAULT_TRAKT_CLIENT_ID,
          configData.TraktAccessToken,
          type === "movie" ? "movies" : "shows",
          configData
        );

        logger.agent('TRAKT_FETCH_RESULT', {
          traktDataExists: !!traktData,
          watchedCount: traktData?.watched?.length ?? 0,
          ratedCount: traktData?.rated?.length ?? 0,
          historyCount: traktData?.history?.length ?? 0,
          preferencesExists: !!traktData?.preferences,
          isIncrementalUpdate: traktData?.isIncrementalUpdate ?? null,
          watchedSample: (traktData?.watched || []).slice(0, 2).map(item => {
            const media = item?.movie || item?.show;
            return { title: media?.title, year: media?.year, tmdb: media?.ids?.tmdb, imdb: media?.ids?.imdb, type: item?.movie ? 'movie' : 'show' };
          }),
        });

        // Filter Trakt data based on discovered genres if we have any
        if (traktData) {
          if (discoveredGenres.length > 0) {
            filteredTraktData = filterTraktDataByGenres(
              traktData,
              discoveredGenres
            );

            logger.info("Filtered Trakt data by genres", {
              genres: discoveredGenres,
              recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
              highlyRatedCount: filteredTraktData.highlyRated.length,
              lowRatedCount: filteredTraktData.lowRated.length,
            });

            // Log if filtering by genres eliminated all Trakt data
            if (
              filteredTraktData.recentlyWatched.length === 0 &&
              filteredTraktData.highlyRated.length === 0 &&
              filteredTraktData.lowRated.length === 0
            ) {
              if (ENABLE_LOGGING) {
                logger.emptyCatalog("No Trakt data matches discovered genres", {
                  type,
                  searchQuery,
                  discoveredGenres,
                  totalWatched: traktData.watched.length,
                  totalRated: traktData.rated.length,
                });
              }
            }
          } else {
            // When no genres are discovered, use all Trakt data
            filteredTraktData = {
              recentlyWatched: traktData.watched?.slice(0, 100) || [],
              highlyRated: (traktData.rated || [])
                .filter((item) => item.rating >= 4)
                .slice(0, 25),
              lowRated: (traktData.rated || [])
                .filter((item) => item.rating <= 2)
                .slice(0, 25),
            };

            logger.info(
              "Using all Trakt data (no specific genres discovered)",
              {
                totalWatched: traktData.watched?.length || 0,
                totalRated: traktData.rated?.length || 0,
                recentlyWatchedCount: filteredTraktData.recentlyWatched.length,
                highlyRatedCount: filteredTraktData.highlyRated.length,
                lowRatedCount: filteredTraktData.lowRated.length,
              }
            );
          }
        }
      } else {
        logger.agent('TRAKT_FETCH_SKIPPED', {
          hasTraktClientId: !!DEFAULT_TRAKT_CLIENT_ID,
          hasTraktAccessToken: !!configData.TraktAccessToken,
          reason: !DEFAULT_TRAKT_CLIENT_ID ? 'missing_TRAKT_CLIENT_ID_env' : 'missing_user_TraktAccessToken',
        });
      }
    }

    const traktIdentity = traktUsername ? `trakt_${traktUsername}` : "no_trakt";
    const cacheKey = `${searchQuery}_${type}_${traktIdentity}`;
    const tursoCache = enableAiCache ? await getAiCache(cacheKey) : null;

    // Check cache for all queries (including Trakt users and homepage queries)
    if (tursoCache) {
      const cached = tursoCache;

      logger.info("AI recommendations cache hit", {
        cacheKey,
        query: searchQuery,
        type,
        model: geminiModel,
        cachedAt: new Date(cached.timestamp).toISOString(),
        age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`,
        responseTime: `${Date.now() - startTime}ms`,
        cachedConfigNumResults: cached.configNumResults,
        requestedResults: numResults,
        hasMovies: !!cached.data?.recommendations?.movies?.length,
        hasSeries: !!cached.data?.recommendations?.series?.length,
      });

      if (cached.configNumResults && numResults > cached.configNumResults) {
        logger.info("NumResults increased, invalidating cache", {
          oldValue: cached.configNumResults,
          newValue: numResults,
        });
        await deleteAiCache(cacheKey);
      } else if (
        !cached.data?.recommendations ||
        (type === "movie" && !cached.data.recommendations.movies) ||
        (type === "series" && !cached.data.recommendations.series)
      ) {
        logger.error("Invalid cached data structure, forcing refresh", {
          type,
          cachedData: cached.data,
        });
        await deleteAiCache(cacheKey);
      } else {
        // Convert cached recommendations to Stremio meta objects
        const selectedRecommendations =
          type === "movie"
            ? cached.data.recommendations.movies || []
            : cached.data.recommendations.series || [];

        logger.debug("Converting cached recommendations to meta objects", {
          recommendationsCount: selectedRecommendations.length,
          type,
        });

        if (selectedRecommendations.length === 0) {
          logger.error("AI returned no valid recommendations", { 
            query: searchQuery, 
            type: type,
            model: geminiModel,
            responseText: text
          });
          const errorMeta = createErrorMeta('No Results Found', 'The AI could not find any recommendations for your query. Please try rephrasing your search.');
          return { metas: [errorMeta] };
        }

        const metaPromises = selectedRecommendations.map((item) =>
          toStremioMeta(
            item,
            platform,
            tmdbKey,
            rpdbKey,
            rpdbPosterType,
            language,
            configData,
            includeAdult
          )
        );

        const metas = (await Promise.all(metaPromises)).filter(Boolean);

        if (metas.length === 0 && !exactMatchMeta) {
          logger.error("All AI recommendations failed TMDB lookup", {
            query: searchQuery,
            type: type,
            recommendationCount: selectedRecommendations.length
          });
          const errorMeta = createErrorMeta('Data Fetch Error', 'Could not retrieve details for any of the AI recommendations. This may be a temporary TMDB issue.');
          return { metas: [errorMeta] };
        }

        logger.debug("Catalog handler response from cache", {
          metasCount: metas.length,
          firstMeta: metas[0],
        });

        let finalMetas = metas;
        if (exactMatchMeta) {
          finalMetas = [
            exactMatchMeta,
            ...metas.filter((meta) => meta.id !== exactMatchMeta.id),
          ];
          logger.info("Added exact match as first result (from cache)", {
            searchQuery,
            exactMatchTitle: exactMatchMeta.name,
            totalResults: finalMetas.length,
            exactMatchId: exactMatchMeta.id,
          });
        }

        if (finalMetas.length === 0) {
            logger.error("No results found for query (from cache)", { query: searchQuery, type: type });
            const errorMeta = createErrorMeta('No Results Found', 'The AI could not find any recommendations for your query. Please try rephrasing your search.');
            return { metas: [errorMeta] };
        }

        // Increment counter for successful cached results
        if (finalMetas.length > 0) {
          incrementQueryCounter(finalMetas.length);
          logger.info(
            "Query counter incremented for successful cached search",
            {
              searchQuery,
              resultCount: finalMetas.length,
            }
          );
        }

        return { metas: finalMetas };
      }
    }

    if (!enableAiCache) {
      logger.info("AI cache bypassed (disabled in config)", {
        cacheKey,
        query: searchQuery,
        type,
      });
    } else {
      logger.info("AI recommendations cache miss", {
        cacheKey,
        query: searchQuery,
        type,
        traktIdentity,
      });
    }

    try {

    const agentSearchTMDB = (query, mediaType, year) =>
      searchTMDB(query, mediaType, year, tmdbKey, language, includeAdult);

    const agentDependencyBundle = {
      geminiApiKey: geminiKey,
      geminiModel,
      modelName: geminiModel,
      userQuery: searchQuery,
      type,
      searchTMDB: agentSearchTMDB,
      tmdbApiKey: tmdbKey,
      traktUsername,
      traktAccessToken,
      traktClientId,
      traktAuth: {
        username: traktUsername,
        accessToken: traktAccessToken,
        clientId: traktClientId,
      },
      fetchTraktWatchedAndRated,
      traktWatchedFetcher: fetchTraktWatchedAndRated,
      processPreferencesInParallel,
      fetchTraktFavorites,
      tmdbCache,
      tmdbDetailsCache,
      traktCache: null,
      traktRawDataCache,
      favoritesCache: null,
      favoritesCacheTtlMs: null,
      logger,
      toolDeclarations,
    };

    let agentRecommendations = null;
    let useAgentRecommendations = false;
    let agentFallbackReason = "";
    let rawText = JSON.stringify({ recommendations: [] });

    if (isRecommendation) {
      const hasTraktAuth = !!(traktClientId && traktUsername && traktAccessToken);
      const effectiveFilterWatched = hasTraktAuth ? filterWatched : false;
      const shouldBuildTraktIdentitySets = hasTraktAuth && effectiveFilterWatched;
      const traktWatchedItems = Array.isArray(traktData?.watched) ? traktData.watched : [];
      const traktRatedItems = Array.isArray(traktData?.rated) ? traktData.rated : [];
      const traktHistoryItems = Array.isArray(traktData?.history) ? traktData.history : [];
      const traktWatchedIdSet = shouldBuildTraktIdentitySets
        ? buildMediaIdentitySet(traktWatchedItems)
        : new Set();
      const traktRatedIdSet = shouldBuildTraktIdentitySets
        ? buildMediaIdentitySet(traktRatedItems)
        : new Set();
      const traktHistoryIdSet = shouldBuildTraktIdentitySets
        ? buildMediaIdentitySet(traktHistoryItems)
        : new Set();
      const doNotRecommend = shouldBuildTraktIdentitySets
        ? buildDoNotRecommendList(traktWatchedItems, traktRatedItems)
        : [];

      if (shouldBuildTraktIdentitySets) {
        logger.agent('TRAKT_IDENTITY_SETS', {
          traktWatchedIdSetSize: traktWatchedIdSet.size,
          traktRatedIdSetSize: traktRatedIdSet.size,
          traktHistoryIdSetSize: traktHistoryIdSet.size,
          doNotRecommendCount: doNotRecommend.length,
          doNotRecommendSample: doNotRecommend.slice(0, 5),
          watchedIdSample: [...traktWatchedIdSet].slice(0, 5),
        });

        logger.info("Trakt identity sets built for agent", {
          watchedSize: traktWatchedIdSet.size,
          ratedSize: traktRatedIdSet.size,
          historySize: traktHistoryIdSet.size,
          doNotRecommendCount: doNotRecommend.length,
          traktUsername,
        });

        if (traktWatchedIdSet.size === 0 && traktRatedIdSet.size === 0 && traktHistoryIdSet.size === 0) {
          logger.agent('TRAKT_WARNING_EMPTY_SETS', {
            message: 'Trakt auth is present but watched/rated/history sets are EMPTY. Agent will not filter any recommendations.',
            traktUsername,
            traktDataWasNull: traktData === null || traktData === undefined,
            traktDataWatched: traktData?.watched?.length ?? 'undefined',
            traktDataRated: traktData?.rated?.length ?? 'undefined',
            traktDataHistory: traktData?.history?.length ?? 'undefined',
          });
        }
      } else if (hasTraktAuth) {
        logger.info("Trakt filtering disabled for this request", {
          query: searchQuery,
          type,
          filterWatched,
          effectiveFilterWatched,
          traktUsername,
        });
      } else {
        logger.info("Running unified agent recommendation path without Trakt filters", {
          query: searchQuery,
          type,
          reason: "Trakt auth not connected",
          hasTraktClientId: !!traktClientId,
          hasTraktUsername: !!traktUsername,
          hasTraktAccessToken: !!traktAccessToken,
        });
      }

      logger.info("agent recommendation path starting", {
        query: searchQuery,
        type,
        hasTraktAuth,
        traktUsername,
        numResults,
        doNotRecommendCount: doNotRecommend.length,
      });

      logger.agent("AGENT_DISPATCH", {
        query: searchQuery,
        traktUsername,
        numResults,
        watchedSize: traktWatchedIdSet.size,
        ratedSize: traktRatedIdSet.size,
        historySize: traktHistoryIdSet.size,
      });

      try {
        const agentResult = await runAgentLoop({
          ...agentDependencyBundle,
          numResults,
          filterWatched: effectiveFilterWatched,
          maxTurns,
          traktWatchedIdSet,
          traktRatedIdSet,
          traktHistoryIdSet,
          discoveredGenres,
          genreAnalysis: extractGenreCriteria(searchQuery),
          favoritesContext: filteredTraktData || traktData?.preferences || null,
          executeTools: (toolCalls, runtimeDeps = {}) =>
            executeAgentTools(toolCalls, {
              ...agentDependencyBundle,
              ...runtimeDeps,
              traktWatchedFetcher:
                runtimeDeps.traktWatchedFetcher || fetchTraktWatchedAndRated,
              traktFavoritesFetcher:
                runtimeDeps.traktFavoritesFetcher || fetchTraktFavorites,
              searchTMDB: runtimeDeps.searchTMDB || agentSearchTMDB,
            }),
        });

        const agentRecommendationsList = Array.isArray(agentResult?.recommendations)
          ? agentResult.recommendations
          : [];
        const agentResultCount = agentRecommendationsList.length;
        const agentReason = agentResult?.reason || "";
        const agentSucceededWithResults =
          !!agentResult?.success && agentResultCount > 0;
        const agentSucceededPartially =
          !!agentResult?.success &&
          agentResultCount > 0 &&
          (agentReason === "agent_stuck" || agentReason === "max_turns_exceeded");

        logger.agent("AGENT_RESULT", {
          query: searchQuery,
          status: agentResult?.success ? "success" : "failure",
          recommendationCount: agentResultCount,
          terminationReason: agentReason || null,
        });

        if (agentSucceededWithResults || agentSucceededPartially) {
          agentRecommendations = agentRecommendationsList;
          useAgentRecommendations = true;
          logger.info("Agent recommendation path selected", {
            query: searchQuery,
            type,
            collectedCount: agentResultCount,
            requestedCount: numResults,
            reason: agentReason || undefined,
          });
          if (agentResultCount < numResults) {
            logger.warn("Agent recommendation path returned fewer results than requested", {
              query: searchQuery,
              type,
              collectedCount: agentResultCount,
              requestedCount: numResults,
              reason: agentReason || "shorter_than_requested",
            });
          }
        } else {
          agentFallbackReason = agentResult?.reason || "agent_returned_failure";
          logger.agent("AGENT_FALLBACK", {
            query: searchQuery,
            reason: agentFallbackReason,
          });
          logger.warn(
            hasTraktAuth
              ? "agent recommendation path falling back"
              : "unified agent recommendation path returned no usable results",
            {
              query: searchQuery,
              type,
              reason: agentFallbackReason,
            }
          );
        }
      } catch (error) {
        agentFallbackReason = error.message || "agent_threw";
        logger.agent("AGENT_FALLBACK", {
          query: searchQuery,
          reason: agentFallbackReason,
        });
        logger.warn(
          hasTraktAuth
            ? "agent recommendation path falling back"
            : "unified agent recommendation path failed",
          {
            query: searchQuery,
            type,
            reason: agentFallbackReason,
            stack: error.stack,
          }
        );
      }
    }
    
      if (useAgentRecommendations) {
        rawText = JSON.stringify({ recommendations: agentRecommendations });
        logger.info("Using agent-produced recommendations for downstream enrichment", {
          query: searchQuery,
          type,
          recommendationCount: agentRecommendations.length,
        });
      } else {
        logger.warn("Unified recommendation path returned no recommendations", {
          query: searchQuery,
          type,
          reason: agentFallbackReason || "agent_returned_no_results",
        });
      }

      // Process the response JSON
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (error) {
        logger.error("Failed to parse Gemini recommendation JSON", {
          error: error.message,
          fullResponse: rawText,
        });
        throw error;
      }

      const recommendationsList = Array.isArray(parsed?.recommendations)
        ? parsed.recommendations
        : [];

      logger.debug("Parsed recommendation items", {
        totalItems: recommendationsList.length,
      });

      const recommendations = {
        movies: type === "movie" ? [] : undefined,
        series: type === "series" ? [] : undefined,
      };

      let validRecommendations = 0;
      let invalidLines = 0;

      for (const item of recommendationsList) {
        try {
          const lineType =
            typeof item?.type === "string" ? item.type.trim().toLowerCase() : "";
          const name = typeof item?.name === "string" ? item.name.trim() : "";
          const yearNum = Number(item?.year);

          if (!lineType || !name || !Number.isInteger(yearNum)) {
            logger.debug("Invalid recommendation data", {
              lineType,
              name,
              year: item?.year,
              isValidYear: Number.isInteger(yearNum),
            });
            invalidLines++;
            continue;
          }

          if (lineType === type && name && yearNum) {
            const tmdbId = Number.parseInt(item?.tmdb_id, 10);
            const imdbIdValue = item?.imdb_id;
            const imdbId =
              imdbIdValue !== undefined && imdbIdValue !== null && String(imdbIdValue).trim()
                ? String(imdbIdValue).trim()
                : null;
            const recommendation = {
              name,
              year: yearNum,
              type,
              id: `ai_${type}_${name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")}`,
              ...(Number.isFinite(tmdbId) ? { tmdb_id: tmdbId } : {}),
              ...(imdbId ? { imdb_id: imdbId } : {}),
            };

            if (type === "movie") recommendations.movies.push(recommendation);
            else if (type === "series") recommendations.series.push(recommendation);

            validRecommendations++;
          }
        } catch (error) {
          logger.error("Error processing recommendation line", {
            item,
            error: error.message,
          });
          invalidLines++;
        }
      }

      logger.info("Recommendation processing complete", {
        validRecommendations,
        invalidLines,
        totalProcessed: recommendationsList.length,
      });

      const finalResult = {
        recommendations,
        fromCache: false,
      };

      const recommendationsToCache = finalResult.recommendations;
      const hasMoviesToCache = recommendationsToCache.movies && recommendationsToCache.movies.length > 0;
      const hasSeriesToCache = recommendationsToCache.series && recommendationsToCache.series.length > 0;

      // Cache all results (including Trakt users and homepage queries)
      if ((hasMoviesToCache || hasSeriesToCache) && enableAiCache) {
        await setAiCache(cacheKey, finalResult, numResults);

        logger.debug("AI recommendations result cached", {
          cacheKey,
          duration: Date.now() - startTime,
          query: searchQuery,
          type,
          numResults,
        });
      } else {
        // Log the reason for not caching
        let reason = "";
        if (!(hasMoviesToCache || hasSeriesToCache)) {
          reason = "Result was empty";
        } else if (!enableAiCache) {
          reason = "AI cache disabled in config";
        }
        logger.debug("AI recommendations not cached", {
          reason,
          duration: Date.now() - startTime,
          query: searchQuery,
          type,
        });
      }

      // Convert recommendations to Stremio meta objects
      const selectedRecommendations =
        type === "movie"
          ? finalResult.recommendations.movies || []
          : finalResult.recommendations.series || [];

      logger.debug("Converting recommendations to meta objects", {
        recommendationsCount: selectedRecommendations.length,
        type,
        originalQuery: searchQuery,
        recommendations: selectedRecommendations.map((r) => ({
          name: r.name,
          year: r.year,
          type: r.type,
          id: r.id,
          tmdb_id: r.tmdb_id,
          imdb_id: r.imdb_id,
        })),
      });

      const metaPromises = selectedRecommendations.map((item) =>
        toStremioMeta(
          item,
          platform,
          tmdbKey,
          rpdbKey,
          rpdbPosterType,
          language,
          configData // Pass the whole config down
        )
      );

      const metas = (await Promise.all(metaPromises)).filter(Boolean);

      // Log detailed results
      logger.debug("Meta conversion results", {
        originalQuery: searchQuery,
        type,
        totalRecommendations: selectedRecommendations.length,
        successfulConversions: metas.length,
        failedConversions: selectedRecommendations.length - metas.length,
        recommendations: selectedRecommendations.map((r) => ({
          name: r.name,
          year: r.year,
          type: r.type,
          tmdb_id: r.tmdb_id,
          imdb_id: r.imdb_id,
        })),
        convertedMetas: metas.map((m) => ({
          id: m.id,
          name: m.name,
          year: m.year,
          type: m.type,
        })),
      });

      logger.debug("Catalog handler response", {
        metasCount: metas.length,
        firstMeta: metas[0],
        originalQuery: searchQuery,
        type,
        platform,
      });

      let finalMetas = metas;
      if (exactMatchMeta) {
        finalMetas = [
          exactMatchMeta,
          ...metas.filter((meta) => meta.id !== exactMatchMeta.id),
        ];
        logger.info("Added exact match as first result", {
          searchQuery,
          exactMatchTitle: exactMatchMeta.name,
          totalResults: finalMetas.length,
          exactMatchId: exactMatchMeta.id,
        });
      }

      if (finalMetas.length === 0) {
          logger.error("No results found for query (from live API call)", { query: searchQuery, type: type });
          const errorMeta = createErrorMeta('No Results Found', 'The AI could not find any recommendations for your query. Please try rephrasing your search.');
          return { metas: [errorMeta] };
      }

      // Only increment the counter if we're returning non-empty results
      if (finalMetas.length > 0) {
        incrementQueryCounter(finalMetas.length);
        logger.info("Query counter incremented for successful search", {
          searchQuery,
          resultCount: finalMetas.length,
        });
      }

      return { metas: finalMetas };
    } catch (error) {
      logger.error("Gemini API Error:", { error: error.message, stack: error.stack, query: searchQuery });
      let errorMessage = 'The AI model failed to respond. This may be a temporary issue.';
      if (error.message.includes('400') || error.message.includes('API key not valid')) {
        errorMessage = 'Your Gemini API key is invalid or has been revoked. Please update it in the settings.';
      } else if (error.message.includes('quota')) {
        errorMessage = 'You have exceeded your Gemini API quota for the day. Please check your Google AI Studio account.';
      } else if (error.message.includes('404')) {
          errorMessage = 'The selected Gemini Model is invalid or not found. Please try a different model in the settings.';
      }
      const errorMeta = createErrorMeta('AI Error', errorMessage);
      return { metas: [errorMeta] };
    }
  } catch (error) {
    logger.error("Catalog processing error", { error: error.message, stack: error.stack });
    const errorMeta = createErrorMeta('Addon Error', 'A critical error occurred. Please check the server logs for more details.');
    return { metas: [errorMeta] };
  }
};

const streamHandler = async (args, req) => {

  const { config } = args;
  if (config) {
    try {
      const decryptedConfigStr = decryptConfig(config);
      if (decryptedConfigStr) {
        const configData = JSON.parse(decryptedConfigStr);
        const enableSimilar = configData.EnableSimilar !== undefined ? configData.EnableSimilar : true;
        if (!enableSimilar) {
          logger.info("'Similar' recommendations are disabled by user configuration.", { id: args.id });
          return Promise.resolve({ streams: [] });
        }
      }
    } catch (error) {
        logger.error("Failed to read 'EnableSimilar' config in streamHandler, defaulting to enabled.", { error: error.message });
    }
  }

  logger.info("Stream request received, creating AI Recommendations link.", { id: args.id, type: args.type });
  const isWeb = req.headers["origin"]?.includes("web.stremio.com");
  const stremioUrlPrefix = isWeb ? "https://web.stremio.com/#" : "stremio://";

  const stream = {
    name: "✨ AI Picks",
    description: "Similar movies and shows.",
    externalUrl: `${stremioUrlPrefix}/detail/${args.type}/ai-recs:${args.id}`,
    behaviorHints: {
      notWebReady: true,
    },
  };

  return Promise.resolve({ streams: [stream] });
};

const metaHandler = async function (args) {
  const { type, id, config } = args;
  const startTime = Date.now();
  const stremioUrlPrefix = "stremio://";

  try {
    if (!id || !id.startsWith('ai-recs:')) {
      return { meta: null };
    }
    if (config) {
      const decryptedConfigStr = decryptConfig(config);
      if (!decryptedConfigStr) {
        throw new Error("Failed to decrypt config data in metaHandler");
      }
      const configData = JSON.parse(decryptedConfigStr);
      const { GeminiApiKey, TmdbApiKey, GeminiModel, NumResults, RpdbApiKey, RpdbPosterType, TmdbLanguage, FanartApiKey } = configData;

      const originalId = id.split(':')[1];
      
      // Check similar content cache first
      const cacheKey = `similar_${originalId}_${type}_${NumResults || 15}`;
      const cached = similarContentCache.get(cacheKey);
      if (cached) {
        logger.debug("Similar content cache hit", { 
          originalId, 
          type, 
          cacheKey,
          cachedAt: new Date(cached.timestamp).toISOString(),
          age: `${Math.round((Date.now() - cached.timestamp) / 1000)}s`
        });
        return { meta: cached.data };
      }
      
      logger.debug("Similar content cache miss", { originalId, type, cacheKey });
      let sourceDetails = await getTmdbDetailsByImdbId(originalId, type, TmdbApiKey);
      
      if (!sourceDetails) {
        const fallbackType = type === 'movie' ? 'series' : 'movie';
        sourceDetails = await getTmdbDetailsByImdbId(originalId, fallbackType, TmdbApiKey);
      }

      if (!sourceDetails) {
        throw new Error(`Could not find source details for original ID: ${originalId}`);
      }

      const sourceTitle = sourceDetails.title || sourceDetails.name;
      const sourceYear = (sourceDetails.release_date || sourceDetails.first_air_date || "").substring(0, 4);
      let numResults = parseInt(NumResults) || 15;
      if (numResults > 25) numResults = 25;

      const promptText = buildSimilarContentPrompt({
        sourceTitle,
        sourceYear,
        numResults,
        type,
      });

      logger.agent("SIMILAR_PROMPT", {
        sourceTitle,
        sourceYear,
        numResults,
        promptText,
      });

      const ai = new GoogleGenAI({ apiKey: GeminiApiKey });

      const config = {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            recommendations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["movie", "series"] },
                  name: { type: "string" },
                  year: { type: "integer" },
                },
                required: ["type", "name", "year"],
                propertyOrdering: ["type", "name", "year"],
              },
            },
          },
          required: ["recommendations"],
          propertyOrdering: ["recommendations"],
        },
      };

      const modelName = GeminiModel || DEFAULT_GEMINI_MODEL;
      if (/2\.5|[3-9]\./i.test(modelName)) {
        config.thinkingConfig = { thinkingBudget: 1024 };
      }
      
      let aiResult;
      try {
        aiResult = await withRetry(
          async () => {
            return await ai.models.generateContent({
              model: modelName,
              config,
              contents: promptText,
            });
          },
          {
            maxRetries: 3,
            baseDelay: 1000,
            shouldRetry: (error) => !error.status || error.status !== 400,
            operationName: "Gemini API call (similar content)"
          }
        );
      } catch (error) {
        logger.agent("SIMILAR_ERROR", {
          sourceTitle,
          sourceYear,
          numResults,
          error: {
            message: error.message,
            stack: error.stack,
          },
        });
        logger.warn("Gemini similar content call failed, returning empty recommendations", {
          error: error.message,
          sourceTitle,
        });
        return { meta: null };
      }
      
      const responseText = aiResult.text.trim();

      logger.agent("SIMILAR_RESPONSE", {
        sourceTitle,
        sourceYear,
        numResults,
        responseText,
        tokenUsage: aiResult.usageMetadata || {
          promptTokenCount: aiResult.promptFeedback?.tokenCount ?? null,
        },
      });

      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (error) {
        logger.error("Failed to parse Gemini similar-content JSON", {
          error: error.message,
          fullResponse: responseText,
        });
        throw error;
      }

      const recommendationsList = Array.isArray(parsed?.recommendations)
        ? parsed.recommendations
        : [];

      const videoPromises = recommendationsList.map(async (rec) => {
        const recType = typeof rec?.type === 'string' ? rec.type.trim().toLowerCase() : '';
        const name = typeof rec?.name === 'string' ? rec.name.trim() : '';
        const year = Number(rec?.year);
        if (!recType || !name || !Number.isInteger(year)) return null;
        const tmdbData = await searchTMDB(name, recType, year, TmdbApiKey);
        if (tmdbData && tmdbData.imdb_id) {
          
          let description = tmdbData.overview || "";

          if (tmdbData.tmdbRating && tmdbData.tmdbRating > 0) {
            const ratingText = `⭐ TMDB Rating: ${tmdbData.tmdbRating.toFixed(1)}/10`;
            description = `${ratingText}\n\n${description}`;
          }

          // Get landscape thumbnail instead of portrait poster
          const landscapeThumbnail = await getLandscapeThumbnail(tmdbData, tmdbData.imdb_id, FanartApiKey, TmdbApiKey);

          return {
            id: tmdbData.imdb_id,
            title: tmdbData.title,
            released: new Date(tmdbData.release_date || '1970-01-01').toISOString(),
            overview: description,
            thumbnail: landscapeThumbnail
          };
        }
        return null;
      });

      const videos = (await Promise.all(videoPromises)).filter(Boolean);

      const meta = {
        id: id,
        type: 'series',
        name: `AI: Recommendations for ${sourceTitle}`,
        description: `A collection of titles similar to ${sourceTitle} (${sourceYear}), generated by AI.`,
        poster: sourceDetails.poster_path ? `https://image.tmdb.org/t/p/w500${sourceDetails.poster_path}` : null,
        background: sourceDetails.backdrop_path ? `https://image.tmdb.org/t/p/original${sourceDetails.backdrop_path}` : null,
        videos: videos,
      };

      // Only cache if we have valid recommendations
      if (videos.length > 0) {
        similarContentCache.set(cacheKey, {
          timestamp: Date.now(),
          data: meta
        });

        // Increment counter for successful similar content recommendations
        incrementQueryCounter(videos.length);

        logger.info(`Successfully generated ${videos.length} recommendations.`, { 
          source: sourceTitle, 
          duration: Date.now() - startTime,
          cached: true
        });
      } else {
        logger.warn(`No valid recommendations generated for similar content`, { 
          source: sourceTitle, 
          duration: Date.now() - startTime,
          cached: false
        });
      }
      return { meta };
    }
  } catch (error) {
    logger.error("Meta Handler Error:", { message: error.message, stack: error.stack, id: id });
  }

  return { meta: null };
};

builder.defineCatalogHandler(catalogHandler);

builder.defineStreamHandler(streamHandler);

builder.defineMetaHandler(metaHandler);

const addonInterface = builder.getInterface();

module.exports = {
  builder,
  addonInterface,
  catalogHandler,
  streamHandler,
  metaHandler,
  clearTmdbCache,
  clearTmdbDetailsCache,
  clearTmdbDiscoverCache,
  clearAiCache,
  removeAiCacheByKeywords,
  purgeEmptyAiCacheEntries,
  clearRpdbCache,
  clearFanartCache,
  clearTraktCache,
  clearTraktRawDataCache,
  clearQueryAnalysisCache,
  clearSimilarContentCache,
  getCacheStats,
  serializeAllCaches,
  deserializeAllCaches,
  hydrateQueryCounter,
  discoverTypeAndGenres,
  filterTraktDataByGenres,
  incrementQueryCounter,
  getQueryCount,
  setQueryCount,
  removeTmdbDiscoverCacheItem,
  listTmdbDiscoverCacheKeys,
  getRpdbTierFromApiKey,
  searchTMDBExactMatch,
  determineIntentFromKeywords,
};
