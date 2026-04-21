# Agent Contract

## Requirements

### Requirement: Forbid agent-emitted TMDB identifiers
The agent MUST emit recommendation items without `tmdb_id`. Any emitted `tmdb_id` field MUST be treated as an `extra_field` schema violation.

#### Scenario: Agent emits legacy `tmdb_id`
- GIVEN the agent returns `[ { "type": "movie", "title": "Oxygen", "year": 2021, "tmdb_id": 18561 } ]`
- WHEN `validateAgentItems` evaluates the payload
- THEN the item is rejected with an `extra_field` violation for `tmdb_id`
- AND the item is not schema-valid for collection

### Requirement: Keep schema wording identical across turn prompts
The item schema wording used in `buildAgentSystemPrompt` and `buildTurnMessage` MUST be identical in field set and field names. Both prompts MUST refer to exactly three fields: `type`, `title`, and `year`. Neither prompt MAY mention `tmdb_id`.

#### Scenario: Prompt helpers describe the same three fields
- GIVEN `buildAgentSystemPrompt` and `buildTurnMessage` are rendered for the same turn
- WHEN the agent reads both prompts
- THEN both prompts describe exactly `type`, `title`, and `year`
- AND neither prompt includes `tmdb_id`

### Requirement: Emit current-turn candidate arrays only
The agent MUST return a single JSON array and nothing else for the current turn. Every array item MUST be an object with exactly three fields: `type` (string), `title` (string), and `year` (number). The agent MUST NOT include any additional fields.

#### Scenario: Response includes non-contract field
- GIVEN a generation turn is active
- WHEN the agent emits an item containing `reason`, `overview`, `imdb_id`, or `tmdb_id`
- THEN the payload violates the contract
- AND corrective feedback requests the three-field schema only

### Requirement: Corrective feedback references only the three-field schema
When a turn violates schema rules, `buildCorrectiveFeedback` MUST render required fields from `AGENT_ITEM_SCHEMA` and therefore MUST reference only `type`, `title`, and `year`.

#### Scenario: Schema violations trigger corrected schema reminder
- GIVEN the first response in a turn violates schema
- WHEN orchestrator sends corrective feedback
- THEN feedback includes required output schema lines for `type`, `title`, and `year`
- AND feedback does not instruct the agent to emit `tmdb_id`

### Requirement: Respect deduplication inputs and the current gap
The agent MUST NOT re-propose any title from `alreadyProposed` or `collected`. The agent MUST return exactly the number of valid items requested for the current turn (`numResults` on the primary turn, or `gap` on refinement turns).

#### Scenario: Gap-sized candidate set excludes prior titles
- GIVEN `collected` already contains accepted items
- AND `alreadyProposed` contains titles from earlier turns
- AND the current gap is 3
- WHEN the agent generates the next turn
- THEN it returns exactly 3 valid items
- AND none of the returned titles appear in `collected`
- AND none of the returned titles appear in `alreadyProposed`

### Requirement: Preserve favorites tool behavior and functionResponse round-trips
`get_user_favorites` MUST remain agent-visible and MAY be called during a turn. FunctionResponse round-trips MUST remain unchanged (model tool call -> orchestrator tool execution -> functionResponse injected back into chat context).

#### Scenario: Favorites call continues to work in-turn
- GIVEN the agent calls `get_user_favorites`
- WHEN the orchestrator executes the tool and returns `functionResponse`
- THEN the agent can continue the same chat turn and emit a final JSON candidate array
- AND the final array still follows the three-field output contract

### Requirement: Agent tool surface excludes TMDB search
The model-visible tool surface MUST NOT include `batch_search_tmdb`. Only `get_user_favorites` remains exposed to the agent.

#### Scenario: Turn tool declarations omit TMDB search tool
- GIVEN the orchestrator creates chat tools for the agent
- WHEN tool declarations are attached
- THEN `batch_search_tmdb` is absent from the agent-visible tool surface
- AND `get_user_favorites` is present
