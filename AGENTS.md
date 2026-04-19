## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Quick Reference

- **Stack**: Node.js (CommonJS), Express, `stremio-addon-sdk`, Google Gemini AI, TMDB, Trakt.tv
- **Entry point**: `server.js` → `addon.js`
- **Port**: hardcoded `7000`, listens on `0.0.0.0`
- **No test suite, no linter, no formatter configured**
- **No CI/CD pipelines**

## Commands

```bash
npm start              # Production: node server.js
npm run start:dev      # Dev with logging (uses ENABLE_LOGGING=true)
```

> **Windows gotcha**: `start:dev` uses Unix-style `ENABLE_LOGGING=true node server.js` — it will fail on Windows cmd/PowerShell. Use `$env:ENABLE_LOGGING="true"; node server.js` or install `cross-env`.

## Required Environment Variables

The server **exits on startup** if `ENCRYPTION_KEY` is missing or < 32 chars.

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

## Architecture Notes

- **Config encryption**: User configuration is AES-256-CBC encrypted and passed as a URL path segment. `utils/crypto.js` handles encrypt/decrypt.
- **Cache persistence**: LRU caches are serialized to gzip files in `cache_data/` every hour and on graceful shutdown (`SIGTERM`/`SIGINT`/`SIGHUP`). Restored on startup.
- **SQLite**: `trakt_tokens.db` stores Trakt OAuth tokens. Created automatically by `database.js`. Gitignored.
- **Trakt OAuth**: Full OAuth callback flow implemented in `server.js` (authorization URL → callback → token exchange → DB storage).
- **Admin endpoints**: Cache management routes protected by `ADMIN_TOKEN` query parameter.
- **Static files**: Served from `public/` at both `/` and `/aisearch` paths.

## Deployment

- **Docker**: `Dockerfile` uses `node:23`, exposes port `7000`, sets `NODE_ENV=production`.
- **PM2**: `ecosystem.config.js` — fork mode, single instance, 2GB memory limit, logs to `logs/`.
- **Gitignored artifacts**: `node_modules/`, `.env`, `logs/`, `trakt_tokens.db`, `cache_data/` (implicit — created at runtime).

## Conventions

- All source is **CommonJS** (`require`/`module.exports`), no transpilation.
- `utils/logger.js` is the central logging dependency — all other utils import it.
- `utils/apiRetry.js` provides exponential backoff with jitter for external API calls.
- No TypeScript, no build step — edit JS files directly.
