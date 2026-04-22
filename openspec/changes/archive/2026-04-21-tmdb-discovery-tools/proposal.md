# Proposal: Add TMDB Discovery Tools to Gemini Agent

## Intent
Enable the Gemini recommendation agent to fetch live TMDB discovery/list data during generation so recommendations are grounded in current catalog signals rather than relying only on model-trained knowledge.

## Scope
### In Scope
- Add two model-visible TMDB tools to the agent tool surface:
  - `discover_content` for `/discover/movie` and `/discover/tv` with consolidated filter parameters.
  - `trending_content` for trending/popular/top-rated movie/TV list retrieval selected via parameters.
- Register both tools unconditionally for all agent requests (no feature toggle).
- Implement strict pagination input guardrails with `page` capped to 5.
- Normalize tool responses into a consistent shape usable by the agent for title proposal.
- Add prompt guidance instructing the agent to prefer varying discover filters over paginating static lists.
- Add telemetry for discovery-tool usage, including tool name, list/discover mode, and pagination/filter behavior.
- Preserve existing orchestrator-owned final TMDB identity resolution (`handleBatchSearchTmdb`) and the 3-field agent output contract `{ type, title, year }`.

### Out of Scope
- Changing the final agent output schema (no `tmdb_id` field in model output).
- Removing or bypassing orchestrator-owned TMDB resolution and post-resolution filtering.
- Introducing user-facing configuration flags for discovery tools.
- Replacing existing favorites tooling or Trakt filtering semantics.
- Broad cache architecture rewrites unrelated to discovery/trending tool calls.

## Approach
1. Extend tool declarations and execution dispatch to include `discover_content` and `trending_content` while keeping `get_user_favorites` behavior intact.
2. Add TMDB endpoint clients for discover and list/trending routes that map tool parameters to TMDB query parameters with validation/sanitization (including `page <= 5`).
3. Normalize TMDB responses from movie/TV/list variants into a unified tool payload for the model (including canonical `type`, `title`, `year`, and supporting metadata).
4. Update agent prompt instructions to bias toward filter diversity (`with_genres`, year/rating/runtime/provider/language combinations) before pagination expansion.
5. Add telemetry events/counters for tool invocation volume, endpoint mode, page usage, and error/rate-limit outcomes.
6. Retain orchestrator post-generation batch resolution as source of truth for accepted `tmdb_id`, even when tool payload contains TMDB IDs.

## Affected Areas
- `utils/agent-tools.js` — new tool declarations, discover/trending executors, normalization, TMDB request plumbing.
- `utils/agent.js` — tool registration, execution path compatibility, prompt policy guidance, telemetry emission points.
- `addon.js` (dependency wiring surface) — verify required TMDB dependencies remain available for new tool execution paths.
- `utils/agent-prompt.js` (or prompt-builder location) — behavioral guidance favoring filter variation over pagination.
- OpenSpec specs likely impacted:
  - `openspec/specs/orchestrator-contract/spec.md` (tool-surface requirements and telemetry expectations)
  - `openspec/specs/agent-contract/spec.md` (agent-visible tool surface constraints)

## Risks
- **Prompt/token overhead**: Additional tool declarations increase context size and may reduce usable output budget.
- **Tool round overuse**: Agent may over-query TMDB instead of synthesizing efficiently from available context.
- **Rate limiting**: Multiple TMDB calls per turn can hit TMDB throughput limits under burst traffic.
- **Normalization drift**: Movie/TV endpoint differences can produce inconsistent fields if not normalized centrally.
- **Identity redundancy**: Discovery results include IDs while orchestrator still resolves IDs, causing duplicated lookup cost.
- **Cache staleness vs freshness**: Aggressive caching can stale trending results; no caching can increase latency/rate pressure.

## Rollback Plan
1. Revert tool declaration/registration changes so only `get_user_favorites` remains model-visible.
2. Disable new discover/trending executors in dispatch and remove associated prompt instructions.
3. Retain existing orchestrator TMDB resolution and filtering flow unchanged.
4. Keep telemetry backward compatibility by tolerating absent discovery metrics after rollback.
5. Validate that request behavior returns to pre-change contract (`favorites` tool only + orchestrator-owned TMDB resolution).

## Success Criteria
1. Agent can call `discover_content` with filter parameters and receive normalized results.
2. Agent can call `trending_content` for trending/popular/top-rated movie/TV sources via parameters.
3. Both tools return a consistent normalized payload shape usable for proposal generation.
4. `page` is supported and hard-capped at 5 for both tools.
5. Agent output contract remains exactly `{ type, title, year }`.
6. Existing orchestrator TMDB batch resolution flow remains active and authoritative.
7. Discovery tools are always registered (no conditional toggle path).
8. Telemetry captures discovery/trending tool usage and operational outcomes.
9. Prompt guidance measurably biases toward filter variation before pagination-heavy behavior.
