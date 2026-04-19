## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Quick Reference

- **Stack**: Node.js (CommonJS), Express, `stremio-addon-sdk`, Google Gemini AI, TMDB, Trakt.tv, `better-sqlite3`
- **Entry point**: `server.js` → `addon.js`
- **Port**: hardcoded `7000`, listens on `0.0.0.0`
- **No test suite, no linter, no formatter configured**
- **No CI/CD pipelines**

## Commands

```bash
pnpm start              # Production: node server.js
pnpm start:dev          # Dev with logging (cross-env ENABLE_LOGGING=true node server.js)
node -c <file.js>       # Syntax-check a file without running it — use after every edit
```

## Required Environment Variables

The server **exits on startup** if `ENCRYPTION_KEY` is missing or < 32 chars.

| Variable | Required | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | **Yes — fatal** | AES-256-CBC key, ≥ 32 chars. Server exits without it. |
| `HOST` | Yes | Domain name (without protocol). Used to build `https://{HOST}` URLs and Trakt OAuth redirect. |
| `TRAKT_CLIENT_ID` | Yes | Trakt.tv OAuth app credentials. |
| `TRAKT_CLIENT_SECRET` | Yes | Trakt.tv OAuth app credentials. |
| `RPDB_API_KEY` | No | Rating Poster DB key for poster overlays. |
| `FANART_API_KEY` | No | Fanart.tv key (used in `addon.js`). |
| `ADMIN_TOKEN` | No | Protects admin cache endpoints. Defaults to `"change-me-in-env-file"`. |
| `GITHUB_TOKEN` | No | For issue submission via `issueHandler.js`. |
| `RECAPTCHA_SECRET_KEY` | No | reCAPTCHA validation for issue submissions. |
| `ENABLE_LOGGING` | No | Must be the **literal string** `"true"`. Other truthy values (`1`, `yes`) are treated as false. |

Env is loaded via `dotenv` (gracefully skipped if `.env` is absent).

## Architecture Notes

- **Config encryption**: User configuration is AES-256-CBC encrypted and passed as a URL path segment. `utils/crypto.js` handles encrypt/decrypt.
- **Cache persistence**: LRU caches are serialized to gzip files in `cache_data/` every hour and on graceful shutdown (`SIGTERM`/`SIGINT`/`SIGHUP`). Restored on startup.
- **SQLite**: `trakt_tokens.db` stores Trakt OAuth tokens. Created automatically by `database.js`. Gitignored.
- **Trakt OAuth**: Full OAuth callback flow implemented in `server.js` (authorization URL → callback → token exchange → DB storage).
- **Admin endpoints**: Cache management routes protected by `ADMIN_TOKEN` query parameter.
- **Static files**: Served from `public/` at both `/` and `/aisearch` paths.

## AI Agent Loop (`utils/agent.js`)

The Gemini recommendation agent uses a turn-based function-calling loop. Key facts:

- **Tools**: `search_tmdb`, `batch_search_tmdb` (up to 20 parallel queries), `check_if_watched`, `get_user_favorites`.
- **Turn mechanics**: The initial Gemini call happens *before* the loop and does not count as a turn. Each loop iteration processes the previous response and makes one `callGemini` call.
- **`maxTurns`**: Read from user config (range 4–12, default 6). Passed via `runAgentLoop` deps.
- **Finalization guard**: On the last turn, the agent forces a JSON response even if Gemini is still calling tools.
- **Partial results fallback**: If Gemini fails mid-loop with items already collected, the loop returns partials (`api_error_partial`) instead of throwing.
- **`filterWatched`**: When `false`, `check_if_watched` is removed from tool declarations AND `traktWatchedIdSet`/`traktRatedIdSet` are omitted from runtime deps. The system prompt is updated accordingly.
- **Batching pattern**: Prompt instructs Gemini to batch all TMDB searches first, then batch watched checks — never one-at-a-time. Gemini supports multiple parallel function calls per turn but must be explicitly instructed to do so.
- **`proposedTitles` tracking**: Agent tracks titles across turns to avoid re-proposing already-discussed items.

## Configuration Page (`public/configure.html`)

- Single HTML file with embedded CSS and JS — no build step.
- State is DOM-centric; Trakt auth state uses hidden inputs + `sessionStorage` during OAuth redirect.
- Hydration of existing config: `fetch` call on `DOMContentLoaded` when a config ID is in the URL.
- **HomepageQuery separator**: Uses `|||` as the multi-entry delimiter (NOT comma). Commas inside query text are safe. Parsing is in three places: `configure.html`, `addon.js`, and `server.js` — all must stay in sync.
- Backend endpoints used by the page: `/aisearch/encrypt` (generate install URL), `/aisearch/validate` (validate config).

## Deployment

- **Docker**: `Dockerfile` uses `node:23` with corepack + pnpm, exposes port `7000`, sets `NODE_ENV=production`.
- **PM2**: `ecosystem.config.js` — fork mode, single instance, 2GB memory limit, logs to `logs/`.
- **Gitignored artifacts**: `node_modules/`, `.env`, `logs/`, `trakt_tokens.db`, `cache_data/`.

## Conventions

- All source is **CommonJS** (`require`/`module.exports`), no transpilation.
- `utils/logger.js` is the central logging dependency — all other utils import it.
- `utils/apiRetry.js` provides exponential backoff with jitter for external API calls.
- No TypeScript, no build step — edit JS files directly.
- After editing any `.js` file, verify syntax with `node -c <file>` before considering the task done.
