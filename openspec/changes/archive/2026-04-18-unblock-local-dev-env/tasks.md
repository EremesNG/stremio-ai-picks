# Tasks: Unblock local development on Windows + Node 24

## Execution Rules
- Do not run `pnpm start` or `pnpm start:dev`.
- Do not delete `trakt_tokens.db` if it already exists locally.
- If any task fails, stop and report back via the RETURN ENVELOPE instead of forcing a workaround.

### Phase 1 — Dependency changes (package.json)
- [x] 1.1 Update `package.json`: remove both `sqlite` and `sqlite3`, add `better-sqlite3` at `^12.9.0`, add `cross-env` to `devDependencies`, and change only `start:dev` to `cross-env ENABLE_LOGGING=true node server.js`.
- [x] 1.2 Run:
  `pnpm install`
  Expected:
  - No errors
  - Exit code 0
  - `pnpm-lock.yaml` regenerates/stays stable for the dependency swap

### Phase 2 — Rewrite `database.js` to use better-sqlite3
- [x] 2.1 Remove both the `sqlite` wrapper (`require('sqlite').open(...)`) and the `sqlite3` driver from `database.js`, and replace them with `const Database = require('better-sqlite3')`, keeping the database file at project-root `trakt_tokens.db` and relying on the default file-creation behavior.
- [x] 2.2 Preserve the exported contract (`initDb`, `storeTokens`, `getTokens`) and keep the SQL schema byte-for-byte identical for the `tokens` table and trigger.
- [x] 2.3 Implement the smallest-diff public contract shape for synchronous better-sqlite3 access: prefer removing `async`/Promise wrapping if `server.js` can stay minimal; otherwise keep `Promise.resolve(...)` wrappers only if that avoids wider call-site churn. Use prepared statements (`db.prepare(...)`) for `storeTokens` and `getTokens`.

### Phase 3 — Align call sites in `server.js`
- [x] 3.1 Verify all `initDb` / `storeTokens` / `getTokens` call sites in `server.js` (currently 5: lines 278, 351, 635, 1391, 1591) work with the chosen `database.js` contract, removing redundant `await` only if the synchronous contract was selected.
- [x] 3.2 Run `node -c server.js` to syntax-check the edited file and confirm the call-site changes are valid.

### Phase 4 — Update documentation
- [x] 4.1 Update `AGENTS.md`: remove the obsolete Windows `start:dev` gotcha, replace the stack reference from `sqlite3` to `better-sqlite3`, and update any remaining `sqlite3@5.1.7` mentions.
- [x] 4.2 Search only files named `codemap.md` and update every `sqlite3` reference to `better-sqlite3`, without touching `.env.example` or the README environment section.

### Phase 5 — Verification smoke checks (no full boot)
- [x] 5.1 Run:
  `pnpm install`
  Expected:
  - No errors
  - Exit code 0
  - Lockfile remains deterministic after the edits
- [x] 5.2 Run:
  `node -e "const db=require('better-sqlite3')('trakt_tokens.db'); db.exec('CREATE TABLE IF NOT EXISTS _smoke(x INTEGER)'); db.prepare('INSERT INTO _smoke(x) VALUES(?)').run(1); console.log(db.prepare('SELECT COUNT(*) AS n FROM _smoke').get()); db.exec('DROP TABLE _smoke');"`
  Expected:
  - A line like `{ n: 1 }` printed to stdout
  - No errors or stack traces
  - Exit code 0
- [x] 5.3 Run:
  `node -c database.js`
  Expected:
  - No output
  - Exit code 0
- [x] 5.4 Run:
  `node -c server.js`
  Expected:
  - No output
  - Exit code 0
