# Proposal: Rewrite agent prompts

## Intent
The Gemini recommendation agent is under-delivering relative to the user’s requested count because the prompt layer contains contradictory count contracts, soft escape clauses, and weak turn-efficiency guidance. This change rewrites the agent prompts so the model understands a single hard requirement: satisfy the requested item count, overshoot early enough to survive filtering, and fill any remaining gap before final return.

## Scope
### In Scope
1. Rewrite the count-contract language in `utils/prompts.js` so every instruction uses the same hard wording and removes escape clauses such as “unless…”, “when possible”, or other soft-outs.
2. Tie turn-efficiency guidance to the count contract in `utils/prompts.js` so the agent is explicitly told to overshoot candidate generation on early turns when watched filtering may remove items.
3. Update progress feedback in `utils/prompts.js` so it tells the agent how many items are still owed and how many turns remain.
4. Update refinement and finalization messaging in `utils/agent.js` so the agent knows the remaining gap and is forced to fill it from high-quality fallback candidates before returning on the last turn.
5. Align tool declaration descriptions in `utils/agent-tools.js` with the same count-first terminology so tool guidance reinforces the prompt contract instead of diluting it.

### Out of Scope
- Any changes to `runAgentLoop` control flow, including turn handling or finalization logic.
- Any changes to `maxTurns` defaults or configuration semantics.
- Any changes to TMDB or Trakt integrations, batching behavior, or filtering algorithms.
- Any UI or `public/configure.html` changes.

## Approach
Replace the current mixed-language prompt set with a single consistent contract that treats the requested count as mandatory. Early-turn messaging will tell the model to generate enough high-quality candidates to absorb expected attrition from watched filtering, progress feedback will quantify the shortfall after each turn, and the final-turn message will require gap-filling from the same recommendation criteria before the response is emitted.

## Affected Areas
- `utils/prompts.js`
- `utils/agent.js`
- `utils/agent-tools.js`

## Risks
- A stricter contract may push the model toward lower-confidence fallback recommendations for the last few items.
- More explicit guidance may increase prompt length and token usage.
- If the fallback tier is underspecified, the agent could still under-deliver or produce uneven quality at the tail end.

## Rollback Plan
Revert the prompt strings in `utils/prompts.js`, `utils/agent.js`, and `utils/agent-tools.js` to their previous wording. This restores the current behavior without changing runtime control flow or data integrations.

## Success Criteria
- Every count-contract statement uses the same hard wording and removes escape clauses.
- Early-turn guidance explicitly tells the agent to overshoot candidate counts enough to survive filtering attrition.
- Progress feedback includes the exact remaining gap and remaining turns.
- Finalization messaging requires the agent to fill any shortfall from high-quality fallback recommendations before returning.
- The proposal remains limited to prompt changes only; loop control flow and integrations stay untouched.
