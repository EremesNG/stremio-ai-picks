# utils/

## Responsibility

The utils directory provides core infrastructure for the Stremio AI Search addon: agent orchestration (turn-based Gemini loop with tool dispatch), external API integration (Trakt.tv, TMDB), resilience patterns (exponential backoff retry), and centralized logging. These modules form the backbone of recommendation generation and data normalization.

## Modules

### agent.js
**Role**: Orchestrates the Gemini agent loop — manages turn-based execution, tool dispatch, recommendation collection, and partial-results fallback.

**Exports**: `runAgentLoop`, `DEFAULT_MAX_TURNS`

**Patterns**: Turn-based agent loop, Strategy pattern (normalization/filtering), Decorator-like retry wrapper

**Flow**: Accepts a `deps` object containing caches, auth tokens, Trakt sets, and config fields. Executes up to `maxTurns` Gemini turns, dispatching function calls to `agent-tools.js`, collecting JSON recommendations, and returning a normalized array. Tracks proposed titles across turns via `proposedTitles` Set to prevent re-proposals. Injects progress feedback as text parts alongside tool-response parts (zero extra turn cost). Forces JSON output on final turn via finalization guard. Falls back to partial results on mid-loop Gemini failure (`api_error_partial`).

**Integration**: Depends on `prompts.js` (prompt building), `agent-tools.js` (tool execution), `trakt.js` (watched/rated data), `apiRetry.js` (Gemini call resilience), `logger.js` (structured logging). Consumed by `addon.js`.

### agent-tools.js
**Role**: Defines Gemini function-calling tool declarations and their handler implementations.

**Exports**: `toolDeclarations`, `executeTools`

**Patterns**: Command pattern (per-tool handlers), Registry pattern (handlers map)

**Flow**: Receives `functionCalls` array from Gemini response, dispatches each call to its matching handler, returns results array. Handlers:
- `search_tmdb` — single TMDB title search
- `batch_search_tmdb` — parallel search for up to 20 queries via `Promise.allSettled`; per-query failure isolation
- `check_if_watched` — checks Trakt watch/rated history; `maxItems=20`; requires `title`, `type`, `year`
- `get_user_favorites` — fetches Trakt favorites list

**Integration**: Depends on `trakt.js` (watched/rated checks, favorites), `logger.js` (tool execution logging). Consumed by `agent.js`.

### prompts.js
**Role**: Builds all prompt strings for the Gemini agent — system prompt, initial message, refinement/finalization messages, and progress feedback.

**Exports**: `buildLinearPrompt`, `buildAgentSystemPrompt`, `buildAgentInitialMessage`, `buildProgressFeedback`

**Patterns**: Builder pattern

**Flow**: Receives context objects (`ctx`), returns formatted strings consumed by `agent.js`. `buildAgentSystemPrompt` conditionally includes `check_if_watched` guidance based on `ctx.filterWatched`. `buildProgressFeedback` generates mid-loop context (accepted count, proposed titles, remaining slots). Implements turn-efficiency protocol: instructs Gemini to batch all searches in one turn, then batch all watched checks, then return JSON.

**Integration**: Consumed by `agent.js`. No external dependencies.

### trakt.js
**Role**: Trakt.tv API integration — fetches watched history, rated items, and favorites; normalizes data into identity key sets for efficient lookups.

**Exports**: `fetchTraktWatchedAndRated`, `isItemWatchedOrRated`, `fetchTraktFavorites`, `normalizeMediaKey`, `buildMediaIdentityKeys`

**Patterns**: Cache-aside pattern, Decorator/Wrapper (retry via `apiRetry.js`)

**Flow**: Fetches paginated Trakt API responses, normalizes into Sets of identity keys (`tmdb:ID`, `imdb:ID`, `title:TYPE:YEAR`), caches results. `buildMediaIdentityKeys` generates all three key variants so Sets contain tmdb, imdb, AND title keys simultaneously. Pagination support enables large watch history retrieval.

**Integration**: Depends on `apiRetry.js` (resilient HTTP calls), `logger.js` (API logging). Consumed by `agent.js`, `agent-tools.js`.

### apiRetry.js
**Role**: Exponential backoff retry utility for resilient external API calls.

**Exports**: `withRetry`

**Patterns**: Decorator/Wrapper

**Flow**: Wraps async functions; retries on transient failures with configurable delay and jitter. Enables graceful degradation for flaky external APIs.

**Integration**: Used by `agent.js` (Gemini calls), `trakt.js` (Trakt API calls). No dependencies.

### logger.js
**Role**: Centralized logging singleton for the entire application.

**Exports**: `logger` (singleton)

**Patterns**: Singleton

**Flow**: Writes structured logs to `logs/` directory. Includes `agent` log method for tracking agent loop events (turns, tool calls, recommendations).

**Integration**: Imported by all other utility modules and `addon.js`. No dependencies.

## Data Flow (Directory-level)

1. **Initialization**: `addon.js` calls `agent.js:runAgentLoop` with a `deps` object containing Trakt tokens, caches, and config.
2. **Prompt Building**: `agent.js` calls `prompts.js` to build system prompt and initial message.
3. **Agent Loop**: `agent.js` sends prompts to Gemini API (wrapped in `apiRetry.js` for resilience).
4. **Tool Dispatch**: Gemini returns function calls; `agent.js` dispatches to `agent-tools.js:executeTools`.
5. **Tool Execution**: `agent-tools.js` handlers call `trakt.js` for watched/rated checks and favorites, or external TMDB API (via `apiRetry.js`).
6. **Feedback Injection**: `agent.js` calls `prompts.js:buildProgressFeedback` to inject mid-loop context.
7. **Finalization**: After `maxTurns` or early termination, `agent.js` returns normalized recommendations to `addon.js`.
8. **Logging**: All modules log via `logger.js` singleton.

## Integration Map

**Depends On**:
- `agent.js` ← `prompts.js`, `agent-tools.js`, `trakt.js`, `apiRetry.js`, `logger.js`
- `agent-tools.js` ← `trakt.js`, `logger.js`
- `trakt.js` ← `apiRetry.js`, `logger.js`
- `prompts.js` ← (no dependencies)
- `apiRetry.js` ← (no dependencies)
- `logger.js` ← (no dependencies)

**Consumed By**:
- `addon.js` ← `agent.js`, `logger.js`
- `server.js` ← `logger.js`
