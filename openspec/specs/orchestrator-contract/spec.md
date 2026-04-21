# Orchestrator Contract

## Requirements

### Requirement: Parse each turn defensively
The orchestrator MUST treat a turn as complete only when the agent emits text content that the orchestrator attempts to parse. The per-turn parser SHOULD tolerate code fences, leading/trailing prose, and other common LLM output variations. If the emitted text cannot be parsed into a JSON array after extraction attempts, or if the parsed items do not satisfy the agent schema validation rules, the turn MUST be treated as a contract violation and MUST trigger the single corrective retry path within the same turn. Tool-call-only Gemini round-trips MUST NOT complete a turn and MUST NOT increment the turn counter.

#### Scenario: Malformed JSON on turn 1 triggers the retry path
- GIVEN turn 1 returns malformed JSON text
- WHEN the orchestrator attempts to parse the response
- THEN the turn is treated as a contract violation
- AND the orchestrator sends one corrective retry within the same turn
- AND the retry asks for a valid JSON array

#### Scenario: Fenced JSON is still parsed
- GIVEN the agent wraps a valid array in code fences and surrounding prose
- WHEN the orchestrator parses the turn response
- THEN it extracts the JSON array successfully
- AND the candidates continue through schema validation

### Requirement: Filter candidates locally before collection
The orchestrator MUST filter only schema-valid candidates against local Trakt watchedIdSet and ratedIdSet. The orchestrator MUST reject any candidate that lacks `tmdb_id` only as part of schema validation, not as a separate filter step. Valid survivors MUST be pushed into collected. These filter rules MUST apply to every parsed text response regardless of how many internal tool rounds preceded it, and the filterWatched=false bypass MUST remain a no-op for watched/rated checks.

#### Scenario: Candidates without TMDB IDs are not collected
- GIVEN the agent returns a parseable array of candidates
- AND some candidates do not include tmdb_id
- WHEN the orchestrator validates and filters the turn results
- THEN candidates without tmdb_id are rejected during validation
- AND they are not pushed into collected
- AND their titles are still appended to proposedTitles

#### Scenario: Minor watched overlap is filtered locally
- GIVEN a user with Trakt history requests 20 items
- AND some parsed candidates match watchedIdSet or ratedIdSet
- WHEN the orchestrator filters the turn results
- THEN watched or rated candidates are removed locally
- AND the surviving candidates are pushed into collected

### Requirement: Validate parsed items against the agent schema before filtering
After `parseTurnResponse` returns parsed items, the orchestrator MUST validate each item against the agent item schema. Each item MUST contain exactly `type` (string), `title` (string), `year` (number), and `tmdb_id` (number). Items missing any required field, carrying a field of the wrong type, or carrying any extra field MUST be rejected as invalid. The orchestrator MUST track valid and invalid items separately.

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
On the first contract violation of a turn, the orchestrator MUST re-prompt the agent exactly once within the same turn using corrective feedback that cites the specific violations observed so far. The corrective feedback MUST mention the relevant shortfall, missing fields, extra fields, or parse error classification, as applicable. This retry MUST consume one inner tool round from the existing safety cap. After the second response, the orchestrator MUST accept whatever valid items the second response contains, including zero, and MUST advance to the next orchestrator turn without a second retry.

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
Valid items whose titles already exist in `collected` or `proposedTitles` MUST be filtered silently by the normal turn-filtering step (`applyTurnFilter`) and MUST NOT trigger a contract retry. Duplicate filtering remains the orchestrator's responsibility and MUST NOT be counted as a schema violation.

#### Scenario: Duplicate titles are filtered silently
- GIVEN the agent returns 20 schema-valid items
- AND 3 of those titles already exist in `collected`
- WHEN the orchestrator applies its turn filter
- THEN the duplicate titles are removed without retrying the agent
- AND the turn closes with 17 accepted items

### Requirement: Record contract retry metadata in turn results
`TURN_RESULT` MUST include `contractRetryUsed` as a boolean, `violationsBeforeRetry` as an array of violation descriptors, and `violationsAfterRetry` as an array of violation descriptors. The existing `parsedCount` and `acceptedCount` semantics MUST remain unchanged but MUST reflect the post-validation-and-retry state.

#### Scenario: Successful first attempt records no retry metadata
- GIVEN the agent returns 20 valid items on the first attempt
- WHEN the orchestrator emits `TURN_RESULT`
- THEN `contractRetryUsed` is false
- AND `violationsBeforeRetry` is an empty array
- AND `violationsAfterRetry` is an empty array
- AND `parsedCount` and `acceptedCount` reflect the final accepted items

### Requirement: Preserve the public runAgentLoop contract
The public return shape of `runAgentLoop` MUST remain `{ success, recommendations, reason }`. The retry mechanism is purely internal, and no new public termination reason MUST be introduced as part of this change.

#### Scenario: Return shape stays unchanged after retries
- GIVEN a turn requires one corrective retry
- WHEN `runAgentLoop` returns
- THEN the returned object still contains `success`, `recommendations`, and `reason`
- AND no new public field is added
- AND no new termination reason is required for the retry path

### Requirement: Count turns on agent text emissions, not tool-only rounds
The orchestrator MUST increment the turn counter only when the agent emits text content that the orchestrator attempts to parse. Internal Gemini round-trips consisting solely of tool calls MUST NOT increment the turn counter. A parse failure after emitted text content still counts as a completed orchestrator turn.

#### Scenario: One full cycle counts as one turn
- GIVEN turn 1 begins with gap=20
- WHEN the agent emits tool-call-only responses followed by a text response containing 20 candidates
- THEN the turn counter is 1 at the end of the cycle
- AND LOOP_END reports totalTurns=1

#### Scenario: Under-delivery advances to the next orchestrator turn
- GIVEN turn 1 begins with gap=20
- WHEN the agent returns a parseable JSON array containing 12 candidates
- THEN the turn counter increments to 1 after parsing
- AND if budget remains the orchestrator dispatches turn 2 with gap=8

### Requirement: Cap internal tool-loop rounds per turn
The orchestrator MUST cap internal tool-loop iterations per turn with a maxToolRoundsPerTurn safety budget. If the agent emits tool-call-only responses for more than maxToolRoundsPerTurn consecutive rounds without emitting text content, the orchestrator MUST abandon the current turn with zero accepted items and MUST treat that turn as complete for turn-budget accounting. If turns remain, the orchestrator MUST proceed to the next turn; if this was the final turn, the orchestrator MUST terminate with reason `tool_loop_exhausted`.

#### Scenario: Tool-loop safety cap stops a runaway turn
- GIVEN the orchestrator dispatches a turn
- WHEN the agent emits tool-call-only responses for more than maxToolRoundsPerTurn consecutive internal rounds without text content
- THEN the orchestrator abandons the current turn with zero accepted items
- AND the turn counter still increments by 1
- AND if this was the last turn the final reason is `tool_loop_exhausted`

### Requirement: Distinguish turn events from internal tool-round events
The orchestrator logging MUST distinguish turn events from internal tool-round events. Turn events MUST include turn-start, turn-result, loop-start, and loop-end, and their turn field MUST reflect orchestrator turns. Internal events MUST include Gemini round-trip, tool-call-request, and tool-call-response events, and MAY include toolRound or an equivalent debugging field.

#### Scenario: Logs separate turn and internal rounds
- GIVEN turn 1 includes two internal tool rounds before text content
- WHEN the orchestrator emits logs
- THEN turn-start, turn-result, loop-start, and loop-end events all report turn=1
- AND internal Gemini and tool-call events are logged separately
- AND internal events MAY include a toolRound field for debugging

### Requirement: Record every proposed title from each turn
The orchestrator MUST append every title from the agent's turn response to proposedTitles, regardless of filter outcome.

#### Scenario: Accepted and rejected titles are both recorded
- GIVEN a turn response contains both accepted and filtered-out candidates
- WHEN the orchestrator processes the turn
- THEN every title from that turn appears in proposedTitles
- AND the recorded titles are available for later deduplication

### Requirement: Deduplicate against collected and prior proposals
The orchestrator MUST NOT push a candidate into collected when its title already exists in collected. The orchestrator MUST also NOT push a candidate into collected when its title has already been recorded in proposedTitles from an earlier turn.

#### Scenario: Re-proposed title already in collected is skipped
- GIVEN collected already contains an accepted title
- WHEN the agent re-proposes that title on a later turn
- THEN the orchestrator does not push the duplicate into collected

#### Scenario: Re-proposed title already proposed after filtering is skipped
- GIVEN a watched candidate was recorded in proposedTitles on an earlier turn
- WHEN the agent re-proposes that same title later
- THEN the orchestrator does not push the duplicate into collected

### Requirement: Compute the remaining gap after filtering
The orchestrator MUST compute gap = numResults - collected.length after filtering.

#### Scenario: Gap reflects filtered collection size
- GIVEN a turn produces survivors and rejections
- WHEN filtering completes
- THEN gap equals the requested count minus collected.length after survivors are added

### Requirement: Terminate on success or turn-budget exhaustion
The orchestrator MUST terminate with status 'success' when collected.length >= numResults at any point. The orchestrator MUST treat maxTurns as the budget for orchestrator turns, not Gemini round-trips. The orchestrator MUST terminate with status 'partial' and reason 'max_turns_exceeded' when the turn budget is exhausted before enough candidates are collected. The orchestrator MUST return collected as-is on termination and MUST NOT perform a final-turn forced fill. The reason field MUST remain compatible with the existing contract, including api_error_partial and existing hard-failure reasons, and MUST additionally allow tool_loop_exhausted when the internal tool-loop safety cap fires on the final remaining orchestrator turn with zero accepted items.

#### Scenario: User with minor Trakt overlap succeeds in one or two turns
- GIVEN a user with Trakt requests 20 items
- AND the first turn leaves only a few items filtered out by watched overlap
- WHEN the collected set reaches 20 items on turn 1 or turn 2
- THEN the orchestrator terminates with status 'success'
- AND it returns the collected items without forcing a final fill

#### Scenario: Heavy history exhausts the turn budget
- GIVEN a user with heavy Trakt history requests 20 items
- AND filtering strips many candidates on each turn
- WHEN the turn budget is exhausted before 20 items are collected
- THEN the orchestrator terminates with status 'partial'
- AND terminationReason is 'max_turns_exceeded'
- AND it returns the collected items as-is

#### Scenario: Return shape is preserved
- GIVEN any termination condition
- WHEN runAgentLoop returns
- THEN it returns an object with success, recommendations, and reason
- AND the reason value remains compatible with the existing contract
- AND `tool_loop_exhausted` is allowed when the safety cap fires on the final turn

### Requirement: Degenerate no-Trakt case does not filter
When traktWatchedIdSet and traktRatedIdSet are empty or unset, filtering MUST be a no-op. The loop SHOULD terminate at the end of turn 0 when no filtering occurs and the agent returned at least numResults valid items. This replaces the previous separate linear pipeline.

#### Scenario: No-Trakt user succeeds on the first turn
- GIVEN a user without Trakt data requests 20 items
- AND the agent returns at least 20 valid candidates on turn 0
- WHEN the orchestrator processes the turn
- THEN no candidates are filtered out by Trakt
- AND the orchestrator terminates successfully after turn 0

### Requirement: Send refinement context between turns
When advancing to a new turn, the orchestrator MUST send a refinement message containing the current collected items as names only, the current proposedTitles, the computed gap, and the original query plus any discovered genres. The refinement message MUST NOT reference turns, turn budget, or numbered workflow steps.

#### Scenario: Refinement message contains only deduplication context
- GIVEN turn 0 did not complete the request
- WHEN the orchestrator prepares turn 1
- THEN the refinement message includes collected item names only
- AND the message includes current proposedTitles
- AND the message includes the computed gap
- AND the message includes the original query and discovered genres
- AND the message does not mention turn counts, turn budget, or numbered steps

### Requirement: Return favorites results without auto-collecting them
When the agent calls get_user_favorites, the orchestrator MUST feed that tool result into the next generation context. The orchestrator MUST NOT auto-populate collected from favorites alone.

#### Scenario: Favorite signals inform the next turn but do not count as results
- GIVEN the agent calls get_user_favorites during a turn
- WHEN the tool result is returned
- THEN the next generation can use the favorite data as context
- AND collected remains unchanged unless a candidate is explicitly accepted
- AND the favorites are not inserted into collected automatically

### Requirement: Restrict the agent tool surface
The orchestrator MUST NOT expose check_if_watched or search_tmdb as tools to the agent. The agent tool surface MUST be limited to batch_search_tmdb and get_user_favorites only.

#### Scenario: Restricted tool surface omits watched lookup tools
- GIVEN the orchestrator prepares a turn for the agent
- WHEN it declares the available tools
- THEN only batch_search_tmdb and get_user_favorites are exposed
- AND check_if_watched and search_tmdb are absent
