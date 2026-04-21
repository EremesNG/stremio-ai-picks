# Verification Report: Enforce Agent Output Contract (Re-run After Fix)

## Completeness
- Pipeline: **full**
- Mode: **openspec**
- Re-run scope: verify prior PARTIAL/NON-COMPLIANT findings after the follow-up `utils/agent.js` + `AGENTS.md` fix.
- Artifacts reviewed: `proposal.md`, `design.md`, `specs/agent-contract/spec.md`, `specs/orchestrator-contract/spec.md`, `tasks.md`, prior `verify-report.md`, `utils/agent.js`, `utils/agent-validate.js`, `utils/prompts.js`, `AGENTS.md`, `codemap.md`, `utils/codemap.md`.
- Manual smokes:
  - **7.1 — DEFERRED**: user-owned manual smoke — documented in `tasks.md` with full reproduction steps.
  - **7.2 — DEFERRED**: user-owned manual smoke — documented in `tasks.md` with full reproduction steps.

## Build and Test Evidence
- Command run: `node -c utils/agent.js && node -c utils/agent-validate.js && node -c utils/prompts.js && node -e "require('./utils/agent'); require('./utils/agent-validate'); require('./utils/prompts'); console.log('syntax-and-require-ok')"`
- Result: **pass** (`syntax-and-require-ok`)

## Compliance Matrix

### Spec: agent-contract
| Requirement | Verdict | Evidence |
|---|---|---|
| Keep schema wording identical across turn prompts | **COMPLIANT** | Shared schema formatter consumed in both prompt helpers: `utils/prompts.js:16-21`, `131-175`; schema source declared once in `utils/agent-validate.js:1-12`. |
| Emit current-turn candidate arrays only | **COMPLIANT** | System/turn prompts require JSON-array-only output and forbid extra prose: `utils/prompts.js:38-43`, `171-177`; validator enforces exact-field contract and types: `utils/agent-validate.js:49-74`. |
| Respect deduplication inputs and current gap | **COMPLIANT** | Gap exactness in prompt + shortfall violation enforcement: `utils/prompts.js:149-174`, `utils/agent-validate.js:84-90`; dedupe against prior proposals/collected in filter path: `utils/agent.js:399-421`, `412-415`. |

### Spec: orchestrator-contract
| Requirement | Verdict | Evidence |
|---|---|---|
| Parse each turn defensively | **COMPLIANT** | Parse failures converted to contract violations: `utils/agent.js:824-834`; fenced/prose extraction in parser: `utils/agent-parse.js:13-19`, `110-121`; tool-only rounds do not close turns: `utils/agent.js:877`, `947-960`. |
| Filter candidates locally before collection | **COMPLIANT** | Schema validation runs before local filter (`evaluateTextResponse` + `validateAgentItems`): `utils/agent.js:824-849`; filter contains only duplicate/watched/rated branches: `utils/agent.js:412-433`; **fixed gap:** proposed-title tracking now records from raw parsed items (`turnResult.parsedRawItems`) and accepts any plain-object item with non-empty `title`: `utils/agent.js:248-263`, `1135`. |
| Validate parsed items against the agent schema before filtering | **COMPLIANT** | Parsed items are validated immediately and split into valid/violations before filter use: `utils/agent.js:837-849`, `937`; validator rejects missing/extra/wrong-type fields: `utils/agent-validate.js:49-74`, `81-99`. |
| Retry once per turn on contract violation | **COMPLIANT** | First violation triggers one corrective retry via same chat session and shared retry budget: `utils/agent.js:883-911`; second response is accepted as-is without second retry: `utils/agent.js:915-933`. |
| Treat duplicate filtering as non-contract behavior | **COMPLIANT** | Retry decision is driven by parse/schema violations, not duplicates: `utils/agent.js:883-885`; duplicate filtering is local in `applyTurnFilter`: `utils/agent.js:402-421`. |
| Record contract retry metadata in turn results | **COMPLIANT** | **fixed blocker:** metadata fields are arrays end-to-end: initialized as arrays `utils/agent.js:859-860`; assigned descriptor arrays on first/retry evaluations `885`, `917`; returned in turn envelope `898-900`, `928-930`, `942-944`; TURN_RESULT emits arrays with `Array.isArray(...)` fallback to `[]`: `utils/agent.js:1166-1172`; doc synced to arrays: `AGENTS.md:73`. |
| Preserve the public runAgentLoop contract | **COMPLIANT** | Public return shape remains unchanged: `utils/agent.js:741-745`, `1217-1221`; exported surface unchanged: `utils/agent.js:1224-1227`. |

## Design Coherence (Decisions 1–9)
| Decision | Verdict | Evidence |
|---|---|---|
| 1) Dedicated validator module | **HONORED** | `utils/agent-validate.js` owns schema/validation/feedback exports and is imported by orchestrator: `utils/agent-validate.js:1-169`, `utils/agent.js:5-9`. |
| 2) Single schema source + prompt-derived wording | **HONORED** | `AGENT_ITEM_SCHEMA` + `formatSchemaForPrompt` feed prompt wording directly: `utils/agent-validate.js:1-12`, `utils/prompts.js:16-21`, `131-175`. |
| 3) Structured corrective feedback template | **HONORED** | Canonical two-section feedback with violation bullets and required output recap: `utils/agent-validate.js:152-161`. |
| 4) Retry in same chat session/inner loop, once per turn | **HONORED** | Corrective retry sent through same `turnChat`; one-retry guard via `contractRetryUsed`: `utils/agent.js:858-885`, `903-911`. |
| 5) Narrow `applyTurnFilter` + preserve title bookkeeping for parsed-invalid items | **HONORED** | `applyTurnFilter` handles only duplicate/watched/rated (`412-433`) and proposed-title tracking is preserved from parsed raw array at call site (`1135`) using plain-object title extraction (`248-263`). |
| 6) TURN_RESULT uses compact violation descriptors | **HONORED** | TURN_RESULT now carries descriptor arrays directly with array guard fallback: `utils/agent.js:1167-1172`. |
| 7) Backward-compatible `missingTmdb`/`missingTitle` keys at 0 | **HONORED** | Deprecated keys retained at zero in `rejectedBreakdown`: `utils/agent.js:1175-1178`. |
| 8) Shared retry budget for parse + schema violations | **HONORED** | Unified `evaluateTextResponse` path drives both parse and schema violations into one retry mechanism: `utils/agent.js:824-849`, `883-911`. |
| 9) `tool_loop_exhausted` semantics unchanged | **HONORED** | Retry consumes inner rounds; exhaustion still yields existing `tool_loop_exhausted` behavior: `utils/agent.js:886-900`, `1190-1193`. |

## Issues Found
- None.

## Verdict
**COMPLIANT**

- Compliance: **10 / 10** requirements compliant.
- Prior findings resolved:
  1. `violationsBeforeRetry` / `violationsAfterRetry` now emitted as descriptor arrays.
  2. Proposed-title tracking now includes schema-invalid parsed items with non-empty `title`.
