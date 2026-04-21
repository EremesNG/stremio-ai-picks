# Tasks: Enforce Agent Output Contract

## Scope Notes
- Phase 1 must land before Phase 4 because the validator and prompt helpers share one schema contract.
- Phase 4 is an atomic cutover; tasks 4.1 through 4.4 must land together so `utils/agent.js` never sits in a half-migrated state.
- Phase 7 tasks are manual/user-owned smoke checks and are intentionally marked skipped for orchestration.
- Blocker 1 uses option A: keep the prompt-verification greps scoped to the `buildAgentOutputContract` + `buildAgentSystemPrompt` section and to `buildTurnMessage` only; `buildSimilarContentPrompt` stays out of scope.

## Phase 1: Schema + prompt unification
- [x] 1.1 Create `utils/agent-validate.js` with the shared `AGENT_ITEM_SCHEMA` source of truth, schema formatting helper, and exported validator surface.
  Verification:
  - Run: `node -c utils/agent-validate.js && node -e "require('./utils/agent-validate'); console.log('ok')"`
  - Expected: syntax check exits 0 and the require smoke prints `ok`.

- [x] 1.2 Rewrite `buildAgentSystemPrompt` in `utils/prompts.js` so the output-contract wording references only `type`, `title`, `year`, and `tmdb_id`, uses `title` rather than `name`, and removes any `reason` or `imdb_id` guidance. Scope the verification to the system-prompt contract block only.
  Verification:
  - Run: `$matches = rg --no-filename -n "name:|imdb_id|reason" utils/prompts.js | rg "^(1[5-9]|2[0-9]|3[0-9]|4[0-2]):"; $allowed = rg --no-filename -n "type|title|year|tmdb_id" utils/prompts.js | rg "^(1[5-9]|2[0-9]|3[0-9]|4[0-2]):"; if (($matches.Count -eq 0) -and ($allowed.Count -gt 0)) { 'ok' } else { exit 1 }`
  - Expected: the `buildAgentOutputContract` + `buildAgentSystemPrompt` block contains no `name`, `imdb_id`, or `reason` guidance, and it does include all four allowed schema fields.

- [x] 1.3 Rewrite `buildTurnMessage` in `utils/prompts.js` to match the same four-field contract wording and remove any `reason` guidance. Scope the verification to the turn-message block only.
  Verification:
  - Run: `$matches = rg --no-filename -n "name:|imdb_id|reason" utils/prompts.js | rg "^(12[7-9]|13[0-9]|14[0-9]|15[0-9]|16[0-9]|17[0-3]):"; $allowed = rg --no-filename -n "type|title|year|tmdb_id" utils/prompts.js | rg "^(12[7-9]|13[0-9]|14[0-9]|15[0-9]|16[0-9]|17[0-3]):"; if (($matches.Count -eq 0) -and ($allowed.Count -gt 0)) { 'ok' } else { exit 1 }`
  - Expected: the `buildTurnMessage` block contains no disallowed schema fields and does include the four allowed fields.

- [x] 1.4 Run syntax and require smoke checks on `utils/prompts.js` after the prompt unification rewrite.
  Verification:
  - Run: `node -c utils/prompts.js && node -e "require('./utils/prompts'); console.log('ok')"`
  - Expected: syntax check exits 0 and the require smoke prints `ok`.

## Phase 2: Validator implementation
- [x] 2.1 Implement `validateAgentItems(items, { gap, schema = AGENT_ITEM_SCHEMA })` in `utils/agent-validate.js` so it returns `{ valid, validItems, invalidItems, violations }` and emits the compact violation descriptors from the design.
  Verification:
  - Run: `node -c utils/agent-validate.js && node -e "const v=require('./utils/agent-validate'); const r=v.validateAgentItems([{type:'movie',title:'X',year:2020,tmdb_id:1}],{gap:1}); if (!r.valid || r.validItems.length!==1 || r.invalidItems.length!==0) process.exit(1); console.log('ok')"`
  - Expected: syntax check exits 0 and the inline smoke prints `ok` for a valid single-item turn.

- [x] 2.2 Verify missing-field rejection in `validateAgentItems` with a case that omits `tmdb_id`.
  Verification:
  - Run: `node -e "const {validateAgentItems}=require('./utils/agent-validate'); const r=validateAgentItems([{type:'movie',title:'X',year:2020}],{gap:1}); if (r.valid || !r.violations.some(v=>v.type==='missing_field'&&v.field==='tmdb_id')) process.exit(1); console.log('ok')"`
  - Expected: the one-liner exits 0 and prints `ok`, proving `missing_field` is reported for `tmdb_id`.

- [x] 2.3 Verify extra-field rejection in `validateAgentItems` with a case that includes `reason`.
  Verification:
  - Run: `node -e "const {validateAgentItems}=require('./utils/agent-validate'); const r=validateAgentItems([{type:'movie',title:'X',year:2020,tmdb_id:1,reason:'x'}],{gap:1}); if (r.valid || !r.violations.some(v=>v.type==='extra_field'&&v.field==='reason')) process.exit(1); console.log('ok')"`
  - Expected: the one-liner exits 0 and prints `ok`, proving `extra_field` is reported for `reason`.

- [x] 2.4 Verify wrong-type rejection in `validateAgentItems` with a case that sets `year` to a string.
  Verification:
  - Run: `node -e "const {validateAgentItems}=require('./utils/agent-validate'); const r=validateAgentItems([{type:'movie',title:'X',year:'2020',tmdb_id:1}],{gap:1}); if (r.valid || !r.violations.some(v=>v.type==='wrong_type'&&v.field==='year')) process.exit(1); console.log('ok')"`
  - Expected: the one-liner exits 0 and prints `ok`, proving `wrong_type` is reported for `year`.

- [x] 2.5 Verify count-shortfall detection in `validateAgentItems` with a gap larger than the returned valid set.
  Verification:
  - Run: `node -e "const {validateAgentItems}=require('./utils/agent-validate'); const r=validateAgentItems([{type:'movie',title:'X',year:2020,tmdb_id:1}],{gap:2}); if (r.valid || !r.violations.some(v=>v.type==='count_shortfall')) process.exit(1); console.log('ok')"`
  - Expected: the one-liner exits 0 and prints `ok`, proving the validator flags shortfalls when valid items do not fill the current gap.

## Phase 3: Corrective feedback builder
- [x] 3.1 Implement `buildCorrectiveFeedback({ violations, gap, schema })` in `utils/agent-validate.js` using the canonical multi-section template from the design.
  Verification:
  - Run: `node -c utils/agent-validate.js && node -e "const v=require('./utils/agent-validate'); console.log(v.buildCorrectiveFeedback({violations:[{type:'count_shortfall',expected:2,got:1},{type:'missing_field',itemIndex:0,field:'tmdb_id'}],gap:2,schema:v.AGENT_ITEM_SCHEMA}))"`
  - Expected: syntax check exits 0 and the printed feedback contains `## Violations detected` and `## Required output`.

## Phase 4: Loop integration (atomic cutover)
- [x] 4.1 Thread `validateAgentItems` into `executeAgentTurn` immediately after `parseTurnResponse`, and on parse/schema violation send one corrective retry through the same chat session before re-parsing and re-validating the follow-up response.
  Verification:
  - Run: `rg -n "parseTurnResponse|validateAgentItems|buildCorrectiveFeedback|contractRetryUsed" utils/agent.js`
  - Expected: `executeAgentTurn` shows the validator import/call, the corrective feedback path, and the single-retry guard in the same turn loop.

- [x] 4.2 Narrow `applyTurnFilter` so it only handles `duplicateCollected`, `duplicateProposed`, `watched`, and `rated`, and remove the `missingTmdb` and `missingTitle` branches. Keep the `TURN_RESULT.rejectedBreakdown` keys backward-compatible at `0` for this rollout.
  Verification:
  - Run: `$matches = rg --no-filename -n "droppedMissingTmdbCount|droppedMissingTitleCount" utils/agent.js | rg "^(349|35[0-9]|36[0-9]|37[0-9]|38[0-9]|39[0-9]|4[0-5][0-9]):"; if ($matches.Count -eq 0) { 'ok' } else { exit 1 }`
  - Expected: no matches remain inside the `applyTurnFilter` block after the cutover, confirming schema enforcement moved out of the filter while the logging payload stays backward-compatible.

- [x] 4.3 Extend `TURN_RESULT` logging with `contractRetryUsed`, `violationsBeforeRetry`, and `violationsAfterRetry`.
  Verification:
  - Run: `rg -n "contractRetryUsed|violationsBeforeRetry|violationsAfterRetry" utils/agent.js`
  - Expected: all three fields are present in the `TURN_RESULT` payload definition.

- [x] 4.4 Extend `executeAgentTurn`'s return envelope with the same three contract-retry fields so the internal turn result stays aligned with the logging payload.
  Verification:
  - Run: `rg -n "contractRetryUsed|violationsBeforeRetry|violationsAfterRetry" utils/agent.js`
  - Expected: the function return literal includes the three fields and exposes them without changing the public `runAgentLoop` contract.

## Phase 5: Syntax + require-chain verification
- [x] 5.1 Verify `utils/agent-validate.js` syntax and require safety.
  Verification:
  - Run: `node -c utils/agent-validate.js && node -e "require('./utils/agent-validate'); console.log('ok')"`
  - Expected: exit code 0 and `ok` printed.

- [x] 5.2 Verify `utils/prompts.js` syntax and require safety.
  Verification:
  - Run: `node -c utils/prompts.js && node -e "require('./utils/prompts'); console.log('ok')"`
  - Expected: exit code 0 and `ok` printed.

- [x] 5.3 Verify `utils/agent.js` syntax after the retry-path integration.
  Verification:
  - Run: `node -c utils/agent.js`
  - Expected: exit code 0.

- [x] 5.4 Verify `utils/agent.js` remains require-safe after the new validator and feedback imports.
  Verification:
  - Run: `node -e "require('./utils/agent'); console.log('ok')"`
  - Expected: the module loads successfully and prints `ok`.

## Phase 6: Documentation sync
- [x] 6.1 Update `AGENTS.md` to document the four-field schema, the validator module, the one-retry turn behavior, and the new logging fields.
  Verification:
  - Run: `rg -n "type, title, year, tmdb_id|contractRetryUsed|violationsBeforeRetry|violationsAfterRetry|utils/agent-validate.js" AGENTS.md`
  - Expected: the doc audit finds the new contract language and the validator module reference.

- [x] 6.2 Update `codemap.md` so the repository atlas reflects the new validator module, shared schema, and retry semantics.
  Verification:
  - Run: `rg -n "agent-validate|validateAgentItems|contractRetryUsed|single corrective retry|schema" codemap.md`
  - Expected: the atlas mentions the validator module and the tightened agent-loop contract.

- [x] 6.3 Update `utils/codemap.md` so the utils atlas reflects schema validation, corrective feedback, and the narrower filter role.
  Verification:
  - Run: `rg -n "agent-validate|validateAgentItems|corrective retry|applyTurnFilter|missingTmdb|missingTitle" utils/codemap.md`
  - Expected: the utils atlas mentions the validator module and the updated `agent.js` responsibilities.

## Phase 7: Manual smokes
- [-] 7.1 Run the no-Trakt smoke manually. This is user-owned and must not be executed automatically by the orchestrator.
  Skipped by orchestrator: MANUAL task requiring running the dev server, a pasted encrypted config from an installed addon, and a user-initiated HTTP request from a second pwsh terminal.
    Preconditions:
    - The smoke config requests `numResults=20`.
    - The active config has no `TraktAccessToken` and therefore exercises the no-Trakt path.
    Setup:
    1. Stop any running server.
    2. Ensure the logs directory exists for a clean-state run:
       Run: New-Item logs -ItemType Directory -Force | Out-Null
       Expected: `logs/` exists before any attempt to rotate or recreate `logs/agent.log`.
    3. Rotate logs so the smoke is isolated:
       Run: Move-Item logs/agent.log logs/agent.log.bak -Force -ErrorAction SilentlyContinue
       Expected: any prior log is archived out of the way.
       Run: New-Item logs/agent.log -ItemType File -Force | Out-Null
       Expected: a fresh empty `logs/agent.log` exists for this smoke.
    4. Ensure Trakt is NOT connected in the config used for the request (fresh config with no Trakt auth).
       Expected: Filter Watched is off and no Trakt identity is available.
    Trigger:
    5. Set the logging environment variable in the terminal where the server will run.
       Run: $env:ENABLE_LOGGING="true"
       Expected: the environment variable is set in the current pwsh session and will be inherited by `pnpm start`.
    6. Start the dev server in the same terminal.
       Run: pnpm start
       Expected: the server stays running and the smoke continues from another terminal.
    7. After the server prints the listening port, read it and set it in the second terminal:
       Run: $port = 3000   # replace with the actual port printed by the server if different
       Expected: `$port` holds the port on which the server is listening.
    8. Capture the encrypted config string from the addon install URL you already used, and paste it into `$config`.
       Run: `$config = "<paste your encrypted config here>"`
       Expected: `$config` contains the opaque AES-256-CBC config segment from the installed addon URL.
    9. Define the smoke query exactly once.
       Run: `$query = "recommend modern sci-fi movies released after 2010 with an IMDB rating over 7.0 like Blade Runner 2049 and Arrival"`
       Expected: the recommendation query is stored in `$query`.
    10. Load the URL-encoding helper.
        Run: `Add-Type -AssemblyName System.Web`
        Expected: `System.Web.HttpUtility` is available in this PowerShell session.
    11. Encode the query for the catalog URL.
        Run: `$encoded = [System.Web.HttpUtility]::UrlEncode($query)`
        Expected: `$encoded` holds a URL-safe version of the query.
    12. Build the exact `aipicks.top` search-catalog URL for the config and query.
        Run: `$url = "http://127.0.0.1:$port/$config/catalog/movie/aipicks.top/search=$encoded.json"`
        Expected: `$url` targets the `aipicks.top` movie search catalog for the encrypted config.
    13. Invoke the request once to trigger exactly one recommendation cycle.
        Run: `Invoke-WebRequest -Uri $url -UseBasicParsing | Out-Null`
        Expected: one recommendation cycle is executed for the smoke and writes one new `LOOP_END` line.
    Verify:
    Because the log was rotated in Setup and only one HTTP request was made in Trigger, the sole `LOOP_END` line necessarily corresponds to this smoke run.
    14. Run: `rg -n '"LOOP_END"' logs/agent.log | Select-Object -Last 1`
        Expected: at least one LOOP_END line exists, and it is the only LOOP_END in the file because the log was rotated.
    15. Run: `rg -n '"terminationReason":"success"' logs/agent.log`
        Expected: exactly one success termination line exists for the smoke run.
    16. Run: `rg -n '"collectedCount":20' logs/agent.log`
        Expected: exactly one collected-count line confirms the full 20-item no-Trakt result.
    17. Run: `rg -n '"contractRetryUsed":' logs/agent.log`
        Expected: at least one match exists, confirming the retry metadata field landed in TURN_RESULT logs.

- [-] 7.2 Run the Trakt-authenticated smoke manually. This is user-owned and must not be executed automatically by the orchestrator.
  Skipped by orchestrator: MANUAL task requiring running the dev server, a Trakt-authenticated encrypted config with `filterWatched=true`, and a user-initiated HTTP request from a second pwsh terminal.
    Preconditions:
    - The smoke config requests `numResults=20`.
    - The active config is authenticated with Trakt and has `filterWatched=true`.
    Setup:
    1. Stop any running server.
    2. Ensure the logs directory exists for a clean-state run:
       Run: New-Item logs -ItemType Directory -Force | Out-Null
       Expected: `logs/` exists before any attempt to rotate or recreate `logs/agent.log`.
    3. Rotate logs so the smoke is isolated:
       Run: Move-Item logs/agent.log logs/agent.log.bak -Force -ErrorAction SilentlyContinue
       Expected: any prior log is archived out of the way.
       Run: New-Item logs/agent.log -ItemType File -Force | Out-Null
       Expected: a fresh empty `logs/agent.log` exists for this smoke.
    4. Ensure Trakt IS connected with a fresh config that has `filterWatched=true`.
       Expected: the active config is authenticated with Trakt and Filter Watched is on.
    Trigger:
    5. Set the logging environment variable in the terminal where the server will run.
       Run: $env:ENABLE_LOGGING="true"
       Expected: the environment variable is set in the current pwsh session and will be inherited by `pnpm start`.
    6. Start the dev server in the same terminal.
       Run: pnpm start
       Expected: the server stays running and the smoke continues from another terminal.
    7. After the server prints the listening port, read it and set it in the second terminal:
       Run: $port = 3000   # replace with the actual port printed by the server if different
       Expected: `$port` holds the port on which the server is listening.
    8. Capture the encrypted config string from the addon install URL you already used, and paste it into `$config`.
       Run: `$config = "<paste your encrypted config here>"`
       Expected: `$config` contains the opaque AES-256-CBC config segment from the installed addon URL for the Trakt-connected configuration.
    9. Define the smoke query exactly once.
       Run: `$query = "recommend modern sci-fi movies released after 2010 with an IMDB rating over 7.0 like Blade Runner 2049 and Arrival"`
       Expected: the recommendation query is stored in `$query`.
    10. Load the URL-encoding helper.
        Run: `Add-Type -AssemblyName System.Web`
        Expected: `System.Web.HttpUtility` is available in this PowerShell session.
    11. Encode the query for the catalog URL.
        Run: `$encoded = [System.Web.HttpUtility]::UrlEncode($query)`
        Expected: `$encoded` holds a URL-safe version of the query.
    12. Build the exact `aipicks.top` search-catalog URL for the config and query.
        Run: `$url = "http://127.0.0.1:$port/$config/catalog/movie/aipicks.top/search=$encoded.json"`
        Expected: `$url` targets the `aipicks.top` movie search catalog for the encrypted Trakt-connected config.
    13. Invoke the request once to trigger exactly one recommendation cycle.
        Run: `Invoke-WebRequest -Uri $url -UseBasicParsing | Out-Null`
        Expected: one recommendation cycle is executed for the smoke and writes one new `LOOP_END` line.
    Verify:
    Because the log was rotated in Setup and only one HTTP request was made in Trigger, the sole `LOOP_END` line necessarily corresponds to this smoke run.
    14. Run: `rg -n '"LOOP_END"' logs/agent.log | Select-Object -Last 1`
        Expected: at least one LOOP_END line exists, and it is the only LOOP_END in the file because the log was rotated.
    15. Run: `rg -n '"terminationReason":"success"' logs/agent.log`
        Expected: exactly one success termination line exists for the smoke run.
    16. Run: `rg -n '"collectedCount":20' logs/agent.log`
        Expected: exactly one collected-count line confirms the full 20-item result.
    17. Run: `rg -n '"contractRetryUsed":' logs/agent.log`
        Expected: the new retry field appears in the log at least once.
