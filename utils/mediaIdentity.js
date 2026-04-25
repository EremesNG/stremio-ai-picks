const { normalizeMediaKey } = require("./trakt");

function normalizeIdentityType(type) {
  const normalizedType = String(type || "").toLowerCase().trim();

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

function normalizeIdentityInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIdentityString(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = String(value).toLowerCase().trim();
  return normalized || null;
}

function buildMediaIdentityKeys(item) {
  const normalized = normalizeMediaKey(item);
  const normalizedType = normalizeIdentityType(normalized.type);
  const normalizedTmdbId = normalizeIdentityInteger(normalized.tmdb_id);
  const normalizedImdbId = normalizeIdentityString(normalized.imdb_id);
  const normalizedTitle = normalizeIdentityString(normalized.title);
  const normalizedYear = normalizeIdentityInteger(normalized.year);
  const keys = [];

  if (normalizedType && normalizedTmdbId != null) {
    keys.push(`tmdb:${normalizedType}:${normalizedTmdbId}`);
  }

  if (normalizedImdbId) {
    keys.push(`imdb:${normalizedImdbId}`);
  }

  if (normalizedTitle) {
    keys.push(`title:${normalizedTitle}:${normalizedYear ?? ""}:${normalizedType || ""}`);
  }

  return [...new Set(keys)].filter(Boolean);
}

function addMediaIdentityKeys(targetSet, item) {
  if (!(targetSet instanceof Set)) {
    return;
  }

  buildMediaIdentityKeys(item).forEach((key) => targetSet.add(key));
}

function buildMediaIdentitySet(items = []) {
  const identitySet = new Set();
  (Array.isArray(items) ? items : []).forEach((item) =>
    addMediaIdentityKeys(identitySet, item)
  );
  return identitySet;
}

function setHasIdentity(set, ...keys) {
  if (!(set instanceof Set)) {
    return false;
  }

  for (const key of keys) {
    if (typeof key === "string" && key && set.has(key)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  buildMediaIdentityKeys,
  buildMediaIdentitySet,
  setHasIdentity,
};
