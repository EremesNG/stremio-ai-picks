# Tasks: Redefine Turn Semantics

Scope note: Phase 2 is the atomic cutover; all turn-accounting, safety-cap, log, and termination changes in `utils/agent.js` must land together so no mixed semantics ship.

## Phase 1: Prep and audit
- [x] 1.1 Audit `utils/prompts.js` `buildTurnMessage` for any turn-number narration that would break under orchestrator-turn semantics, and record whether the helper can stay unchanged.
  Audit result (1.1): UNCHANGED. `buildTurnMessage` at `utils/prompts.js:127-173` only describes gap/context state (remaining gap, collected titles, already proposed titles); no numbered turn narration.
  Verification:
  Run: `rg -n "buildTurnMessage|Turn [0-9]|turn" utils/prompts.js`
  Expected: only gap/context wording is present; no functional change is needed, or the exact turn-number mismatch is documented in the audit note.
- [x] 1.2 Read-only audit: inspect `addon.js` termination handling around `max_turns_exceeded` and the `LOOP_END` path and record whether `tool_loop_exhausted` will fall through safely or needs a distinct branch. Do NOT change any code here; document the finding as an inline note for task 3.1 to act on.
  Audit result (1.2): FALL-THROUGH SAFE. `addon.js:3797-3846` only special-cases `agent_stuck` and `max_turns_exceeded` for partial-success at lines 3798-3803; every other reason (including a new `tool_loop_exhausted`) flows through the generic non-success fallback at lines 3812-3846, same as any other failure reason. No distinct branch required; task 3.1 will confirm and document this intentional fall-through.
  Verification:
  Run: `rg -n "max_turns_exceeded|tool_loop_exhausted|LOOP_END|recommendationCount|cache" addon.js`
  Expected: the observed branch behavior is recorded (fall-through safe or needs new branch); no source changes are made in this task.

## Phase 2: Atomic cutover in `utils/agent.js`
- [x] 2.1 Introduce internal `executeAgentTurn(ctx)` in `utils/agent.js` and move the inner tool-round loop plus parsing into it, returning `{ rawText, parseResult, parsedItems, toolRoundsUsed, endedByText, toolLoopExhausted }`.
  Verification:
  Run: `node -c utils/agent.js`
  Expected: syntax passes and the new helper is wired into the agent module with the structured result shape.
- [x] 2.2 Restructure `runAgentLoop` into an outer orchestrator-turn loop that calls `executeAgentTurn`, and ensure the turn counter advances only when `turnResult.endedByText` or `turnResult.toolLoopExhausted` closes the helper.
  Verification:
  Run: `rg -n "turn \+ 1|turn\+\+|executeAgentTurn|TURN_START|TURN_RESULT|LOOP_START|LOOP_END" utils/agent.js`
  Expected: turn increments appear only at orchestrator boundaries, not inside tool-call branches.
- [x] 2.3 Add internal `maxToolRoundsPerTurn` safety capping with default `8`, and make final-turn exhaustion terminate with `turnResult.toolLoopExhausted` / `tool_loop_exhausted` while earlier cap hits continue to the next turn.
  Verification:
  Run: `rg -n "maxToolRoundsPerTurn|DEFAULT_MAX_TOOL_ROUNDS_PER_TURN|tool_loop_exhausted" utils/agent.js`
  Expected: the cap is internal, defaults to 8, and the final-turn exhaustion path maps to `tool_loop_exhausted`.
- [x] 2.4 Split logging so `TURN_START`, `TURN_RESULT`, `LOOP_START`, and `LOOP_END` use orchestrator turn numbers, while `RESPONSE_RECEIVED`, `AGENT_RAW_RESPONSE`, `TOOL_CALL_REQUEST`, and `TOOL_CALL_RESPONSE` carry `toolRound` for internal rounds and `TURN_RESULT` is derived from `turnResult.parsedItems`.
  Verification:
  Run: `rg -n "TURN_START|TURN_RESULT|LOOP_START|LOOP_END|RESPONSE_RECEIVED|AGENT_RAW_RESPONSE|TOOL_CALL_REQUEST|TOOL_CALL_RESPONSE|toolRound" utils/agent.js`
  Expected: turn-level events reference the orchestrator turn counter and internal events expose `toolRound`.
- [x] 2.5 Add `tool_loop_exhausted` to the termination reason handling in `utils/agent.js` so the switch or equivalent returns a consistent public reason when `turnResult.toolLoopExhausted` is true.
  Verification:
  Run: `rg -n "tool_loop_exhausted|max_turns_exceeded|api_error_partial|all_tools_failed|function_calling_unsupported" utils/agent.js`
  Expected: the new reason is accepted in the termination path and is not treated as an unknown case.

## Phase 3: Caller and config audit
- [x] 3.1 Re-read the `addon.js` termination branch around line 3803 and decide whether `tool_loop_exhausted` needs distinct handling or an intentional fall-through, then document the choice.
  Decision: FALL-THROUGH CONFIRMED, NO CHANGE. `utils/agent.js:1083-1085` returns `tool_loop_exhausted` via `finalizeResult(collected.length > 0, ...)`, so partial-success is already surfaced as `success: true` and the generic success path at `addon.js:3798-3813` accepts it. No downstream edit needed.
  Verification:
  Run: `rg -n "max_turns_exceeded|tool_loop_exhausted|LOOP_END|recommendationCount|cache" addon.js`
  Expected: the branch behavior is explicitly justified, including any no-op fall-through.
- [x] 3.2 Re-audit the `MaxTurns` clamp and nearby comments in `addon.js` around lines 3223-3226 to confirm the default `6` and range `4-12` still read correctly under orchestrator-turn semantics.
  Verdict: ACCURATE, NO CHANGE. Clamp at `addon.js:3223-3226` enforces 4..12 default 6; no Gemini-round-trip wording anywhere in the file. Safe under orchestrator-turn semantics.
  Verification:
  Run: `rg -n "MaxTurns|4-12|default 6|clamp|turn" addon.js`
  Expected: the config text still matches the design, or the exact comment drift is documented for follow-up.

## Phase 4: Documentation sync
- [x] 4.1 Rewrite the AI agent loop notes in `AGENTS.md:58-67` so they define an orchestrator turn as a full cycle, distinguish internal tool rounds, mention the internal safety cap, and remove or replace any stale `search_tmdb` / `check_if_watched` references so the tool list matches the current surface (`batch_search_tmdb` + `get_user_favorites`).
  Section rewritten at `AGENTS.md:58-69`. Word-boundary audit `rg -n "\b(search_tmdb|check_if_watched)\b" AGENTS.md` returns no matches (the unbounded regex's match on `batch_search_tmdb` is a substring false positive — the approved tool name is preserved).
   Verification:
   Run: rg -n "search_tmdb|check_if_watched" AGENTS.md
   Expected: no matches; the maintainer doc no longer names removed tool references.
   Run: rg -n "turn-based function-calling loop|maxTurns|tool rounds|safety cap|batch_search_tmdb|get_user_favorites|turn" AGENTS.md
   Expected: the updated section explains orchestrator-attempt semantics and the current tool surface without reintroducing round-trip-based counting.
- [x] 4.2 Update the turn-semantics references in `codemap.md:74-79` and `utils/codemap.md:9-43` so both maps describe orchestrator turns, internal tool rounds, the unchanged `MaxTurns` range, and remove or replace any stale `search_tmdb` / `check_if_watched` references with the current tool surface (`batch_search_tmdb` + `get_user_favorites`).
  Both codemaps updated (root and utils). Word-boundary audit clean; only the substring false-positive on `batch_search_tmdb` remains, as expected.
   Verification:
   Run: rg -n "search_tmdb|check_if_watched" codemap.md
   Expected: no matches; the repository atlas no longer lists removed tool names.
   Run: rg -n "search_tmdb|check_if_watched" utils/codemap.md
   Expected: no matches; the utils atlas no longer lists removed tool names.
   Run: rg -n "turn-based|MaxTurns|toolRound|tool rounds|orchestrator|batch_search_tmdb|get_user_favorites" codemap.md utils/codemap.md
   Expected: both atlas files describe the outer/inner loop model consistently and only mention the current tool surface.
- [x] 4.3 Update the user-facing `MaxTurns` copy in `public/configure.html` so the control explains that one turn is one full orchestrator attempt and tool calls inside the turn are automatic.
  Label at line 578 renamed to "AI Attempts"; help text added at line 580 explaining orchestrator-attempt semantics and automatic tool calls. Control `id/name/min/max/value/step` preserved (default 6, range 4..12); JS hooks untouched.
   Verification:
   Run: `rg -n "AI Max Turns|orchestrator attempt|tool calls|automatic|MaxTurns" public/configure.html`
   Expected: the label/help text explains the new semantics without changing the control, default, or range.

 ## Phase 5: Verification
 - [x] 5.1 Run syntax checks on the edited JavaScript files, with `utils/agent.js` as the minimum required target.
  `node -c utils/agent.js` → exit 0, no output.
  Verification:
  Run: `node -c utils/agent.js`
  Expected: exit 0, no syntax errors.
- [x] 5.2 Run the require-chain smoke for `utils/agent.js` so the module loads cleanly after the refactor.
  `node -e "require('./utils/agent'); console.log('ok')"` → printed `ok`.
  Verification:
  Run: `node -e "require('./utils/agent'); console.log('ok')"`
  Expected: prints `ok` and exits 0.
- [x] 5.3 Run grep audits for turn accounting, internal tool-round logging, and the new termination reason in `utils/agent.js`.
  Audit clean: no `turn + 1` / `turn++` matches. `TURN_START` at 990, `TURN_RESULT` at 1057, `LOOP_START` at 655, `LOOP_END` at 715/729 (outer-loop only). `toolRound` appears only in internal events (580/589/600 in logger infra, and inside `executeAgentTurn` 834/880/899/903/911/939/949). `toolRoundsUsed += 1` at 961 is inside the inner loop and does not advance the turn counter. `tool_loop_exhausted` used at 1085 in the final-turn termination path.
  Verification:
  Run: `rg -n "turn \+ 1|turn\+\+|TURN_START|TURN_RESULT|LOOP_START|LOOP_END|toolRound|tool_loop_exhausted" utils/agent.js`
  Expected: no turn increments appear inside tool-call-only branches; all four turn-level events are present; internal events expose `toolRound`; `tool_loop_exhausted` appears in termination logic.
 - [-] 5.4 Manual smoke — no-Trakt path, verifies `totalTurns: 1`.
  Skipped by orchestrator: MANUAL task requiring running dev server (`pnpm start`), a pasted encrypted config from an installed addon, and user-initiated HTTP request from a second pwsh terminal. Orchestrator cannot execute this end to end. User must run it following the steps in the task body; automated verification (5.1, 5.2, 5.3) all passed.
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
        Expected: the environment variable is set in the current pwsh session and will be inherited by pnpm start.
     6. Start the dev server in the same terminal.
        Run: pnpm start
        Expected: the server stays running and the smoke continues from another terminal.
     7. After vercel dev starts, it prints a line like "Ready! Available at http://localhost:PORT". Read that port and set it in the second terminal:
        Run: $port = 3000   # replace with the actual port vercel dev printed if different
        Expected: `$port` holds the port on which the dev server is listening.
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
     14. Run: rg -n '"LOOP_END"' logs/agent.log | Select-Object -Last 1
         Expected: at least one LOOP_END line exists, and it is the only LOOP_END in the file because the log was rotated.
     15. Run: rg -n '"totalTurns": 1' logs/agent.log
         Expected: at least one match exists, and it is in the same LOOP_END line from step 14.
   - [-] 5.5 Manual smoke — Trakt-authenticated path, verifies `totalTurns: 1`.
  Skipped by orchestrator: MANUAL task requiring running dev server, Trakt-authenticated encrypted config with `filterWatched=true`, and user-initiated HTTP request. Orchestrator cannot execute this. User must run it following the steps in the task body.
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
        Expected: the environment variable is set in the current pwsh session and will be inherited by pnpm start.
     6. Start the dev server in the same terminal.
        Run: pnpm start
        Expected: the server stays running and the smoke continues from another terminal.
     7. After vercel dev starts, it prints a line like "Ready! Available at http://localhost:PORT". Read that port and set it in the second terminal:
        Run: $port = 3000   # replace with the actual port vercel dev printed if different
        Expected: `$port` holds the port on which the dev server is listening.
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
     14. Run: rg -n '"LOOP_END"' logs/agent.log | Select-Object -Last 1
         Expected: at least one LOOP_END line exists, and it is the only LOOP_END in the file because the log was rotated.
     15. Run: rg -n '"totalTurns": 1' logs/agent.log
         Expected: at least one match exists, and it is in the same LOOP_END line from step 14.
