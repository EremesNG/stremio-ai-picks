# Project Context

## Overview
AI-powered Stremio addon for movie/series recommendations using Google Gemini for query interpretation, TMDB for metadata, and Trakt.tv for user history/ratings.

## Stack
- Node.js (CommonJS)
- Express
- `stremio-addon-sdk`
- `@google/generative-ai`
- TMDB + Trakt.tv APIs
- SQLite via `sqlite`/`sqlite3`
- pnpm (`pnpm@10.33.0`)

## Architecture
- `server.js` is the main HTTP entry point.
- `addon.js` contains catalog/meta/stream handlers, AI processing, and LRU cache usage.
- `database.js` manages Trakt OAuth token persistence in SQLite.
- `utils/crypto.js` handles AES-256-CBC config encryption/decryption.
- Request flow: encrypted config arrives in the URL, is decrypted by the server, then routed through Express middleware into addon handlers.

## Conventions
- CommonJS only; no transpilation.
- Central logging lives in `utils/logger.js`.
- `utils/apiRetry.js` provides retry/backoff for external APIs.
- Cache state is persisted to disk from in-memory LRU caches.
- Static files are served from `public/` and the root path.

## Operational Notes
- `ENCRYPTION_KEY` is required and must be at least 32 characters.
- `HOST`, `TRAKT_CLIENT_ID`, and `TRAKT_CLIENT_SECRET` are required env vars.
- Gemini and TMDB keys are end-user configuration values and travel encrypted in the manifest URL, not as server env vars.
- Default port is `7000`, listening on `0.0.0.0`.

## Windows Gotcha
- `pnpm start:dev` uses `ENABLE_LOGGING=true node server.js`, which is Unix-style and fails in PowerShell/CMD; use `$env:ENABLE_LOGGING="true"; node server.js` instead.

## Detected Gaps
- No test suite detected.
- No linter/formatter detected.
- No CI workflow detected.
