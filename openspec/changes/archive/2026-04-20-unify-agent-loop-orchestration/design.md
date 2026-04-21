# Design: Unify agent loop orchestration

## Technical Approach

The recommendation flow will use **one orchestration path** for all requests: `runAgentLoop` becomes the single entry point for candidate generation, parsing, local filtering, and termination. The old split between a linear no-Trakt path and an agentic Trakt path is removed.

The unified loop works the same way whether Trakt data exists or not:

- When Trakt sets are present, the orchestrator filters parsed candidates locally before collection.
- When Trakt sets are empty, filtering becomes an identity operation, so a valid first JSON array can satisfy the request immediately.
- There is no separate “linear” shortcut; the no-Trakt case is just the same loop with a no-op filter.

The agent contract is also simplified into a single turn message builder. The old turn-specific prompt helpers are replaced by one `buildTurnMessage(ctx)` that receives the current collection state (`collected`, `proposedTitles`, and derived `gap`) on every turn, including turn 0. The prompt always asks for exactly the current gap of new candidates, not a rebuilt full list.

For robustness, raw Gemini text is parsed by a dedicated helper that tolerates fenced JSON and prose wrappers. If the parser cannot recover a JSON array, that turn contributes zero candidates and the loop continues when budget remains.

## Architecture Decisions

### Decision: Use one unified orchestration loop
**Choice**: Route every recommendation request through `runAgentLoop`; remove the separate linear recommendation path from `addon.js`.

**Alternatives considered**: Keep the linear path as a shortcut for no-Trakt users.

**Rationale**: The split pipeline is exactly what caused drift between prompt contract, parsing behavior, and collection logic. A single loop keeps candidate generation, filtering, deduplication, and termination in one place, which makes the behavior easier to reason about and debug.

### Decision: Count turns by Gemini round-trip
**Choice**: One orchestrator turn equals one Gemini model response cycle, including tool-call-only responses.

**Alternatives considered**: Count one turn as a full “tool call + JSON emission” cycle.

**Rationale**: The current system already budgets and logs by model response. Keeping turn count aligned with round-trips makes `maxTurns` and logs deterministic, and it handles the common case where turn 0 is a `batch_search_tmdb` call and turn 1 is the JSON array. If a response includes both function calls and text, the text is parsed immediately; if it includes only function calls, that response still consumes a turn and the next response is the first candidate-bearing turn.

### Decision: Move parsing into a dedicated helper file
**Choice**: Add `utils/agent-parse.js` and keep `parseTurnResponse(rawText)` there.

**Alternatives considered**: Keep parsing helpers inside `utils/agent.js`.

**Rationale**: The parse logic is pure and orthogonal to orchestration. A dedicated file keeps `runAgentLoop` focused on control flow, makes the extraction logic easier to inspect and reuse, and avoids growing an already-large orchestration file.

### Decision: Slim the agent tool surface
**Choice**: Expose only `batch_search_tmdb` and `get_user_favorites` to Gemini.

**Alternatives considered**: Retain `search_tmdb` and `check_if_watched` as direct tools.

**Rationale**: The orchestrator now owns watched/rated filtering locally, so the model no longer needs a direct watch-status tool. `batch_search_tmdb` remains the only required search tool for resolving multiple candidates efficiently, and `get_user_favorites` stays as contextual preference input only.

### Decision: Use one prompt builder for every turn
**Choice**: Replace the turn-specific prompt builders with `buildTurnMessage(ctx)`.

**Alternatives considered**: Keep separate initial and refinement messages.

**Rationale**: The agent should receive the same contract on every turn. The only meaningful state changes are `collected`, `proposedTitles`, and the remaining `gap`; those are inputs to one builder, not reasons to maintain multiple prompt variants.

### Decision: Preserve the caller-facing result shape
**Choice**: Keep `runAgentLoop` returning the existing `{ success, recommendations, reason }` shape, while using `terminationReason` terminology internally and in logs.

**Alternatives considered**: Introduce a new public result schema.

**Rationale**: This minimizes caller churn in `addon.js` and avoids introducing a parallel migration just to rename the result envelope.

## Data Flow

1. `addon.js` always enters `runAgentLoop` for recommendation requests, regardless of Trakt availability.
2. `runAgentLoop` builds the chat with the slimmed tool declarations and a static system prompt.
3. On every turn, the loop calls `buildTurnMessage(ctx)` with the current query, requested count, `collected`, `proposedTitles`, current gap, discovered genres, and any contextual favorite data.
4. Gemini returns a response that may contain function calls, text, or both.
5. If function calls are present, the orchestrator executes them and feeds the tool results back into the next Gemini call.
6. The loop extracts the text payload and passes it to `parseTurnResponse(rawText)`.
7. If a JSON array is recovered, the orchestrator validates each candidate shape, records its titles in `proposedTitles`, filters the parsed items locally, and appends only surviving candidates to `collected`.
8. Filtering happens **after parsing** and **before collection**. Titles are still recorded even when a candidate is rejected, so later turns cannot reuse them.
9. `get_user_favorites` results are fed back into the next generation context only. They are never auto-added to `collected` and never count toward the requested result total.
10. If `collected.length >= numResults` at any point, the loop terminates successfully.
11. If the Gemini API errors after partial progress, the loop returns the partial `collected` set with an `api_error_partial` termination reason.
12. If the turn budget is exhausted first, the loop returns the partial set with `max_turns_exceeded`.
13. If the parser cannot recover JSON for a turn, that turn contributes zero candidates and the loop continues when budget remains.

## File Changes

### `utils/agent-parse.js` — new
- Add `parseTurnResponse(rawText)`.
- Strip ```json / ``` fences before parsing.
- If prose surrounds the payload, locate the first balanced `[` ... `]` block and parse only that block.
- Return `{ items: [], error: 'reason' }` on failure, with the error used for logging and turn-level recovery.

### `utils/prompts.js`
- Add `buildTurnMessage(ctx)` as the single per-turn prompt builder.
- Fold the old initial/refinement/progress messaging into that builder.
- Remove the numbered workflow language and keep the prompt short, imperative, and contract-driven.
- Keep `buildAgentSystemPrompt` as the static wrapper, but remove turn-numbered protocol narration from it.

### `utils/agent-tools.js`
- Delete the `search_tmdb` declaration and handler.
- Delete the `check_if_watched` declaration and handler.
- Keep `batch_search_tmdb` and `get_user_favorites` as the only exposed tools.
- Update the handler map so unsupported tool names are no longer part of the normal dispatch surface.

### `utils/agent.js`
- Rewrite the loop to: parse turn response -> filter locally -> collect survivors -> continue or terminate.
- Replace the old final-text-only completion path with per-turn parsing via `parseTurnResponse`.
- Remove the forced-finalization message block and the final “fill the gap from own knowledge” behavior.
- Remove the `filterCandidates` dependency expectation; local filtering is owned by the loop.
- Update tool dispatch to work only with the slimmed tool surface.

### `addon.js`
- Remove the recommendation-path split between the Trakt-authenticated agent loop and the no-Trakt linear fallback.
- Stop building or sending the linear prompt for recommendations.
- Stop maintaining the no-Trakt `filterCandidates` shim; empty watched/rated sets should make the filter a no-op naturally.
- Keep downstream enrichment intact; it can continue to consume the unified `runAgentLoop` result.

## Interfaces / Contracts

### `buildTurnMessage(ctx)`
- **Input**: request context plus current turn state (`query`, `type`, `numResults`, `collected`, `proposedTitles`, `gap`, `discoveredGenres`, optional genre analysis, optional favorites context).
- **Output**: a single string prompt for the current turn.
- **Contract**: turn 0 and later turns use the same builder; only the input arrays differ.

### `parseTurnResponse(rawText)`
- **Input**: raw text extracted from Gemini response parts.
- **Output**: `{ items, error }`, where `items` is the parsed candidate array or `[]` on failure.
- **Parsing rules**: strip fences, recover the first top-level JSON array if prose is present, and treat any unparseable response as recoverable for the current turn.

### `runAgentLoop(dependencies)`
- **Signature**: stays structurally compatible for callers, but the old `filterCandidates` dependency is no longer part of the design contract.
- **Expected inputs**: `numResults`, `filterWatched`, `traktWatchedIdSet`, `traktRatedIdSet`, `executeTools`, `toolDeclarations`, `searchTMDB`, and the context needed by `buildTurnMessage`.
- **Return shape**: preserve `{ success, recommendations, reason }` so `addon.js` does not need a broader migration.
- **Reason values**: `success`, `max_turns_exceeded`, `api_error_partial`, and any existing hard-failure reasons already used by the caller.

### Removed / renamed / added functions
- DELETE `buildLinearPrompt` in `utils/prompts.js`
- DELETE `buildAgentInitialMessage` in `utils/prompts.js` (merged into `buildTurnMessage`)
- DELETE `buildRefinementMessage` in `utils/agent.js` (merged into `buildTurnMessage`)
- DELETE `buildProgressFeedback` in `utils/prompts.js` (folded into `buildTurnMessage`)
- DELETE forced-finalization message block in `runAgentLoop`
- REWRITE `processFinalTextResponse` as `parseTurnResponse`
- REWRITE `runAgentLoop` to parse turn response -> filter -> collect -> continue/terminate
- ADD `buildTurnMessage(ctx)` in `utils/prompts.js`

## Testing Strategy

There is no automated test suite, so verification is manual and syntax-driven:

1. Run `node -c` on every edited `.js` file.
2. Start the server normally and exercise the recommendation path through `public/configure.html`.
3. Verify a Trakt-connected query logs turn count, collected count, and termination reason correctly.
4. Verify a no-Trakt query uses the same loop and succeeds when the first valid JSON array already satisfies `numResults`.
5. Verify malformed JSON yields zero candidates for that turn but does not crash the loop when turns remain.
6. Verify logs no longer mention `search_tmdb` or `check_if_watched` in the agent tool surface.

## Migration / Rollout

- Roll out in one code-only pass; there is no schema or storage migration.
- Update `utils/prompts.js`, `utils/agent-tools.js`, `utils/agent-parse.js`, and `utils/agent.js` together so the loop, parser, and prompts stay in sync.
- Update `addon.js` last so the caller only switches to the unified path after the loop contract is ready.
- Existing callers that still pass `filterCandidates` can be tolerated briefly, but the recommended migration is to remove that shim because empty Trakt sets already represent the no-filter case.

## Rollback Considerations

Rollback is code-only. If the unified orchestration regresses recommendation quality or reliability, restore the previous split behavior by:

- reintroducing the linear recommendation path in `addon.js`,
- restoring the old prompt builders and finalization behavior,
- re-adding the removed agent tools, and
- swapping back to the previous text-completion flow.

No data migration is required because this change does not alter cache formats, token storage, or external API contracts.

## Open Questions

None. The design resolves the prompt structure, turn semantics, parsing strategy, and caller migration path.
