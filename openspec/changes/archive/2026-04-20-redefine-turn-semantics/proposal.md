# Proposal: Redefine Turn Semantics

## Problem Statement

The agent loop currently counts Gemini round-trips as turns. That blurs two different things: internal tool consumption inside the model loop, and orchestrator-facing attempts to complete a recommendation cycle.

Recent smoke runs show the mismatch clearly: the loop reported `totalTurns: 2` and `totalTurns: 3`, yet under the owner-defined semantics the agent actually completed the work in a single orchestrator cycle and returned parseable JSON on that one reply.

The domain reason matters: `batch_search_tmdb` is not an optional side quest. It is structurally required to satisfy the agent contract, because every candidate must carry a `tmdb_id` and that ID is resolved through the tool. Internal tool iterations are therefore part of producing the JSON the orchestrator is waiting for, not separate turns.

## Goal

Redefine a turn as the full orchestrator↔agent cycle, so `maxTurns` measures the number of orchestrator attempts instead of Gemini round-trips. Preserve the caller-facing result shape, keep internal tool execution inside a single turn, and add a bounded internal safety cap so one turn cannot loop forever.

The implementation should also make the logs honest: turn-level metrics must reflect orchestrator attempts, while internal tool rounds remain visible as a separate dimension.

## Scope

### In Scope

- Redefine a turn as one full orchestrator↔agent cycle, from request dispatch to parseable JSON response.
- Restructure `runAgentLoop` so the turn counter and `maxTurns` budget operate on orchestrator attempts, not Gemini round-trips.
- Keep internal Gemini↔tool iterations inside a single turn, while still counting that turn as complete once the agent replies with parseable JSON, even if filtering later removes all candidates.
- Add an internal safety cap for tool-only iterations within a single turn (`maxToolRoundsPerTurn`; proposed default: 8) so one bad turn cannot spin indefinitely.
- Update logging so turn-level events and internal tool-round events are distinguishable and both dimensions remain observable.
- Keep the external caller contract unchanged: `runAgentLoop` must continue returning `{ success, recommendations, reason }`.
- Update the user-facing `MaxTurns` copy in `public/configure.html` so the UI reflects orchestrator-attempt semantics and automatic inner tool calls.
- Sync documentation in `AGENTS.md`, `codemap.md`, `utils/codemap.md`, and `public/configure.html` to the new semantics.

### Out of Scope

- Re-opening the tool-surface decision; `batch_search_tmdb` and `get_user_favorites` remain the agent tools.
- Re-opening the unified loop decision; `runAgentLoop` stays the single orchestration path.
- Fixing the Trakt identity-format mismatch; that is a separate follow-up change.
- Changing the public return shape of `runAgentLoop`.
- Changing the agent-contract JSON shape requirements.

## Approach

1. Reframe the loop boundary in `utils/agent.js` so `turn` represents the orchestrator attempt, not the number of Gemini response cycles.
2. Preserve internal tool handling inside the same turn, but track those cycles with a separate internal counter and safety cap.
3. Ensure a turn is considered completed once the agent returns parseable JSON, regardless of whether the parsed candidates are later filtered away or produce zero survivors.
4. Keep `maxTurns` as the budget for orchestrator attempts; confirm whether the default remains appropriate once the semantics change.
5. Audit `utils/prompts.js` for any turn-gap messaging that still implies the old round-trip semantics; likely this is an audit-only pass, not a functional change.
6. Update docs and repository atlas files so the new definition is visible to maintainers and future SDD work.

## Affected Areas

- `utils/agent.js` — main loop restructure, turn accounting, internal safety cap, logging split
- `utils/prompts.js` — audit `buildTurnMessage` gap context for new semantics
- `addon.js` — verify `maxTurns` configuration range/default still makes sense for orchestrator-level turns
- `AGENTS.md` — update developer-facing turn definition and loop notes
- `codemap.md` — update repository-level architecture notes
- `utils/codemap.md` — update agent-loop documentation
- `public/configure.html` — update the user-facing MaxTurns copy for orchestrator-attempt semantics
- `openspec/changes/redefine-turn-semantics/specs/` — spec deltas to be written in the next phase

## Risks

- **Tool-loop runaway within one turn**: once internal tool iterations no longer consume turn budget, a bug could burn a large amount of tokens inside a single orchestrator attempt. The proposed `maxToolRoundsPerTurn` cap mitigates this.
- **Budget expectation drift**: `maxTurns=6` will now mean six orchestrator attempts, not six Gemini round-trips. That may be the right budget, or it may be too generous; this should be validated in design.
- **Log consumer compatibility**: downstream dashboards or scripts may have implicitly treated the current `turn` field as a Gemini round-trip index. No such consumer is visible in the repo, but the risk is real.
- **Prompt/context mismatch**: any helper that describes turn progression may still imply the old semantics unless audited alongside the loop.

## Open Questions

None. The design phase resolved the `maxToolRoundsPerTurn` default, the `maxTurns` default, and the log-consumer risk; see `design.md` for the rationale.

## Rollback Plan

If the change regresses recommendation quality or causes runaway internal loops, revert the loop accounting change in `utils/agent.js` to the previous Gemini-round-trip model, restore the old logging semantics, and keep the documentation updates isolated until the behavior is stable again. No storage migration is expected, so rollback is code-only.

## Success Criteria

- `LOOP_END` reports `totalTurns` as orchestrator attempts, not Gemini round-trips.
- `maxTurns=6` means the agent gets 6 attempts to close the gap, with each attempt allowed up to `maxToolRoundsPerTurn` internal tool rounds.
- The current smoke scenarios finish in `totalTurns: 1` in logs under the new definition.
- `addon.js` continues to call `runAgentLoop` without any signature break or return-shape change.
- `AGENTS.md` and the codemaps accurately describe the new turn semantics.
- Syntax and audit checks pass after implementation (`node -c` per edited JS file and targeted grep audits).
