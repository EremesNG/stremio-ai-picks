# Verification Report: Orchestrator-Owned TMDB Search

## Completeness
- Artifacts reviewed (full pipeline):
  - `openspec/changes/orchestrator-owned-tmdb-search/specs/agent-contract/spec.md`
  - `openspec/changes/orchestrator-owned-tmdb-search/specs/orchestrator-contract/spec.md`
  - `openspec/changes/orchestrator-owned-tmdb-search/design.md`
  - `openspec/changes/orchestrator-owned-tmdb-search/tasks.md`
- Task status in `tasks.md`: implementation phases are effectively complete, but task **2.1 is marked `[~]`** (not `[x]`) at `tasks.md:22`.
- Verification checklist V1–V8 remains unchecked (`tasks.md:159-167`).

## Build and Test Evidence
- Syntax checks executed successfully (no output, zero exit code):
  - `node -c utils/agent.js`
  - `node -c utils/agent-tools.js`
  - `node -c utils/agent-validate.js`
  - `node -c utils/prompts.js`
  - `node -c addon.js`
- Automated tests/lint/CI: not applicable by project constraints.

## Compliance Matrix

### Agent Contract Spec (`specs/agent-contract/spec.md`)
| Scenario | Status | Evidence |
|---|---|---|
| Agent emits legacy `tmdb_id` -> `extra_field` violation | ✅ | `utils/agent-validate.js:68-72` (extra fields), `utils/agent-validate.js:23-29` (schema fields only `type,title,year`) |
| Agent emits three-field contract -> schema valid | ✅ | `utils/agent-validate.js:1-5`, `utils/agent-validate.js:48-66`, `utils/agent-validate.js:75-77` |
| Prompt helpers describe same three fields, no `tmdb_id` | ✅ | Both prompt paths reuse `buildAgentOutputContract`: `utils/prompts.js:13-19`, `utils/prompts.js:41`, `utils/prompts.js:262`; explicit do-not-emit `tmdb_id`: `utils/prompts.js:38`, `utils/prompts.js:261` |
| Non-contract fields violate output contract + corrective feedback requests 3-field schema | ✅ | Extra field detection: `utils/agent-validate.js:68-72`; corrective feedback schema rendering: `utils/agent-validate.js:155-160` |
| Corrective feedback references only three-field schema | ✅ | `utils/agent-validate.js:1-5`, `utils/agent-validate.js:7-10`, `utils/agent-validate.js:155-160` |
| Favorites call works with functionResponse round-trip | ✅ | Tool execution path: `utils/agent.js:1405`; tool results converted to functionResponse in executor: `utils/agent-tools.js:183-194`; reinjected into next message: `utils/agent.js:1485-1490` |
| Agent tool surface excludes TMDB search | ✅ | Tool declarations expose only favorites: `utils/agent-tools.js:4-20`; chat uses `toolDeclarations`: `utils/agent.js:925`; no `batch_search_tmdb` in prompt/tool declaration surface |

### Orchestrator Contract Spec (`specs/orchestrator-contract/spec.md`)
| Scenario | Status | Evidence |
|---|---|---|
| Parsed candidates resolved by orchestrator TMDB batch before filtering | ✅ | Resolution function: `utils/agent.js:1141-1221`; batch call once per turn: `utils/agent.js:1161`; filter runs after turn result: `utils/agent.js:1549-1557` |
| Zero valid items skip TMDB resolution | ✅ | Early return on empty valid items: `utils/agent.js:1142-1144` |
| Type mismatch rejected and not collected | ✅ | Cross-type diagnostic -> `typeMismatch`: `utils/agent.js:1121-1135`; rejection bucket in filter: `utils/agent.js:517-521` |
| Type match continues to downstream filtering | ✅ | Non-`none`/non-`typeMismatch` items continue to watched/history/rated checks: `utils/agent.js:531-549` |
| Agent-provided ID ignored; accepted item uses TMDB-derived ID only | ✅ | Agent `tmdb_id` rejected by schema as extra field: `utils/agent-validate.js:68-72`; orchestrator sets `tmdb_id` from selected TMDB match: `utils/agent.js:1195-1216`; accepted payload uses resolved `tmdb_id`: `utils/agent.js:552-558` |
| Between-turn feedback includes accepted `title (year)`, grouped rejections, gap | ✅ | Accepted formatting: `utils/prompts.js:112-131`, `utils/prompts.js:199-201`, `utils/prompts.js:224`; required buckets: `utils/prompts.js:210-217`, `utils/prompts.js:234-241`; remaining gap: `utils/prompts.js:226` |
| Filtering includes `history`, `typeMismatch`, `notFound` categories | ✅ | Rejection categories in filter: `utils/agent.js:452-459`, `utils/agent.js:517-542`, `utils/agent.js:524-527` |
| Legacy `tmdb_id` fails schema before TMDB resolution | ✅ | Validation occurs before resolution in `handleTextResponse`: `utils/agent.js:1224-1229`, resolution only on `validItems`: `utils/agent.js:1254`, `utils/agent.js:1268`; extra field rule: `utils/agent-validate.js:68-72` |
| Turn tool declarations omit TMDB search tool | ✅ | `toolDeclarations` has only `get_user_favorites`: `utils/agent-tools.js:4-20`; chat attaches these declarations: `utils/agent.js:925` |
| Empty text after favorites round may trigger narrow nudge | ✅ | Nudge only when no text/no tool and prior tool rounds >0: `utils/agent.js:1355-1362`; reason used is `empty_response_post_tool`: `utils/agent.js:1361` |
| Text-only turn never uses empty-response nudge | ✅ | Text path returns immediately before nudge branch: `utils/agent.js:1350-1353` |
| TURN_RESULT includes `rejectedBreakdown.typeMismatch` | ✅ | `utils/agent.js:1614` |
| Removed TMDB-loop telemetry not emitted (`TOOL_LOOP_DETECTED`, reasons `repeated_batch|cap_reached`) | ✅ | No occurrences in `utils/agent.js` (verified via search); nudge reason emitted path uses only provided reason and callsite uses `empty_response_post_tool`: `utils/agent.js:1289-1293`, `utils/agent.js:1361` |
| Every collected `tmdb_id` traceable via orchestrator resolution event | ✅ | Per-query event emitted with required payload: `utils/agent.js:1203-1210`; collected items receive TMDB-derived id from same resolution flow: `utils/agent.js:1195-1216`, `utils/agent.js:552-558` |
| Resolved candidate can still be rejected by history filter | ✅ | History identity check and rejection: `utils/agent.js:538-542` |
| Invalid first payload gets exactly one corrective retry | ✅ | Single retry guard: `utils/agent.js:1226` (`!contractRetryUsed`), set true: `utils/agent.js:1227`, retry issued once and no second retry path |
| No TMDB loop-cap termination path (by tool-surface construction) | ✅ | TMDB tool not model-visible: `utils/agent-tools.js:4-20`; tool rounds cap now applies only to actual tool rounds that can be favorites-only under current declaration: `utils/agent.js:1472-1482` |
| Nudge reasons constrained after change | ✅ | Nudge dispatch reason source at callsite is `empty_response_post_tool`: `utils/agent.js:1361`; forbidden reasons absent in code search |
| Telemetry contract across full run (TURN_RESULT/LOOP_END shape) | ✅ | `TURN_RESULT` includes migrated fields and breakdown: `utils/agent.js:1586-1618`; `LOOP_END` exact payload fields without `droppedDuplicates`/`durationMs`: `utils/agent.js:846-857`, `utils/agent.js:860-871` |

## Design Coherence (full pipeline only)
- D1/D2/D3/D4 alignment: tool surface restricted in `agent-tools.js` while TMDB resolution moved to orchestrator in `agent.js` with deterministic `exact -> title+type -> type-only` plus cross-type diagnostic fallback.
- D5 alignment: functionResponse round-trip remains intact (`executeTools` + reinjection flow).
- D6 alignment: refinement message structure and bucket ordering implemented in `prompts.js` and fed by `runAgentLoop` rejection aggregates.
- D7 alignment: telemetry migrated (`ORCHESTRATOR_TMDB_RESOLVE_RESULT`, enriched `TURN_RESULT`, constrained nudge reasons, stable `LOOP_END`).
- D8/D9 alignment: per-query TMDB isolation preserved via `Promise.allSettled` in `handleBatchSearchTmdb`; validator schema reduced to `{type,title,year}` and used for corrective feedback.

## Issues Found
1. **Warning**: `tasks.md` marks task 2.1 as `[~]` instead of `[x]` (`tasks.md:22`), despite implementation evidence present (`utils/agent-tools.js:237`, `utils/agent-tools.js:377-381`).
2. **Warning**: Verification checklist V1–V8 remains unchecked (`tasks.md:159-167`).
3. **Warning (docs consistency)**: `AGENTS.md:68` still states prompt instructs Gemini to batch TMDB searches first, which conflicts with favorites-only tool surface/orchestrator-owned TMDB behavior documented elsewhere in the same file.

## Verdict
**Pass with warnings** — all delta spec scenarios are implemented and evidenced in code; remaining issues are task/checklist bookkeeping and one documentation inconsistency.
