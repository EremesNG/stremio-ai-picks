# Proposal: Configure page enhancements

## Intent
Improve the configuration experience and expose a few agent controls that are currently hard-coded or awkward to edit. The change should make setup safer and clearer while preserving backward compatibility for existing encrypted configs.

## Scope
### In Scope
1. Replace the free-text Gemini model field in `public/configure.html` with a predefined dropdown, defaulting new configs to `gemini-flash-lite-latest`.
2. Replace the comma-separated homepage catalog input with editable rows (title + query + delete/add controls) while still serializing to and from the existing `HomepageQuery` string format.
3. Add a Trakt-gated `FilterWatched` toggle, default ON, that disables watched filtering behavior when OFF.
4. Add `MaxTurns` to Advanced Options with a bounded 4–12 control, default 6, and pass it through to the agent runtime.
5. Update `addon.js`, `utils/agent.js`, `utils/prompts.js`, and `utils/agent-tools.js` to honor the new config fields and conditional behavior.

### Out of Scope
- Changing `server.js` HomepageQuery parsing logic.
- Redesigning the underlying recommendation flow beyond the watched-filter toggle.
- Introducing new persistence formats for config data.
- Altering Trakt OAuth, token storage, or TMDB integration.

## Approach
Use curated UI controls for safer configuration, but keep the wire format stable so old configs continue to load and new configs can still be consumed by existing parsing logic. Gate watched filtering behind a single config flag so the agent can run without `check_if_watched` when users opt out, and read `MaxTurns` from config with a sane default/fallback.

## Affected Areas
- `public/configure.html`
- `addon.js`
- `utils/agent.js`
- `utils/prompts.js`
- `utils/agent-tools.js`

## Risks
- Existing configs may omit new fields, so every new setting must default gracefully.
- HomepageQuery row editing must round-trip exactly to the legacy `Title:Query,Title:Query` format.
- Disabling watched filtering must not leave the agent loop dependent on `check_if_watched` or break Trakt favorites usage.
- The curated model list must stay aligned with models supported by the backend Gemini client.

## Rollback Plan
Restore the current free-text model field, the single text input for homepage catalogs, always-on watched filtering, and the previous agent turn behavior. Existing stored configs should remain readable because the legacy formats are preserved.

## Success Criteria
- Users can choose a model from a dropdown and new configs default to `gemini-flash-lite-latest`.
- Homepage catalogs can be edited as rows and still serialize/deserialize to the legacy `HomepageQuery` string.
- When `FilterWatched` is OFF, `check_if_watched` is not exposed and watched filtering is skipped, while Trakt favorites still work.
- `MaxTurns` is honored by the agent with a default of 6 and a bounded range of 4–12.
- Older encrypted configs continue to load without manual migration.
