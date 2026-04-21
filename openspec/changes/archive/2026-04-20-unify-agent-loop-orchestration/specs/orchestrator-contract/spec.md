# Orchestrator Contract

## Requirements

### Requirement: Parse each turn defensively
The orchestrator MUST parse the agent's turn response as a JSON array. The per-turn parser SHOULD tolerate code fences, leading/trailing prose, and other common LLM output variations. If the response is unparseable after extraction attempts, the turn MUST yield zero candidates and the loop MUST proceed to the next turn when budget remains.

#### Scenario: Malformed JSON on turn 1 is recoverable
- GIVEN turn 1 returns malformed JSON text
- WHEN the orchestrator attempts to parse the response
- THEN it extracts no valid array
- AND turn 1 contributes zero candidates
- AND the loop continues to the next turn if turns remain

#### Scenario: Fenced JSON is still parsed
- GIVEN the agent wraps a valid array in code fences and surrounding prose
- WHEN the orchestrator parses the turn response
- THEN it extracts the JSON array successfully
- AND the candidates continue through filtering

### Requirement: Filter candidates locally before collection
The orchestrator MUST filter parsed candidates against local Trakt watchedIdSet and ratedIdSet. The orchestrator MUST reject any parsed candidate that lacks a tmdb_id. Filtered survivors MUST be pushed into collected.

#### Scenario: Candidates without TMDB IDs are not collected
- GIVEN the agent returns a parseable array of candidates
- AND some candidates do not include tmdb_id
- WHEN the orchestrator filters the turn results
- THEN candidates without tmdb_id are rejected
- AND they are not pushed into collected
- AND their titles are still appended to proposedTitles

#### Scenario: Minor watched overlap is filtered locally
- GIVEN a user with Trakt history requests 20 items
- AND some parsed candidates match watchedIdSet or ratedIdSet
- WHEN the orchestrator filters the turn results
- THEN watched or rated candidates are removed locally
- AND the surviving candidates are pushed into collected

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
The orchestrator MUST terminate with status 'success' when collected.length >= numResults at any point. The orchestrator MUST terminate with terminationReason 'max_turns_exceeded' and status 'partial' when turn >= maxTurns and collected.length < numResults. The orchestrator MUST return collected as-is on termination and MUST NOT perform a final-turn forced fill.

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
