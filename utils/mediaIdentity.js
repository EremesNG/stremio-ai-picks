const { normalizeMediaKey } = require("./trakt");

function buildMediaIdentityKeys(item) {
  const normalized = normalizeMediaKey(item);
  const keys = [];

  if (normalized.type && normalized.tmdb_id != null) {
    keys.push(`tmdb:${normalized.type}:${normalized.tmdb_id}`);
  }

  if (normalized.imdb_id) {
    keys.push(`imdb:${normalized.imdb_id}`);
  }

  if (normalized.title) {
    keys.push(
      `title:${normalized.type || ""}:${normalized.title.trim().toLowerCase()}:${normalized.year ?? ""}`
    );
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
