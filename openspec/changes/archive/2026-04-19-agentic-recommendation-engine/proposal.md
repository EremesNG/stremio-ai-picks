# Proposal: Agentic recommendation engine

## Intent
Replace the recommendation handler’s one-shot linear pipeline with an agentic Gemini function-calling loop so the model can iteratively gather context, validate candidates, and retry when needed. This should improve relevance, reduce fragile watched-item filtering, and keep recommendation responses non-empty whenever possible.

## Scope
### In Scope
1. Rework the recommendation catalog handler in `addon.js` only (call site 2).
2. Add a new helper module for the Gemini agent loop and tool execution.
3. Introduce tools for `search_tmdb`, `get_watched_history`, `get_user_favorites`, and `check_if_watched`.
4. Integrate Trakt favorites as an additional preference signal.
5. Cache Trakt history/favorites using the existing LRU cache infrastructure.
6. Preserve the current response JSON schema (`[{ type, name, year }]`).
7. Fall back to the existing linear recommendation flow whenever the agent loop fails or Trakt is unavailable.

### Out of Scope
- Similar content handler migration (call site 3).
- Genre discovery migration (call site 1).
- UI/configuration changes in `public/configure.html`.
- New user-facing configuration flags.
- Broader schema, database, or deployment changes.

## Approach
Add a bounded Gemini tool-use loop with a strict `MAX_TURNS` limit and deterministic tool responses. The agent will fetch watched history once per session, use Trakt favorites to guide selection, check candidate watch status via cached IMDB IDs, and only return after producing JSON that matches the existing catalog contract.

## Affected Areas
- `addon.js`
- `utils/agent.js` or a new `agent/` helper module
- Trakt API integration helpers
- Existing LRU cache usage

## Risks
- Multiple Gemini turns increase latency and cost versus the current linear flow.
- Tool-loop bugs could cause runaway iterations or malformed output.
- Trakt favorites and watch-history caching could return stale preference data if invalidation is incomplete.
- Function-calling support varies by Gemini model, so fallback behavior must remain reliable.

## Rollback Plan
If the agent loop degrades reliability or performance, disable the agent path in the recommendation handler and restore the current linear Gemini → TMDB → watched-filter flow without changing the response contract.

## Success Criteria
- The recommendation handler can iterate with Gemini tools up to a bounded turn limit.
- Watched filtering no longer depends on fragile title+year matching alone.
- Trakt favorites are used as a recommendation signal when available.
- Requests still return valid JSON in the current response schema.
- When the agent path fails, the existing linear pipeline still returns recommendations.
