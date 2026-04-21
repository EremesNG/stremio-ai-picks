# Design: Orchestrator-Owned TMDB Search

## Technical Approach

### 1) Architecture overview (new per-turn path)

1. **Turn dispatch in a single chat session**: `runAgentLoop` creates one chat via `ai.chats.create` and reuses it across turns (`utils/agent.js:854-860`, `utils/agent.js:1303-1307`).
2. **Model response retrieval**: each round uses `callGemini -> chat.sendMessage` (`utils/agent.js:627-637`, `utils/agent.js:1099-1103`).
3. **Favorites tool rounds remain in-turn**: function calls are executed and injected back as `functionResponse` parts + refreshed text instruction (`utils/agent.js:1191-1192`, `utils/agent.js:1282-1287`).
4. **Text response parse + schema validation**: parse via `parseTurnResponse`, then validate against `AGENT_ITEM_SCHEMA` (`utils/agent.js:895-920`, `utils/agent-validate.js:1-6`, `utils/agent-validate.js:24-100`).
5. **Single corrective retry unchanged**: violations trigger one corrective follow-up using `buildCorrectiveFeedback` (`utils/agent.js:988-1029`, `utils/agent-validate.js:102-162`).
6. **New orchestrator-owned TMDB resolve step** (added): for schema-valid items only, call `handleBatchSearchTmdb` directly (existing handler is deterministic and already uses `Promise.allSettled`) (`utils/agent-tools.js:268-315`).
7. **Type coherence gate** (added): compare candidate `type` vs TMDB-resolved type; mismatches rejected as `typeMismatch` before identity filtering.
8. **Identity filtering and dedupe remain orchestrator-owned**: pass resolved+type-coherent items into `applyTurnFilter` (`utils/agent.js:1346-1354`) which uses collected/proposed sets + Trakt identity keys (`utils/agent.js:409-523`, `utils/mediaIdentity.js:3-52`).
9. **Collection and feedback**: collect survivors, compute gap, send enriched categorized feedback for next turn when needed.

### 2) Coexisting `get_user_favorites` path

- `get_user_favorites` remains agent-visible and executable through `executeTools` handler map (`utils/agent-tools.js:37-50`, `utils/agent-tools.js:317-338`, `utils/agent-tools.js:340-406`).
- Turn completion still depends on text emission; tool-only rounds do not close a turn (`utils/agent.js:1107-1115`, `utils/agent.js:1117-1136`).
- Empty-response nudge is retained only for post-favorites empty non-tool response (see D5/D6/D7).

## Architecture Decisions

### D1: Remove `batch_search_tmdb` declaration vs dormant/flagged
**Choice**: Remove from Gemini `toolDeclarations` entirely; keep handler callable by orchestrator only.

**Alternatives considered**:
- Keep declaration but “unused” by prompt.
- Feature-flag declaration.

**Rationale**:
- Full removal is the only option that makes TMDB-tool-loop branches unreachable by construction and matches spec deltas.
- Current declaration is explicitly agent-facing (`utils/agent-tools.js:4-35`) and currently drives loop-recovery logic (`utils/agent.js:1147-1171`, `utils/agent.js:1262-1280`); keeping it visible preserves failure mode risk.

### D2: Where orchestrator invokes `handleBatchSearchTmdb`
**Choice**: Inside `executeAgentTurn`, immediately after parse/schema validation (and post-corrective retry if used), before returning `parsedItems` for `applyTurnFilter`.

**Alternatives considered**:
- Resolve in outer `runAgentLoop` after `executeAgentTurn` returns.

**Rationale**:
- Keeps all per-turn contract handling (parse/validate/retry/resolve) co-located (`utils/agent.js:895-1039`).
- Preserves existing outer call-site responsibility split where `applyTurnFilter` remains post-turn (`utils/agent.js:1346-1354`).
- Enables `TURN_RESULT` to represent post-resolution acceptance/rejection categories in one place.

### D3: Authoritative `tmdb_id` source and disambiguation
**Choice**: TMDB resolution output is authoritative; agent-provided IDs are invalid schema extras. Matching algorithm per candidate:
1) Query `handleBatchSearchTmdb` with candidate `{type, title, year}`.
2) In returned `matches`, select first match where normalized `title` equals candidate title (case-insensitive) and `year` equals candidate year.
3) If multiple exact matches remain, choose first returned match (stable API order).
4) If none, reject as `notFound`.

**Alternatives considered**:
- Trust agent `tmdb_id` when present.
- Fuzzy-title ranking.

**Rationale**:
- Spec requires TMDB-only identity materialization.
- Existing handler already returns ordered deduped `matches` per query (`utils/agent-tools.js:283-293`), making deterministic first-match resolution feasible.

### D4: `typeMismatch` detection strategy
**Choice**: Dual-check strategy: resolve using declared type first; if no candidate match, perform one fallback cross-type lookup (`movie`<->`series`) for diagnosis only. If cross-type resolves, reject as `typeMismatch`; if not, reject `notFound`.

**Alternatives considered**:
- Single-type lookup only; all misses become `notFound`.

**Rationale**:
- Required `typeMismatch` category needs observable detection, not inference.
- Preserves strictness while avoiding false negatives when title/year exists under opposite media type.

### D5: Handling `get_user_favorites` within new flow
**Choice**: Keep current loop semantics: favorites function calls can happen in one or more internal rounds before final text; if model emits both function call and text in same response, treat as text-completing response and skip tool execution for that response.

**Alternatives considered**:
- Force favorites to be a separate round only.
- Execute tools even when text is present.

**Rationale**:
- Current control flow prioritizes text completion (`utils/agent.js:1112-1115`) and only executes tools for tool-only responses (`utils/agent.js:1110`, `utils/agent.js:1138-1192`); design keeps this deterministic behavior.

### D6: Enriched next-turn feedback structure
**Choice**: Replace generic `buildTurnMessage`-only continuation with a structured refinement body containing:
- Accepted items list as `title (year)`.
- Rejected groups: `watched`, `rated`, `history`, `duplicate`, `typeMismatch`, `notFound`.
- Remaining `gap` and anti-duplication reminder using `proposedTitles` context.

**Pseudo-template**:
- `Accepted this turn: <title (year), ... | none>`
- `Rejected this turn:`
  - `watched: n`
  - `rated: n`
  - `history: n`
  - `duplicate: n`
  - `typeMismatch: n`
  - `notFound: n`
- `Remaining gap: <gap>`
- `Do not re-propose accepted/proposed titles.`
- `Return ONLY JSON array with exactly {type,title,year} items.`

**Rationale**:
- Meets orchestrator-contract requirement for categorized rejection feedback.

### D7: Telemetry migration
**Choice**: migrate `TURN_RESULT` and `LOOP_END` field-by-field, preserving existing semantics where still valid and explicitly replacing TMDB-tool-surface-only observability.

#### D7.1 `TURN_RESULT` mapping (`utils/agent.js:1367-1397`)

| Field | Current behavior | New behavior | Rationale |
|---|---|---|---|
| `turn` (`1368`) | Orchestrator turn index | **Retained** | Turn accounting contract unchanged |
| `toolRoundsUsed` (`1369`) | Internal tool rounds consumed in turn | **Retained, narrowed** to favorites-only rounds | TMDB tool rounds removed from model surface |
| `parsedCount` (`1370`) | Parsed items count for turn | **Retained** | Still required for contract debugging |
| `rawTextLength` (`1371`) | Response text length | **Retained** | Parse diagnostics unchanged |
| `rawTextSnippet` (`1372`) | First text snippet | **Retained** | Parse diagnostics unchanged |
| `parseError` (`1373`) | Parse error code or null | **Retained** | Retry path unchanged |
| `endedByText` (`1374`) | Whether turn closed via text | **Retained** | Turn semantics unchanged |
| `toolLoopExhausted` (`1375`) | Max tool rounds exhausted | **Removed for TMDB path; retained only if favorites-only safety cap remains** | TMDB loop exhaustion path is superseded |
| `contractRetryUsed` (`1376`) | Single corrective retry used | **Retained** | Existing schema-retry contract remains |
| `emptyResponseNudgeUsed` (`1377`) | Empty-response nudge dispatched | **Retained, narrowed** to post-favorites empty non-tool path | Required narrowing in this change |
| `nudgeReason` (`1378`) | Nudge classification | **Retained but constrained**: MUST NOT emit `repeated_batch` or `cap_reached`; may be null/empty-response-only | Removes TMDB-loop reasons while preserving compatibility |
| `toolLoopDetected` (`1379`) | Repeated TMDB batch loop detection | **Deprecated inert** (`false`) or removed | No model-visible TMDB batch tool remains |
| `violationsBeforeRetry` (`1380-1382`) | Violations before corrective retry | **Retained** | Contract observability unchanged |
| `violationsAfterRetry` (`1383-1385`) | Violations after corrective retry | **Retained** | Contract observability unchanged |
| `acceptedCount` (`1386`) | Accepted candidates this turn | **Retained** | Core turn accounting |
| `rejectedCount` (`1387`) | Rejected candidates this turn | **Retained** | Core turn accounting |
| `rejectedBreakdown.missingTmdb` (`1389`) | Missing `tmdb_id` rejections | **Removed/deprecated zero** | Agent no longer emits `tmdb_id` |
| `rejectedBreakdown.missingTitle` (`1390`) | Missing title filter rejects | **Retained/deprecated zero if unreachable** | Backward compatibility and explicit invariants |
| `rejectedBreakdown.duplicateCollected` (`1391`) | Duplicate-in-collected rejects | **Retained** | Dedupe ownership unchanged |
| `rejectedBreakdown.duplicateProposed` (`1392`) | Duplicate-in-proposed rejects | **Retained** | Dedupe ownership unchanged |
| `rejectedBreakdown.watched` (`1393`) | Watched-history rejects (legacy mixed) | **Retained, narrowed** to watched only | Split from history bucket |
| `rejectedBreakdown.rated` (`1394`) | Rated rejects | **Retained** | Trakt rated filtering unchanged |
| `rejectedBreakdown.history` (new) | Not present today | **Added** | Explicit history visibility required |
| `rejectedBreakdown.typeMismatch` (new) | Not present today | **Added** | New TMDB type-coherence rejection |
| `rejectedBreakdown.notFound` (new) | Not present today | **Added** | New unresolved-candidate rejection |
| `gap` (`1396`) | Remaining gap after turn | **Retained** | Loop progression unchanged |

Note: `droppedHistory` is **not present** in current `TURN_RESULT`; this change keeps history as `rejectedBreakdown.history` rather than introducing a new top-level dropped field.

#### D7.2 `LOOP_END` mapping (`utils/agent.js:782-807`)

| Field | Current behavior | New behavior | Rationale |
|---|---|---|---|
| `totalTurns` (`783`, `797`) | Completed orchestrator turns | **Retained** | Stable public telemetry |
| `terminationReason` (`784`, `798`) | Final loop reason | **Retained** (without TMDB-loop reason dependency) | Loop-end continuity required |
| `collectedCount` (`785`, `799`) | Final collected count | **Retained** | Success/partial accounting unchanged |
| `droppedWatched` (`786`, `800`) | Aggregate watched drops | **Retained** | Existing dashboards |
| `droppedNoId` (`787`, `801`) | Aggregate no-id drops | **Deprecated inert/zero** | Agent `tmdb_id` requirement removed |
| `droppedMissingTitle` (`788`, `802`) | Aggregate missing-title drops | **Retained/deprecated zero if unreachable** | Compatibility |
| `droppedCollected` (`789`, `803`) | Aggregate duplicate-collected drops | **Retained** | Dedupe continuity |
| `droppedProposed` (`790`, `804`) | Aggregate duplicate-proposed drops | **Retained** | Dedupe continuity |
| `droppedRated` (`791`, `805`) | Aggregate rated drops | **Retained** | Rated filtering continuity |
| `elapsed` (`792`, `806`) | Loop elapsed milliseconds | **Retained** | Operational monitoring |

#### D7.3 Event-level migration

- `TOOL_LOOP_DETECTED`: **Removed** for TMDB-loop path.
- `NUDGE_DISPATCHED`: **Constrained**; reasons `repeated_batch` and `cap_reached` must not appear.
- New event: **`ORCHESTRATOR_TMDB_RESOLVE_RESULT`** to replace TMDB-resolution visibility previously provided by model-tool `TOOL_EXEC_RESULT` when `batch_search_tmdb` ran via `executeTools` (`utils/agent-tools.js:363-381`).

`ORCHESTRATOR_TMDB_RESOLVE_RESULT` payload requirements:
- emitted once per query within an orchestrator-owned TMDB resolution batch
- includes: `title`, `year`, `requestedType`, `matchedTmdbId`, `matchedType`, `resolution` (`exact|title+type|type-only|typeMismatch|none`), `durationMs`

**Rationale**:
- Current TMDB visibility in logs depends on tool execution events that will not fire once orchestrator calls `handleBatchSearchTmdb` directly (`utils/agent-tools.js:268-315`).
- New event restores auditability and enables verification that every final `tmdb_id` is derived from same-request TMDB resolution.

### D8: Error handling for orchestrator TMDB resolution
**Choice**: Preserve per-query isolation from existing `Promise.allSettled` behavior (`utils/agent-tools.js:271-315`).
- Per-query failure with empty `matches` + `error` becomes rejection `notFound` (and increments diagnostics counter for tmdbQueryError).
- Candidate conversion/schema issues remain under validation/violation handling (`failedConversions` stays for downstream transformation errors, not TMDB misses).
- `ORCHESTRATOR_TMDB_RESOLVE_RESULT` MUST still emit per-query entries for failed queries with `resolution=none` and populated `durationMs`.

**Alternatives considered**:
- Fail whole turn on any query error.

**Rationale**:
- Existing handler is intentionally resilient per query; design keeps partial-progress behavior.

### D9: Validator update path
**Choice**: Change `AGENT_ITEM_SCHEMA` to exactly `{ type, title, year }`; any `tmdb_id` emitted by agent remains `extra_field` violation.

**Alternatives considered**:
- Silently strip `tmdb_id`.

**Rationale**:
- Spec requires explicit violation behavior.
- Corrective feedback is schema-derived via `formatSchemaForPrompt(schema)` and therefore automatically references only three fields after schema update (`utils/agent-validate.js:8-12`, `utils/agent-validate.js:152-161`).

## Data Flow

1. `runAgentLoop` builds runtime deps and shared chat (`utils/agent.js:862-879`, `utils/agent.js:854-860`).
2. `executeAgentTurn` runs model rounds (`utils/agent.js:1095-1103`).
3. If tool-only and tool is favorites, execute and inject `functionResponse` parts (`utils/agent.js:1191-1192`, `utils/agent.js:1282-1287`).
4. On text: parse + validate + optional corrective retry (`utils/agent.js:895-920`, `utils/agent.js:988-1029`).
5. **New**: resolve validated candidates via orchestrator TMDB handler (`utils/agent-tools.js:268-315`) and annotate with rejection causes (`notFound`/`typeMismatch`).
6. Record proposed titles from raw parsed items (unchanged ownership) (`utils/agent.js:1344`).
7. Apply local dedupe + Trakt identity filter on resolved candidates (`utils/agent.js:1346-1354`, `utils/agent.js:409-523`, `utils/mediaIdentity.js:3-52`).
8. Emit migrated `TURN_RESULT`, continue until success or max turns (`utils/agent.js:1367-1414`).

## File Changes

- **Modify** `utils/agent.js` — remove TMDB-loop recovery branches/reasons/events; add post-parse orchestrator TMDB resolution + typeMismatch/notFound categorization; narrow empty-response nudge trigger; enrich next-turn feedback; migrate `TURN_RESULT` and keep `LOOP_END` stable.
- **Modify** `utils/agent-tools.js` — remove `batch_search_tmdb` from `toolDeclarations`; export `handleBatchSearchTmdb`; keep favorites declaration/handler/dispatcher behavior.
- **Modify** `utils/agent-validate.js` — update schema to three fields; keep extra-field violations; ensure corrective feedback renders three-field schema.
- **Modify** `utils/prompts.js` — remove TMDB tool instructions from system/turn prompts; align all schema wording to `{type,title,year}` and orchestrator-owned resolution model.
- **Modify** `addon.js` — validate and minimally adjust dependency wiring so `runAgentLoop` can call exported `handleBatchSearchTmdb` with existing `searchTMDB` runtime dependency (`addon.js:3628-3630`, `addon.js:3765-3773`).
- **Modify** `AGENTS.md` — replace agent-loop docs: favorites-only tool surface, orchestrator-owned TMDB resolution, telemetry updates.
- **Modify** `codemap.md` — update architecture/tooling/schema notes for orchestrator-owned TMDB flow.
- **Modify** `utils/codemap.md` — update module responsibilities (`agent.js` owns TMDB resolution; `agent-tools.js` exposes favorites tool + reusable TMDB handler).

## Interfaces / Contracts

- **Agent output contract**: per-item fields become exactly `type`, `title`, `year`.
- **Orchestrator enrichment contract**: accepted items gain orchestrator-resolved `tmdb_id` only.
- **Rejection taxonomy**: include `watched`, `rated`, `history`, `duplicate`, `typeMismatch`, `notFound` in between-turn feedback; `TURN_RESULT.rejectedBreakdown` includes at least `typeMismatch` and `notFound` plus existing dedupe/watch/rate buckets.
- **Tool surface contract**: model-visible tools limited to `get_user_favorites` only.

## Testing Strategy

No automated suite exists; verification is scenario + log driven.

1. **Tool surface**: inspect startup/turn logs and ensure `batch_search_tmdb` is absent from chat tools while favorites remains (`utils/agent.js:858-859` behavior after update).
2. **Schema enforcement**: inject/observe agent response with legacy `tmdb_id`; confirm `extra_field` violation and corrective feedback mentions only three fields.
3. **Orchestrator TMDB ownership**: for accepted item, trace `tmdb_id` to same-turn orchestrator resolution logs.
4. **Type mismatch**: use known cross-type title/year; verify rejection in `typeMismatch` and not collected.
5. **Not found**: use nonexistent title/year; verify `notFound` rejection.
6. **Favorites round-trip**: force `get_user_favorites` call; verify functionResponse injection still occurs before final text.
7. **Nudge narrowing**: verify `emptyResponseNudgeUsed` can be true only after at least one favorites tool round and subsequent empty non-tool response.
8. **Telemetry migration**: confirm no `TOOL_LOOP_DETECTED`, no `NUDGE_DISPATCHED` with `repeated_batch|cap_reached`, `LOOP_END` still reports `totalTurns/terminationReason/collectedCount`.

## Migration / Rollout

1. Update contracts first (`agent-validate.js`, `prompts.js`, tool declarations).
2. Implement orchestrator TMDB resolution path and telemetry mapping in `agent.js`.
3. Wire any missing dependency export/import in `agent-tools.js` + `addon.js`.
4. Update docs (`AGENTS.md`, codemaps).
5. Run syntax checks for all changed JS files.

## Risks and Mitigations

- **Higher rejection rates -> more turns**: mitigate with explicit rejected-reason feedback + gap visibility.
- **Per-turn latency increase (new orchestrator TMDB pass)**: mitigate with one batched call per turn and existing per-query isolation (`Promise.allSettled`).
- **History vs watched ambiguity** (current `applyTurnFilter` maps history into watched counter at `utils/agent.js:489-492`): split history bucket explicitly in new rejection accounting.
- **Telemetry consumer breakage**: keep deprecated fields inert (`toolLoopDetected=false`, `nudgeReason=null`) for one release before full removal.
- **Dependency wiring duplication** between `addon.js` and new direct TMDB call path: centralize on existing `searchTMDB` runtime dep passed at loop creation (`utils/agent.js:862-879`, `addon.js:3628-3630`).

## Open Questions

1. **`emptyResponseNudgeUsed` decision**: confirmed **KEEP** with narrowed trigger: only when at least one successful `get_user_favorites` tool round occurred in the current turn and the next Gemini response is non-text + non-tool.
2. **TMDB multi-candidate tie-breaker**: design chooses first exact title+year match in returned order. No blocking ambiguity remains.
