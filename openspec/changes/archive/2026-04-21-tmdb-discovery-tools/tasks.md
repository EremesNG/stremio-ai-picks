# Tasks: Add TMDB Discovery Tools to Gemini Agent

## Phase 1: Infrastructure (Tool Surface and Shared Contracts)
- [x] 1.1 Extend model-visible tool declarations in `utils/agent-tools.js` to add `discover_content` and `trending_content` with explicit parameter schemas (including bounded pagination semantics and endpoint-mode selectors).
  - Reference: Proposal Success Criteria #1, #2, #4, #7.
- [x] 1.2 Add shared argument sanitization/validation helpers in `utils/agent-tools.js` for both new tools (including `page` hard-cap at `5`, media type guards, list-mode guards, and normalized defaults).
  - Reference: Proposal Success Criteria #4.
- [x] 1.3 Add a centralized TMDB result normalizer in `utils/agent-tools.js` that converts movie/TV/discover/list variants into one consistent payload shape for the model (canonical `type`, `title`, `year`, plus supporting metadata).
  - Reference: Proposal Success Criteria #3.

### Verification
- Run: `node -c utils/agent-tools.js`
- Expected: Syntax passes after Phase 1 edits.

## Phase 2: Implementation (TMDB Clients and Tool Execution)
- [x] 2.1 Implement `discover_content` execution in `utils/agent-tools.js` with TMDB calls to `/discover/movie` and `/discover/tv`, mapping consolidated tool parameters to TMDB query parameters with strict sanitization.
  - Reference: Proposal Success Criteria #1, #4.
- [x] 2.2 Implement `trending_content` execution in `utils/agent-tools.js` with support for:
  - `/trending/movie/{time_window}` and `/trending/tv/{time_window}`
  - `/movie/popular`, `/movie/top_rated`, `/tv/popular`, `/tv/top_rated`
  - shared `page <= 5` enforcement and consistent normalized output.
  - Reference: Proposal Success Criteria #2, #3, #4.
- [x] 2.3 Update `executeTools` in `utils/agent-tools.js` to dispatch `discover_content` and `trending_content` while preserving existing `get_user_favorites` behavior and keeping `handleBatchSearchTmdb` orchestrator-owned.
  - Reference: Proposal Success Criteria #6.
- [x] 2.4 Validate and update dependency wiring in `addon.js` (`agentDependencyBundle`) so new tool executors receive all required TMDB runtime inputs without feature toggles. Required deps for new tools: `tmdbApiKey` (TMDB bearer auth), `language` (user config language preference), `includeAdult` (user config adult filter), `logger` (logging dependency), and the `apiRetry`-wrapped fetch utility for TMDB HTTP calls with exponential backoff.
  - Reference: Proposal Success Criteria #7.

### Verification
- Run: `node -c utils/agent-tools.js`
- Expected: Syntax passes after tool execution and dispatch updates.
- Run: `node -c addon.js`
- Expected: Syntax passes after dependency wiring updates.

## Phase 3: Integration (Prompt Policy and Telemetry)
- [x] 3.1 Update prompt guidance in `utils/prompts.js` (`buildAgentSystemPrompt`, `buildTurnMessage`) so the agent prefers discover-filter diversity before pagination expansion, uses trending/list tools intentionally, and still returns only `{ type, title, year }`.
  - Reference: Proposal Success Criteria #5, #9.
- [x] 3.2a Add per-invocation discovery-tool telemetry in `utils/agent-tools.js` (inside each tool executor): emit a `DISCOVERY_TOOL_CALL` log event with tool name, endpoint/mode, page requested, filter summary (for discover), and error/rate-limit signals on failure.
  - Reference: Proposal Success Criteria #8.
- [x] 3.2b Add turn/loop-level discovery-tool aggregation in `utils/agent.js`: extend `TURN_RESULT` and `LOOP_END` telemetry events with discovery tool usage counts (discoverCalls, trendingCalls) and total pages requested.
  - Reference: Proposal Success Criteria #8.
- [x] 3.3 Confirm `utils/agent.js` keeps tools registered unconditionally (`tools: [{ functionDeclarations: toolDeclarations }]`) and preserves orchestrator-owned `handleBatchSearchTmdb` as the authoritative final identity resolution path.
  - Reference: Proposal Success Criteria #6, #7.

### Verification
- Run: `node -c utils/prompts.js`
- Expected: Syntax passes after prompt updates.
- Run: `node -c utils/agent.js`
- Expected: Syntax passes after telemetry/integration updates.
- Run: `node -c utils/agent-tools.js`
- Expected: Syntax still passes after telemetry hooks.

## Phase 4: Testing and Verification
- [x] 4.1 Verify tool behavior by code review of `executeTools` dispatch paths in `utils/agent-tools.js`: confirm `discover_content` and `trending_content` branches exist, page clamping logic caps at 5, empty TMDB results return a well-formed empty array, and normalized response shape matches the contract from task 1.3. Run `node -c utils/agent-tools.js` to confirm syntax.
  - Files reviewed: `utils/agent-tools.js`.
- [x] 4.2 Verify contract preservation by code review of `utils/agent.js` and `utils/agent-validate.js`: confirm `AGENT_ITEM_SCHEMA` still requires exactly `{ type, title, year }`, `handleBatchSearchTmdb` is still called post-generation, and `toolDeclarations` array now contains all 3 tools unconditionally. Run `node -c utils/agent.js` to confirm syntax.
  - Files reviewed: `utils/agent.js`, `utils/agent-validate.js`.
- [x] 4.3 Final syntax sweep and success criteria evidence: run `node -c` on all 4 modified JS files, then document evidence mapping for proposal success criteria #1-#9.

### Verification
- Run: `node -c utils/agent-tools.js && node -c utils/agent.js && node -c utils/prompts.js && node -c addon.js`
- Expected: All 4 files pass syntax check. Evidence for each success criterion documented.
