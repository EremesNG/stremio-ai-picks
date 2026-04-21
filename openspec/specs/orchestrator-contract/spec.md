# Orchestrator Contract

## Requirements

### Requirement: Parse each turn defensively
The orchestrator MUST treat a turn as complete only when Gemini emits text that is parsed. Tool-call-only rounds MUST NOT complete a turn. Parse or schema failures MUST use the same single corrective retry path inside the same turn.

#### Scenario: Parse errors trigger corrective retry
- GIVEN Gemini emits malformed text
- WHEN parse is attempted
- THEN the turn is treated as a contract violation
- AND one corrective retry is sent in the same turn

### Requirement: Validate parsed items against the three-field schema before TMDB resolution
After parsing, each item MUST contain exactly `type` (string), `title` (string), and `year` (number). Any extra field (including `tmdb_id`) MUST be rejected before TMDB resolution.

#### Scenario: Legacy `tmdb_id` fails schema
- GIVEN parsed output includes `{ type, title, year, tmdb_id }`
- WHEN validation runs
- THEN the item is rejected as `extra_field`
- AND it is not eligible for TMDB resolution or collection

### Requirement: Resolve turn candidates through orchestrator-owned TMDB search
For schema-valid candidates, the orchestrator MUST invoke `handleBatchSearchTmdb` directly before `applyTurnFilter`. TMDB resolution is orchestrator-owned and is the only identity source for accepted items.

#### Scenario: Parsed candidates are resolved before filtering
- GIVEN a turn yields schema-valid `{ type, title, year }` candidates
- WHEN the orchestrator processes the turn
- THEN one orchestrator-owned TMDB batch resolution step runs
- AND only resolved candidates proceed to filtering/collection

### Requirement: Enforce type coherence against TMDB matches
The orchestrator MUST compare requested `type` with TMDB-resolved media type. Opposite-type resolutions MUST be rejected as `typeMismatch` and MUST NOT be collected.

#### Scenario: Type mismatch is rejected
- GIVEN the agent emits `{ "type": "movie", "title": "Dark", "year": 2017 }`
- AND TMDB resolves it as `series`
- WHEN orchestrator evaluates the candidate
- THEN the candidate is rejected as `typeMismatch`
- AND no recommendation is collected

### Requirement: Materialize tmdb_id exclusively from TMDB resolution output
Collected recommendations MUST use `tmdb_id` from orchestrator TMDB resolution only. The orchestrator MUST NOT trust, forward, or merge `tmdb_id` from agent text.

#### Scenario: Agent-provided ID is ignored
- GIVEN agent text includes a legacy `tmdb_id`
- WHEN validation and resolution run
- THEN the agent-supplied `tmdb_id` is rejected/ignored
- AND any accepted recommendation uses TMDB-derived `tmdb_id`

### Requirement: Filter candidates after orchestrator TMDB resolution
After TMDB resolution, the orchestrator MUST apply dedupe and Trakt filtering, with rejection accounting across `watched`, `rated`, `history`, `duplicate`, `typeMismatch`, and `notFound`.

#### Scenario: Filtering includes TMDB-resolution rejection categories
- GIVEN a turn yields schema-valid candidates
- WHEN resolution and filtering complete
- THEN rejections include `history`, `typeMismatch`, and `notFound` when applicable
- AND only eligible resolved candidates are collected

### Requirement: Emit structured between-turn feedback with rejection reasons
When another turn is needed, the orchestrator MUST send refinement context containing: accepted items as `title (year)`, grouped rejected counts by `watched|rated|history|duplicate|typeMismatch|notFound`, and the remaining gap.

#### Scenario: Feedback includes categorized summary
- GIVEN a turn accepts some items and rejects others
- WHEN the next turn message is built
- THEN accepted items are listed as `title (year)`
- AND rejected counts are grouped by the required reason set
- AND remaining gap equals `numResults - collected.length`

### Requirement: Restrict agent tool surface to favorites-only
The orchestrator MUST expose only `get_user_favorites` to Gemini. `batch_search_tmdb`, `search_tmdb`, and watched-status tools MUST NOT be agent-visible.

#### Scenario: Tool declarations omit TMDB search
- GIVEN orchestrator starts a chat
- WHEN tool declarations are attached
- THEN `get_user_favorites` is present
- AND `batch_search_tmdb` is absent

### Requirement: Preserve favorites functionResponse behavior
If Gemini calls `get_user_favorites`, the orchestrator MUST execute the tool and feed the functionResponse back into the same chat turn; favorites MUST NOT be auto-collected as recommendations.

#### Scenario: Favorites inform next generation only
- GIVEN Gemini calls `get_user_favorites`
- WHEN tool output is returned
- THEN the next generation can use favorites context
- AND `collected` remains unchanged until explicit candidate acceptance

### Requirement: Narrow empty-response nudge scope to favorites path
`emptyResponseNudgeUsed` MAY be true only after at least one favorites tool round in the same turn followed by an empty non-tool response. TMDB-loop reasons `repeated_batch` and `cap_reached` MUST NOT be emitted.

#### Scenario: Text-only turn does not use nudge
- GIVEN Gemini emits parseable text without tool calls
- WHEN the turn is processed
- THEN `emptyResponseNudgeUsed` remains false

### Requirement: Preserve single corrective retry for schema violations
The orchestrator MUST send at most one corrective retry per turn. After retry, it MUST continue with whatever valid items remain (including zero) and advance.

#### Scenario: One retry maximum
- GIVEN the first response violates schema
- WHEN the corrective retry has already been used
- THEN no second corrective retry is sent
- AND the turn proceeds with remaining valid items

### Requirement: Update telemetry fields for TMDB-orchestrated flow
`TURN_RESULT` MUST include `rejectedBreakdown.typeMismatch` and `rejectedBreakdown.notFound`, keep `contractRetryUsed/violationsBeforeRetry/violationsAfterRetry`, and keep legacy `missingTmdb/missingTitle` as backward-compatible inert fields when present. Removed TMDB-loop telemetry (`TOOL_LOOP_DETECTED`, nudge reasons `repeated_batch|cap_reached`) MUST be absent.

#### Scenario: Removed TMDB-loop telemetry is absent
- GIVEN a full request runs
- WHEN telemetry is inspected
- THEN `TOOL_LOOP_DETECTED` is absent
- AND `NUDGE_DISPATCHED` reasons `repeated_batch` and `cap_reached` are absent

### Requirement: Emit orchestrator TMDB resolution telemetry per query
For each TMDB batch query, the orchestrator MUST emit `ORCHESTRATOR_TMDB_RESOLVE_RESULT` with fields: `title`, `year`, `requestedType`, `matchedTmdbId`, `matchedType`, `resolution`, and `durationMs`.

#### Scenario: Collected IDs are traceable to resolution events
- GIVEN a request returns collected recommendations
- WHEN `TURN_RESULT` and `ORCHESTRATOR_TMDB_RESOLVE_RESULT` are correlated
- THEN each collected `tmdb_id` is traceable to a same-request resolution event

### Requirement: Preserve turn accounting, public return shape, and loop-end contract
Orchestrator turns count text-parse completions, not tool-only rounds. Public return shape MUST remain `{ success, recommendations, reason }`. `LOOP_END` MUST keep payload: `totalTurns`, `terminationReason`, `collectedCount`, `droppedWatched`, `droppedNoId`, `droppedMissingTitle`, `droppedCollected`, `droppedProposed`, `droppedRated`, `elapsed`.

#### Scenario: Return and LOOP_END contracts remain stable
- GIVEN any termination condition
- WHEN `runAgentLoop` returns and `LOOP_END` is logged
- THEN return shape remains `{ success, recommendations, reason }`
- AND `LOOP_END` contains the required payload fields only
