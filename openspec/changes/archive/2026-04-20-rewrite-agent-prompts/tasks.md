# Tasks: Rewrite agent prompts

Scope note: Prompt-string and prompt-payload changes only. Do not modify control flow, batching logic, `maxTurns`, or integrations.

## Phase 1: Canonicalize the count contract in `utils/prompts.js`
- [x] 1.1 Normalize the shared count-contract text in `buildLinearOutputContract` and `buildAgentOutputContract` so both helpers use identical hard wording for the requested count and never imply optional compliance. File: `utils/prompts.js` approx. lines 38-56.
  Verification:
  - Run: `node -c utils/prompts.js`
  - Expected: exit 0, no output
- [x] 1.2 Rewrite the count-related wording in `buildLinearPrompt`, `buildAgentInitialMessage`, and `buildSimilarContentPrompt` so every prompt section repeats the same mandatory count contract and removes soft phrasing such as “when possible” or “unless ... cannot support ...”. File: `utils/prompts.js` approx. lines 92-127, 171-205, 208-237.
  Verification:
  - Run: `node -c utils/prompts.js`
  - Expected: exit 0, no output
- [x] 1.3 Rewrite the remaining count-contract lines in `buildAgentSystemPrompt` outside `TURN EFFICIENCY PROTOCOL` — including the top-level “Use the available tools to produce exactly ... when possible” line and the appended `unless ...` line — and keep both `filterWatched=true` and `filterWatched=false` branches aligned so neither branch reintroduces soft count language. File: `utils/prompts.js` approx. lines 160-164.
  Verification:
  - Run: `node -c utils/prompts.js`
  - Expected: exit 0, no output

## Phase 2: Strengthen turn-efficiency protocol in `utils/prompts.js`
- [x] 2.1 Rewrite the `TURN EFFICIENCY PROTOCOL` block in `buildAgentSystemPrompt` to define a clear purpose for each turn, make the 1.5x overshoot expectation explicit, and tie early candidate generation to surviving watched-item filtering. File: `utils/prompts.js` approx. lines 135-168.
  Verification:
  - Run: `node -c utils/prompts.js`
  - Expected: exit 0, no output
- [x] 2.2 Update `buildProgressFeedback` in `utils/prompts.js` to accept `turnsRemaining` and report the accepted count, the exact remaining gap, and the remaining-turn budget in plain, gap-oriented language that reinforces the hard count contract. File: `utils/prompts.js` approx. lines 240-259.
  Verification:
  - Run: `node -c utils/prompts.js`
  - Expected: exit 0, no output

## Phase 3: Propagate the remaining-turn payload and tighten agent messaging in `utils/agent.js`
- [x] 3.1 Update the `buildProgressFeedback` call site in `utils/agent.js` so the message payload passes `turnsRemaining` from the existing loop turn index, without changing loop control or turn limits. File: `utils/agent.js` approx. lines 1131-1141.
  Verification:
  - Run: `node -c utils/agent.js`
  - Expected: exit 0, no output
- [x] 3.2 Rewrite `buildRefinementMessage` so it quantifies the shortfall, states the number of items still owed, and explicitly demands overshoot on the next turn from the same recommendation criteria. File: `utils/agent.js` approx. lines 329-351.
  Verification:
  - Run: `node -c utils/agent.js`
  - Expected: exit 0, no output
- [x] 3.3 Rewrite the forced finalization message inside `runAgentLoop` so the last-turn instruction requires gap-filling from high-quality fallback candidates when the agent is still short, while keeping the change limited to the prompt string only. File: `utils/agent.js` approx. lines 994-1009.
  Verification:
  - Run: `node -c utils/agent.js`
  - Expected: exit 0, no output

## Phase 4: Reinforce batching in `utils/agent-tools.js`
- [x] 4.1 Tighten the `batch_search_tmdb` description so it explicitly frames batching as the default, calls out the 20-query ceiling, and removes any wording that could be read as one-at-a-time usage being acceptable. File: `utils/agent-tools.js` approx. lines 27-55.
  Verification:
  - Run: `node -c utils/agent-tools.js`
  - Expected: exit 0, no output
- [x] 4.2 Tighten the `check_if_watched` description so it explicitly encourages batched checks, preserves the 20-item ceiling, and avoids any language that dilutes the batch-first contract. File: `utils/agent-tools.js` approx. lines 73-107.
  Verification:
  - Run: `node -c utils/agent-tools.js`
  - Expected: exit 0, no output

## Phase 5: Verification
- [x] 5.1 Run syntax checks for every edited file: `node -c utils/prompts.js`, `node -c utils/agent.js`, and `node -c utils/agent-tools.js`. File range: entire touched files.
  Verification:
  - Run: `node -c utils/prompts.js && node -c utils/agent.js && node -c utils/agent-tools.js`
  - Expected: all commands exit 0 with no output
- [x] 5.2 Manually review the prompt strings with exact grep patterns for `when possible`, `unless`, and `if possible` across `utils/prompts.js`, `utils/agent.js`, and `utils/agent-tools.js`; confirm zero hits in the count-contract and turn-efficiency text. File ranges: `utils/prompts.js` lines 38-259, `utils/agent.js` lines 329-1141, `utils/agent-tools.js` lines 6-107.
  Verification:
  - Run: `rg -n "when possible|unless|if possible" utils/prompts.js utils/agent.js utils/agent-tools.js`
  - Expected: no matches in the edited count-contract and turn-efficiency sections
  - Run: `rg -n "turnsRemaining" utils/prompts.js utils/agent.js`
   - Expected: matches appear in BOTH `utils/prompts.js` (function signature + at least one usage in the prompt body) AND `utils/agent.js` (call-site property passing the value)
