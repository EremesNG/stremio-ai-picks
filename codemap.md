# Repository Atlas: stremio-ai-picks

## Project Responsibility
AI-powered Stremio addon that delivers personalized movie and series recommendations through natural language queries. Integrates Google Gemini AI for intelligent query interpretation, TMDB for media metadata, and Trakt.tv for user watch history and ratings. Encrypts user configuration in URL segments and maintains persistent LRU caches for performance.

## System Entry Points
- **`server.js`** — Express HTTP server, request routing, Trakt OAuth flow, config decryption, static file serving, admin cache management, graceful shutdown. **Main entry point** (`node server.js`).
- **`addon.js`** — Core Stremio addon logic: catalog/meta/stream handlers, AI agent loop integration, TMDB/Trakt API processing, LRU caching, config field parsing (FilterWatched, MaxTurns, HomepageQuery).
- **`database.js`** — SQLite persistence for Trakt.tv OAuth tokens. Singleton DB connection with prepared statements.
- **`package.json`** — Dependency manifest. Key deps: `stremio-addon-sdk`, `@google/generative-ai`, `express`, `better-sqlite3`, `better-lru-cache`. Managed via pnpm.
- **`Dockerfile`** — Container build on `node:23` with corepack + pnpm. Exposes port 3000, sets NODE_ENV=production.

## Architecture Overview

### Request Flow (End-to-End)
1. Stremio client hits `server.js` with encrypted config in URL path segment
2. `server.js` decrypts config via `utils/crypto.js` (AES-256-CBC), initializes SQLite DB and LRU cache
3. Request routed through Express middleware (logging, platform detection, rate limiting)
4. `addon.js` handlers (`catalogHandler`, `metaHandler`, `streamHandler`) process the request
5. Handlers invoke `runAgentLoop` (from `utils/agent.js`) with Gemini AI for intelligent query interpretation
6. Agent loop uses function-calling tools (`utils/agent-tools.js`): `get_user_favorites` is the sole model-visible tool; TMDB resolution is orchestrator-owned and happens after the model emits its candidate array
7. Results cached in Turso (LibSQL) with 24h TTL — persists across serverless cold starts. Caches all catalog responses including Trakt users (keyed by username) and homepage queries.
8. Response returned as Stremio-compatible JSON

### Config Encryption & Persistence
- User configuration (API keys, preferences) is AES-256-CBC encrypted and passed as URL path segment
- `utils/crypto.js` handles encrypt/decrypt operations
- Trakt OAuth tokens stored in `trakt_tokens.db` (SQLite, gitignored, auto-created)
- AI recommendation cache and Trakt processed data cache persisted in Turso (LibSQL); other caches in-memory only

### Agent Loop Design
- Orchestrator-turn Gemini agent with internal tool rounds inside each turn
- Supports `FilterWatched` (conditional on Trakt auth) and `MaxTurns` (4–12 range, default 6) configuration; `MaxTurns` counts orchestrator attempts, not Gemini tool rounds
- Internal tool rounds are bounded by a module-local safety cap in `utils/agent.js` (default 8) and are not user-configurable
- Tracks `proposedTitles` across turns to avoid duplicates
- Batching protocol for efficiency: TMDB resolution runs as a single orchestrator-owned batch per turn (up to 20 parallel queries via `handleBatchSearchTmdb`), while `get_user_favorites` can add Trakt context during the turn
- Finalization guard prevents incomplete responses; `tool_loop_exhausted` marks final-turn safety-cap exhaustion and partial fallback still covers agent timeout
- Progress feedback sent to user during multi-turn orchestrator reasoning
- Agent item schema (`{ type, title, year }`) declared once in `utils/agent-validate.js` as `AGENT_ITEM_SCHEMA` and used as the shared source of truth by both the prompt helpers and the validator; `tmdb_id` is NOT emitted by the model — it is added by the orchestrator after TMDB resolution
- `validateAgentItems` in `utils/agent-validate.js` enforces the contract: required fields, field types, allowed fields, and per-turn item count against the current gap
- Single corrective retry per turn: parse errors or schema violations trigger one corrective follow-up in the same chat session via `buildCorrectiveFeedback`; a `contractRetryUsed` flag prevents a second retry within the same turn
- `TURN_RESULT` logging extended with `contractRetryUsed`, `violationsBeforeRetry`, and `violationsAfterRetry` for structured telemetry

### Caching Strategy
- AI recommendations and Trakt processed data cached in Turso (LibSQL) with 24h TTL — survive serverless cold starts
- Other caches use custom `SimpleLRUCache` in `addon.js` (in-memory, 7 days TTL for TMDB/RPDB/Fanart/Trakt raw data)
- Admin endpoints (`/cache/save`, `/stats/*`) protected by `ADMIN_TOKEN` query parameter

### HomepageQuery Serialization
- User-defined homepage catalog rows parsed with `|||` delimiter
- Allows multiple independent queries in a single configuration field
- Each query processed independently by the agent loop

## Directory Map
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `utils/` | Shared infrastructure: Gemini agent loop, function-calling tools, prompt builders, Trakt API client, exponential backoff retry, AES-256-CBC encryption, logging singleton, GitHub issue submission. | [View Map](utils/codemap.md) |
| `public/` | User-facing frontend: configuration dashboard (HTML/CSS/JS), Stremio install URL generation, API key validation, model selector, dynamic homepage editor, FilterWatched/MaxTurns controls. | [View Map](public/codemap.md) |

## Root Files

| File | Role | Key Exports/Patterns |
|------|------|----------------------|
| **server.js** | Express HTTP server, request routing, Trakt OAuth flow, static file serving, admin cache management, graceful shutdown | Middleware chain (logging, platform detection, rate limiting); routes: `/*` (addon), `/oauth/callback`, `/api/getConfig/:configId`, `/api/decrypt-config`, `/cache/save`, `/stats/*`, `/oauth/refresh` |
| **addon.js** | Core Stremio addon logic, catalog/meta/stream handlers, AI agent integration, LRU caching, config parsing | `addonInterface`, `catalogHandler`, `metaHandler`, `streamHandler`, `SimpleLRUCache`, `purgeEmptyAiCacheEntries`; reads `DEFAULT_GEMINI_MODEL = "gemini-flash-lite-latest"`, `FilterWatched`, `MaxTurns`, `HomepageQuery` |
| **database.js** | Trakt OAuth token storage (SQLite), AI recommendation cache (Turso/LibSQL), and Trakt processed data cache (Turso/LibSQL) | `initDb`, `storeTokens`, `getTokens`, `cacheAiResult`, `getAiCacheResult`, `getTraktCache`, `setTraktCache`, `deleteTraktCache`, `purgeExpiredTraktCache`, `clearTraktCache`; singleton DB connections, prepared statements, auto-created `trakt_tokens.db` |
| **Dockerfile** | Container build specification | Node 23 base, corepack + pnpm, port 3000, NODE_ENV=production |
| **package.json** | Dependency manifest, npm scripts | Entry: `server.js`; key deps: `@google/generative-ai`, `better-sqlite3`, `stremio-addon-sdk`, `express`, `better-lru-cache` |

## Key Design Decisions

### 1. Config Encryption via URL Path Segment
- User configuration (API keys, preferences) encrypted with AES-256-CBC and embedded in Stremio addon URL
- Avoids storing secrets server-side; decryption happens per-request
- Tradeoff: URL length constraints; mitigation via `utils/crypto.js` compression

### 2. Orchestrator-Turn Gemini Agent with Function-Calling Tools
- Agent loop (`utils/agent.js`) uses Gemini's native function-calling API
- Orchestrator turns are the outer budget; internal tool rounds happen inside each turn
- Tools declared in `utils/agent-tools.js`: only `get_user_favorites` is model-visible; `handleBatchSearchTmdb` remains callable by the orchestrator for post-emission TMDB resolution
- Batching protocol (up to 20 parallel TMDB queries) reduces API calls and latency
- Internal tool rounds are guarded by a module-local safety cap in `utils/agent.js` (default 8); `MaxTurns` remains the 4–12 range with default 6
- Finalization guard + partial fallback ensures graceful degradation on timeout
- Tradeoff: Multi-turn reasoning increases latency; mitigated by turn limits (MaxTurns 4–12) and the internal tool-round cap

### 3. Turso-Backed AI & Trakt Cache with SimpleLRUCache for Other Data
- AI recommendation cache and Trakt processed data cache persisted in Turso (LibSQL) with 24h TTL — survive serverless cold starts
- Other caches (TMDB, RPDB, Fanart, Trakt raw data) use in-memory `SimpleLRUCache` with TTL-based expiration
- Non-persistent caches reset on process restart
- Tradeoff: Turso persistence adds external dependency; benefit: recommendations and Trakt data survive cold starts. Other caches remain simple in-memory for reduced latency

### 4. Trakt.tv OAuth Token Storage in SQLite
- Tokens stored in `trakt_tokens.db` with `updated_at` trigger
- Singleton DB connection with prepared statements
- Gitignored; auto-created on first run
- Tradeoff: Local file storage; benefit: no external dependency, simple CRUD

### 5. HomepageQuery Serialization with `|||` Delimiter
- Allows multiple independent catalog rows in a single configuration field
- Each query processed independently by the agent loop
- Tradeoff: Custom parsing logic; benefit: flexible, user-friendly configuration

### 6. FilterWatched & MaxTurns Configuration Fields
- `FilterWatched`: Conditional on Trakt authentication; filters results to unwatched items only
- `MaxTurns`: Limits orchestrator turns (4–12 range, default 6) to control latency; inner tool rounds are handled automatically by `utils/agent.js`
- Both fields parsed in `addon.js` and passed to `runAgentLoop`
- Tradeoff: Additional config complexity; benefit: user control over behavior and performance

## Environment Variables (Required)

| Variable | Required | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | **Yes — fatal** | AES-256-CBC key, ≥ 32 chars. Server exits without it. |
| `HOST` | Yes | Domain name (without protocol). Used to build `https://{HOST}` URLs. |
| `TRAKT_CLIENT_ID` | Yes | Trakt.tv OAuth app credentials. |
| `TRAKT_CLIENT_SECRET` | Yes | Trakt.tv OAuth app credentials. |
| `RPDB_API_KEY` | No | Rating Poster DB key for poster overlays. |
| `FANART_API_KEY` | No | Fanart.tv key (used in `addon.js`). |
| `ADMIN_TOKEN` | No | Protects admin cache endpoints. Defaults to `"change-me-in-env-file"`. |
| `GITHUB_TOKEN` | No | For issue submission via `issueHandler.js`. |
| `RECAPTCHA_SECRET_KEY` | No | reCAPTCHA validation for issue submissions. |
| `ENABLE_LOGGING` | No | Set `"true"` to enable verbose logging. |

Env is loaded via `dotenv` (gracefully skipped if `.env` is absent).

## Conventions

- All source is **CommonJS** (`require`/`module.exports`), no transpilation
- `utils/logger.js` is the central logging dependency — all other utils import it
- `utils/apiRetry.js` provides exponential backoff with jitter for external API calls
- No TypeScript, no build step — edit JS files directly
- No test suite, no linter, no formatter configured
- No CI/CD pipelines
