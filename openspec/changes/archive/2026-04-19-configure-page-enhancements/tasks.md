# Tasks: Configure page enhancements

## Phase 1: Backend foundation
- [x] 1.1 Update `addon.js` to read `FilterWatched` and `MaxTurns` from config with backward-compatible defaults (`true` and `6`) and pass both into `runAgentLoop`.
- [x] 1.2 Update `utils/agent.js` to accept `FilterWatched` and `MaxTurns` from dependencies, remove reliance on `DEFAULT_MAX_TURNS` for runtime selection, and skip watched-filter behavior when `FilterWatched` is false.
- [x] 1.3 Update `utils/prompts.js` so the system prompt only includes `check_if_watched` guidance when watched filtering is enabled.
- [x] 1.4 Review `utils/agent-tools.js` for compatibility with conditional watched-filter wiring and keep tool exports stable for `utils/agent.js` to control Gemini tool exposure.

## Phase 2: Frontend configuration UI
- [x] 2.1 Replace the free-text Gemini model field in `public/configure.html` with a `<select>` using `gemini-flash-lite-latest` as the default and options for `gemini-2.5-flash-lite`, `gemini-2.5-flash`, and `gemini-2.5-pro`.
- [x] 2.2 Replace the homepage catalog text input with a dynamic row editor (title input, query input, remove button, add button) that can add/remove rows without losing existing values.
- [x] 2.3 Implement parsing of legacy `HomepageQuery` strings (`Title:Query,Title:Query`) into editable rows when loading an existing config.
- [x] 2.4 Update `generateUrl` in `public/configure.html` so `homepageQuery` is serialized from the dynamic rows back into the legacy comma-separated format.
- [x] 2.5 Add the `FilterWatched` checkbox to Advanced Options, show it only when Trakt is connected, and default it to ON for existing configs.
- [x] 2.6 Add a bounded `MaxTurns` number input in Advanced Options with min/max 4–12 and default value 6.
- [x] 2.7 Ensure `public/configure.html` preserves older encrypted configs by tolerating missing `FilterWatched` and `MaxTurns` fields during form hydration.

## Phase 3: Integration and compatibility
- [x] 3.1 Wire the new config values from the configure page through the generated URL payload so `addon.js` receives `FilterWatched`, `MaxTurns`, `GeminiModel`, and the serialized `HomepageQuery` consistently.
- [x] 3.2 Verify watched filtering remains active only when `FilterWatched` is enabled and Trakt is connected, while Trakt favorites behavior stays unchanged.
- [x] 3.3 Verify `HomepageQuery` round-trips exactly between legacy string storage and the new row-based editor, including empty and multi-row cases.

## Phase 4: Verification
- [x] 4.1 Run syntax checks: `node -c addon.js && node -c utils/agent.js && node -c utils/prompts.js && node -c utils/agent-tools.js`.
- [x] 4.2 Perform browser/manual verification for `public/configure.html` since HTML cannot be validated with `node -c`.
- [x] 4.3 Add deterministic checks for backward compatibility: load configs missing `FilterWatched` and `MaxTurns`, confirm defaults resolve to `true` and `6`.
- [x] 4.4 Smoke-test that the configure page still saves and reloads old configs without requiring migration.
