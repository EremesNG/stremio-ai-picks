# Verification Report: Unify agent loop orchestration

## Verification Result

**Verdict**: COMPLIANT
**Change**: unify-agent-loop-orchestration

### Artifacts verified
- `openspec/changes/unify-agent-loop-orchestration/proposal.md`
- `openspec/changes/unify-agent-loop-orchestration/specs/agent-contract/spec.md`
- `openspec/changes/unify-agent-loop-orchestration/specs/orchestrator-contract/spec.md`
- `openspec/changes/unify-agent-loop-orchestration/design.md`
- `openspec/changes/unify-agent-loop-orchestration/tasks.md`

### Compliance summary
- 14 requirements verified
- 14 compliant
- 0 in-scope issues

### Automated checks
- `node -c` (5 files): passed
- `node -e "require('./utils/agent'); console.log('ok')"`: passed
- Grep audits: clean
  - no matches for removed split-pipeline helpers
  - no matches for legacy `search_tmdb` handler declaration/surface
  - no matches for numbered prompt steps in `utils/prompts.js`

### Known gaps (out of scope)
- Trakt identity-format mismatch: `openspec/changes/unify-agent-loop-orchestration/specs/orchestrator-contract/spec.md:21-23` requires filtering against local Trakt watched/rated sets by `tmdb_id`, and `utils/agent.js:340-346,425-431` does exactly that via `setHasIdentity(...)`.
- The runtime Trakt sets are compound identity keys, built in `addon.js:2945-2977` and populated with `buildMediaIdentityKeys(...)` values such as `tmdb:movie:59967`. That is a data-contract mismatch between the literal spec wording and the runtime set shape.
- This is documented as out-of-scope for this change and tracked for follow-up; it does not invalidate the orchestration refactor.

### Compliance report file
- `openspec/changes/unify-agent-loop-orchestration/verify-report.md`

### Next step
- Archive the change with `sdd-archive`.

## Build and Test Evidence
- Syntax checks passed for `utils/prompts.js`, `utils/agent.js`, `utils/agent-tools.js`, `utils/agent-parse.js`, and `addon.js` via `node -c`.
- `node -e "require('./utils/agent'); console.log('ok')"` passed, confirming the require chain resolves.
- Grep audits were clean for removed split-pipeline helpers, legacy `search_tmdb` handler exposure, and numbered prompt-step language.
- Existing smoke evidence was accepted as-is and not rerun: the Trakt-authenticated smoke completed successfully with turn-0 tool call / turn-1 JSON array / success, and the no-Trakt smoke completed successfully with the same unified loop path.

## Compliance Matrix

### Agent contract

| Requirement | Evidence | Status |
| --- | --- | --- |
| Emit current-turn candidate arrays only (`agent-contract/spec.md:5-14`) | `utils/prompts.js:28-41,127-170` instructs a pure JSON-array response with no prose; `utils/agent-parse.js:91-127` parses only the current turn; `utils/agent.js:834-837` applies that parser per turn. | Compliant |
| Respect deduplication inputs and the current gap (`agent-contract/spec.md:15-26`) | `utils/prompts.js:131-170` injects `collected`, `proposedTitles`, and `gap`; `utils/agent.js:348-460,838-857` deduplicates locally and recomputes `gap` after filtering. | Compliant |
| Resolve every candidate through TMDB search (`agent-contract/spec.md:27-35`) | `utils/agent-tools.js:4-50,288-334,360-363` exposes `batch_search_tmdb` only for search and returns resolved `tmdb_id` values; `utils/agent.js:105-125` enforces parsed recommendations include `tmdb_id`. | Compliant |
| Use favorites as optional selection context (`agent-contract/spec.md:37-45`) | `utils/agent-tools.js:337-357` implements `get_user_favorites`; `utils/agent.js:746-757,809-810` passes `favoritesContext` into `buildTurnMessage`; `utils/prompts.js:161-170` includes favorites context without changing the JSON-array-only contract. | Compliant |

### Orchestrator contract

| Requirement | Evidence | Status |
| --- | --- | --- |
| Parse each turn defensively (`orchestrator-contract/spec.md:5-20`) | `utils/agent-parse.js:13-127` strips fences, recovers the first balanced array, and returns recoverable errors; `utils/agent.js:834-837` parses every model turn with that helper. | Compliant |
| Filter candidates locally before collection (`orchestrator-contract/spec.md:21-38`) | `utils/agent.js:348-460,838-847` filters parsed candidates before `collected.push(...)`; `utils/agent.js:425-431` applies watched/rated filtering. | Compliant |
| Record every proposed title from each turn (`orchestrator-contract/spec.md:39-46`) | `utils/agent.js:377-399` adds proposal tokens to `proposedTitles` before accept/reject decisions, so accepted and rejected titles are both recorded. | Compliant |
| Deduplicate against collected and prior proposals (`orchestrator-contract/spec.md:48-60`) | `utils/agent.js:353-423` builds collected/proposed identity sets and skips duplicates already collected or already proposed. | Compliant |
| Compute the remaining gap after filtering (`orchestrator-contract/spec.md:61-68`) | `utils/agent.js:857-875` computes `gap = resolvedNumResults - collected.length` after filtering and logs it. | Compliant |
| Terminate on success or turn-budget exhaustion (`orchestrator-contract/spec.md:69-85`) | `utils/agent.js:959-969,1016-1025,1079-1085` terminates with `success`, `max_turns_exceeded`, or partial success on API failure; there is no final forced fill path. | Compliant |
| Degenerate no-Trakt case does not filter (`orchestrator-contract/spec.md:87-96`) | `utils/agent.js:357-364` disables watched/rated lookups when sets are empty; `addon.js:3703-3750` passes `filterWatched: false` and empty sets for the no-Trakt path. | Compliant |
| Send refinement context between turns (`orchestrator-contract/spec.md:97-107`) | `utils/prompts.js:127-170` builds the turn message from collected names, proposed titles, gap, query, and genres; `utils/agent.js:971-977,1028-1031` uses that message for subsequent turns. | Compliant |
| Return favorites results without auto-collecting them (`orchestrator-contract/spec.md:109-117`) | `utils/agent-tools.js:337-357` returns favorites as tool output only; `utils/agent.js:847-853` only appends parsed candidates to `collected`. | Compliant |
| Restrict the agent tool surface (`orchestrator-contract/spec.md:119-127`) | `utils/agent-tools.js:4-51,360-363` exposes only `batch_search_tmdb` and `get_user_favorites`; `utils/agent.js:782-787` passes that slimmed surface to Gemini. | Compliant |

## Design Coherence
- The implementation matches the design’s core decision to use one unified orchestration loop (`design.md:5-15,19-25,61-75`).
- Parsing is isolated in `utils/agent-parse.js`, prompt construction is centralized in `buildTurnMessage`, and caller migration is completed in `addon.js`.
- The shrunk tool surface and per-turn refinement contract are consistent across design, spec, and code.

## Issues Found
- No in-scope compliance failures found.
- One out-of-scope data-contract mismatch remains documented in the Known gaps section above.

## Verdict
- **COMPLIANT**: all 14 requirements were verified against the implementation, syntax checks passed, the require chain resolved, and the grep audit found no legacy split-pipeline symbols in active code.
