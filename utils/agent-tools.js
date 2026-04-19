const logger = require("./logger");
const { normalizeMediaKey } = require("./trakt");

const toolDeclarations = [
  {
    name: "search_tmdb",
    description:
      "Search TMDB for a movie or series by title and optional year. Returns top matches with tmdb_id, imdb_id, title, year, overview, and popularity.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: {
          type: "STRING",
          enum: ["movie", "series"],
        },
        query: {
          type: "STRING",
        },
        year: {
          type: "INTEGER",
        },
      },
      required: ["type", "query"],
    },
  },
  {
    name: "batch_search_tmdb",
    description:
      "Search TMDB for multiple movies or series at once. Accepts an array of search queries and returns results for each. Use this instead of calling search_tmdb multiple times.",
    parameters: {
      type: "OBJECT",
      properties: {
        queries: {
          type: "ARRAY",
          maxItems: 20,
          items: {
            type: "OBJECT",
            properties: {
              type: {
                type: "STRING",
                enum: ["movie", "series"],
              },
              query: {
                type: "STRING",
              },
              year: {
                type: "INTEGER",
              },
            },
            required: ["type", "query"],
          },
        },
      },
      required: ["queries"],
    },
  },
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
    name: "check_if_watched",
    description:
      "Check whether items have already been watched or rated by the user. Returns per-item watched/rated status for batches of up to 20 items.",
    parameters: {
      type: "OBJECT",
      properties: {
        items: {
           type: "ARRAY",
           maxItems: 20,
           items: {
            type: "OBJECT",
            properties: {
              type: {
                type: "STRING",
              },
              tmdb_id: {
                type: "INTEGER",
              },
              imdb_id: {
                type: "STRING",
              },
              title: {
                type: "STRING",
                description: "The title of the movie or series to check",
              },
              year: {
                type: "INTEGER",
              },
            },
            required: ["type", "title"],
          },
        },
      },
      required: ["items"],
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
    type: normalizeMediaType(item.type || fallbackType) || undefined,
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

function buildMediaIdentityKeys(normalized) {
  const keys = [];

  if (normalized?.type && normalized.tmdb_id != null) {
    keys.push(`tmdb:${normalized.type}:${normalized.tmdb_id}`);
  }

  if (normalized?.imdb_id) {
    keys.push(`imdb:${normalized.imdb_id}`);
  }

  if (normalized?.title) {
    keys.push(
      `title:${normalized.type || ""}:${normalized.title.trim().toLowerCase()}:${normalized.year ?? ""}`
    );
  }

  return [...new Set(keys)].filter(Boolean);
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

async function handleSearchTmdb(args, deps) {
  const type = normalizeMediaType(args.type);
  const results = await callSearchTMDB(deps.searchTMDB, {
    query: normalizeString(args.query),
    type,
    year: normalizeOptionalYear(args.year),
  });

  const normalized = dedupeItems(
    collectArrayLike(results)
      .map((item) => normalizeSearchResult(item, type))
      .filter(Boolean)
  );

  return {
    results: normalized.map(({ type: _type, ...item }) => item),
  };
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

async function handleCheckIfWatched(args, deps) {
   const items = Array.isArray(args.items) ? args.items.slice(0, 20) : [];
  const watchedIdSet = deps.traktWatchedIdSet instanceof Set ? deps.traktWatchedIdSet : new Set();
  const ratedIdSet = deps.traktRatedIdSet instanceof Set ? deps.traktRatedIdSet : new Set();

  return {
    items: items.map((item) => {
      const normalized = normalizeMediaKey(item);
      const keys = buildMediaIdentityKeys(normalized);
      const watched = keys.some((key) => watchedIdSet.has(key));
      const rated = keys.some((key) => ratedIdSet.has(key));

      return {
        title: item?.title || "Unknown",
        watched,
        rated,
      };
    }),
  };
}

const handlers = {
  search_tmdb: handleSearchTmdb,
  batch_search_tmdb: handleBatchSearchTmdb,
  get_user_favorites: handleGetUserFavorites,
  check_if_watched: handleCheckIfWatched,
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

      const response = await handler(call.args, deps);

      logger.agent("TOOL_EXEC_RESULT", {
        toolName: call.name,
        resultCount: Array.isArray(response?.results)
          ? response.results.length
          : Array.isArray(response?.items)
            ? response.items.length
            : 0,
        result: response,
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
};
