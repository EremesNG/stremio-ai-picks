# Proposal: Orchestrator-Owned TMDB Search

## Intent
Eliminate recommendation integrity failures caused by Gemini owning TMDB resolution timing. Recent logs show three systemic pathologies that are not prevented by current safeguards: (1) hallucinated `tmdb_id` values not present in tool results, including repeated wrong IDs for “Oxygen” (`logs/with-trakt/agent.log:1271-1275` vs TMDB tool match `18561` in `logs/with-trakt/agent.log:1031-1038`), (2) turns that skip TMDB calls and emit direct memory-based items (`logs/with-trakt/agent.log:1650-1661`, `1709-1714`; `logs/with-trakt2/agent.log:1569-1580`), and (3) high-duplication tool batches (e.g., multiple `Upgrade` entries in one 20-slot batch, `logs/with-trakt/agent.log:807-893`).

Current loop-recovery protections are tool-loop scoped and do not defend text-only hallucination turns: repeated-batch/cap logic only executes when function calls exist (`utils/agent.js:1147-1171`, `1262-1280`), and nudge reasons `repeated_batch`/`cap_reached` are bound to that path (`utils/agent.js:962-979`, `1042-1056`).

## Scope
### In Scope
- Move TMDB verification ownership from Gemini tool-calling to orchestrator flow inside `runAgentLoop` (`utils/agent.js:680-1435`).
- Remove `batch_search_tmdb` from Gemini-declared tools while keeping `get_user_favorites` available (`utils/agent-tools.js:4-51`).
- Change agent output contract from `{ type, title, year, tmdb_id }` to `{ type, title, year }` by updating schema source of truth (`utils/agent-validate.js:1-6`) and prompt rendering (`utils/prompts.js:15-21`, `169-175`).
- Add orchestrator-side TMDB resolution step by directly invoking existing pure handler `handleBatchSearchTmdb` (`utils/agent-tools.js:268-315`) after parse/validation.
- Add orchestrator rejection category `typeMismatch` when proposed type conflicts with resolved TMDB media type before collection/filtering.
- Enrich between-turn feedback with accepted items, rejected items by reason (`watched`, `rated`, `history`, `duplicate`, `typeMismatch`, `notFound`), and remaining gap.
- Remove obsolete TMDB tool-round mechanics and telemetry tied to Gemini-owned TMDB loops: `TOOL_LOOP_DETECTED`, nudge reasons `repeated_batch` and `cap_reached`, and `DEFAULT_MAX_TOOL_ROUNDS_PER_TURN` for TMDB loop safety (`utils/agent.js:18`, `1147-1171`, `1262-1280`).
- Preserve favorites tool behavior: function-call rounds remain valid for `get_user_favorites` and can still occur before final text emission.

### Out of Scope
- Prompt-quality tuning for semantic constraints such as “released after 2010”.
- Refactor of `get_user_favorites` retrieval logic beyond compatibility updates.
- Chat session topology changes (already single chat per request via `ai.chats.create`, `utils/agent.js:854-860`).

## Approach
1. Keep the one-chat orchestrator model (`utils/agent.js:854-860`) and per-turn parse/contract retry behavior (`utils/agent.js:895-1039`), but require Gemini to emit candidates without `tmdb_id`.
2. After parsing and schema validation, orchestrator deduplicates candidate proposals against turn and cross-turn state (`proposedTitles` flow remains in orchestrator, `utils/agent.js:304-320`, `1344-1349`).
3. Orchestrator resolves surviving candidates through direct `handleBatchSearchTmdb` calls (existing deterministic dependency surface: `searchTMDB` via runtime deps).
4. Orchestrator materializes final candidate IDs from TMDB results only, rejects unresolved items as `notFound`, and rejects type disagreements as `typeMismatch` before Trakt identity filtering (`applyTurnFilter`, `utils/agent.js:409-523`).
5. Orchestrator sends structured refinement feedback between turns summarizing accepted/rejected outcomes and remaining gap.
6. Keep empty-response corrective behavior only for genuinely empty text responses in the remaining favorites-call path; drop TMDB tool-loop-specific recovery branches.

## Affected Areas
- `utils/agent.js` — turn execution flow, TMDB post-parse resolution step, rejection taxonomy/logging, removal of TMDB tool-loop mechanics.
- `utils/agent-tools.js` — tool declaration surface (remove `batch_search_tmdb` declaration), export/retain `handleBatchSearchTmdb`, keep `get_user_favorites` execution path.
- `utils/agent-validate.js` — schema update to `{ type, title, year }`, corrective feedback schema rendering updates.
- `utils/prompts.js` — system/turn contract text updated to no `tmdb_id` emission and to align with orchestrator-owned resolution feedback loop.
- `addon.js` — dependency wiring validation for direct TMDB resolution path and unchanged `searchTMDB` use in non-agent flows (`addon.js:975`, `2068`, `3629`, `4304`).
- `AGENTS.md` — agent loop documentation and contract expectations.
- OpenSpec baseline alignment note: existing specs currently require agent-emitted `tmdb_id` and mandatory `batch_search_tmdb` tool usage (`openspec/specs/agent-contract/spec.md:6-7`, `16-17`, `37-39`); proposal intentionally supersedes this behavior.

## Risks
- Higher rejection rates if Gemini proposes blind candidates and feedback quality is insufficient, increasing turn consumption.
- Remaining empty-response edge cases may persist even without TMDB tool rounds; `emptyResponseNudgeUsed` scope must be narrowed rather than blindly removed.
- Mixed favorites-call + text behavior in one turn remains possible and must keep deterministic handling order.

## Rollback Plan
- Revert to current Gemini-owned TMDB tool flow by restoring `batch_search_tmdb` in `toolDeclarations` and previous turn-loop mechanics in `utils/agent.js`.
- Restore previous schema contract (`tmdb_id` required) in `utils/agent-validate.js` and prompt contract wording in `utils/prompts.js`.
- Roll back logging taxonomy changes to prior `TURN_RESULT` and nudge/tool-loop events.

## Success Criteria
- Gemini output contract excludes `tmdb_id`; any emitted `tmdb_id` is rejected as extra field by validator.
- No runtime `TOOL_LOOP_DETECTED` and no `NUDGE_DISPATCHED` with `repeated_batch` or `cap_reached` because those code paths are removed.
- Text-only turn responses without function calls are treated as normal turn completions, not anomalous empty-tool states.
- `TURN_RESULT.rejectedBreakdown` includes `typeMismatch` when proposal type conflicts with resolved TMDB type.
- In with-Trakt runs, every final recommendation `tmdb_id` is traceable to a TMDB resolution executed within the same request session.
- Orchestrator emits `ORCHESTRATOR_TMDB_RESOLVE_RESULT` per TMDB batch so traceability does not depend on removed `TOOL_EXEC_RESULT` TMDB tool logs.
