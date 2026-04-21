# Delta for Orchestrator Contract

## MODIFIED Requirements

### Requirement: Parse each turn defensively
The orchestrator MUST treat a turn as complete only when the agent emits text content that the orchestrator attempts to parse. The per-turn parser SHOULD tolerate code fences, leading/trailing prose, and other common LLM output variations. If the emitted text is unparseable after extraction attempts, the turn MUST yield zero candidates and the loop MUST proceed according to the remaining turn budget. Tool-call-only Gemini round-trips MUST NOT complete a turn and MUST NOT increment the turn counter.

#### Scenario: Malformed JSON text still ends the turn
- GIVEN turn 1 produces text content containing malformed JSON
- WHEN the orchestrator attempts to parse the response
- THEN the turn is counted as complete
- AND the turn yields zero candidates
- AND the loop continues only if turns remain

### Requirement: Filter candidates locally before collection
The orchestrator MUST filter parsed candidates against local Trakt watchedIdSet and ratedIdSet. The orchestrator MUST reject any parsed candidate that lacks a tmdb_id. Filtered survivors MUST be pushed into collected. These filter rules MUST apply to every parsed text response regardless of how many internal tool rounds preceded it, and the filterWatched=false bypass MUST remain a no-op for watched/rated checks.

#### Scenario: filterWatched=false bypass stays disabled
- GIVEN filterWatched=false
- AND the agent returns a parseable array of candidates
- WHEN the orchestrator filters the turn results
- THEN watched and rated checks MUST NOT run
- AND the candidates are evaluated only by the other existing collection rules

#### Scenario: Parseable text with only rejected candidates still counts the turn
- GIVEN turn 1 returns parseable text containing 20 candidates
- AND all 20 candidates are rejected by `applyTurnFilter` because each is missing `tmdb_id`
- WHEN the orchestrator filters the turn results
- THEN the turn counter MUST increment by 1 because the turn ended with text
- AND `collected.length` MUST remain unchanged
- AND if budget remains the orchestrator MUST dispatch another turn with the same gap

### Requirement: Terminate on success or turn-budget exhaustion
The orchestrator MUST terminate with status 'success' when collected.length >= numResults at any point. The orchestrator MUST treat maxTurns as the budget for orchestrator turns, not Gemini round-trips. The orchestrator MUST return collected as-is on termination and MUST NOT perform a final-turn forced fill. The reason field MUST remain compatible with the existing contract, including `max_turns_exceeded`, `api_error_partial`, and existing hard-failure reasons, and MUST additionally allow `tool_loop_exhausted` when the internal tool-loop safety cap fires on the final remaining orchestrator turn with zero accepted items.

#### Scenario: Return shape is preserved
- GIVEN any termination condition
- WHEN runAgentLoop returns
- THEN it returns an object with success, recommendations, and reason
- AND the reason value remains compatible with the existing contract
- AND `tool_loop_exhausted` is allowed when the safety cap fires on the final turn

## ADDED Requirements

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

## REMOVED Requirements

None
