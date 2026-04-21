# Delta for Orchestrator Contract

## MODIFIED Requirements

### Requirement: Parse each turn defensively
This amends the canonical requirement of the same name. The orchestrator MUST treat a turn as complete only when the agent emits text content that the orchestrator attempts to parse. The per-turn parser SHOULD tolerate code fences, leading/trailing prose, and other common LLM output variations. If the emitted text cannot be parsed into a JSON array after extraction attempts, or if the parsed items do not satisfy the agent schema validation rules, the turn MUST be treated as a contract violation and MUST trigger the single corrective retry path within the same turn. Tool-call-only Gemini round-trips MUST NOT complete a turn and MUST NOT increment the turn counter.

#### Scenario: Malformed JSON on turn 1 triggers the retry path
- GIVEN turn 1 returns malformed JSON text
- WHEN the orchestrator attempts to parse the response
- THEN the turn is treated as a contract violation
- AND the orchestrator sends one corrective retry within the same turn
- AND the retry asks for a valid JSON array

#### Scenario: Fenced JSON is still parsed before validation
- GIVEN the agent wraps a valid array in code fences and surrounding prose
- WHEN the orchestrator parses the turn response
- THEN it extracts the JSON array successfully
- AND the candidates continue through schema validation

### Requirement: Filter candidates locally before collection
This amends the canonical requirement of the same name. The orchestrator MUST filter only schema-valid candidates against local Trakt watchedIdSet and ratedIdSet. The orchestrator MUST reject any candidate that lacks `tmdb_id` only as part of schema validation, not as a separate filter step. Valid survivors MUST be pushed into collected. These filter rules MUST apply to every parsed text response regardless of how many internal tool rounds preceded it, and the filterWatched=false bypass MUST remain a no-op for watched/rated checks.

#### Scenario: Candidates without TMDB IDs are not collected
- GIVEN the agent returns a parseable array of candidates
- AND some candidates do not include `tmdb_id`
- WHEN the orchestrator validates and filters the turn results
- THEN candidates without `tmdb_id` are rejected during validation
- AND they are not pushed into collected
- AND their titles are still appended to proposedTitles

#### Scenario: Minor watched overlap is filtered locally
- GIVEN a user with Trakt history requests 20 items
- AND some parsed candidates match watchedIdSet or ratedIdSet
- WHEN the orchestrator filters the turn results
- THEN watched or rated candidates are removed locally
- AND the surviving candidates are pushed into collected

## ADDED Requirements

### Requirement: Validate parsed items against the agent schema before filtering
This requirement adds to the canonical orchestrator contract and depends on the canonical agent schema. After `parseTurnResponse` returns parsed items, the orchestrator MUST validate each item against the agent item schema. Each item MUST contain exactly `type` (string), `title` (string), `year` (number), and `tmdb_id` (number). Items missing any required field, carrying a field of the wrong type, or carrying any extra field MUST be rejected as invalid. The orchestrator MUST track valid and invalid items separately.

#### Scenario: Extra fields and missing fields are rejected
- GIVEN `parseTurnResponse` returns three parsed items
- AND one item includes `reason`
- AND one item omits `tmdb_id`
- AND one item matches the schema exactly
- WHEN the orchestrator validates the parsed items
- THEN the first two items are rejected as invalid
- AND the valid item is tracked separately
- AND invalid items are not treated as schema-compliant candidates

### Requirement: Retry once per turn on contract violation
This requirement adds to and amends the canonical requirements `Parse each turn defensively`, `Terminate on success or turn-budget exhaustion`, and the turn-result logging contract. On the first contract violation of a turn, the orchestrator MUST re-prompt the agent exactly once within the same turn using corrective feedback that cites the specific violations observed so far. The corrective feedback MUST mention the relevant shortfall, missing fields, extra fields, or parse error classification, as applicable. This retry MUST consume one inner tool round from the existing safety cap. After the second response, the orchestrator MUST accept whatever valid items the second response contains, including zero, and MUST advance to the next orchestrator turn without a second retry.

#### Scenario: Count shortfall triggers one corrective retry
- GIVEN the turn gap is 20
- AND the agent returns only 1 valid item
- WHEN the orchestrator validates the turn response
- THEN the orchestrator detects a count shortfall of 19
- AND it sends one corrective retry in the same turn
- AND the corrective feedback cites the shortfall

#### Scenario: Extra fields trigger one corrective retry
- GIVEN the agent returns an item shaped like `{ type, title, year, tmdb_id, reason }`
- WHEN the orchestrator validates the turn response
- THEN the item is rejected because `reason` is an extra field
- AND the orchestrator sends one corrective retry in the same turn
- AND the corrective feedback cites the extra-field violation

#### Scenario: A second under-delivering response is accepted without another retry
- GIVEN the first response in a turn under-delivers
- AND the orchestrator has already used its one corrective retry
- WHEN the agent's second response still returns only 5 valid items while 20 were requested
- THEN the orchestrator accepts the 5 valid items
- AND it advances to the next orchestrator turn
- AND it does not issue a third response request for that same turn

#### Scenario: Parse errors use the same retry path
- GIVEN the agent emits text that `parseTurnResponse` classifies as `no_json_array`
- WHEN the orchestrator processes the turn
- THEN the turn is treated as a contract violation
- AND the corrective feedback tells the agent to emit a valid JSON array
- AND the orchestrator uses the same single-retry budget as for schema violations

### Requirement: Treat duplicate filtering as non-contract behavior
This requirement adds to the canonical `Filter candidates locally before collection` and `Deduplicate against collected and prior proposals` requirements. Valid items whose titles already exist in `collected` or `proposedTitles` MUST be filtered silently by the normal turn-filtering step (`applyTurnFilter`) and MUST NOT trigger a contract retry. Duplicate filtering remains the orchestrator's responsibility and MUST NOT be counted as a schema violation.

#### Scenario: Duplicate titles are filtered silently
- GIVEN the agent returns 20 schema-valid items
- AND 3 of those titles already exist in `collected`
- WHEN the orchestrator applies its turn filter
- THEN the duplicate titles are removed without retrying the agent
- AND the turn closes with 17 accepted items

### Requirement: Record contract retry metadata in turn results
This requirement adds to the canonical turn-result logging contract. `TURN_RESULT` MUST include `contractRetryUsed` as a boolean, `violationsBeforeRetry` as an array of violation descriptors, and `violationsAfterRetry` as an array of violation descriptors. The existing `parsedCount` and `acceptedCount` semantics MUST remain unchanged but MUST reflect the post-validation-and-retry state.

#### Scenario: Successful first attempt records no retry metadata
- GIVEN the agent returns 20 valid items on the first attempt
- WHEN the orchestrator emits `TURN_RESULT`
- THEN `contractRetryUsed` is false
- AND `violationsBeforeRetry` is an empty array
- AND `violationsAfterRetry` is an empty array
- AND `parsedCount` and `acceptedCount` reflect the final accepted items

### Requirement: Preserve the public runAgentLoop contract
This requirement amends the canonical termination contract. The public return shape of `runAgentLoop` MUST remain `{ success, recommendations, reason }`. The retry mechanism is purely internal, and no new public termination reason MUST be introduced as part of this change.

#### Scenario: Return shape stays unchanged after retries
- GIVEN a turn requires one corrective retry
- WHEN `runAgentLoop` returns
- THEN the returned object still contains `success`, `recommendations`, and `reason`
- AND no new public field is added
- AND no new termination reason is required for the retry path
