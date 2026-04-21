# Delta for Agent Contract

## MODIFIED Requirements

### Requirement: Resolve every candidate through TMDB search
The agent MUST call batch_search_tmdb to resolve IDs for its candidates. The agent MAY invoke batch_search_tmdb and get_user_favorites multiple times within the same turn before it emits its response. The agent MUST eventually emit a JSON array of exactly gap NEW candidate objects with resolved tmdb_id values for the current turn. The agent tool surface MUST remain limited to batch_search_tmdb and get_user_favorites only.

#### Scenario: Candidate objects include TMDB IDs after internal tool rounds
- GIVEN a turn begins
- WHEN the agent needs to resolve titles
- THEN it MAY invoke batch_search_tmdb one or more times within the same turn
- AND it MUST eventually emit a JSON array containing exactly gap NEW candidate objects for the current turn
- AND each returned candidate includes a resolved tmdb_id

#### Scenario: Tool surface is limited to the approved tools
- GIVEN a turn is in progress
- WHEN the agent decides which tools to invoke
- THEN it MUST only invoke batch_search_tmdb or get_user_favorites
- AND it MUST NOT invoke search_tmdb, check_if_watched, or any other tool

## ADDED Requirements

None

## REMOVED Requirements

None
