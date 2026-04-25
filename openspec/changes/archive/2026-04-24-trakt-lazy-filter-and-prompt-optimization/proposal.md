# Proposal: Trakt Lazy Filter and Prompt Optimization

## Intent
Replace wasteful bulk Trakt watched/rated/history prefetching with orchestrator-owned post-TMDB per-item status checks, and replace oversized raw favorites prompt payloads with compact preference summaries so filtering correctness is preserved while latency, token usage, and API pressure are reduced.

## Scope
### In Scope
1. Remove bulk Trakt watched/ratings/history fetch dependency for agent-turn filtering in the Trakt-authenticated path.
2. Add orchestrator-side Trakt status evaluation after TMDB candidate resolution and before collection/filtering decisions.
3. Reuse and/or extend existing Trakt status primitives (including `isItemWatchedOrRatedImpl`) behind a deterministic per-item check interface.
4. Introduce request/session-aware caching for Trakt per-item status checks to avoid redundant lookups across turns and duplicate proposals.
5. Preserve `filterWatched` behavior: when disabled, Trakt status checks are skipped and no watched/rated/history exclusions are applied.
6. Replace `Favorites context` raw item JSON injection with compact preference payloads from processed Trakt preferences (`preferences`) and/or equivalent human-readable summary formatting.
7. Keep `get_user_favorites` tool availability and round-trip behavior unchanged.
8. Keep rejection accounting categories (`watched`, `rated`, `history`, `duplicate`, `typeMismatch`, `notFound`) and overall return contract stable.

### Out of Scope
- Changes to agent output schema (`{ type, title, year }`) or corrective retry semantics.
- Changes to model-visible tool surface beyond preserving existing favorites tool behavior.
- UI/config page changes beyond any required wiring for existing `filterWatched` semantics.
- Non-agent recommendation path redesign.
- Trakt OAuth/token storage redesign.

## Approach
Shift Trakt exclusion checks to a lazy, orchestrator-owned stage that runs only for TMDB-resolved candidates in each turn. Keep deterministic filtering in the orchestrator (not model-dependent), but reduce data ingress by querying only proposed items. Add bounded caching and optional concurrency limits/backoff-aware request strategy to respect Trakt rate limits. For prompt construction, stop serializing large raw Trakt item arrays and instead inject compact preference-level context (genres, people, year/rating tendencies) in concise model-friendly form.

## Affected Areas
- `addon.js` — remove bulk watched/rated/history fetch reliance for agent filtering inputs; wire compact preferences into prompt context.
- `utils/agent.js` — add post-TMDB Trakt status check stage with caching and `filterWatched` gating before collection.
- `utils/trakt.js` — expose/align per-item watched/rated/history lookup utilities and caching boundaries.
- `utils/prompts.js` — replace raw `Favorites context` JSON serialization path with compact/summarized preference context rendering.
- `utils/agent-tools.js` — no behavioral expansion; preserve `get_user_favorites` contract.

## Risks
- Per-item Trakt checks can increase request count and latency if caching/concurrency controls are weak.
- Insufficient mapping coverage between TMDB-resolved identities and Trakt lookup identities may cause false negatives.
- Over-compressing preferences could reduce recommendation quality if key signal is lost.
- History parity regressions are possible if lazy checks cover watched/rated but omit history equivalence.

## Rollback Plan
Reinstate current bulk watched/rated/history prefetch path and legacy filtering inputs, restore prior prompt context injection behavior, and disable lazy per-item Trakt checks behind a feature-guarded code path rollback. This returns behavior to current baseline without changing public API shape.

## Success Criteria
- Agent flow no longer performs bulk paginated watched/ratings/history fetches solely to support turn filtering.
- Every accepted/rejected candidate in Trakt-authenticated flows is evaluated via post-TMDB orchestrator Trakt status checks (respecting `filterWatched`).
- Rejection quality parity is maintained for `watched`, `rated`, and `history` categories.
- Prompt payload size for `Favorites context` is materially reduced by replacing raw item dumps with compact preferences/summary text.
- `get_user_favorites` tool flow remains functional and unchanged in contract.
- Logs/telemetry demonstrate reduced pre-turn Trakt payload volume and stable recommendation return contract.
