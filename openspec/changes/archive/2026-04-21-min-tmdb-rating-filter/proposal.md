# Proposal: Minimum TMDB Rating Filter per Custom Catalog Entry

## Intent
Add an optional per-catalog `minTmdbRating` setting so users can enforce a minimum TMDB quality threshold on AI recommendations. The change improves recommendation relevance without altering the agent output schema or Stremio manifest contract.

## Scope
### In Scope
- Add optional `minTmdbRating` (0-10 float) to each custom catalog entry in configuration UX and serialization.
- Extend custom catalog serialization from `title:query` to `title:query@@minRating` with backward-compatible parsing.
- Apply the threshold as a soft constraint in turn prompt generation.
- Apply the threshold as a deterministic hard filter in orchestrator post-processing (`applyTurnFilter`).
- Preserve and propagate TMDB rating through the existing TMDB search normalization pipeline.
- Add `lowRating` rejection accounting to turn filtering feedback and turn-result telemetry.

### Out of Scope
- IMDb-based filtering or any non-TMDB rating source.
- Global rating threshold outside per-catalog entries.
- Changes to agent emission schema (`{ type, title, year }` only).
- Changes to Stremio manifest structure.
- New TMDB API endpoints or additional TMDB calls beyond current search flow.

## Approach
1. **Data propagation fix:** Ensure TMDB rating survives normalization by extending `normalizeSearchResult` to map `tmdbRating` from normalized search items (`item.tmdbRating ?? item.vote_average`).
2. **Config model evolution:** Update `public/configure.html` to capture an optional per-row minimum rating and serialize/deserialize rows using `title:query@@minRating`, where absent `@@` suffix means no filter.
3. **Server/addon parsing:** Update `addon.js` parsing of homepage/custom catalog entries to read optional `minTmdbRating` while keeping legacy two-segment rows valid.
4. **Agent loop integration:** Extend `runAgentLoop` inputs and `applyTurnFilter` in `utils/agent.js` to enforce hard filtering when `minTmdbRating` is provided; items below threshold are rejected as `lowRating`.
5. **Prompt guidance:** Update `utils/prompts.js` `buildTurnMessage` to include threshold guidance when configured, preserving existing contract wording for agent item schema.
6. **Telemetry and feedback:** Include `lowRating` in rejection breakdown surfaced to between-turn refinement messaging and `TURN_RESULT` structured output.

## Affected Areas
- `utils/agent-tools.js` — search normalization includes TMDB rating field.
- `public/configure.html` — per-catalog minimum rating input and row serialization/parsing logic.
- `addon.js` — parse/pass `minTmdbRating` from custom catalog configuration.
- `utils/agent.js` — hard filter logic, rejection bucket updates, telemetry accounting.
- `utils/prompts.js` — threshold-aware prompt guidance for generation turns.

## Risks
- **Serialization ambiguity risk:** Suffix-delimited row format can break if parsing assumptions are not updated consistently across configure/addon/server paths.
- **Backward compatibility risk:** Legacy `title:query` rows could be misread if optional `@@minRating` suffix handling is not tolerant.
- **Behavior drift risk:** Prompt-only changes without deterministic filter could produce inconsistent enforcement; must keep hard filter authoritative.
- **Telemetry compatibility risk:** Adding a new rejection bucket can break downstream assumptions if consumers expect fixed key sets.

## Rollback Plan
1. Revert parsing and UI changes to legacy `title:query` only format.
2. Remove `minTmdbRating` from agent-loop inputs and disable `lowRating` post-filter checks.
3. Revert prompt additions so threshold guidance is omitted.
4. Keep normalization changes isolated; if needed, revert TMDB rating field propagation with no impact on core recommendation flow.
5. Validate rollback by confirming existing configs load and recommendation generation works with no rating-based rejections.

## Success Criteria
- Users can optionally set a per-catalog minimum TMDB rating in configuration UI.
- Existing configurations without rating segment continue to work unchanged.
- Agent prompts include rating guidance when threshold is configured.
- Final collected recommendations deterministically exclude items with TMDB rating below configured threshold.
- Rejection reporting and turn telemetry include `lowRating` when applicable.
- No changes to agent output contract or manifest shape.
