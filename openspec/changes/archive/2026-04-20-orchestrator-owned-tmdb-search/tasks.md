# Tasks: Orchestrator-Owned TMDB Search

## Phase 1 — Contract and schema foundations
- [x] 1.1 Update `AGENT_ITEM_SCHEMA` to exactly `{ type, title, year }` in `utils/agent-validate.js`. (Files: `utils/agent-validate.js` | Depends on: none | Satisfies: agent-contract spec §Forbid agent-emitted TMDB identifiers, §Emit current-turn candidate arrays only; implements design D9)
  - Verification:
    - Run: `rg "AGENT_ITEM_SCHEMA|tmdb_id" utils/agent-validate.js`
    - Expected: Schema definition contains only `type,title,year`; no required `tmdb_id` field remains.
- [x] 1.2 Update corrective-feedback schema wording to render only three required fields (`type`, `title`, `year`) via `buildCorrectiveFeedback` + schema renderer in `utils/agent-validate.js`. (Files: `utils/agent-validate.js` | Depends on: 1.1 | Satisfies: agent-contract spec §Corrective feedback MUST reference the three-field schema; implements design D9)
  - Verification:
    - Run: `rg "buildCorrectiveFeedback|formatSchemaForPrompt|tmdb_id" utils/agent-validate.js`
    - Expected: Corrective feedback path renders three-field schema text; no feedback instruction requires `tmdb_id`.
- [x] 1.3 Define and document the `typeMismatch` rejection bucket in the turn-result rejection breakdown shape owned by orchestrator flow. (Files: `utils/agent.js` | Depends on: 1.1 | Satisfies: orchestrator-contract spec §Update telemetry fields for TMDB-orchestrated flow; implements design D7)
  - Verification:
    - Run: `rg "rejectedBreakdown|typeMismatch" utils/agent.js`
    - Expected: `TURN_RESULT.rejectedBreakdown` includes `typeMismatch`.
- [x] 1.4 Run syntax check for Phase 1 JS edits with `node -c utils/agent-validate.js` and `node -c utils/agent.js`. (Files: `utils/agent-validate.js`, `utils/agent.js` | Depends on: 1.1-1.3 | Satisfies: repo convention in `AGENTS.md`)
  - Verification:
    - Run: `node -c utils/agent-validate.js && node -c utils/agent.js`
    - Expected: Zero exit code; no syntax errors printed.

## Phase 2 — Orchestrator TMDB invocation
- [x] 2.1 Export `handleBatchSearchTmdb` for direct orchestrator use while preserving existing handler behavior. (Files: `utils/agent-tools.js` | Depends on: 1.1 | Satisfies: orchestrator-contract spec §Resolve turn candidates through orchestrator-owned TMDB search; implements design D2)
  - Verification:
    - Run: `rg "handleBatchSearchTmdb|module\.exports" utils/agent-tools.js`
    - Expected: `handleBatchSearchTmdb` is exported and existing handler signature/logic remains present.
- [x] 2.2 Add orchestrator-side TMDB resolution step inside `executeAgentTurn` after parse/schema-validation (and post-corrective retry) but before `applyTurnFilter` consumption. (Files: `utils/agent.js` | Depends on: 2.1 | Satisfies: orchestrator-contract spec §Resolve turn candidates through orchestrator-owned TMDB search; implements design D2)
  - Verification:
    - Run: `rg "executeAgentTurn|handleBatchSearchTmdb|applyTurnFilter" utils/agent.js`
    - Expected: Resolution call exists in turn flow before the `applyTurnFilter` call site.
- [x] 2.3 Implement deterministic TMDB disambiguation: exact normalized title+year+type first, then first returned match order when ties exist. (Files: `utils/agent.js` | Depends on: 2.2 | Satisfies: orchestrator-contract spec §Materialize tmdb_id exclusively from TMDB tool results; implements design D3)
  - Verification:
    - Run: `rg "normalize|title|year|first" utils/agent.js`
    - Expected: Candidate matching logic documents/enforces exact title+year+type priority and deterministic tie handling.
- [x] 2.4 Implement dual-check type mismatch detection with one cross-type diagnostic fallback and reject as `typeMismatch` when opposite media type resolves. (Files: `utils/agent.js` | Depends on: 2.3 | Satisfies: orchestrator-contract spec §Enforce type coherence against TMDB matches; implements design D4)
  - Verification:
    - Run: `rg "typeMismatch|cross-type|fallback" utils/agent.js`
    - Expected: Opposite-type diagnostic path exists and emits `typeMismatch` classification.
- [x] 2.5 Ensure accepted item identity always uses TMDB-resolved `tmdb_id` and never any model-provided value. (Files: `utils/agent.js` | Depends on: 2.3 | Satisfies: orchestrator-contract spec §Materialize tmdb_id exclusively from TMDB tool results; agent-contract spec §Forbid agent-emitted TMDB identifiers; implements design D3)
  - Verification:
    - Run: `rg "tmdb_id|resolved|parsedItems" utils/agent.js`
    - Expected: Collected/accepted item creation sources `tmdb_id` from resolution output only.
- [x] 2.6 Map per-query TMDB failures from `Promise.allSettled` outcomes to per-candidate rejection handling (`notFound`) and keep `failedConversions` scoped to conversion-stage errors only. (Files: `utils/agent.js`, `utils/agent-tools.js` | Depends on: 2.2 | Satisfies: orchestrator-contract spec §Resolve turn candidates through orchestrator-owned TMDB search; implements design D8)
  - Verification:
    - Run: `rg "notFound|failedConversions|Promise\.allSettled" utils/agent.js utils/agent-tools.js`
    - Expected: Query-level TMDB failures map to `notFound`; `failedConversions` is not reused for TMDB misses.
- [x] 2.7 Run syntax check for Phase 2 JS edits with `node -c utils/agent.js` and `node -c utils/agent-tools.js`. (Files: `utils/agent.js`, `utils/agent-tools.js` | Depends on: 2.1-2.6 | Satisfies: repo convention in `AGENTS.md`)
  - Verification:
    - Run: `node -c utils/agent.js && node -c utils/agent-tools.js`
    - Expected: Zero exit code; no syntax errors printed.

## Phase 3 — Tool surface and prompt updates
- [x] 3.1 Remove `batch_search_tmdb` from model-visible `toolDeclarations` while keeping internal handler availability for orchestrator calls. (Files: `utils/agent-tools.js` | Depends on: 2.1 | Satisfies: agent-contract spec §Agent tool surface excludes TMDB search tool; orchestrator-contract spec §Restrict agent tool surface to favorites-only; implements design D1)
  - Verification:
    - Run: `rg "toolDeclarations|batch_search_tmdb|get_user_favorites" utils/agent-tools.js`
    - Expected: `batch_search_tmdb` absent from declarations; `get_user_favorites` present.
- [x] 3.2 Preserve `get_user_favorites` declaration and execution round-trip behavior in tool dispatch. (Files: `utils/agent-tools.js`, `utils/agent.js` | Depends on: 3.1 | Satisfies: agent-contract spec §Preserve favorites tool behavior and functionResponse round-trips; implements design D5)
  - Verification:
    - Run: `rg "get_user_favorites|functionResponse|executeTools" utils/agent-tools.js utils/agent.js`
    - Expected: Favorites handler and functionResponse injection path remain intact.
- [x] 3.3 Rewrite prompt contract text to require output items with exactly `{type,title,year}` and remove any TMDB-ID/tool ownership instructions from model responsibilities. (Files: `utils/prompts.js` | Depends on: 1.2, 3.1 | Satisfies: agent-contract spec §Keep schema wording identical across turn prompts; §Emit current-turn candidate arrays only; implements design D9)
  - Verification:
    - Run: `rg "tmdb_id|batch_search_tmdb|type,title,year" utils/prompts.js`
    - Expected: Prompt contract references only `{type,title,year}`; no agent-side TMDB-ID/tool-resolution instructions remain.
- [x] 3.4 Implement enriched between-turn refinement feedback format: accepted `title (year)`, rejected grouped by `watched|rated|history|duplicate|typeMismatch|notFound`, and remaining gap. (Files: `utils/agent.js`, `utils/prompts.js` | Depends on: 2.4, 3.3 | Satisfies: orchestrator-contract spec §Emit structured between-turn feedback with rejection reasons; implements design D6)
  - Verification:
    - Run: `rg "watched|rated|history|duplicate|typeMismatch|notFound|Remaining gap" utils/agent.js utils/prompts.js`
    - Expected: Feedback construction includes all required rejection groups and remaining gap.
- [x] 3.5 Run syntax check for Phase 3 JS edits with `node -c utils/agent.js`, `node -c utils/agent-tools.js`, and `node -c utils/prompts.js`. (Files: `utils/agent.js`, `utils/agent-tools.js`, `utils/prompts.js` | Depends on: 3.1-3.4 | Satisfies: repo convention in `AGENTS.md`)
  - Verification:
    - Run: `node -c utils/agent.js && node -c utils/agent-tools.js && node -c utils/prompts.js`
    - Expected: Zero exit code; no syntax errors printed.

## Phase 4 — Removal of obsolete loop mechanics
- [x] 4.1 Remove TMDB-loop-specific recovery/event branches: `TOOL_LOOP_DETECTED` path and nudge reasons `repeated_batch` and `cap_reached`. (Files: `utils/agent.js` | Depends on: 3.1 | Satisfies: orchestrator-contract spec §Remove TMDB tool-loop safety path and loop-detection recovery, §Remove TMDB-loop-specific nudge reasons; implements design D1, D7)
  - Verification:
    - Run: `rg "TOOL_LOOP_DETECTED|repeated_batch|cap_reached" utils/agent.js`
    - Expected: No active emission path remains for these TMDB-loop telemetry surfaces.
- [x] 4.2 Remove TMDB-path reliance on `DEFAULT_MAX_TOOL_ROUNDS_PER_TURN` while preserving remaining favorites-only internal round behavior. (Files: `utils/agent.js` | Depends on: 4.1 | Satisfies: orchestrator-contract spec §No TMDB loop-cap termination path; implements design D1)
  - Verification:
    - Run: `rg "DEFAULT_MAX_TOOL_ROUNDS_PER_TURN|toolRounds" utils/agent.js`
    - Expected: TMDB loop-cap behavior is removed; any retained cap is scoped to favorites-only flow.
- [x] 4.3 Narrow `emptyResponseNudgeUsed` trigger to favorites-only empty non-tool response path and keep text-first completion semantics when text+tool appear together. (Files: `utils/agent.js` | Depends on: 4.1 | Satisfies: orchestrator-contract spec §Narrow empty-response nudge scope to favorites path; implements design D5)
  - Verification:
    - Run: `rg "emptyResponseNudgeUsed|nudgeReason|endedByText" utils/agent.js`
    - Expected: Nudge path is gated to post-favorites empty non-tool responses only.
- [x] 4.4 Preserve single corrective retry contract (one retry maximum) independent of tool-round removal. (Files: `utils/agent.js` | Depends on: 4.1 | Satisfies: orchestrator-contract spec §Preserve single corrective retry for schema violations; implements design D2)
  - Verification:
    - Run: `rg "contractRetryUsed|violationsBeforeRetry|violationsAfterRetry" utils/agent.js`
    - Expected: One-retry flow remains present and unchanged in limit semantics.
- [x] 4.5 Run syntax check for Phase 4 JS edits with `node -c utils/agent.js`. (Files: `utils/agent.js` | Depends on: 4.1-4.4 | Satisfies: repo convention in `AGENTS.md`)
  - Verification:
    - Run: `node -c utils/agent.js`
    - Expected: Zero exit code; no syntax errors printed.

## Phase 5 — Telemetry migration
- [x] 5.1 Enumerate and update every `TURN_RESULT` field according to design D7 mapping (including retained, removed/deprecated, narrowed, and added fields). (Files: `utils/agent.js`, `openspec/changes/orchestrator-owned-tmdb-search/design.md` | Depends on: 2.4, 3.4 | Satisfies: orchestrator-contract spec §Update telemetry fields for TMDB-orchestrated flow, §Superseded telemetry fields and event mapping; implements design D7)
  - Verification:
    - Run: `rg "TURN_RESULT|toolRoundsUsed|emptyResponseNudgeUsed|contractRetryUsed|toolLoopDetected|nudgeReason|rejectedBreakdown" utils/agent.js openspec/changes/orchestrator-owned-tmdb-search/design.md`
    - Expected: All current and migrated `TURN_RESULT` fields are explicitly mapped and implementation aligns with the mapping.
- [x] 5.2 Add orchestrator-side TMDB resolution telemetry event `ORCHESTRATOR_TMDB_RESOLVE_RESULT` with per-query payload (`title`,`year`,`requestedType`,`matchedTmdbId`,`matchedType`,`resolution`,`durationMs`). (Files: `utils/agent.js`, `openspec/changes/orchestrator-owned-tmdb-search/specs/orchestrator-contract/spec.md`, `openspec/changes/orchestrator-owned-tmdb-search/design.md` | Depends on: 2.2, 5.1 | Satisfies: orchestrator-contract spec §Emit orchestrator TMDB resolution telemetry per batch; implements design D7)
  - Verification:
    - Run: `rg "ORCHESTRATOR_TMDB_RESOLVE_RESULT|matchedTmdbId|requestedType|resolution|durationMs" utils/agent.js openspec/changes/orchestrator-owned-tmdb-search/specs/orchestrator-contract/spec.md openspec/changes/orchestrator-owned-tmdb-search/design.md`
    - Expected: Event name and required payload fields exist in both spec/design and implementation references.
- [x] 5.3 Remove/retire TMDB-loop telemetry emissions (`TOOL_LOOP_DETECTED`, deprecated nudge reasons), and constrain `NUDGE_DISPATCHED` to non-removed reasons only. (Files: `utils/agent.js` | Depends on: 4.1 | Satisfies: orchestrator-contract spec §Removed TMDB-loop telemetry is not emitted; §Superseded telemetry fields and event mapping; implements design D7)
  - Verification:
    - Run: `rg "TOOL_LOOP_DETECTED|repeated_batch|cap_reached|NUDGE_DISPATCHED" utils/agent.js`
    - Expected: TMDB-loop event/reasons are absent from active emission paths.
- [x] 5.4 Enumerate and migrate the full `LOOP_END` field set per design D7.2: `totalTurns` (retain), `terminationReason` (retain; no TMDB-loop reason dependency), `collectedCount` (retain), `droppedWatched` (retain), `droppedNoId` (deprecate inert/zero), `droppedMissingTitle` (retain/deprecate zero if unreachable), `droppedCollected` (retain), `droppedProposed` (retain), `droppedRated` (retain), and `elapsed` (retain). Ensure removed/non-contract loop fields are not present in `LOOP_END` payload. (Files: `utils/agent.js`, `openspec/changes/orchestrator-owned-tmdb-search/design.md` | Depends on: 5.2 | Satisfies: orchestrator-contract spec §Superseded telemetry fields and event mapping; implements design D7.2)
  - Verification:
    - Run: `rg "LOOP_END|totalTurns|terminationReason|collectedCount|droppedWatched|droppedNoId|droppedMissingTitle|droppedCollected|droppedProposed|droppedRated|elapsed|droppedDuplicates|durationMs" utils/agent.js`
    - Expected: `LOOP_END` includes `totalTurns,terminationReason,collectedCount,droppedWatched,droppedNoId,droppedMissingTitle,droppedCollected,droppedProposed,droppedRated,elapsed` and does not include `droppedDuplicates` or `durationMs`.
- [x] 5.5 Verify that verification-checklist telemetry items remain checkable against the migrated log shape. (Files: `openspec/changes/orchestrator-owned-tmdb-search/tasks.md`, `openspec/changes/orchestrator-owned-tmdb-search/design.md` | Depends on: 5.1-5.4 | Satisfies: design §Testing Strategy items 3, 7, 8)
  - Verification:
    - Run: `rg "V3|V7|V8|ORCHESTRATOR_TMDB_RESOLVE_RESULT|TURN_RESULT|LOOP_END" openspec/changes/orchestrator-owned-tmdb-search/tasks.md openspec/changes/orchestrator-owned-tmdb-search/design.md`
    - Expected: Checklist items reference fields/events that exist in migrated telemetry definitions.
- [x] 5.6 Run syntax check for Phase 5 JS edits with `node -c utils/agent.js`. (Files: `utils/agent.js` | Depends on: 5.1-5.5 | Satisfies: repo convention in `AGENTS.md`)
  - Verification:
    - Run: `node -c utils/agent.js`
    - Expected: Zero exit code; no syntax errors printed.

## Phase 6 — Runtime deps verification
- [x] 6.1 Verify `runAgentLoop` runtime dependencies still provide orchestrator TMDB resolution needs (`searchTMDB`, caches) and adjust wiring only if gaps exist. (Files: `addon.js`, `utils/agent.js` | Depends on: 2.2 | Satisfies: orchestrator-contract spec §Resolve turn candidates through orchestrator-owned TMDB search; implements design file changes + D8)
  - Verification:
    - Run: `rg "runAgentLoop|searchTMDB|dependencies" addon.js utils/agent.js`
    - Expected: Direct orchestrator TMDB resolution path has required runtime dependencies.
- [x] 6.2 Confirm no regression to non-agent TMDB consumers in `addon.js` while preserving existing dependency ownership boundaries. (Files: `addon.js` | Depends on: 6.1 | Satisfies: design file changes section §Modify addon.js; implements design risk mitigation)
  - Verification:
    - Run: `rg "searchTMDB\(|metaHandler|catalogHandler|streamHandler" addon.js`
    - Expected: Non-agent TMDB call sites remain present and unchanged in responsibility.
- [x] 6.3 Run syntax check for Phase 6 JS edits with `node -c addon.js` and `node -c utils/agent.js`. (Files: `addon.js`, `utils/agent.js` | Depends on: 6.1-6.2 | Satisfies: repo convention in `AGENTS.md`)
  - Verification:
    - Run: `node -c addon.js && node -c utils/agent.js`
    - Expected: Zero exit code; no syntax errors printed.

## Phase 7 — Documentation updates
- [x] 7.1 Update `AGENTS.md` agent-loop contract to document favorites-only model tool surface, orchestrator-owned TMDB resolution, and revised rejection/telemetry expectations. (Files: `AGENTS.md` | Depends on: 3.1, 5.4 | Satisfies: design file changes section §Modify AGENTS.md)
  - Verification:
    - Run: `rg "favorites-only|orchestrator-owned TMDB|ORCHESTRATOR_TMDB_RESOLVE_RESULT|typeMismatch|notFound" AGENTS.md`
    - Expected: Updated agent-loop docs include new tool surface and telemetry vocabulary.
- [x] 7.2 Update root `codemap.md` architecture and agent-loop notes for `{type,title,year}` output contract and orchestrator TMDB ownership. (Files: `codemap.md` | Depends on: 7.1 | Satisfies: design file changes section §Modify codemap.md)
  - Verification:
    - Run: `rg "\{ type, title, year \}|orchestrator-owned TMDB|get_user_favorites" codemap.md`
    - Expected: Root codemap reflects three-field schema and orchestrator TMDB ownership.
- [x] 7.3 Update `utils/codemap.md` module responsibilities to reflect `agent.js` TMDB resolution ownership and `agent-tools.js` favorites-only tool declaration surface. (Files: `utils/codemap.md` | Depends on: 7.1 | Satisfies: design file changes section §Modify utils/codemap.md)
  - Verification:
    - Run: `rg "agent\.js|agent-tools\.js|favorites-only|TMDB resolution" utils/codemap.md`
    - Expected: Utility codemap reflects new responsibility split.

## Phase 8 — Manual verification readiness
- [x] 8.1 Prepare a live-run log review checklist mapped to every design "Testing Strategy" item 1-8 (tool surface, schema violation correction, TMDB ownership traceability, typeMismatch/notFound, favorites round-trip, nudge narrowing, telemetry migration). (Files: `openspec/changes/orchestrator-owned-tmdb-search/tasks.md` | Depends on: 5.4, 7.3 | Satisfies: design "Testing Strategy" items 1-8)
  - Verification:
    - Run: Manual review of `openspec/changes/orchestrator-owned-tmdb-search/tasks.md` Verification checklist entries V1-V8.
    - Expected: Every design Testing Strategy scenario 1-8 maps to at least one checklist item.
- [x] 8.2 Confirm no automated test, CI, lint, formatter, or build tasks were introduced in this plan; keep verification manual/log-driven plus `node -c` syntax checks only. (Files: `openspec/changes/orchestrator-owned-tmdb-search/tasks.md` | Depends on: 8.1 | Satisfies: repo constraints in `AGENTS.md` and user task rules)
  - Verification:
    - Run: `rg "npm test|pnpm test|jest|vitest|eslint|prettier|build|CI" openspec/changes/orchestrator-owned-tmdb-search/tasks.md`
    - Expected: No new automated test/lint/build/CI tasks introduced; verification remains manual/log-driven plus syntax checks.

## Verification checklist
- [x] V1. Inspect chat tool-declaration logs and verify `batch_search_tmdb` is absent while `get_user_favorites` remains present. (Design "Testing Strategy" item 1; agent-contract spec tool-surface scenario) — PASS: confirmed in all 4 runs (no-trakt, no-trakt2, with-trakt, with-trakt2); `functionCallNames: []` throughout and system prompt only declares `get_user_favorites`.
- [-] V2. Inspect a turn with legacy `tmdb_id` in model output and verify schema violation `extra_field` plus corrective feedback that mentions only `{type,title,year}`. (Design "Testing Strategy" item 2; agent-contract spec legacy-id + corrective-feedback scenarios) — N/A in 4 runs: model never emitted `tmdb_id` across 11 turns / 78 items. Condition did not trigger. Infrastructure present (validator rejects `tmdb_id` as `extra_field` per `utils/agent-validate.js` AGENT_ITEM_SCHEMA); requires adversarial prompt to exercise.
- [x] V3. Inspect accepted recommendations and trace each final `tmdb_id` to orchestrator-side TMDB resolution in the same request session via `ORCHESTRATOR_TMDB_RESOLVE_RESULT`. (Design "Testing Strategy" item 3; orchestrator-contract spec TMDB ownership requirements) — PASS: 49 `ORCHESTRATOR_TMDB_RESOLVE_RESULT` events in with-trakt alone; every accepted item has matching resolution event with full payload (`title`, `year`, `requestedType`, `matchedTmdbId`, `matchedType`, `resolution`, `durationMs`).
- [-] V4. Inspect a known cross-type candidate and verify rejection is recorded as `typeMismatch` and item is not collected. (Design "Testing Strategy" item 4; orchestrator-contract spec type-coherence scenarios) — N/A in 4 runs: `typeMismatch: 0` in all TURN_RESULT blocks; no cross-type candidates present in test prompts. Infrastructure present (cross-type diagnostic in `selectTmdbMatchForCandidate`); requires adversarial prompt (e.g., "Love Death & Robots" as movie) to exercise.
- [-] V5. Inspect a nonexistent title/year candidate and verify rejection is recorded as `notFound`. (Design "Testing Strategy" item 5; orchestrator-contract spec resolution-rejection scenarios) — N/A in 4 runs: `notFound: 0` in all TURN_RESULT blocks; all 45+ unique titles resolved successfully. Infrastructure present (per-query failure mapping in `resolveValidatedItems`); requires adversarial prompt with fabricated title to exercise.
- [-] V6. Inspect a turn with `get_user_favorites` and verify functionResponse round-trip occurs before final text array emission. (Design "Testing Strategy" item 6; agent-contract favorites-roundtrip scenario) — N/A verifiable in log: `toolRoundsUsed: 0` in all 4 runs including with-trakt/with-trakt2. Model did not invoke the tool because orchestrator pre-seeded empty `Favorites context` in the system prompt. Round-trip audit (Task 3.2) confirmed mechanism is intact at `utils/agent.js:1432` → `utils/agent-tools.js:339` → `utils/agent-tools.js:352`.
- [-] V7. Inspect nudge telemetry and verify `emptyResponseNudgeUsed=true` appears only after at least one favorites tool round followed by empty non-tool response, never on normal text-only turns. (Design "Testing Strategy" item 7; orchestrator-contract nudge-scope scenarios) — N/A in 4 runs: `emptyResponseNudgeUsed: false` all turns because pre-condition (≥1 favorites round) never occurred (V6 dependency). Gate confirmed correct in source audit (Task 4.3) at `utils/agent.js:1335` — `if (toolRoundsUsed > 0)`.
- [x] V8. Inspect end-to-end telemetry and verify absence of `TOOL_LOOP_DETECTED` and `NUDGE_DISPATCHED` reasons `repeated_batch|cap_reached`, while `LOOP_END` still reports `totalTurns`, `terminationReason`, and `collectedCount`. (Design "Testing Strategy" item 8; orchestrator-contract telemetry migration scenarios) — PASS: no `TOOL_LOOP_DETECTED` events in any of 4 run logs; `NUDGE_DISPATCHED` never emitted (no pre-condition met); `LOOP_END` correctly reports all 10 fields in all runs.
