# Archive Report: redefine-turn-semantics

## Change
- `redefine-turn-semantics`
- Pipeline type: `full`
- Archive path: `openspec/changes/archive/2026-04-20-redefine-turn-semantics/`

## Merged Specs
- `openspec/specs/agent-contract/spec.md`
- `openspec/specs/orchestrator-contract/spec.md`

## Verification Lineage
- Verified source: `openspec/changes/archive/2026-04-20-redefine-turn-semantics/verify-report.md`
- Verification report was previously persisted at `openspec/changes/redefine-turn-semantics/verify-report.md` before archive relocation.
- Verdict: `COMPLIANT`
- Requirements verified: `7/7`

## Preservation Confirmation
- Proposal preserved: yes
- Design preserved: yes
- Tasks preserved: yes
- Verify report preserved: yes
- Delta specs preserved and merged into canonical specs: yes
- Archive report created: yes

## Out-of-Scope Follow-up
- Trakt-path prompt JSON compliance gap: the Trakt-authenticated smoke still exhibits `empty_turn` / `no_json_array` output-contract failures.
- This is intentionally out of scope for `redefine-turn-semantics` and will be addressed by the future `enforce-agent-output-contract` change.
