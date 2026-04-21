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
- **Port**: `3000` (dev), deployed on Vercel (primary), Docker alternative
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
- **Static files**: Served from `public/` at `/`.

## AI Agent Loop (`utils/agent.js`)

The Gemini recommendation agent uses an orchestrator-turn loop. Key facts:

- **Orchestrator turn**: One full orchestrator↔agent cycle, from dispatch until the agent emits parseable text, closes with an empty non-tool response, or exhausts the inner tool cap.
- **Internal tool rounds**: A single orchestrator turn may contain multiple Gemini tool rounds. Those rounds live inside the turn and do not consume `maxTurns`.
- **Tools**: `batch_search_tmdb` (up to 20 parallel queries) and `get_user_favorites` only.
- **`maxTurns`**: Read from user config (range 4–12, default 6). It budgets orchestrator attempts, not internal tool rounds.
- **Internal safety cap**: `DEFAULT_MAX_TOOL_ROUNDS_PER_TURN = 8` in `utils/agent.js`. This guardrail is internal, not a public config, and prevents one turn from looping forever on tool calls.
- **Final-turn exhaustion**: If the inner cap fires on the final orchestrator turn, the loop returns `tool_loop_exhausted`.
- **Partial results fallback**: If Gemini fails mid-turn with items already collected, the loop returns partials (`api_error_partial`) instead of throwing.
- **`filterWatched`**: When `false`, the Trakt watch/rate filtering deps are omitted from runtime deps and the prompt skips those checks.
- **Batching pattern**: Prompt instructs Gemini to batch TMDB searches first, then use `get_user_favorites` when needed — never one-at-a-time. Gemini supports multiple parallel function calls within a turn, but they remain internal to that turn.
- **`proposedTitles` tracking**: Agent tracks titles across orchestrator turns to avoid re-proposing already-discussed items.
- **Agent item schema**: All recommendation items emitted by the agent must conform to the four-field schema `{ type, title, year, tmdb_id }`. The schema is declared once in `utils/agent-validate.js` as `AGENT_ITEM_SCHEMA` and derived into prompt wording via `formatSchemaForPrompt`.
- **Validator module**: `utils/agent-validate.js` owns the contract. Exports: `AGENT_ITEM_SCHEMA`, `validateAgentItems(items, { gap, schema })`, `buildCorrectiveFeedback({ violations, gap, schema })`, and `formatSchemaForPrompt(schema)`. The validator checks required fields, field types, allowed fields, and per-turn item count against the current gap. It is also the source of truth that keeps prompt and validation in sync.
- **Single corrective retry per turn**: Parse errors and schema violations both trigger exactly one corrective follow-up inside the same chat session. The retry uses `buildCorrectiveFeedback` to send a structured message listing violations and the required schema. A `contractRetryUsed` flag prevents a second retry. After the retry the orchestrator accepts whatever valid items remain and continues with normal outer-loop behavior.
- **Turn-result logging**: `TURN_RESULT` logs include three new fields — `contractRetryUsed` (boolean), `violationsBeforeRetry` (array of compact violation descriptors from the first attempt), and `violationsAfterRetry` (array of compact violation descriptors from the corrective follow-up). `missingTmdb` and `missingTitle` are retained in `rejectedBreakdown` at `0` for backward compatibility.

## Configuration Page (`public/configure.html`)

- Single HTML file with embedded CSS and JS — no build step.
- State is DOM-centric; Trakt auth state uses hidden inputs + `sessionStorage` during OAuth redirect.
- Hydration of existing config: `fetch` call on `DOMContentLoaded` when a config ID is in the URL.
- **HomepageQuery separator**: Uses `|||` as the multi-entry delimiter (NOT comma). Commas inside query text are safe. Parsing is in three places: `configure.html`, `addon.js`, and `server.js` — all must stay in sync.
- Backend endpoints used by the page: `/encrypt` (generate install URL), `/validate` (validate config).

## Deployment

- **Vercel** (primary): Serverless deployment with Turso (LibSQL) for token storage. Environment variables configured in Vercel dashboard.
- **Docker** (alternative): `Dockerfile` uses `node:23` with corepack + pnpm, exposes port `3000`, sets `NODE_ENV=production`.
- **Gitignored artifacts**: `node_modules/`, `.env`, `trakt_tokens.db`, `cache_data/`.

## Conventions

- All source is **CommonJS** (`require`/`module.exports`), no transpilation.
- `utils/logger.js` is the central logging dependency — all other utils import it.
- `utils/apiRetry.js` provides exponential backoff with jitter for external API calls.
- No TypeScript, no build step — edit JS files directly.
- After editing any `.js` file, verify syntax with `node -c <file>` before considering the task done.
