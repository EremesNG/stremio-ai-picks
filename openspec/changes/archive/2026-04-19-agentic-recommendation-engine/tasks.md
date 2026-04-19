# Tasks: Agentic recommendation engine

## Phase 1: Agent loop
- [x] 1.1 Create `utils/agent.js` as a bounded Gemini function-calling loop that receives injected `searchTMDB`, `fetchTraktWatchedAndRated`, `isItemWatchedOrRated`, `processPreferencesInParallel`, cache instances, and Trakt auth from `addon.js`, with the shared `MAX_TURNS` default set to `4`.
  Verification:
  Run: `node --check utils/agent.js && node -e "const m = require('./utils/agent'); console.log(typeof m.runAgentLoop)"`
  Expected: the module parses cleanly, loads at require-time, and exports the agent entrypoint without circular access to `addon.js`.
- [x] 1.2 Add defensive handling in `utils/agent.js` for malformed model output, empty tool turns, unsupported function-calling responses, and tool exceptions so the caller can exit the agent path immediately.
  Verification:
  Run: `node --check utils/agent.js && node -e "const m = require('./utils/agent'); console.log('agent loaded OK')"`
  Expected: the module loads successfully and the failure branches are present without relying on syntax-only validation.
- [x] 1.3 Preserve the existing successful recommendation shape `[{ type, name, year }]` and reject partial payloads before they reach the Stremio response layer.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js`
  Expected: addon syntax is valid and the agent path still normalizes to the current catalog payload contract without requiring `addon.js` at runtime.

## Phase 2: Tool and Trakt integration
- [x] 2.1 Create or update `utils/trakt.js` so history, rated items, and favorites are fetched through injected dependencies and the caller-provided LRU caches, not shared singletons.
  Verification:
  Run: `node --check utils/trakt.js && node -e "const m = require('./utils/trakt'); console.log(typeof m.fetchTraktWatchedAndRated, typeof m.isItemWatchedOrRated)"`
  Expected: the Trakt helper loads cleanly, exports the injected helpers, and does not depend on hidden state in `addon.js`.
- [x] 2.2 Create or update `utils/agent-tools.js` to expose stable declarative schemas for `search_tmdb`, `get_watched_history`, `get_user_favorites`, and `check_if_watched`.
  Verification:
  Run: `node --check utils/agent-tools.js && node -e "const m = require('./utils/agent-tools'); console.log(typeof m.toolDeclarations, typeof m.executeTools)"`
  Expected: the registry loads successfully and exports a declarative tool shape independent of the Gemini loop implementation.
- [x] 2.3 Route preference processing through the injected `processPreferencesInParallel` helper so history, favorites, and candidate checks can be combined without importing addon internals.
  Verification:
  Run: `node --check utils/agent.js && node --check utils/agent-tools.js && node --check utils/trakt.js && node -e "require('./utils/agent'); require('./utils/agent-tools'); require('./utils/trakt'); console.log('agent deps loaded OK')"`
  Expected: preference scoring stays wired through dependency injection and remains optional for the agent path.

## Phase 3: Recommendation integration
- [x] 3.1 Wire the agent path into the recommendation branch of `catalogHandler` in `addon.js` only when Trakt auth is present, passing the full dependency bundle from the call site.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js && node --check utils/agent-tools.js && node --check utils/trakt.js`
  Expected: the recommendation branch invokes the agent with injected tools/caches/auth and leaves other catalog flows untouched; addon integration is verified via syntax only.
- [x] 3.2 Preserve the current linear Gemini → TMDB → watched-filter pipeline as the fallback path for missing auth, unsupported function calling, or any agent failure.
  Verification:
  Run: `node --check addon.js`
  Expected: the fallback path remains available and unchanged when the agent cannot complete successfully.
- [x] 3.3 Keep the success response contract unchanged so both agent and fallback results still serialize to the existing catalog JSON schema.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js`
  Expected: recommendation responses remain valid Stremio catalog payloads in both code paths without runtime addon smoke tests.

## Phase 4: Latency and cost instrumentation
- [x] 4.1 Add lightweight instrumentation around agent execution to capture end-to-end latency, turn count, tool-call count, and fallback reason for production monitoring.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js`
  Expected: the agent path emits structured timing and cost-proxy data without changing behavior.
- [x] 4.2 Emit instrumentation through the existing logging path only and keep it non-blocking so recommendation latency is not increased by telemetry work.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js && node --check utils/trakt.js`
  Expected: telemetry is observational only and does not alter the response payload or control flow.

## Phase 5: Verification
- [x] 5.1 Run syntax checks across every touched module after integration is complete.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js && node --check utils/agent-tools.js && node --check utils/trakt.js && node -e "require('./utils/agent'); require('./utils/agent-tools'); require('./utils/trakt'); console.log('all standalone modules loaded OK')"`
  Expected: no syntax, require-time, or module-resolution errors remain in the recommendation path; addon.js is syntax-checked only.
- [ ] 5.2 Perform one recommendation smoke test with Trakt connected and one forced-fallback smoke test with Trakt auth removed or invalidated.
  Verification:
  Run:
  ```bash
  # Agent path (with Trakt):
  curl http://127.0.0.1:7000/{CONFIG_WITH_TRAKT}/catalog/movie/ai_search/search=sci-fi.json

  # Fallback path (without Trakt):
  curl http://127.0.0.1:7000/{CONFIG_WITHOUT_TRAKT}/catalog/movie/ai_search/search=sci-fi.json
  ```
  Expected: start the server with `pnpm start:dev`, use the configure page to generate an encrypted config URL with Trakt connected for the agent path, and confirm recommendations are returned; then repeat with a config that has no `traktUsername` to exercise the fallback.

## Phase 6: Correctness migration (added after 5.2 smoke surfaced thoughtSignature bug)
- [x] 6.1 Migrate `runAgentLoop` in `utils/agent.js` to use `ai.chats.create()` + `chat.sendMessage()` instead of manual `contents[]` bookkeeping. The manual loop dropped part-level `thoughtSignature` when rebuilding the previous-turn model content, causing HTTP 400 `INVALID_ARGUMENT` on turn N+1 with thinking-capable Gemini models (2.5+/3.x). `ai.chats` preserves the full `Content` object (including signatures) via its internal `recordHistory`, aligning with the officially-documented pattern.
  Verification:
  Run: `node --check utils/agent.js && node -e "const m = require('./utils/agent'); console.log(typeof m.runAgentLoop)"`
  Expected: syntax valid, require-time load under 1s, same exported surface.

## Phase 7: Orchestrator-owned filter + agent-proposer loop (added after 6.1 smoke surfaced watched-items-in-output bug)
Architecture: agent proposes candidates with verifiable IDs; orchestrator deterministically filters against Trakt history; loop iterates with explicit refinement feedback until N unwatched items collected or termination. See `sdd/agentic-recommendation-engine/phase-7-contract` in memory for full contract and oracle review (approved after revisions on duplicates/no-ID handling and removing watched backfill).

- [x] 7.1 Fix title/name mismatch bug in `utils/trakt.js:203` (`isItemWatchedOrRatedImpl`). Accept `item.title || item.name` defensively, and add normalized media-key helper `{ type, tmdb_id, imdb_id, title, year }` that centralizes type aliasing (`show`/`series`), ID extraction, and title/year fallback. Export the helper for reuse in 7.5 filter.
  Verification:
  Run: `node --check utils/trakt.js && node -e "const m = require('./utils/trakt'); console.log(typeof m.fetchTraktWatchedAndRated, typeof m.isItemWatchedOrRated)"`
  Expected: module loads, exports intact.

- [x] 7.2 Extract rich prompt-building logic from `addon.js:3320-3413` to a new `utils/prompts.js` module. Two exported builders: `buildLinearPrompt(ctx)` (current shape, returns complete prompt string) and `buildAgentSystemPrompt(ctx)` / `buildAgentInitialMessage(ctx)` (new, with imperative tool-use protocol, N, do-not-recommend ID set, output shape `[{ type, name, year, tmdb_id, imdb_id? }]`). Refactor addon.js linear path to consume `buildLinearPrompt`; no behavior change for linear path.
  Verification:
  Run: `node --check utils/prompts.js && node --check addon.js && node -e "const p = require('./utils/prompts'); console.log(typeof p.buildLinearPrompt, typeof p.buildAgentSystemPrompt, typeof p.buildAgentInitialMessage)"`
  Expected: module loads, three functions exported, addon.js still parses cleanly.

- [x] 7.3 Redesign `utils/agent-tools.js`: REMOVE `check_if_watched` and `get_watched_history` tool declarations AND handlers (orchestrator owns filtering; history passed inline via prompt in 7.2). KEEP `search_tmdb` and `get_user_favorites`. Update `toolDeclarations` export accordingly.
  Verification:
  Run: `node --check utils/agent-tools.js && node -e "const m = require('./utils/agent-tools'); console.log(m.toolDeclarations.map(d => d.name))"`
  Expected: outputs `[ 'search_tmdb', 'get_user_favorites' ]`.

- [x] 7.4 Update response normalization in `utils/agent.js` (`normalizeRecommendationList`): enforce `tmdb_id` presence as a finite integer, preserve `imdb_id` when present, drop items missing `tmdb_id`. Update output contract to `[{ type, name, year, tmdb_id, imdb_id? }]`. Per-item drop reasons logged at debug level.
  Verification:
  Run: `node --check utils/agent.js`
  Expected: syntax valid.

- [x] 7.5 Rewrite `runAgentLoop` in `utils/agent.js` to orchestrate the new multi-turn proposer-verifier loop:
  - Accept deps: `numResults` (N), `traktWatchedIdSet` (Set/Map of normalized keys), `traktRatedIdSet`, plus existing deps.
  - Initial turn: send prompt built by `buildAgentSystemPrompt` + `buildAgentInitialMessage` (includes do-not-recommend IDs).
  - Tool turns: execute via existing `executeTools` with current tools (search_tmdb, get_user_favorites).
  - After each final-answer turn: hand off to a deterministic filter function (injected via deps as `filterCandidates(rawItems) -> { unwatched, droppedWatched, droppedNoId, droppedDuplicates }`). Maintain cross-turn `proposedIdSet` to detect duplicates; maintain `collected` of verified-unwatched items.
  - If `collected.length >= N`: exit with `{ success: true, recommendations: collected.slice(0, N) }`.
  - Else: send refinement message listing k needed, ID list of items watched-dropped from this turn, count of no-ID and duplicate drops. Include bounded forbidden-set from recent proposals.
  - If a turn produces 0 useful items: exit early with `reason: "agent_stuck"` returning `collected` (may be shorter than N).
  - Hit MAX_TURNS: exit with `reason: "max_turns_exceeded"` returning `collected` (may be shorter than N). No backfill with watched items.
  - Preserve existing defensive exits (function_calling_unsupported, empty_turn, invalid_final_json). Preserve telemetry log (add `collectedCount`, `droppedWatched`, `droppedNoId`, `droppedDuplicates` fields).
  Verification:
  Run: `node --check utils/agent.js && node -e "const m = require('./utils/agent'); console.log(typeof m.runAgentLoop)"`
  Expected: syntax valid, require-time load under 1s.

- [x] 7.6 Wire Phase 7 contract into `addon.js` catalogHandler recommendation branch:
  - Pass `numResults`, `traktWatchedIdSet`, `traktRatedIdSet` (built from existing traktData using the normalized-key helper from 7.1) into `runAgentLoop` deps.
  - Inject `filterCandidates` closure that uses the helper for matching on `(type, tmdb_id)` primary, `imdb_id` secondary, `title+year` last-resort.
  - On agent success (even with shorter list): feed collected items into existing downstream enrichment. Log `collectedCount` vs requested N.
  - On agent failure (`{ success: false }` with technical reasons like `function_calling_unsupported`, `invalid_final_json`, etc.): fall through to existing linear pipeline as today.
  - On `reason: "agent_stuck"` or `"max_turns_exceeded"` with `collected.length > 0`: treat as success with shorter list (NO linear fallback).
  - On `reason: "agent_stuck"` or `"max_turns_exceeded"` with `collected.length === 0`: fall through to linear pipeline as if technical error.
  Verification:
  Run: `node --check addon.js`
  Expected: syntax valid.

- [x] 7.7 Run syntax + require-time smoke across all touched modules after Phase 7 integration.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js && node --check utils/agent-tools.js && node --check utils/trakt.js && node --check utils/prompts.js && node -e "require('./utils/agent'); require('./utils/agent-tools'); require('./utils/trakt'); require('./utils/prompts'); console.log('phase 7 modules loaded OK')"`
  Expected: all checks pass, require-time loads under 1s, prints the OK marker.

- [x] 7.9 Guard `discoverTypeAndGenres` call in `catalogHandler` (addon.js:~3127) with try/catch. On failure, log a warning and continue with `discoveredType` falling back to the catalog's own `type` and `discoveredGenres = []`. This unblocks 7.8 verification when Gemini returns 503s during genre discovery and aligns with the existing "fail open to linear path" posture elsewhere.
  Verification:
  Run: `node --check addon.js`
  Expected: syntax valid; recommendation branch no longer aborts the whole request when `discoverTypeAndGenres` throws.

- [x] 7.10 Guard remaining Gemini `generateContent` call sites in `addon.js` at the linear-path locations (around lines 3692 and 3763) and at `addon.js:4313` (getAiSearch) with try/catch so request no longer crashes when `withRetry` exhausts its attempts on 503. On failure: log at `warn` level, return an empty/sensible fallback response (empty metas array for catalog path, empty suggestions for search path) rather than propagating 500 to Stremio.
  Verification:
  Run: `node --check addon.js`
  Expected: syntax valid; no Gemini call in the hot request paths can propagate an unhandled throw to Express.

- [x] 7.11 Switch hardcoded default model strings to `gemini-flash-lite-latest` to align with AI Studio behavior and avoid preview/thinking pool saturation. Update: `addon.js:248` (DEFAULT_GEMINI_MODEL), `utils/agent.js:477` (default modelName), `server.js:1532` (modelToUse fallback). Keep user-config override intact.
  Verification:
  Run: `node --check addon.js && node --check utils/agent.js && node --check server.js`
  Expected: syntax valid.

- [x] 7.12 Reduce `thinkingBudget` aggressiveness. In `addon.js` at lines 3689, 3789, 4308: change `1024` → `256`. Additionally, in the thinking-gate regex (currently `/2\.5|[3-9]\./i`), exclude `-lite` model variants entirely (thinking is wasted on lite models). Keep line 2513 at 256 unchanged.
  Verification:
  Run: `node --check addon.js`
  Expected: syntax valid.

- [x] 7.13 Increase `withRetry` default `maxRetries` in `utils/apiRetry.js` from 3 to 6, and increase base delay slightly to give transient 503 spikes more time to recover. Keep existing jitter/backoff curve otherwise intact.
  Verification:
  Run: `node --check utils/apiRetry.js`
  Expected: syntax valid.

- [x] 7.14 Fix Trakt history/ratings pagination in `addon.js:735-739`, `addon.js:576-579`, and `utils/trakt.js:185-191`. Currently all three fetch only `page=1&limit=100`, which truncates the watched/rated dataset used to build `traktWatchedIdSet` / `traktRatedIdSet`. Users with >100 items see the filter pass through items they've already watched. Implement paginated accumulation (loop while `X-Pagination-Page-Count` header indicates more pages, or fallback: raise limit to `limit=1000` on each endpoint and keep pagination loop for safety). Apply identical fix to both `addon.js` internal fetch and `utils/trakt.js` shim.
  Verification:
  Run: `node --check addon.js && node --check utils/trakt.js`
  Expected: syntax valid; subsequent e2e smoke shows `droppedWatched > 0` on at least one turn for a user with rich Trakt history.

- [x] 7.15 Preserve agent-resolved `tmdb_id`/`imdb_id` through downstream enrichment in `addon.js`. Log evidence shows recommendations reach "Converting recommendations to meta objects" as `{ name, year, type, id: 'ai_movie_*' }` — the `tmdb_id` the agent returned (and that Phase 7 made required) is being stripped before enrichment, forcing wasteful name+year re-resolution against TMDB. Locate where agent-produced recommendations are reshaped prior to enrichment and preserve the `tmdb_id` / `imdb_id` fields. Enrichment can use them to short-circuit TMDB lookup.
  Verification:
  Run: `node --check addon.js`
  Expected: syntax valid; subsequent e2e log shows enrichment input objects include `tmdb_id`.

- [x] 7.16 Add instrumentation log for set sizes (watched/rated/doNotRecommend) before `runAgentLoop` invocation to make cache-staleness or build errors visible in one glance.

- [ ] 7.8 Manual e2e smoke: agent path with Trakt connected should return N items none of which appear in the user's Trakt watched/rated history. Forced-fallback path (Trakt disconnected) unchanged. Verify in `logs/app.log` that `Agent loop complete` telemetry shows `toolCalls > 1`, `collectedCount >= N` or a clear `reason` explaining shortage, and `droppedWatched > 0` on at least one turn when history is relevant.
  Verification:
  Run: `pnpm start:dev` then trigger a recommendation request in Stremio with Trakt connected. Inspect `logs/app.log` for the agent turn trace.
  Expected: no items in the final response match the user's Trakt watched/rated IDs.
