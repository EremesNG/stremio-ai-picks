# Delta for Agent Contract

## ADDED Requirements

### Requirement: Keep schema wording identical across turn prompts
This requirement adds to the canonical agent contract and amends the prompt guidance that supports it. The item schema wording used in `buildAgentSystemPrompt` and `buildTurnMessage` MUST be identical in field set and field names. Both prompts MUST refer to the same four fields, spelled exactly as `type`, `title`, `year`, and `tmdb_id`, and MUST NOT diverge by introducing alternate names such as `name`.

#### Scenario: Prompt helpers describe the same fields
- GIVEN `buildAgentSystemPrompt` and `buildTurnMessage` are rendered for the same turn
- WHEN the agent reads both prompts
- THEN both prompts describe the same four fields
- AND both prompts use `title` rather than `name`
- AND neither prompt introduces any extra field name

## MODIFIED Requirements

### Requirement: Emit current-turn candidate arrays only
This amends the canonical requirement of the same name. The agent MUST return a single JSON array and nothing else for the current turn. The agent MUST NOT emit markdown, code fences, prose, or metacognitive narration inside or outside the array. Every array item MUST be an object with exactly four fields: `type` (string), `title` (string), `year` (number), and `tmdb_id` (number). The agent MUST NOT include any other fields, including `reason`, `imdb_id`, `name`, or `overview`.

#### Scenario: Current-turn array is returned directly
- GIVEN the orchestrator requests one generation turn
- WHEN the agent responds for that turn
- THEN the response is a single JSON array
- AND every element is an object with exactly `type`, `title`, `year`, and `tmdb_id`
- AND the response contains no markdown or explanatory prose

### Requirement: Respect deduplication inputs and the current gap
This amends the canonical requirement of the same name. The agent MUST NOT re-propose any title from the alreadyProposed list or any item already in collected. The agent MUST return exactly the number of valid items requested by the current turn message: `numResults` on the primary turn, or `gap` on a refinement turn when the turn message defines the remaining gap. Returning fewer items is a contract violation.

#### Scenario: Gap-sized candidate set excludes prior titles
- GIVEN collected already contains accepted items
- AND alreadyProposed contains titles from earlier turns
- AND the current gap is 3
- WHEN the agent generates the next turn
- THEN it returns exactly 3 valid items
- AND none of the returned titles appear in collected
- AND none of the returned titles appear in alreadyProposed
