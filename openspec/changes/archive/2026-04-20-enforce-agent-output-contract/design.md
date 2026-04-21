# Design: Enforce Agent Output Contract

## Technical Approach
This change hardens the agent/orchestrator boundary without changing the public `runAgentLoop` contract. The design keeps parsing, schema validation, retry prompting, and local deduplication as separate concerns so each layer can be reasoned about and tested independently.

The implementation centers on a new validator module that owns the agent item schema, a prompt update that derives its wording from the same schema descriptors, and an orchestrator retry path that reuses the same Gemini chat session for one corrective follow-up inside the same turn. Schema-invalid or malformed text is treated as a contract violation immediately, but only one corrective retry is allowed per turn. After that retry, the orchestrator accepts whatever valid items remain and continues with normal outer-loop behavior.

The key behavior change is that `applyTurnFilter` stops acting as a schema gate. It becomes responsible only for local collection safety: duplicates against `collected`, duplicates against `proposedTitles`, and Trakt watched/rated filtering. Schema enforcement moves earlier, before filtering, so validation can produce precise violation metadata and a targeted corrective message.

## Architecture Decisions

### Decision: Add a dedicated validator module
**Choice**: Create `utils/agent-validate.js` with `validateAgentItems(items, { gap, schema = AGENT_ITEM_SCHEMA }) -> { valid, validItems, invalidItems, violations }`.

**Alternatives considered**:
- Extend `utils/agent-parse.js` so parsing also performs validation.
- Inline validation directly inside `executeAgentTurn` in `utils/agent.js`.

**Rationale**: Parsing and validation are different responsibilities. `parseTurnResponse` should continue to answer only “can this text be decoded into an array?”, while the validator answers “do these items satisfy the contract for this turn?”. Keeping them separate matches the repository’s small-module pattern, makes schema checks easier to unit-reason about, and prevents the retry logic from becoming entangled with text-recovery code.

**Tradeoff**: This adds one more module and one more import boundary. The cost is small, but it does require the prompt helpers and the validator to stay synchronized through shared schema descriptors rather than ad hoc literals.

### Decision: Declare the item schema once and derive prompt wording from it
**Choice**: Declare `AGENT_ITEM_SCHEMA` in `utils/agent-validate.js` and expose a formatter such as `formatSchemaForPrompt(schema)` so `utils/prompts.js` can render the exact field set from the same descriptors.

**Alternatives considered**:
- Hard-code the schema separately in `utils/prompts.js` and the validator, then test that they match.
- Keep prompt wording handwritten and let the validator be the source of truth only.

**Rationale**: The contract already drifted because the prompt and parser/validator semantics diverged. A single schema descriptor list prevents that class of bug from returning. The prompt still remains natural language, but the field set, field names, and types are generated from one shared source of truth.

**Tradeoff**: `utils/prompts.js` gains a dependency on the validator module, so the validator must remain a leaf module and must not import prompt helpers back. That dependency direction is acceptable and keeps the graph acyclic.

### Decision: Use a structured corrective feedback template
**Choice**: Send a short, structured, multi-section corrective message with a violations header, explicit shortfall line, per-item bullets, and a schema recap.

**Alternatives considered**:
- A single compact paragraph with all violations embedded inline.
- A verbose multi-step instruction block with examples and explanatory prose.

**Rationale**: Gemini has been more reliable in observed runs when the failure mode is labeled clearly and the required output is restated immediately. The template is still compact, but the headings make the contract unambiguous and keep the retry payload deterministic.

**Tradeoff**: The feedback is slightly longer than a one-line reminder, which costs a small amount of context. That is acceptable because the retry is bounded to a single attempt per turn and should buy correctness, not minimal tokens.

**Canonical retry template**:
```text
## Violations detected
- Count shortfall: You returned M valid items but I need N. Emit exactly N valid items.
- Parse error: Your previous response was not a JSON array. Emit ONLY a JSON array, nothing else.
- Item #3: missing required field `tmdb_id`.
- Item #5: contains forbidden field `reason`.

## Required output
Return ONLY a JSON array.
Each item must contain exactly these fields:
- `type` (string)
- `title` (string)
- `year` (number)
- `tmdb_id` (number)
```

### Decision: Retry within the same chat session and same inner loop
**Choice**: In `executeAgentTurn`, a validation or parse violation triggers one corrective follow-up via the same `chat.sendMessage(...)` session. The retry is handled inside the existing inner loop and guarded by a `contractRetryUsed` flag.

**Alternatives considered**:
- Start a fresh chat session for the retry.
- Move the retry outside the inner loop and treat it as a new orchestrator turn.

**Rationale**: Reusing the same chat preserves context and avoids paying the cost of re-establishing the turn state. It also matches the spec’s intent: the agent should self-correct immediately in the same turn, not restart the conversation.

**Tradeoff**: The inner loop state becomes slightly richer because it now needs to distinguish “tool round”, “text parse/validation failure”, and “single contract retry already used”. That complexity is localized to `executeAgentTurn` and does not leak into the public loop contract.

### Decision: Narrow `applyTurnFilter` to local dedupe and Trakt filtering only
**Choice**: Remove the `missingTmdb` and `missingTitle` drop branches from `applyTurnFilter`. The validator rejects those items before filtering, and `applyTurnFilter` keeps only these drop branches: `duplicateCollected`, `duplicateProposed`, `watched`, and `rated`.

**Alternatives considered**:
- Keep the schema checks in `applyTurnFilter` as a redundant safeguard.
- Move watched/rated filtering into the validator as well.

**Rationale**: Schema validation and local collection filtering are different concerns. By narrowing `applyTurnFilter`, the function’s name once again matches its behavior. This also avoids double-counting the same invalid item in both validation and local filtering metrics, while keeping the remaining drop reasons aligned with the actual local-filter responsibilities.

**Tradeoff**: The caller must preserve proposed-title tracking for all parsed items before discarding invalid ones, because invalid-but-titled items still need to be recorded for future dedupe semantics. That bookkeeping moves into `utils/agent.js` at the call site.

### Decision: Extend `TURN_RESULT` with compact violation descriptors
**Choice**: Add `contractRetryUsed`, `violationsBeforeRetry`, and `violationsAfterRetry` to `TURN_RESULT`, where each violation descriptor is a compact object.

**Alternatives considered**:
- Store only a boolean retry flag.
- Log free-form strings instead of structured descriptors.

**Rationale**: The new metadata needs to be machine-readable for later debugging and regression analysis. Structured descriptors make it possible to answer “what failed?” without scraping prose.

**Tradeoff**: The log schema grows slightly, but the fields remain compact and are only emitted once per turn.

### Decision 9: TURN_RESULT backward compatibility — option (ii)
**Choice**: Keep `missingTmdb` and `missingTitle` in `TURN_RESULT.rejectedBreakdown` at `0` for this rollout while `applyTurnFilter` stops incrementing them. This follows option (ii): preserve the old drop-reason keys as deprecated compatibility fields so operators do not lose historical signal.

**Alternatives considered**:
- Remove the keys from `TURN_RESULT.rejectedBreakdown` immediately.
- Move the signal entirely into the validator violation report and drop the logging keys.

**Rationale**: This preserves the operator-facing log shape during the cutover and avoids making the filter/logging migration harder to correlate across deployments. The new validator report still becomes the source of truth for schema failures, but the old counters remain visible at zero until the rollout is complete.

**Tradeoff**: The log payload temporarily carries deprecated zero-valued fields, which is slightly noisy, but that is preferable to silently removing a long-lived diagnostic signal in the same change.

**Descriptor shape**:
```text
{ type: "parse_error", code: string }
{ type: "count_shortfall", expected: number, got: number }
{ type: "missing_field", itemIndex: number, field: "type" | "title" | "year" | "tmdb_id" }
{ type: "extra_field", itemIndex: number, field: string }
{ type: "wrong_type", itemIndex: number, field: string, expectedType: string, actualType: string }
```

### Decision: Share one retry budget for parse errors and schema violations
**Choice**: Parse failures and schema violations both use the same single corrective retry path and the same per-turn retry budget.

**Alternatives considered**:
- Separate retry budgets for parse failures and schema failures.
- Treat parse failures as recoverable but schema violations as terminal.

**Rationale**: The contract boundary is the same in both cases: the model did not produce an acceptable turn response. A shared retry policy keeps the state machine simple and the user-visible behavior consistent.

**Tradeoff**: The corrective message builder must branch on failure type so it can say either “emit only a JSON array” or “fix these specific schema violations.” That branching is acceptable and still centralized.

### Decision: Leave `tool_loop_exhausted` semantics unchanged
**Choice**: The existing inner cap remains authoritative. The new contract retry counts against the same inner-round budget, and if that budget is exhausted the existing `tool_loop_exhausted` behavior still applies.

**Alternatives considered**:
- Introduce a new termination reason for retry exhaustion.
- Reset the inner cap after the corrective retry.

**Rationale**: The change is about response correctness, not about redefining the turn-budget model. Preserving the current exhaustion semantics avoids widening the public contract and keeps rollout risk low.

**Tradeoff**: Retry exhaustion is not called out as a distinct reason, so debugging relies on the new violation metadata plus existing turn logs. That is sufficient for this change.

## Data Flow
1. `addon.js` continues to call `runAgentLoop` with the same dependencies and the same public return expectation.
2. `runAgentLoop` builds the system prompt and first turn message using prompt helpers that now reflect the shared four-field schema.
3. `executeAgentTurn` starts the inner Gemini loop for the current orchestrator turn.
4. Tool-call-only Gemini rounds still dispatch `batch_search_tmdb` and `get_user_favorites` only. They do not complete the turn and do not advance the outer orchestrator turn counter.
5. Once Gemini emits text, `parseTurnResponse` attempts to recover a JSON array. If it fails, the result is classified as a parse violation.
6. If parsing succeeds, `validateAgentItems` checks the parsed items against `AGENT_ITEM_SCHEMA` and the current `gap`. It returns `validItems`, `invalidItems`, and a compact violation list.
7. Before local filtering runs, `utils/agent.js` records proposed titles from the parsed response so title dedupe remains intact even when some items are invalid.
8. `applyTurnFilter` receives only the schema-valid items. It now filters only duplicates against `collected`, duplicates against `proposedTitles`, and Trakt watched/rated overlaps.
9. If a parse error or schema violation occurs and `contractRetryUsed` is still false, `executeAgentTurn` builds the structured corrective message, logs `violationsBeforeRetry`, increments the inner-round budget, and sends the corrective follow-up in the same chat session.
10. The follow-up response is parsed and validated again. Its violations, if any, populate `violationsAfterRetry`. No second corrective retry is allowed.
11. The caller merges accepted items into `collected`, updates turn logs, and either terminates successfully when the gap is filled or advances to the next orchestrator turn with the usual refinement message.
12. `runAgentLoop` still returns `{ success, recommendations, reason }`. No new public termination reason is added.

## File Changes

- `utils/prompts.js` — medium change, medium risk. Update `buildAgentSystemPrompt` and `buildTurnMessage` so their schema wording is derived from the shared schema descriptors. Remove the `reason`/`imdb_id` style guidance and make the “exactly gap new candidates” wording contract-accurate.
- `utils/agent-parse.js` — no functional change expected, low risk. Keep parsing orthogonal unless a tiny helper export is needed for test fixtures or shared parse-error classification.
- `utils/agent-validate.js` — new file, medium change, medium risk. Own `AGENT_ITEM_SCHEMA`, `validateAgentItems`, and the schema-to-prompt formatting helper. Also own compact violation descriptor construction.
- `utils/agent.js` — large change, high risk. Thread the validator into `executeAgentTurn`, add the single corrective retry path, update `TURN_RESULT` logging, narrow `applyTurnFilter`, preserve proposed-title recording for all parsed items, and keep the outer `runAgentLoop` return shape unchanged.
- `AGENTS.md` — small doc change, low risk. Document the stricter contract, the validator module, and the single retry semantics so future edits do not drift the prompt/schema/loop triangle.
- `codemap.md` — small doc change, low risk. Update the agent-loop summary to mention schema validation, the corrective retry, and the new validator module.
- `utils/codemap.md` — small doc change, low risk. Update the `agent.js` and `prompts.js` descriptions to reflect the validator and the narrower filtering role.
- Reviewed but not edited: `utils/agent-tools.js` and `addon.js` — no public shape change is required, and the tool surface stays limited to `batch_search_tmdb` and `get_user_favorites`.

## Interfaces / Contracts
- `AGENT_ITEM_SCHEMA`
  - Source of truth for the agent contract fields.
  - Fields: `type` (string), `title` (string), `year` (number), `tmdb_id` (number).

- `validateAgentItems(items, { gap, schema = AGENT_ITEM_SCHEMA } = {})`
  - Returns `{ valid, validItems, invalidItems, violations }`.
  - `valid` is true only when `invalidItems.length === 0` and `validItems.length === gap`.
  - `validItems` contains only schema-compliant items.
  - `invalidItems` contains rejected original items so the caller can inspect and log them.
  - `violations` is the flattened list used for corrective feedback and `TURN_RESULT` logging.

- `executeAgentTurn(...)`
  - Internal return envelope extends to `{ ..., contractRetryUsed, violationsBeforeRetry, violationsAfterRetry }`.
  - `contractRetryUsed` is false on the initial pass and true once the corrective follow-up has been sent.
  - `violationsBeforeRetry` captures the first failure only.
  - `violationsAfterRetry` captures the second response only and is empty when no retry occurs.

- `runAgentLoop(...)`
  - Public return shape remains unchanged: `{ success, recommendations, reason }`.
  - No caller-side changes are required for `addon.js`.

- `TURN_RESULT`
  - Adds `contractRetryUsed`, `violationsBeforeRetry`, and `violationsAfterRetry`.
  - Existing fields such as `parsedCount`, `acceptedCount`, and `gap` continue to reflect the final post-retry state.

## Testing Strategy
- Syntax checks after each edited JS file: `node -c utils/prompts.js`, `node -c utils/agent-parse.js`, `node -c utils/agent-validate.js`, and `node -c utils/agent.js`.
- Require smoke: load the edited CommonJS modules in a one-off `node -e` invocation to catch import/order mistakes and circular dependency regressions early.
- Grep audits:
  - confirm `buildAgentSystemPrompt` and `buildTurnMessage` no longer advertise `reason` or other disallowed schema fields;
  - confirm `applyTurnFilter` no longer contains the `missingTmdb` / `missingTitle` branches;
  - confirm `TURN_RESULT.rejectedBreakdown` still carries the deprecated `missingTmdb` / `missingTitle` keys at `0` for rollout compatibility;
  - confirm `TURN_RESULT` logs include the new contract fields;
  - confirm `runAgentLoop` still exports the same public shape.
- Manual smokes mirroring the prior turn-semantics scenarios:
  - no-Trakt path should now converge in one turn when Gemini returns valid output, or at worst one additional in-turn corrective retry;
  - Trakt-authenticated path should recover from malformed JSON and from extra-field output via the corrective retry instead of burning outer turns;
  - duplicate-heavy cases should still filter silently without triggering contract retries.
- Verification focus: the retry path must improve the previous smoke failures without changing normal success behavior or the outer loop contract.

## Migration / Rollout
This is a code-only rollout with no data migration and no config migration. The prompt, validator, and orchestrator loop must land together because any partial deployment would create mixed semantics: a stricter prompt without validation still accepts bad output, while a validator without aligned prompts would immediately punish stale model instructions.

Recommended rollout order:
1. Land the new validator and prompt/schema alignment in the same change set.
2. Land the `executeAgentTurn` retry and logging extension alongside it.
3. Update the documentation maps so future maintenance work points at the new module boundaries.

Because `runAgentLoop`’s public return shape is unchanged, the rollout is backward compatible for callers, but the internal semantics are intentionally tighter.

## Open Questions
None. The requirements interview resolved the implementation choices, and this design fixes the validator placement, schema ownership, retry mechanics, and logging shape explicitly.
