# Verification Report: Redefine Turn Semantics

## Verdict
COMPLIANT

## Completeness
- Artifacts reviewed: `proposal.md`, `design.md`, `tasks.md`, `specs/agent-contract/spec.md`, `specs/orchestrator-contract/spec.md`
- Requirements verified: 7 / 7
- Scenarios verified: 10 / 10
- Implementation files inspected: `utils/agent.js`, `utils/agent-tools.js`, `addon.js`, `AGENTS.md`, `codemap.md`, `utils/codemap.md`, `public/configure.html`, `utils/prompts.js`

## Build and Test Evidence
- `node -c utils/agent.js` → exit 0
- `node -e "require('./utils/agent'); console.log('ok')"` → printed `ok`
- Grep audit confirmed turn increments only at outer-loop boundaries and `tool_loop_exhausted` is emitted from the final-turn safety-cap path
- Manual smoke 5.4 (no Trakt): `LOOP_START` → `LOOP_END`, `totalTurns: 4`, `terminationReason: "success"`, all four turns emitted parseable JSON, no `empty_turn` / `no_json_array` errors
- Manual smoke 5.5 (Trakt-authenticated): `LOOP_START` → `LOOP_END`, `totalTurns: 6`, `terminationReason: "max_turns_exceeded"`, parse errors were `empty_turn` / `no_json_array`; this is documented below as an out-of-scope prompt contract issue, not a loop-semantics failure

## Compliance Matrix

### R1 — Resolve every candidate through TMDB search
**Status:** PASS

- Scenario: Candidate objects include TMDB IDs after internal tool rounds
  - Evidence: `utils/agent-tools.js` exposes only `batch_search_tmdb` and `get_user_favorites`; `batch_search_tmdb` is explicitly the required batched search path; `utils/prompts.js` instructs the model to resolve candidates by calling `batch_search_tmdb`; `applyTurnFilter` rejects any item missing `tmdb_id` and only accepted items are collected with a resolved `tmdb_id`.
- Scenario: Tool surface is limited to the approved tools
  - Evidence: `toolDeclarations` contains only the two approved tools, and the agent loop dispatches through that surface only.

### R2 — Parse each turn defensively
**Status:** PASS

- Scenario: Malformed JSON text still ends the turn
  - Evidence: `executeAgentTurn` treats any text-bearing Gemini response as a completed turn, parses it, and returns zero candidates on parse failure; the outer loop logs `TURN_RESULT` and advances when budget remains. Smoke 5.5 shows parse failures on text-bearing turns while `totalTurns` still advances to 6.

### R3 — Filter candidates locally before collection
**Status:** PASS

- Scenario: `filterWatched=false` bypass stays disabled
  - Evidence: `applyTurnFilter` computes `filterWatched = ctx.filterWatched !== false`, and only applies watched/rated filtering when that flag is true. `addon.js` continues to pass the config-derived `filterWatched` value without any special-case branch for the new reason.
- Scenario: Parseable text with only rejected candidates still counts the turn
  - Evidence: the outer loop increments by orchestrator turn, not by internal tool rounds; rejected candidates are filtered locally, `collected` can remain unchanged, and the turn is still logged as complete. Smoke 5.4 includes rejected candidates (`droppedCollected: 2`) while the loop still reports complete turns and a successful final result.

### R4 — Terminate on success or turn-budget exhaustion
**Status:** PASS

- Scenario: Return shape is preserved
  - Evidence: `runAgentLoop` still returns `{ success, recommendations, reason }`; `addon.js` consumes that shape unchanged. `tool_loop_exhausted` is handled by the existing success/failure fall-through in `addon.js`, so no signature or return-shape break was introduced.

### R5 — Count turns on agent text emissions, not tool-only rounds
**Status:** PASS

- Scenario: One full cycle counts as one turn
  - Evidence: tool-only Gemini round-trips stay inside `executeAgentTurn` and do not increment the outer loop counter. Turn-level logs use `turn`, while internal logs carry `toolRound`. Smoke 5.4 shows four complete orchestrator attempts with parseable JSON and no turn-count inflation from internal tool rounds.
- Scenario: Under-delivery advances to the next orchestrator turn
  - Evidence: when parsed output is accepted but still under-fills the requested gap, the outer loop advances to the next turn with updated context. Smoke 5.4 demonstrates multiple orchestrator attempts (`totalTurns: 4`) without any evidence of tool-round miscounting.

### R6 — Cap internal tool-loop rounds per turn
**Status:** PASS

- Scenario: Tool-loop safety cap stops a runaway turn
  - Evidence: `DEFAULT_MAX_TOOL_ROUNDS_PER_TURN = 8` is defined in `utils/agent.js`; `executeAgentTurn` increments `toolRoundsUsed` only inside the inner loop and returns `toolLoopExhausted: true` when the cap is reached; the outer loop maps final-turn exhaustion to `tool_loop_exhausted`.

### R7 — Distinguish turn events from internal tool-round events
**Status:** PASS

- Scenario: Logs separate turn and internal rounds
  - Evidence: `TURN_START`, `TURN_RESULT`, `LOOP_START`, and `LOOP_END` report orchestrator turns; `RESPONSE_RECEIVED`, `AGENT_RAW_RESPONSE`, `TOOL_CALL_REQUEST`, `TOOL_CALL_RESPONSE`, and `LOOP_ERROR` include `toolRound` for inner-loop visibility. Grep audit confirms turn increments occur only at outer boundaries.

## Design Coherence
- The implementation matches the design’s outer-turn / inner-tool-round split in `utils/agent.js`.
- The internal safety cap remains module-local and fixed at 8, exactly as designed.
- Documentation sync is coherent across `AGENTS.md`, `codemap.md`, `utils/codemap.md`, and `public/configure.html`.
- `addon.js` remains audit-only for this change; the `MaxTurns` clamp stays `4..12` with default `6`, and the `tool_loop_exhausted` reason falls through safely.

## Issues Found
- No in-scope compliance defects found.
- Out-of-scope follow-up: the Trakt-authenticated smoke still exhibits agent output-contract violations (`empty_turn` / `no_json_array`) under that context. The evidence indicates this is a prompt/contract issue, not a turn-semantics regression, and it should be handled by the separate `enforce-agent-output-contract` change.

## Verdict
The `redefine-turn-semantics` implementation is COMPLIANT with the verified spec deltas and design. The loop semantics, safety cap, logging split, termination reasons, and documentation updates all align with the OpenSpec change.
