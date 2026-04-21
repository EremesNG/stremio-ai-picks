# Design: Redefine Turn Semantics

## Technical Approach

Redefine a turn as one orchestrator-facing attempt to complete a recommendation cycle, not one Gemini round-trip.

The implementation will split `runAgentLoop` into:
- an **outer turn loop** that owns `maxTurns`, success/failure termination, and turn-level logging
- an **inner tool-round loop** that keeps calling Gemini until the turn emits text or the safety cap is hit

The existing parse/filter helpers stay in place. The main behavior change is the loop boundary and the logs that describe it.

## Architecture Decisions

### Decision: Use an outer turn loop plus an inner tool-round loop

**Choice**: Refactor `runAgentLoop` into an outer loop over orchestrator turns and an inner loop over Gemini/tool rounds.

**Alternatives considered**:
- A single loop with extra state to detect when a turn is complete
- Leaving the current structure in place and layering new counters on top

**Rationale**: The semantics now distinguish two budgets. The outer loop must count user-visible orchestrator attempts, while the inner loop must count only tool churn inside one attempt. Separating them makes the code and logs match the mental model and avoids accidental incrementing of `turn` on tool-only Gemini responses.

**Tradeoff**: This is a larger refactor than a single-loop patch, but it is much harder to get wrong and easier for future maintainers to read.

### Decision: A turn ends on the first non-tool-only Gemini response

**Choice**: Treat a response as turn-ending when it is not tool-call-only. Concretely:
- `hasText = typeof rawText === "string" && rawText.trim().length > 0`
- `isToolOnly = functionCalls.length > 0 && !hasText`
- `turnClosed = !isToolOnly`

If `hasText` is true, the turn ends even when `parseTurnResponse` fails; the turn yields zero candidates and the outer loop advances if budget remains. If the response has no text and no tool calls, the turn also closes as an empty turn so the loop cannot deadlock.

**Alternatives considered**:
- Only close the turn on a successful JSON parse
- Keep tool-call-only rounds open but also require parse success before counting the turn

**Rationale**: The spec requires that malformed text still consumes a turn, while tool-call-only round-trips do not. Using tool-only as the only open state gives a deterministic rule that matches the Gemini response shape and preserves forward progress.

**Tradeoff**: A mixed response containing both text and function calls is treated as terminal text and any embedded tool calls are ignored rather than executed. That is acceptable because the contract expects tool-call-only rounds before final text.

### Decision: Keep `maxToolRoundsPerTurn` internal with a default of 8

**Choice**: Introduce a module-level `DEFAULT_MAX_TOOL_ROUNDS_PER_TURN = 8` and keep it internal to `utils/agent.js`.

**Alternatives considered**:
- 6, to match the existing turn budget
- 10 or higher, to allow more self-correction
- Expose the cap through `runAgentLoop` dependencies

**Rationale**: Eight gives enough room for a batch search, an optional favorites lookup, and one or two self-correction passes, while still bounding runaway token burn inside one orchestrator attempt. Keeping the cap internal avoids widening the public call contract for a safety mechanism.

**Tradeoff**: A hard-coded default is less tunable from `addon.js`, but this is a guardrail, not a user-facing product setting.

### Decision: Keep `maxTurns` default and clamp unchanged

**Choice**: Preserve the existing `4..12` clamp and the default of `6`.

**Alternatives considered**:
- Lower the default to 3 or 4 now that each turn is more valuable
- Change the range to a smaller ceiling

**Rationale**: The semantics change already increases the amount of work each configured turn can do. Keeping the current default avoids a second user-visible policy change and preserves existing addon configuration behavior.

**Tradeoff**: `MaxTurns=6` now means six full orchestrator attempts instead of roughly 2–3 Gemini round-trips. That is intentional, but it must be documented as a behavior-visible change.

### Decision: Split logging into turn-level and tool-round-level events

**Choice**: Keep `TURN_START`, `TURN_RESULT`, `LOOP_START`, and `LOOP_END` as turn/loop boundary events. Treat `RESPONSE_RECEIVED`, `AGENT_RAW_RESPONSE`, `TOOL_CALL_REQUEST`, `TOOL_CALL_RESPONSE`, and mid-round `LOOP_ERROR` as internal tool-round events.

Add `toolRound` to internal events so turn count and tool-round count are both observable.

**Alternatives considered**:
- Preserve the current single `turn` field for everything
- Rename all events to a new schema

**Rationale**: The current logs blur orchestrator attempts and Gemini churn. Splitting the dimensions keeps observability honest without breaking the high-level loop events that operators already expect.

**Tradeoff**: Internal logs become slightly more verbose, but the extra detail is exactly what this change needs.

### Decision: Emit `tool_loop_exhausted` only when the inner safety cap terminates the final orchestrator turn

**Choice**: If the tool-round cap fires on a non-final orchestrator turn, complete that turn with zero accepted items and continue. If it fires on the final orchestrator turn, terminate with `tool_loop_exhausted`.

**Alternatives considered**:
- Emit `tool_loop_exhausted` on every cap hit
- Treat cap hits as generic `max_turns_exceeded`

**Rationale**: The new reason should identify the real failure mode without turning recoverable mid-loop stalls into terminal failures. This mirrors the current pattern where a reason can be shared by success and partial-success outcomes.

**Tradeoff**: The same reason can appear with either `success: true` or `success: false`, depending on whether any recommendations were already collected. That is acceptable and keeps it parallel to `max_turns_exceeded`.

### Decision: Keep the public `runAgentLoop` contract unchanged

**Choice**: Do not add a new dependency requirement to `runAgentLoop`'s external call sites. The new tool-round cap remains internal to `utils/agent.js`.

**Alternatives considered**:
- Add `maxToolRoundsPerTurn` to the dependency object
- Move the cap into `addon.js`

**Rationale**: The change is about orchestration semantics, not configuration surface area. Keeping the call signature stable means `addon.js` does not need to learn about a new safety knob.

**Tradeoff**: Lower runtime tunability, but less churn and fewer call-site edits.

## Data Flow

1. `addon.js` keeps reading `maxTurns` exactly as it does today and calls `runAgentLoop` with the same dependency shape.
2. `runAgentLoop` normalizes the existing config, logs `LOOP_START`, and enters the outer orchestrator loop.
3. For each orchestrator turn, it logs `TURN_START`, builds the same turn context, and calls an internal `executeAgentTurn` helper.
4. `executeAgentTurn` performs the inner Gemini/tool loop:
   - call Gemini with the current turn context
   - log `RESPONSE_RECEIVED` and `AGENT_RAW_RESPONSE` with `turn` + `toolRound`
   - if the response is tool-call-only, execute the tools, log `TOOL_CALL_REQUEST`/`TOOL_CALL_RESPONSE`, feed the tool result back to Gemini, and increment `toolRound`
   - stop once text is emitted or the per-turn tool cap is hit
5. When text is emitted, `runAgentLoop` parses it with `parseTurnResponse`, applies `applyTurnFilter`, updates `collected` and `proposedTitles`, and logs `TURN_RESULT`.
6. If `collected.length >= numResults`, the loop returns `success` immediately.
7. If the inner cap fires on the final outer turn, the loop returns `tool_loop_exhausted`; otherwise it advances to the next outer turn with the usual refinement context.
8. `LOOP_END` reports the total orchestrator turns only; tool-round churn is visible separately in the internal logs.

## File Changes

- `utils/agent.js` — restructure `runAgentLoop` into outer turn + inner tool-round loops, add `executeAgentTurn`, add `DEFAULT_MAX_TOOL_ROUNDS_PER_TURN`, attach `toolRound` to internal logs, and return `tool_loop_exhausted` when the final turn exhausts the safety cap.
- `AGENTS.md` — rewrite the agent-loop notes so they describe orchestrator attempts, tool-round separation, and the unchanged `maxTurns` config range.
- `codemap.md` — update the repository atlas to describe the new turn definition and the new internal tool-round dimension.
- `utils/codemap.md` — update the utils map so `agent.js` and `prompts.js` descriptions match the outer/inner loop model.
- `public/configure.html` — update the user-facing `MaxTurns` label/help text so it explains orchestrator attempts and automatic inner tool calls without changing the control value or range.

### Reviewed but not edited

- `utils/prompts.js` — audit only; `buildTurnMessage` already describes current-gap context and does not depend on turn-round-trip semantics.
- `utils/agent-parse.js` — unchanged; `empty_turn` remains the internal no-text parse signal.
- `addon.js` — no code change expected because the call signature stays stable and the `MaxTurns` default remains 6.

## Interfaces / Contracts

### Internal helper signature

Introduce an internal helper in `utils/agent.js` with a concrete shape like:

`executeAgentTurn({ chat, turnNumber, turnContext, runtime, maxToolRoundsPerTurn }) -> Promise<{ rawText, parseResult, parsedItems, toolRoundsUsed, endedByText, toolLoopExhausted }>`

This helper owns the inner Gemini/tool loop and returns parsed-but-unfiltered candidates for the outer loop to apply filtering and termination logic.

Field semantics:
- `parseResult` is the full output of `parseTurnResponse`
- `parsedItems` is the convenience alias for `parseResult.items` and is empty on parse failure or tool-loop exhaustion
- `endedByText` is `true` when the inner loop exited because the model emitted text content
- `toolLoopExhausted` is `true` when the inner loop exited because `maxToolRoundsPerTurn` was reached without text
- `rawText` is the raw text from the final text-bearing response, or `""` when exhausted
- `toolRoundsUsed` counts only tool-only rounds consumed within that turn

### `runAgentLoop` dependencies

No new public dependency is required. `maxToolRoundsPerTurn` is read internally from a module-level default, so `addon.js` keeps calling `runAgentLoop` unchanged.

### External return shape

`runAgentLoop` keeps returning `{ success, recommendations, reason }`.

Valid `reason` values after this change are:
- `success`
- `max_turns_exceeded`
- `tool_loop_exhausted`
- `api_error_partial`
- `all_tools_failed`
- `function_calling_unsupported`

`empty_turn` remains an internal parse error from `parseTurnResponse`; it is not a public `reason`.

## Testing Strategy

There is no automated test suite, so verification stays local and surgical:

- Run `node -c` on every edited `.js` file, especially `utils/agent.js`
- Run `node -e "require('./utils/agent'); console.log('ok')"` to verify the module loads cleanly
- Grep/audit the loop body to confirm `turn` increments only on orchestrator boundaries, not inside tool-only branches
- Verify internal logs now carry `toolRound` for `RESPONSE_RECEIVED`, `AGENT_RAW_RESPONSE`, `TOOL_CALL_REQUEST`, `TOOL_CALL_RESPONSE`, and `LOOP_ERROR`
- Re-run the same no-Trakt and Trakt smoke cases and confirm `LOOP_END.totalTurns` reports `1` for scenarios that previously showed `2` or `3`

## Migration / Rollout

- Land the loop refactor, logging split, and `tool_loop_exhausted` reason in one coordinated change so no mixed semantics ship.
- No schema migration is needed.
- No config migration is needed; existing `MaxTurns` values keep their numeric value but now represent orchestrator attempts.
- Document the semantic shift in `AGENTS.md` and the codemaps so future work does not reintroduce round-trip-based counting.

## Open Questions

None. The remaining task is implementation and verification.
