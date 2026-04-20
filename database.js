const { createClient } = require("@libsql/client/web");
const logger = require("./utils/logger");

const db = createClient({
  url: process.env.TURSO_URI,
  authToken: process.env.TURSO_TOKEN,
});

async function initDb() {
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS tokens (trakt_username TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TRIGGER IF NOT EXISTS update_tokens_updated_at AFTER UPDATE ON tokens FOR EACH ROW BEGIN UPDATE tokens SET updated_at = CURRENT_TIMESTAMP WHERE trakt_username = OLD.trakt_username; END;`);
    await db.execute(`CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)`);
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

module.exports = { initDb, storeTokens, getTokens, getStatValue, incrementStat, setStatValue };
