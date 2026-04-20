# Proposal: Tool-based watched filter

## Intent
Replace the large prompt-injected `doNotRecommend` list with a lightweight `check_if_watched` tool so the agent can verify candidate recommendations against the user’s full Trakt history on demand. This should reduce prompt size, improve coverage beyond the current 200-item cap, and keep watched-item filtering accurate for Trakt-authenticated users.

## Scope
### In Scope
1. Remove `doNotRecommend` from the agent initial prompt built in `utils/prompts.js`.
2. Add a new `check_if_watched` tool in `utils/agent-tools.js` that accepts batches of up to 10 items and returns watched/rated status per item.
3. Pass `traktWatchedIdSet` and `traktRatedIdSet` through `utils/agent.js` into tool execution context.
4. Update `addon.js` to stop passing `doNotRecommend` into the prompt builder while preserving the existing `filterCandidates` safety net.
5. Keep the change limited to Trakt-authenticated agent flows; non-Trakt users remain unchanged.

### Out of Scope
- Changing the recommendation agent loop structure or turn limits.
- Removing `buildDoNotRecommendList` or `buildMediaIdentitySet` from the codebase.
- Altering the linear (non-agent) recommendation path.
- Reworking Trakt history fetching, caching, or pagination behavior.
- UI, configuration, database, or deployment changes.

## Approach
Move watched-item validation out of prompt context and into a deterministic tool call pattern. The agent will ask `check_if_watched` before including candidates, while the orchestrator still performs post-response filtering as a fallback so correctness does not depend solely on model compliance.

## Affected Areas
- `utils/prompts.js`
- `utils/agent-tools.js`
- `utils/agent.js`
- `addon.js`

## Risks
- More tool calls may increase latency if the model overchecks candidates.
- The agent may still skip the tool occasionally, so fallback filtering must remain reliable.
- Batch validation logic must stay aligned with the normalized identity sets to avoid false negatives.

## Rollback Plan
Restore the current prompt-injected `doNotRecommend` flow, remove the `check_if_watched` tool declaration/handler, and keep `filterCandidates` as the only safety net. This returns the system to its current behavior without changing user-facing response shape.

## Success Criteria
- The initial agent prompt no longer contains a `doNotRecommend` list.
- The agent can call `check_if_watched` with batches of up to 10 items.
- Watched/rated items are still excluded through tool-guided selection plus deterministic filtering.
- Initial prompt token usage drops materially for Trakt-authenticated users.
- Agent logs show `TOOL_CALL_REQUEST` entries for `check_if_watched` with batched arguments.
