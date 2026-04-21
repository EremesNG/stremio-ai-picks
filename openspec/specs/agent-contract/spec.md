# Agent Contract

## Requirements

### Requirement: Keep schema wording identical across turn prompts
The item schema wording used in `buildAgentSystemPrompt` and `buildTurnMessage` MUST be identical in field set and field names. Both prompts MUST refer to the same four fields, spelled exactly as `type`, `title`, `year`, and `tmdb_id`, and MUST NOT diverge by introducing alternate names such as `name`.

#### Scenario: Prompt helpers describe the same fields
- GIVEN `buildAgentSystemPrompt` and `buildTurnMessage` are rendered for the same turn
- WHEN the agent reads both prompts
- THEN both prompts describe the same four fields
- AND both prompts use `title` rather than `name`
- AND neither prompt introduces any extra field name

### Requirement: Emit current-turn candidate arrays only
The agent MUST return a single JSON array and nothing else for the current turn. The agent MUST NOT emit markdown, code fences, prose, or metacognitive narration inside or outside the array. Every array item MUST be an object with exactly four fields: `type` (string), `title` (string), `year` (number), and `tmdb_id` (number). The agent MUST NOT include any other fields, including `reason`, `imdb_id`, `name`, or `overview`.

#### Scenario: Current-turn array is returned directly
- GIVEN the orchestrator requests one generation turn
- WHEN the agent responds for that turn
- THEN the response is a single JSON array
- AND every element is an object with exactly `type`, `title`, `year`, and `tmdb_id`
- AND the response contains no markdown or explanatory prose

### Requirement: Respect deduplication inputs and the current gap
The agent MUST NOT re-propose any title from the alreadyProposed list or any item already in collected. The agent MUST return exactly the number of valid items requested by the current turn message: `numResults` on the primary turn, or `gap` on a refinement turn when the turn message defines the remaining gap. Returning fewer items is a contract violation.

#### Scenario: Gap-sized candidate set excludes prior titles
- GIVEN collected already contains accepted items
- AND alreadyProposed contains titles from earlier turns
- AND the current gap is 3
- WHEN the agent generates the next turn
- THEN it returns exactly 3 valid items
- AND none of the returned titles appear in collected
- AND none of the returned titles appear in alreadyProposed

### Requirement: Resolve every candidate through TMDB search
The agent MUST call batch_search_tmdb to resolve IDs for its candidates. The agent MAY invoke batch_search_tmdb and get_user_favorites multiple times within the same turn before it emits its response. The agent MUST eventually emit a JSON array of exactly gap new candidate objects for the current turn. The agent tool surface MUST be limited to batch_search_tmdb and get_user_favorites only.

#### Scenario: Candidate objects include TMDB IDs
- GIVEN the agent needs to produce candidates for a turn
- WHEN it resolves those candidates
- THEN it uses batch_search_tmdb one or more times within the same turn
- AND it returns exactly gap new candidate objects for the current turn
- AND each returned candidate includes a resolved tmdb_id
- AND no other tool is available to the agent

### Requirement: Use favorites as optional selection context
The agent MAY call get_user_favorites during candidate generation to improve later turns, but it MUST still return only the current-turn candidate array.

#### Scenario: Favorite signals can influence later candidates
- GIVEN get_user_favorites returns a preference list
- WHEN the agent generates the next candidate set
- THEN the returned payload is still a JSON array only
- AND the candidate selection may reflect the favorite signals
