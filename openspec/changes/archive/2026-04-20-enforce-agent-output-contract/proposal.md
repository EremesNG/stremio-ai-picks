# Proposal: Enforce Agent Output Contract

## Intent

### Problem Statement
The current agent ↔ orchestrator contract is inconsistent and too permissive. In smoke runs from the previous session, the no-Trakt path returned a truncated first turn and relied on multiple orchestrator turns to recover, while the Trakt-authenticated path frequently emitted non-JSON text and exhausted the turn budget. The root cause is a mismatch between prompt schemas, weak parsing/validation, and an orchestrator loop that accepts contract-violating responses without immediate correction.

### Goal
Make each orchestrator turn contractually strict and self-correcting: the agent must emit a JSON array with exactly the requested number of items, each item must follow one unified schema, and any contract violation must trigger one corrective retry within the same turn before the loop advances.

## Scope

### In Scope
- Unify the agent item schema across prompts to exactly `{ type, title, year, tmdb_id }`.
- Remove any prompt language that invites scratchpad or metacognitive output such as `reason`.
- Add a contract validator that checks required fields, field types, allowed fields, and per-turn item count against the current gap.
- Update the orchestrator turn loop to reject parse/schema violations, send targeted corrective feedback, and retry once within the same turn.
- Extend turn-result logging with retry and violation metadata.
- Update repository documentation artifacts that describe the agent/orchestrator contract and any new validator placement.

### Out of Scope
- Changing the public return shape of `runAgentLoop`.
- Adding new dependencies to `runAgentLoop` arguments.
- Changing the internal turn-round safety cap or the outer `maxTurns` budget.
- Treating dedupe against `collected` or `proposedTitles` as a contract violation.
- Introducing a new public termination reason.
- Addressing any Trakt-specific prompt issues beyond the general contract hardening in this change.

## Approach
1. Align both prompt helpers so they describe the same strict item schema and the same exactness requirement.
2. Introduce a validator that can distinguish parse failures from schema violations and return a structured report of invalid items, missing fields, extra fields, and count shortfall.
3. Wire the validator into the turn execution path so the orchestrator can retry once per turn with corrective feedback when the contract is broken.
4. Preserve existing outer-loop semantics: if the second attempt still under-delivers, accept the valid subset and continue with normal gap-closing on the next orchestrator turn.
5. Keep observability high by logging when the retry was used and what violations were observed before and after the retry.

## Affected Areas
- `utils/prompts.js` — unify prompt schema language and remove metacognitive fields.
- `utils/agent-parse.js` or a new validator module — implement structured contract validation.
- `utils/agent.js` — enforce retry-on-violation behavior and enrich turn-result logging.
- `AGENTS.md` — document the strict contract, validator, and retry semantics.
- `codemap.md` and `utils/codemap.md` — reflect the new contract enforcement behavior and any new module.
- `openspec/changes/enforce-agent-output-contract/specs/` — future spec deltas for the change.

## Risks
- A retry may not fully resolve the Trakt-authenticated non-JSON failure mode if the prompt context still pushes the model off-contract.
- Feedback that is too verbose could pollute the model context; feedback that is too sparse may not correct behavior.
- Tightening validation could surface items that were previously filtered silently, increasing the amount of rejected output before convergence.
- The additional retry consumes one tool round per violated turn, which increases token usage but remains bounded by the existing safety cap.

## Open Questions
- None. The requirements interview resolved the implementation choices and scope boundaries.

## Rollback Plan
Revert the validator and retry logic in `utils/agent.js`, remove or disable the new validation helper, and restore the previous prompt wording in `utils/prompts.js`. No data migration or config migration is required.

## Success Criteria
- No-Trakt smoke completes successfully with the requested count, ideally in one orchestrator turn and at worst within two turns.
- Trakt-authenticated smoke completes successfully with the requested count.
- Contract violations trigger a retry attempt within the same turn before the loop advances.
- Parsed items never include disallowed fields such as `reason`, `imdb_id`, `name`, or `overview`.
- Syntax checks pass for all edited JavaScript files, and `utils/agent.js` remains require-safe.
