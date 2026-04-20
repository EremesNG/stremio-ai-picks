# Tasks: Tool-based watched filter

## Phase 1: Tool definition

### 1.1 Add `check_if_watched` tool declaration and handler
- [x] Add the `check_if_watched` tool declaration and handler in `utils/agent-tools.js`, following the existing `search_tmdb` and `get_user_favorites` pattern.
- [x] Handler must accept batches of up to 10 items shaped like `{ type, tmdb_id?, imdb_id?, title?, year? }`.
- [x] For each item, call `normalizeMediaKey(item)` and check every derived identity key against `traktWatchedIdSet` and `traktRatedIdSet` from tool deps.
- [x] Return per-item status in the form `{ title, watched: boolean, rated: boolean }`.

**Verification**
- **Run**: `node -c utils/agent-tools.js` (syntax check)
- **Expected**: No syntax errors; tool definition includes `check_if_watched` with `execute` function that accepts `items` array parameter

### 1.2 Verify tool handler logic
- [x] Confirm handler normalizes each candidate with `normalizeMediaKey(item)` before any set lookup.
- [x] Confirm handler checks all derived identity keys for each candidate, not just the raw `item.id`.
- [x] Confirm handler returns an array of `{ title, watched, rated }` records aligned to the input batch.

**Verification**
- **Run**: Inspect `utils/agent-tools.js` for handler implementation
- **Expected**: Handler iterates over the items array, normalizes each item, checks all derived keys against `traktWatchedIdSet` and `traktRatedIdSet`, and returns the per-item status array

---

## Phase 2: Prompt updates

### 2.1 Remove `DO-NOT-RECOMMEND IDS:` section from initial message
- [x] Remove the `DO-NOT-RECOMMEND IDS:` section from `buildAgentInitialMessage` in `utils/prompts.js`.
- [x] Remove any references to "do-not-recommend set" or "do-not-recommend list" from the prompt text.

**Verification**
- **Run**: `grep -n "DO-NOT-RECOMMEND\|do-not-recommend" utils/prompts.js`
- **Expected**: No matches in `buildAgentInitialMessage` function

### 2.2 Update `buildAgentSystemPrompt` to instruct tool usage
- [x] Update `buildAgentSystemPrompt` in `utils/prompts.js` to replace the old instruction "Never recommend any item whose tmdb_id or imdb_id appears in the do-not-recommend set" with: "Use the `check_if_watched` tool to verify whether an item has been watched or rated before recommending it. Do not recommend items that have already been watched or rated."
- [x] Ensure the new instruction is clear and actionable for the agent.

**Verification**
- **Run**: `grep -A 5 "check_if_watched" utils/prompts.js`
- **Expected**: System prompt contains instruction to use `check_if_watched` tool; no references to "do-not-recommend set"

### 2.3 Update `utils/agent.js` to remove `doNotRecommend` from prompt builder
- [x] Remove the `doNotRecommend` parameter from the `buildAgentInitialMessage` call in `utils/agent.js`.
- [x] Verify no other calls to `buildAgentInitialMessage` pass `doNotRecommend`.

**Verification**
- **Run**: `grep -n "buildAgentInitialMessage" utils/agent.js`
- **Expected**: All calls to `buildAgentInitialMessage` do not include `doNotRecommend` parameter

### 2.4 Remove `doNotRecommend` from system-prompt build path in `utils/agent.js`
- [x] In `utils/agent.js`, remove the `doNotRecommend` variable construction (around lines 523-527 in `runAgentLoop()`).
- [x] Remove the `doNotRecommend` parameter from the `buildAgentSystemPrompt()` call (around lines 608-613).
- [x] Verify `buildAgentSystemPrompt()` is called without `doNotRecommend` and only receives necessary parameters.

**Verification**
- **Run**: `grep -n "doNotRecommend" utils/agent.js`
- **Expected**: No references to `doNotRecommend` in `utils/agent.js`

---

## Phase 3: Runtime wiring

### 3.1 Thread watched/rated sets into tool execution runtime
- [x] In `utils/agent.js`, ensure `traktWatchedIdSet` and `traktRatedIdSet` are passed to the tool execution context so `check_if_watched` can resolve watched/rated state.
- [x] Verify the sets are available in the tool deps when `check_if_watched` is invoked.

**Verification**
- **Run**: Inspect `utils/agent.js` for tool execution setup
- **Expected**: `traktWatchedIdSet` and `traktRatedIdSet` are included in tool dependencies passed to tool executor

### 3.2 Keep `buildDoNotRecommendList` in `addon.js` for `filterCandidates`
- [x] Confirm `buildDoNotRecommendList` remains in `addon.js` and is used only in the `filterCandidates` function.
- [x] Remove `doNotRecommend` from the `runAgentLoop(...)` call in `addon.js` while keeping the variable for `filterCandidates`.
- [x] Remove `doNotRecommend` parameter acceptance from `runAgentLoop(...)` in `utils/agent.js`.
- [x] Verify `doNotRecommend` is no longer threaded into any prompt-building path.

**Verification**
- **Run**: `grep -n "doNotRecommend\|buildDoNotRecommendList" addon.js utils/agent.js utils/prompts.js`
- **Expected**: `addon.js` still builds `doNotRecommend` for `filterCandidates`, but the `runAgentLoop(...)` call omits it and `utils/agent.js` no longer accepts or passes it into prompt builders

---

## Phase 4: Verification

### 4.1 Syntax verification across all touched files
- [x] Run syntax check on `utils/agent-tools.js`, `utils/prompts.js`, `utils/agent.js`, and `addon.js`.

**Verification**
- **Run**: `node -c utils/agent-tools.js && node -c utils/prompts.js && node -c utils/agent.js && node -c addon.js`
- **Expected**: All files pass syntax check with no errors

### 4.2 Verify system prompt no longer contains do-not-recommend content
- [x] Confirm the system prompt returned by `buildAgentSystemPrompt` does not contain "do-not-recommend" or "do not recommend set".
- [x] Confirm it contains the new instruction to use `check_if_watched` tool.

**Verification**
- **Run**: Create a test script that calls `buildAgentSystemPrompt()` and logs the result; search output for "do-not-recommend" and "check_if_watched"
- **Expected**: Output contains "check_if_watched" instruction; no "do-not-recommend" text present

### 4.3 Deterministic check: `check_if_watched` tool is declared and executable
- [x] Verify `check_if_watched` is declared in `toolDeclarations` in `utils/agent-tools.js`.
- [x] Test tool execution via `executeTools(toolCalls, deps)` with mock dependencies (no live server required).
- [x] Verify it handles edge cases: non-existent IDs, empty batch, batch of 10 items.

**Verification**
- **Run**: `node -e "const { toolDeclarations, executeTools } = require('./utils/agent-tools.js'); const hasCheckIfWatched = toolDeclarations.some(t => t.name === 'check_if_watched'); console.log('check_if_watched declared:', hasCheckIfWatched); const mockDeps = { traktWatchedIdSet: new Set(['tmdb:movie:123']), traktRatedIdSet: new Set(['imdb:tt1234567']) }; executeTools([{ name: 'check_if_watched', args: { items: [{ type: 'movie', tmdb_id: 123, title: 'A', year: 2024 }, { type: 'series', imdb_id: 'tt1234567', title: 'B', year: 2023 }] } }], mockDeps).then(r => console.log('Result:', JSON.stringify(r))).catch(e => console.error('Error:', e.message));"
- **Expected**: 
  - `check_if_watched declared: true`
  - `executeTools(...)` returns an array of function-response payloads
  - Watched item resolves through normalized keys and returns `{ watched: true, rated: false }`
  - Rated item resolves through normalized keys and returns `{ watched: false, rated: true }`
  - No exceptions thrown

### 4.4 Deterministic verification: Prompts and tool integration
- [x] Verify `buildAgentSystemPrompt` output contains the `check_if_watched` tool instruction.
- [x] Verify `buildAgentInitialMessage` output does NOT contain "DO-NOT-RECOMMEND" or "do-not-recommend".
- [x] Verify `toolDeclarations` includes `check_if_watched` and `buildAgentSystemPrompt` references it.

**Verification**
- **Run**: `node -e "const { buildAgentSystemPrompt, buildAgentInitialMessage } = require('./utils/prompts.js'); const { toolDeclarations } = require('./utils/agent-tools.js'); const systemPrompt = buildAgentSystemPrompt(); const initialMsg = buildAgentInitialMessage(); const hasCheckIfWatched = toolDeclarations.some(t => t.name === 'check_if_watched'); console.log('Tool declared:', hasCheckIfWatched); console.log('System prompt contains check_if_watched:', systemPrompt.includes('check_if_watched')); console.log('Initial message contains DO-NOT-RECOMMEND:', initialMsg.includes('DO-NOT-RECOMMEND') || initialMsg.includes('do-not-recommend'));"
- **Expected**: 
  - `Tool declared: true`
  - `System prompt contains check_if_watched: true`
  - `Initial message contains DO-NOT-RECOMMEND: false`
