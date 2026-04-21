# Proposal: Unify agent loop orchestration

## Intent
The current recommendation flow has an architectural mismatch with the intended design: it asks Gemini to narrate turn structure and emit a final JSON payload, while the orchestrator only partially participates in collection. That mismatch is visible in the recent regression where a request for 20 items can return only 3, because tool results do not reliably populate `collected` and the model often produces unparseable narration instead of a usable final array.

This change realigns the system around a single rule: the agent is a pure per-turn candidate generator, and the orchestrator owns collection, filtering, gap computation, and termination.

## Scope
### In Scope
1. Refactor `utils/agent.js` so the loop consumes a per-turn JSON array from Gemini, parses it defensively, filters locally against Trakt watched/rated sets, appends survivors to `collected`, computes the next gap, and terminates on success or `maxTurns` exhaustion.
2. Remove the separate linear-vs-agent orchestration split and unify all recommendation requests through the same turn-based loop, including the no-Trakt case where filtering becomes a no-op and the loop can terminate after turn 0.
3. Rewrite `utils/prompts.js` so agent prompts are short, imperative, and non-numbered; eliminate “Turn 1 / Turn 2 / Step 3” narration cues and replace them with a strict per-turn contract.
4. Update `utils/agent-tools.js` to reduce the tool surface to `batch_search_tmdb` and `get_user_favorites` only; remove `search_tmdb` and `check_if_watched` from the agent contract.
5. Update direct caller wiring in `addon.js` only as needed so all recommendation entry points use the unified orchestration path.

### Out of Scope
- TMDB API behavior, result shape, or ranking logic.
- Trakt OAuth, token storage, or watched/rated data acquisition.
- UI changes in `public/configure.html` or other frontend assets.
- Cache persistence, storage format, or cache invalidation logic.
- Any broader schema or deployment changes outside the recommendation orchestration path.

## Approach
The new architecture splits responsibilities cleanly:

- **Agent contract:** On each turn, Gemini receives the user query, current context, already-accepted items, already-proposed titles, and the current gap. It must return exactly that turn’s new candidates as a JSON array, and it must resolve each candidate through `batch_search_tmdb` so TMDB IDs are included.
- **Orchestrator contract:** `utils/agent.js` parses the per-turn JSON array, filters survivors locally against in-memory Trakt watched/rated sets, adds accepted candidates to `collected`, tracks proposed titles, and either terminates successfully, terminates with `max_turns_exceeded`, or computes the next gap and sends a refinement message for another turn.
- **Unified flow:** The same loop serves users with and without Trakt. When Trakt is unavailable, filtering is a no-op and the loop should naturally finish after turn 0 if the model resolves enough valid TMDB IDs.
- **Prompt shape:** Prompts should be imperative and compact, with no numbered workflow steps that encourage Gemini to narrate the process instead of executing it.
- **Parsing resilience:** Because malformed JSON is still a risk, the orchestrator should use defensive JSON extraction and treat invalid turn output as a recoverable failure mode rather than depending on final-text completion.

## Affected Areas
- `utils/agent.js` — unified turn loop, per-turn parsing, local filtering, gap management, termination, and refinement messaging.
- `utils/prompts.js` — agent prompt contract, refinement text, and removal of linear/numbered workflow guidance.
- `utils/agent-tools.js` — agent-visible tool declarations; keep `batch_search_tmdb` and `get_user_favorites`, remove `search_tmdb` and `check_if_watched`.
- `addon.js` — direct recommendation caller(s) may need wiring updates to use the unified loop only.

## Risks
- **Malformed per-turn JSON:** The model may still emit invalid JSON arrays. Mitigation: implement robust extraction/parsing in the orchestrator and treat bad output as a turn-level recovery case.
- **Silent watched-item waste:** Removing `check_if_watched` means the model can propose watched items that get filtered out locally. Mitigation: refinement messages must explicitly include already-accepted items and titles filtered out on prior turns so Gemini does not retry them.
- **Behavior change for no-Trakt users:** Collapsing the split pipeline changes the control flow for users without Trakt data. Mitigation: verify the unified loop degenerates to a single successful turn when filtering is a no-op.
- **Turn-budget pressure:** Heavy Trakt histories may consume more turns before enough survivors remain. Mitigation: keep `maxTurns` as the explicit tradeoff knob and return a clear partial result when the budget is exhausted.

## Rollback Plan
If this change regresses quality or reliability, revert the unified orchestration and restore the previous split behavior: re-enable the linear path, restore `search_tmdb` and `check_if_watched` to the agent tool surface, and return to final-text-based completion handling in the touched recommendation files. This rollback is limited to the orchestration layer and does not require changes to TMDB, Trakt, UI, or cache subsystems.

## Success Criteria
- Requests for N recommendations are satisfied by collecting per-turn candidate arrays until `collected.length >= N`, or they end with `terminationReason: 'max_turns_exceeded'` and the partial `collected` set.
- Users without Trakt still use the same loop and complete after turn 0 when enough valid TMDB IDs are produced.
- The agent never sees `check_if_watched` or `search_tmdb` in its tool options.
- The agent prompt contains no numbered workflow steps such as “Turn 1:” or “Step 2:”.
- `collected` is populated from the orchestrator’s per-turn JSON parsing, not from a final text response.
- The old linear pipeline path is removed or fully unified into the single recommendation loop.
- A real run of “recommend 20 sci-fi movies post-2010” against a Trakt user returns at least 20 items when enough candidates exist, or a clearly logged partial result with a valid termination reason.
