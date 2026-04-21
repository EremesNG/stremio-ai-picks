# Agent Contract

## Requirements

### Requirement: Emit current-turn candidate arrays only
The agent MUST return a JSON array of candidate objects for the current turn only. The agent MUST NOT narrate its process, emit markdown, or wrap JSON in prose.

#### Scenario: Current-turn array is returned directly
- GIVEN the orchestrator requests one generation turn
- WHEN the agent responds for that turn
- THEN the response is valid JSON array text
- AND every element is a candidate object for that turn
- AND the response contains no markdown or explanatory prose

### Requirement: Respect deduplication inputs and the current gap
The agent MUST NOT re-propose any title from the alreadyProposed list or any item already in collected. The agent MUST propose exactly gap new candidates per turn, where gap = numResults - collected.length.

#### Scenario: Gap-sized candidate set excludes prior titles
- GIVEN collected already contains accepted items
- AND alreadyProposed contains titles from earlier turns
- AND the current gap is 3
- WHEN the agent generates the next turn
- THEN it returns exactly 3 candidates
- AND none of the returned titles appear in collected
- AND none of the returned titles appear in alreadyProposed

### Requirement: Resolve every candidate through TMDB search
The agent MUST call batch_search_tmdb to resolve IDs for its candidates. The agent tool surface MUST be limited to batch_search_tmdb and get_user_favorites only.

#### Scenario: Candidate objects include TMDB IDs
- GIVEN the agent needs to produce candidates for a turn
- WHEN it resolves those candidates
- THEN it uses batch_search_tmdb
- AND each returned candidate includes a resolved tmdb_id
- AND no other tool is available to the agent

### Requirement: Use favorites as optional selection context
The agent MAY call get_user_favorites during candidate generation to improve later turns, but it MUST still return only the current-turn candidate array.

#### Scenario: Favorite signals can influence later candidates
- GIVEN get_user_favorites returns a preference list
- WHEN the agent generates the next candidate set
- THEN the returned payload is still a JSON array only
- AND the candidate selection may reflect the favorite signals
