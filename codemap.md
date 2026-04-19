# Repository Atlas: stremio-ai-search

## Project Responsibility
AI-powered Stremio addon that provides personalized movie and series recommendations using Google Gemini AI for natural language query interpretation, TMDB for media metadata, and Trakt.tv for user-specific watch history and ratings.

## System Entry Points
- `server.js` — Express HTTP server, routing, config decryption, rate limiting, graceful shutdown. **Main entry point** (`node server.js`).
- `addon.js` — Core addon logic: AI processing via Gemini, TMDB/Trakt API integration, LRU caching, catalog/meta/stream handlers.
- `database.js` — SQLite persistence layer for Trakt.tv OAuth tokens (CRUD via `initDb`, `storeTokens`, `getTokens`).
- `package.json` — Dependency manifest. Key deps: `stremio-addon-sdk`, `@google/generative-ai`, `express`, `sqlite`.
- `Dockerfile` — Container build on `node:23`. Entry: `CMD ["node", "server.js"]`.

## Request Flow
1. Stremio client hits `server.js` with encrypted config in URL path
2. `server.js` decrypts config via `utils/crypto.js`, initializes DB and cache
3. Request routed through Express middleware (logging, platform detection, rate limiting)
4. `addon.js` handlers (`catalogHandler`, `metaHandler`, `streamHandler`) process the request
5. Handlers query Gemini AI, fetch TMDB metadata, check Trakt history
6. Results cached in custom `SimpleLRUCache`, returned as Stremio-compatible JSON

## Design Patterns
- **Builder** — `stremio-addon-sdk` constructs addon manifest and handlers
- **Middleware Chain** — Express middleware for logging, rate limiting, platform detection
- **LRU Cache** — Custom `SimpleLRUCache` in `addon.js` minimizes redundant API calls
- **Router** — Express router organizes addon routes and API endpoints
- **Graceful Shutdown** — `server.js` handles SIGTERM/SIGINT to persist caches before exit

## Frontend
- `index.html` — Root landing page for the addon
- `public/configure.html` — Configuration UI for API key setup and user preferences

## Infrastructure
- `ecosystem.config.js` — PM2 process manager configuration
- `Dockerfile` / `.dockerignore` — Container deployment

## Directory Map
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `utils/` | Shared infrastructure: logging (Singleton), API retry with backoff (Decorator), AES-256-CBC encryption, issue submission handler. | [View Map](utils/codemap.md) |
