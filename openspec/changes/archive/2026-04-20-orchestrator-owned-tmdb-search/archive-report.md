# Archive Report: orchestrator-owned-tmdb-search

- Change: `orchestrator-owned-tmdb-search`
- Date archived: `2026-04-20`
- Persistence mode: `openspec`
- Pipeline type: `full`
- Verification lineage: `openspec/changes/archive/2026-04-20-orchestrator-owned-tmdb-search/verify-report.md`

## Merged Specs
- `agent-contract` → `openspec/specs/agent-contract/spec.md`
- `orchestrator-contract` → `openspec/specs/orchestrator-contract/spec.md`

## Merge Summary
- Promoted three-field agent schema contract (`type`, `title`, `year`) as canonical.
- Promoted favorites-only model tool surface (`get_user_favorites` only).
- Promoted orchestrator-owned TMDB resolution and TMDB-derived identity rules.
- Promoted rejection taxonomy/feedback (`watched`, `rated`, `history`, `duplicate`, `typeMismatch`, `notFound`).
- Promoted telemetry migration (`ORCHESTRATOR_TMDB_RESOLVE_RESULT`, updated `TURN_RESULT`, constrained nudge reasons, stable `LOOP_END` payload).

## Archive Summary
- Change directory moved to:
  `openspec/changes/archive/2026-04-20-orchestrator-owned-tmdb-search/`
- Preserved artifacts:
  - `proposal.md`
  - `design.md`
  - `tasks.md` (final checkbox state kept)
  - `verify-report.md`
  - `specs/agent-contract/spec.md`
  - `specs/orchestrator-contract/spec.md`

## Mode-Based Skips
- `thoth-mem` persistence intentionally skipped by contract (`openspec` mode).
