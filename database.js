const { createClient } = require("@libsql/client/web");
const logger = require("./utils/logger");

const db = createClient({
  url: process.env.TURSO_URI,
  authToken: process.env.TURSO_TOKEN,
});

const AI_CACHE_TTL = 24 * 60 * 60 * 1000;
const TRAKT_CACHE_TTL = 24 * 60 * 60 * 1000;

async function initDb() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS tokens (trakt_username TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TRIGGER IF NOT EXISTS update_tokens_updated_at AFTER UPDATE ON tokens FOR EACH ROW BEGIN UPDATE tokens SET updated_at = CURRENT_TIMESTAMP WHERE trakt_username = OLD.trakt_username; END;`);
    await db.execute(`CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS ai_cache (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, config_num_results INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, is_full INTEGER NOT NULL DEFAULT 0)`);
    try {
      await db.execute(`ALTER TABLE ai_cache ADD COLUMN is_full INTEGER NOT NULL DEFAULT 0`);
    } catch (migrationError) {
      if (!migrationError.message.includes('duplicate column')) {
        throw migrationError;
      }
    }
    await db.execute(`CREATE TABLE IF NOT EXISTS trakt_cache (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    await db.execute({ sql: `INSERT OR IGNORE INTO stats (key, value) VALUES (?, ?)`, args: ['recommendations_served', 0] });
  } catch (error) {
    logger.error("Failed to initialize database", { error: error.message, stack: error.stack });
    throw error;
  }
}

async function storeTokens(username, accessToken, refreshToken, expiresIn) {
  const expiresAt = Math.floor(Date.now() / 1000) + Number(expiresIn);

  try {
    await db.execute({
      sql: 'INSERT INTO tokens (trakt_username, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(trakt_username) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP',
      args: [username, accessToken, refreshToken, expiresAt],
    });
  } catch (error) {
    logger.error(`Failed to store tokens for user: ${username}`, { error: error.message });
    throw error;
  }
}

async function getTokens(username) {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM tokens WHERE trakt_username = ?',
      args: [username],
    });
    return result.rows[0] ?? null;
  } catch (error) {
    logger.error(`Failed to retrieve tokens for user: ${username}`, { error: error.message });
    throw error;
  }
}

async function getStatValue(key) {
  try {
    const result = await db.execute({ sql: 'SELECT value FROM stats WHERE key = ?', args: [key] });
    if (result.rows.length > 0) {
      return Number(result.rows[0].value);
    }
    return 0;
  } catch (error) {
    logger.error('Failed to get stat value', { key, error: error.message });
    return 0;
  }
}

async function incrementStat(key, amount = 1) {
  try {
    await db.execute({ sql: 'UPDATE stats SET value = value + ? WHERE key = ?', args: [amount, key] });
  } catch (error) {
    logger.error('Failed to increment stat', { key, amount, error: error.message });
  }
}

async function setStatValue(key, value) {
  try {
    await db.execute({ sql: 'INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, value] });
  } catch (error) {
    logger.error('Failed to set stat value', { key, value, error: error.message });
  }
}

async function getAiCache(cacheKey) {
  try {
    const now = Date.now();
    const result = await db.execute({
      sql: 'SELECT data, config_num_results, created_at, is_full FROM ai_cache WHERE cache_key = ? AND expires_at > ?',
      args: [cacheKey, now],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      data: JSON.parse(row.data),
      configNumResults: Number(row.config_num_results),
      timestamp: Number(row.created_at),
      isFull: row.is_full === 1,
    };
  } catch (error) {
    logger.error('Failed to get AI cache entry', { cacheKey, error: error.message });
    return null;
  }
}

async function setAiCache(cacheKey, data, configNumResults, isFull = true) {
  try {
    const createdAt = Date.now();
    const expiresAt = createdAt + AI_CACHE_TTL;

    await db.execute({
      sql: 'INSERT OR REPLACE INTO ai_cache (cache_key, data, config_num_results, created_at, expires_at, is_full) VALUES (?, ?, ?, ?, ?, ?)',
      args: [cacheKey, JSON.stringify(data), configNumResults, createdAt, expiresAt, isFull ? 1 : 0],
    });
  } catch (error) {
    logger.error('Failed to set AI cache entry', { cacheKey, error: error.message });
  }
}

async function updateAiCacheData(cacheKey, data, configNumResults, isFull = true) {
  try {
    await db.execute({
      sql: 'UPDATE ai_cache SET data = ?, config_num_results = ?, is_full = ? WHERE cache_key = ?',
      args: [JSON.stringify(data), configNumResults, isFull ? 1 : 0, cacheKey],
    });
  } catch (error) {
    logger.error('Failed to update AI cache entry data', { cacheKey, error: error.message });
  }
}

async function deleteAiCache(cacheKey) {
  try {
    await db.execute({
      sql: 'DELETE FROM ai_cache WHERE cache_key = ?',
      args: [cacheKey],
    });
  } catch (error) {
    logger.error('Failed to delete AI cache entry', { cacheKey, error: error.message });
  }
}

async function purgeExpiredAiCache() {
  try {
    const result = await db.execute({
      sql: 'DELETE FROM ai_cache WHERE expires_at <= ?',
      args: [Date.now()],
    });
    return Number(result.rowsAffected ?? 0);
  } catch (error) {
    logger.error('Failed to purge expired AI cache entries', { error: error.message });
    return 0;
  }
}

async function clearAiCache() {
  try {
    await db.execute({ sql: 'DELETE FROM ai_cache', args: [] });
  } catch (error) {
    logger.error('Failed to clear AI cache', { error: error.message });
  }
}

async function getTraktCache(cacheKey) {
  try {
    const now = Date.now();
    const result = await db.execute({
      sql: 'SELECT data, created_at FROM trakt_cache WHERE cache_key = ? AND expires_at > ?',
      args: [cacheKey, now],
    });

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      data: JSON.parse(row.data),
      timestamp: Number(row.created_at),
    };
  } catch (error) {
    logger.error('Failed to get Trakt cache entry', { cacheKey, error: error.message });
    return null;
  }
}

async function setTraktCache(cacheKey, data) {
  try {
    const createdAt = Date.now();
    const expiresAt = createdAt + TRAKT_CACHE_TTL;

    await db.execute({
      sql: 'INSERT OR REPLACE INTO trakt_cache (cache_key, data, created_at, expires_at) VALUES (?, ?, ?, ?)',
      args: [cacheKey, JSON.stringify(data), createdAt, expiresAt],
    });
  } catch (error) {
    logger.error('Failed to set Trakt cache entry', { cacheKey, error: error.message });
  }
}

async function deleteTraktCache(cacheKey) {
  try {
    await db.execute({
      sql: 'DELETE FROM trakt_cache WHERE cache_key = ?',
      args: [cacheKey],
    });
  } catch (error) {
    logger.error('Failed to delete Trakt cache entry', { cacheKey, error: error.message });
  }
}

async function purgeExpiredTraktCache() {
  try {
    const result = await db.execute({
      sql: 'DELETE FROM trakt_cache WHERE expires_at <= ?',
      args: [Date.now()],
    });
    return Number(result.rowsAffected ?? 0);
  } catch (error) {
    logger.error('Failed to purge expired Trakt cache entries', { error: error.message });
    return 0;
  }
}

async function clearTraktCache() {
  try {
    await db.execute({ sql: 'DELETE FROM trakt_cache', args: [] });
  } catch (error) {
    logger.error('Failed to clear Trakt cache', { error: error.message });
  }
}

module.exports = { initDb, storeTokens, getTokens, getStatValue, incrementStat, setStatValue, getAiCache, setAiCache, updateAiCacheData, deleteAiCache, purgeExpiredAiCache, clearAiCache, getTraktCache, setTraktCache, deleteTraktCache, purgeExpiredTraktCache, clearTraktCache };
