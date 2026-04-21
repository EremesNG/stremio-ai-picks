# Verification Report: Rewrite agent prompts

## Overall Status
PASS

## Summary
- The prompt rewrite now satisfies all 10 acceptance criteria with no regressions in the earlier prompt-contract or tool-guidance work.
- Criterion 10 is fixed: `buildProgressFeedback` now derives the remaining gap internally from the total needed count, and the call site passes the total (`resolvedNumResults`) instead of a pre-subtracted remainder.

## Compliance Matrix

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Count-contract statements are canonicalized with hard mandate wording across `buildLinearOutputContract`, `buildAgentOutputContract`, `buildLinearPrompt`, `buildAgentInitialMessage`, `buildSimilarContentPrompt`, and the top-level mandate in `buildAgentSystemPrompt`. | PASS | `utils/prompts.js:38-55`, `utils/prompts.js:106-127`, `utils/prompts.js:182-198`, `utils/prompts.js:207-230`, `utils/prompts.js:155-161` |
| 2 | `buildAgentSystemPrompt` TURN EFFICIENCY PROTOCOL references `Math.ceil(numResults * 1.5)` and ties early-turn generation to watched-filter survival. | PASS | `utils/prompts.js:135-142` |
| 3 | `buildProgressFeedback` accepts `turnsRemaining`, and the call site in `utils/agent.js` passes it from existing loop variables. | PASS | Signature in `utils/prompts.js:233-265`; call site in `utils/agent.js:1148-1160` |
| 4 | `buildRefinementMessage` quantifies the shortfall and demands overshoot on the next turn. | PASS | `utils/agent.js:329-358` |
| 5 | Forced finalization in `runAgentLoop` instructs gap-fill from high-quality fallback candidates when short. | PASS | `utils/agent.js:1007-1026` |
| 6 | Tool descriptions for `batch_search_tmdb` and `check_if_watched` use imperative batch-first language with explicit 20-item ceilings. | PASS | `utils/agent-tools.js:27-30`, `utils/agent-tools.js:73-76` |
| 7 | No `when possible` / `unless` / `if possible` soft language appears in the count-contract or turn-efficiency sections across the three edited files. | PASS | `rg -n "when possible|unless|if possible" utils/prompts.js utils/agent.js utils/agent-tools.js` returned no matches |
| 8 | Syntax checks pass for all edited files. | PASS | `node -c utils/prompts.js && node -c utils/agent.js && node -c utils/agent-tools.js` exited 0 with no output |
| 9 | The change stays limited to prompt-string / prompt-payload updates and does not alter loop control flow or integrations. | PASS | `utils/agent.js:1148-1160` only adds the `resolvedNumResults` payload to `buildProgressFeedback`; other edits remain prompt text only |
| 10 | `buildProgressFeedback` reports the exact remaining gap in plain, gap-oriented language. | PASS | `utils/prompts.js:233-265` computes `gap = Math.max(0, neededCount - acceptedItems.length)` while the call site passes total needed count (`utils/agent.js:1151-1159`). Mental trace with `collected.length = 5` and `resolvedNumResults = 20` renders: `Accepted count: 5. Remaining gap: 15 items.` and `You MUST return exactly 20 items.` |

## Build and Test Evidence
- `node -c utils/prompts.js` — passed
- `node -c utils/agent.js` — passed
- `node -c utils/agent-tools.js` — passed
- `rg -n "when possible|unless|if possible" utils/prompts.js utils/agent.js utils/agent-tools.js` — no matches
- Mental trace render for `acceptedItems.length = 5`, `neededCount = 20`, `turnsRemaining = 2` produced the required gap text and hard count contract

## Issues Found
- None

## Verdict
PASS — all acceptance criteria are satisfied, including the gap-calculation fix for criterion 10, with no regressions introduced in criteria 1-9.
