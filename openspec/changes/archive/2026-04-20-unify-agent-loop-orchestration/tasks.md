# Tasks: Unify agent loop orchestration

Scope note: Full pipeline. Phase 1 stays additive/non-breaking; Phase 2 is the atomic cutover that rewrites the orchestrator and shrinks the tool surface together; Phase 3 migrates callers before Phase 4 deletes legacy code.

## Phase 1: Add parser and turn builder
- [x] 1.1 Create `utils/agent-parse.js` with `parseTurnResponse(rawText)` plus the fence/prose recovery helpers described in `design.md`. This covers the orchestrator contract requirement to parse each turn defensively.
  Verification:
  Run: `node -c utils/agent-parse.js`
  Expected: exit 0, no output
- [x] 1.2 Add `buildTurnMessage(ctx)` to `utils/prompts.js` and export it alongside the existing builders; keep the old prompt helpers intact for now. The new builder must accept the current query, type, count, collected items, proposed titles, gap, discovered genres, and optional favorites context without numbered turn narration.
  Verification:
  Run: `node -c utils/prompts.js`
  Expected: exit 0, no output

## Phase 2: Rewrite the unified orchestrator
- [x] 2.1 Rewrite `runAgentLoop` in `utils/agent.js` so each Gemini round-trip is one turn, `buildTurnMessage(ctx)` is used for every turn, tool-call-only responses still consume budget, and `parseTurnResponse` replaces the final-text parsing path. Keep `proposedTitles` cumulative and recompute `gap = numResults - collected.length` after every turn.
  Verification:
  Run: `node -c utils/agent.js && node -c utils/agent-parse.js && node -c utils/prompts.js`
  Expected: all files parse cleanly
- [x] 2.2 Fold the old tool-surface shrink into the same cutover: remove `search_tmdb` and `check_if_watched` declarations/handlers from `utils/agent-tools.js`, and remove their dispatch/special-casing from `utils/agent.js`. After this phase, Gemini should only see `batch_search_tmdb` and `get_user_favorites`.
  Verification:
  Run: `node -c utils/agent-tools.js && node -c utils/agent.js`
  Expected: exit 0, no output
- [x] 2.3 Update the system prompt and per-turn prompt text in `utils/prompts.js` so they no longer reference `search_tmdb` or `check_if_watched`. Keep `buildAgentSystemPrompt` as the static wrapper and strip only the turn-numbered narration from it.
  Verification:
  Run: `node -c utils/prompts.js`
  Expected: exit 0, no output
- [x] 2.4 Implement the local turn filter in `utils/agent.js` so parsed candidates are deduplicated against `collected` and `proposedTitles`, rejected when `tmdb_id` is missing or when local Trakt watched/rated sets match, and appended to `collected` only after filtering. Ensure the termination branches are success, partial `max_turns_exceeded`, or recoverable parse failure.
  Verification:
  Run: `node -c utils/agent.js`
  Expected: exit 0, and the turn-filter branches remain in the loop

## Phase 3: Migrate remaining callers
- [x] 3.1 Update `buildSimilarContentPrompt` in `utils/prompts.js` so it no longer depends on `buildLinearOutputContract`; inline or otherwise absorb the needed contract text before any deletion so the builder can be removed safely later.
  Verification:
  Run: `node -c utils/prompts.js`
  Expected: exit 0, no output
- [x] 3.2 Update the recommendation branch in `addon.js` around `isRecommendation` so all recommendation requests call the unified `runAgentLoop` path only; pass the query/type/count/context it needs and stop building `buildLinearPrompt` for the fallback path.
  Verification:
  Run: `node -c addon.js`
  Expected: exit 0, no output

## Phase 4: Remove obsolete code
- [x] 4.1 Delete the obsolete prompt builders from `utils/prompts.js`: `buildLinearPrompt`, `buildLinearOutputContract`, `buildAgentInitialMessage`, and `buildProgressFeedback`. Keep `buildAgentSystemPrompt`, `buildTurnMessage`, `buildSimilarContentPrompt`, and `buildClassificationPrompt` intact.
  Verification:
  Run: `node -c utils/prompts.js`
  Expected: exit 0, no output
- [x] 4.2 Remove dead orchestration helpers from `utils/agent.js` that were only used by the old split pipeline, including `processFinalTextResponse`, `buildRefinementMessage`, and any now-unused imports from `prompts.js`. Keep the unified loop entrypoint and logging helpers intact.
  Verification:
  Run: `node -c utils/agent.js`
  Expected: exit 0, no output

## Phase 5: Verification
- [x] 5.1 Run syntax checks on every edited JS file after the refactor lands: `utils/prompts.js`, `utils/agent.js`, `utils/agent-tools.js`, `utils/agent-parse.js`, and `addon.js`.
  Verification:
  Run: `node -c utils/prompts.js && node -c utils/agent.js && node -c utils/agent-tools.js && node -c utils/agent-parse.js && node -c addon.js`
  Expected: all commands exit 0
- [x] 5.2 Run grep audits to confirm the old split-pipeline symbols are gone from active code. For `search_tmdb`, only look for a standalone declaration/handler site; matches inside the `batch_search_tmdb` description are acceptable.
  Verification:
  Run: `rg -n "check_if_watched|buildLinearPrompt|buildAgentInitialMessage|buildRefinementMessage|buildProgressFeedback|processFinalTextResponse" utils/agent.js utils/agent-tools.js utils/prompts.js utils/agent-parse.js addon.js`
  Run: `rg -n "name:\s*['\"]search_tmdb['\"]|handlers\.search_tmdb" utils/agent-tools.js utils/agent.js addon.js`
  Run: `rg -n "Turn 1|Turn 2|Turn 3|Step 1|Step 2" utils/prompts.js`
  Expected: no matches for removed declarations/legacy split-pipeline helpers; incidental `search_tmdb` text inside other descriptions is okay
- [x] 5.3 Manual no-Trakt smoke run: start `pnpm start:dev`, trigger a recommendation query with Trakt disabled, and inspect logs for a one-turn completion path that still returns `numResults` items.
  Verification:
  Run: `pnpm start:dev` then submit one recommendation request with no Trakt auth/config
  Expected: `turnCount` stays at 1, no watched-set filtering branches fire, and final logs show `recommendationCount === numResults`
- [x] 5.4 Manual turn-0 tool-call smoke run: start `pnpm start:dev`, trigger a Trakt-connected recommendation request, and inspect the first two turns to verify turn 0 can be tool-call-only and turn 1 carries the first JSON array.
  Verification:
  Run: `pnpm start:dev` then submit one Trakt-authenticated recommendation request that exercises search tools
  Expected: logs show turn 0 with tool calls only, turn 1 with parsed JSON candidates, and `collected` grows after parsing
