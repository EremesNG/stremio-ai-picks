# Delta for Orchestrator Contract

## ADDED Requirements

### Requirement: Resolve turn candidates through orchestrator-owned TMDB search
After parsing and schema validation of each text turn, the orchestrator MUST invoke `handleBatchSearchTmdb` directly for candidate resolution, using runtime TMDB dependencies already present in `runAgentLoop` (`utils/agent.js:862-879`) and the existing pure handler (`utils/agent-tools.js:268-315`). The orchestrator MUST perform this resolution before `applyTurnFilter` (`utils/agent.js:1346-1354`).

#### Scenario: Parsed candidate set is resolved by orchestrator
- GIVEN a turn produces schema-valid items `{ type, title, year }`
- WHEN orchestrator processes the turn
- THEN orchestrator issues one TMDB batch resolution step from parsed items
- AND resolved matches become the only source for item identity enrichment
- AND unresolved candidates are marked as rejected for this turn

#### Scenario: No parsed candidates skips TMDB resolution
- GIVEN a turn yields zero schema-valid items
- WHEN orchestrator finalizes the turn result
- THEN no TMDB resolution call is made
- AND turn feedback reports zero accepted items and unchanged gap

### Requirement: Enforce type coherence against TMDB matches
For every candidate that resolves to a TMDB match, the orchestrator MUST compare Gemini-reported `type` with TMDB-resolved media type. If they differ, the candidate MUST be rejected with rejection category `typeMismatch` and MUST NOT be collected.

#### Scenario: Type mismatch is rejected
- GIVEN agent emits `{ "type": "movie", "title": "Dark", "year": 2017 }`
- AND TMDB resolves the candidate as `series`
- WHEN orchestrator validates resolved identity
- THEN the candidate is rejected under `typeMismatch`
- AND no recommendation is collected from that candidate

#### Scenario: Type match is eligible for downstream filtering
- GIVEN agent emits `{ "type": "series", "title": "Dark", "year": 2017 }`
- AND TMDB resolves the candidate as `series`
- WHEN orchestrator processes the resolved candidate
- THEN the candidate proceeds to Trakt and dedupe filtering

### Requirement: Materialize tmdb_id exclusively from TMDB tool results
The orchestrator MUST derive `tmdb_id` from orchestrator-owned TMDB resolution output only. The orchestrator MUST NOT trust, forward, or merge `tmdb_id` from agent JSON text.

#### Scenario: Agent-provided ID conflicts with TMDB
- GIVEN agent text includes a legacy `tmdb_id` value (schema-invalid) and title/year
- WHEN validation and TMDB resolution run
- THEN the agent-supplied `tmdb_id` is ignored/rejected
- AND any accepted recommendation uses TMDB-derived `tmdb_id` only

### Requirement: Emit structured between-turn feedback with rejection reasons
When a new turn is required, the orchestrator MUST send a refinement message that includes: (a) accepted items as `title (year)` only, (b) rejected items grouped by reasons `watched`, `rated`, `history`, `duplicate`, `typeMismatch`, and `notFound`, and (c) the remaining gap.

#### Scenario: Feedback includes categorized rejection summary
- GIVEN a turn accepted some candidates and rejected others for multiple reasons
- WHEN orchestrator builds the next turn message
- THEN the message lists accepted `title (year)` entries
- AND rejected counts are grouped by the required reason categories
- AND remaining gap equals `numResults - collected.length`

## MODIFIED Requirements

### Requirement: Filter candidates after orchestrator TMDB resolution
This change MODIFIES baseline requirement "Filter candidates locally before collection" (`openspec/specs/orchestrator-contract/spec.md:21-38`).

- **Baseline clause replaced**: "The orchestrator MUST filter only schema-valid candidates against local Trakt watchedIdSet and ratedIdSet."
- **Replacement in this delta**: The orchestrator MUST first run orchestrator-owned TMDB resolution for schema-valid `{ type, title, year }` candidates, then apply local filtering and rejection accounting across `watched`, `rated`, `history`, `duplicate`, `typeMismatch`, and `notFound` categories before collection.

- **Baseline clause replaced**: "The orchestrator MUST reject any candidate that lacks `tmdb_id` only as part of schema validation, not as a separate filter step."
- **Replacement in this delta**: `tmdb_id` is no longer an agent-emitted field; it is materialized exclusively from orchestrator TMDB resolution output. Candidates with no resolvable TMDB match MUST be rejected as `notFound`.

#### Scenario: Filtering includes TMDB-resolution rejection categories
- GIVEN a turn yields schema-valid `{ type, title, year }` candidates
- WHEN orchestrator resolves and filters candidates
- THEN rejections are attributable to the required categories, including `history`, `typeMismatch`, and `notFound`
- AND only eligible resolved candidates are collected

### Requirement: Validate parsed items against the three-field schema before TMDB resolution
This change MODIFIES baseline requirement "Validate parsed items against the agent schema before filtering" (`openspec/specs/orchestrator-contract/spec.md:39-51`).

- **Baseline clause replaced**: "Each item MUST contain exactly `type` (string), `title` (string), `year` (number), and `tmdb_id` (number)."
- **Replacement in this delta**: Each parsed item MUST contain exactly `type` (string), `title` (string), and `year` (number); `tmdb_id` in agent output is invalid and MUST be treated as an extra field.

#### Scenario: Legacy `tmdb_id` fails schema before TMDB resolution
- GIVEN `parseTurnResponse` returns `{ type, title, year, tmdb_id }`
- WHEN schema validation runs
- THEN the item is rejected as schema-invalid (`extra_field`)
- AND it is not treated as a resolved candidate for collection

### Requirement: Replace baseline refinement payload with structured rejection feedback
This change MODIFIES baseline `openspec/specs/orchestrator-contract/spec.md:216-226` ("Send refinement context between turns").

- **Baseline fields RETAINED**: computed `gap` between requested and collected count.
- **Baseline fields REMOVED**: collected names-only continuation payload, `proposedTitles` list as a required payload field, and `original query + discovered genres` as required refinement payload fields.
- **Baseline fields ADDED**: accepted items rendered as `title (year)` plus rejected counts grouped by `watched`, `rated`, `history`, `duplicate`, `typeMismatch`, and `notFound`.

- **Replacement in this delta**: "Emit structured between-turn feedback with rejection reasons" (`openspec/changes/orchestrator-owned-tmdb-search/specs/orchestrator-contract/spec.md:46-55`) is the sole normative refinement message contract.

### Requirement: Restrict agent tool surface to favorites-only
This change MODIFIES baseline requirement "Restrict the agent tool surface" (`openspec/specs/orchestrator-contract/spec.md:238-245`). The orchestrator MUST expose only `get_user_favorites` to Gemini. `batch_search_tmdb`, `search_tmdb`, and watch-status tools MUST NOT be agent-visible.

#### Scenario: Turn tool declarations omit TMDB search tool
- GIVEN orchestrator starts a chat for an addon request (`utils/agent.js:854-860`)
- WHEN tool declarations are attached
- THEN `get_user_favorites` is available
- AND `batch_search_tmdb` is not available to Gemini

### Requirement: Narrow empty-response nudge scope to favorites path
This change MODIFIES baseline retry/nudge behavior in `executeAgentTurn` (`utils/agent.js:1042-1126`). `emptyResponseNudgeUsed` MAY be set only when a turn has already executed at least one `get_user_favorites` tool round and Gemini then emits an empty non-tool response. It MUST NOT be used for TMDB-loop recovery reasons.

#### Scenario: Empty text after favorites round triggers narrow nudge
- GIVEN Gemini called `get_user_favorites` and received functionResponse
- AND the next model message has no text and no function call
- WHEN orchestrator evaluates turn completion
- THEN a single empty-response nudge may be dispatched
- AND nudge reason is not classified as TMDB loop recovery

#### Scenario: Text-only turn never uses empty-response nudge
- GIVEN Gemini emits parseable text without tool calls
- WHEN orchestrator processes the turn
- THEN `emptyResponseNudgeUsed` remains false

### Requirement: Update telemetry fields for TMDB-orchestrated flow
This change MODIFIES baseline turn/loop telemetry. `TURN_RESULT.rejectedBreakdown` MUST add `typeMismatch`. Tool-loop-specific fields/events tied to agent-owned TMDB looping MUST be removed or remain permanently null/unreachable.

#### Scenario: Turn telemetry includes new rejection category
- GIVEN at least one candidate is rejected for TMDB type disagreement
- WHEN `TURN_RESULT` is emitted (`utils/agent.js:1367-1397` baseline location)
- THEN `rejectedBreakdown.typeMismatch` is present and greater than zero

#### Scenario: Removed TMDB-loop telemetry is not emitted
- GIVEN a full request executes under this change
- WHEN telemetry is inspected
- THEN event `TOOL_LOOP_DETECTED` is absent
- AND `NUDGE_DISPATCHED` reasons `repeated_batch` and `cap_reached` are absent

### Requirement: Emit orchestrator TMDB resolution telemetry per batch
The orchestrator MUST emit `ORCHESTRATOR_TMDB_RESOLVE_RESULT` for each orchestrator-owned TMDB resolution batch. This event replaces TMDB-resolution observability previously inferred from `TOOL_EXEC_RESULT` when TMDB search was model-invoked (`utils/agent-tools.js:268-315`, `363-381`).

The event payload MUST include per-query outcomes with:
- `title`
- `year`
- `requestedType`
- `matchedTmdbId`
- `matchedType`
- `resolution` (`matched` | `notFound` | `typeMismatch`)
- `durationMs`

#### Scenario: Every collected tmdb_id is traceable to same-request resolution event
- GIVEN a request returns collected recommendations
- WHEN `TURN_RESULT` and `ORCHESTRATOR_TMDB_RESOLVE_RESULT` events are correlated for that same request
- THEN every collected `tmdb_id` can be traced to a query entry with `resolution=matched` and the same `matchedTmdbId`
- AND unresolved or type-mismatched candidates are traceable via `resolution=notFound|typeMismatch`

### Requirement: Preserve existing post-resolution filtering ownership
`applyTurnFilter` Trakt identity filtering and cross-turn deduplication ownership remain unchanged in responsibility (baseline behavior at `utils/agent.js:1346-1354` and `utils/agent.js:409-523`), but now apply only to orchestrator-resolved candidates.

#### Scenario: Resolved candidate still rejected by history filter
- GIVEN a candidate resolves successfully with matching type
- AND candidate identity exists in Trakt history
- WHEN `applyTurnFilter` runs
- THEN the candidate is rejected under history/watched filtering rules
- AND not collected

### Requirement: Preserve single corrective retry for schema violations
The single corrective retry per turn remains unchanged (baseline behavior in `utils/agent.js:988-1039`), including one retry maximum and continuation with whatever valid items remain.

#### Scenario: Invalid first payload still gets one corrective retry
- GIVEN first text payload has schema violations
- WHEN orchestrator handles the turn
- THEN exactly one corrective retry is sent
- AND second payload is accepted without a second retry attempt

## REMOVED Requirements

### Requirement: Remove TMDB tool-loop safety path and loop-detection recovery
This change REMOVES the TMDB-specific internal tool-loop safeguards from baseline requirement "Cap internal tool-loop rounds per turn" (`openspec/specs/orchestrator-contract/spec.md:131-140`) and supersedes repeated-batch recovery in current code (`utils/agent.js:1147-1171`, `1262-1280`).

#### Scenario: No TMDB loop-cap termination path
- GIVEN Gemini cannot invoke `batch_search_tmdb`
- WHEN a turn runs under the new tool surface
- THEN TMDB-loop cap exhaustion cannot occur
- AND TMDB-loop termination path is unreachable by construction

### Requirement: Remove TMDB-loop-specific nudge reasons
This change REMOVES TMDB-loop nudge reasons from runtime behavior, superseding baseline/tooling behavior currently defined in `buildNudgeMessage` (`utils/agent.js:962-979`) and dispatch path (`utils/agent.js:1042-1056`). Reasons `repeated_batch` and `cap_reached` MUST NOT be emitted.

#### Scenario: Nudge reasons are constrained after change
- GIVEN any request path under this change
- WHEN `NUDGE_DISPATCHED` is logged
- THEN reason `repeated_batch` is never emitted
- AND reason `cap_reached` is never emitted

### Requirement: Superseded telemetry fields and event mapping
This change supersedes baseline telemetry assumptions for turn-loop diagnostics. The following are required observable deltas:
- `TURN_RESULT.rejectedBreakdown.typeMismatch` ADDED.
- `TURN_RESULT.toolLoopDetected` REMOVED (or always false and deprecated).
- `TURN_RESULT.nudgeReason` REMOVED (or constrained to empty-response-only and never `repeated_batch`/`cap_reached`).
- `TURN_RESULT.emptyResponseNudgeUsed` MODIFIED scope (favorites empty-response path only).
- Event `TOOL_LOOP_DETECTED` REMOVED.
- Event `NUDGE_DISPATCHED` MODIFIED to disallow reasons `repeated_batch` and `cap_reached`.
- `LOOP_END` MUST continue to report `totalTurns`, `terminationReason`, and `collectedCount` (baseline `utils/agent.js:782-807`) with no TMDB-loop-specific reason dependency.

#### Scenario: Telemetry contract validation across one full run
- GIVEN a request that executes at least two turns
- WHEN turn and loop telemetry are collected
- THEN all required added/removed/modified fields and events match this mapping
- AND no superseded TMDB-loop telemetry surface is observable
