# Proposal: Unblock local development on Windows + Node 24

## Why
Local development is blocked by two concrete issues discovered while running `pnpm start` / `pnpm start:dev` on Windows + Node 24.

1. `start:dev` uses POSIX inline env syntax (`ENABLE_LOGGING=true node server.js`), which fails on Windows cmd/PowerShell with `ENABLE_LOGGING no se reconoce como un comando`. The fix is to use `cross-env` so the script is portable across Windows, macOS, and Linux.
2. `sqlite3@5.1.7` cannot load on Node 24 (`Could not locate the bindings file` for `node-v137-win32-x64\node_sqlite3.node`). The project’s SQLite usage is small and centralized, and the user has already chosen `better-sqlite3@12.9.0` as the replacement because it ships a Node 24 Win x64 prebuild and is actively maintained.

## Scope
### What changes
1. Add `cross-env` as a dev dependency and update the `start:dev` script in `package.json` so it works without shell-specific syntax.
2. Replace `sqlite3` with `better-sqlite3@^12.9.0` in `package.json`.
3. Rewrite `database.js` to use the `better-sqlite3` API while preserving the public contract (`initDb`, `storeTokens`, `getTokens`) and keeping the SQL schema identical.
4. Update `server.js` call sites only if needed to accommodate synchronous database access; prefer a small adapter if the contract can remain stable.
5. Update `AGENTS.md` to remove the obsolete Windows gotcha for `start:dev` and replace the sqlite3 mention with better-sqlite3.
6. Update `codemap.md` references from sqlite3 to better-sqlite3 where present.

### Impact
- `local-dev-workflow`
- `data-persistence`

### Out of scope
- No SQL schema changes.
- No new database features (no pooling, migrations framework, extra tables).
- No test suite introduction.
- No unrelated encryption, caching, or module changes.
- No Dockerfile changes unless verification in the tasks phase proves they are strictly required for the dependency swap.

## Approach
Use a minimal dependency migration: make the dev script portable with `cross-env`, switch the SQLite driver to a Node 24-capable maintained alternative, and preserve the current token-storage behavior and schema exactly.

## Affected Areas
- `package.json`
- `database.js`
- `server.js` (only if call sites must adapt)
- `AGENTS.md`
- `codemap.md`

## Risks
- `better-sqlite3` is synchronous. Mitigation: the database is only used on cold-path OAuth token CRUD and occasional refresh, so blocking impact should be negligible.
- Windows users without a C++ toolchain could be affected if no prebuild exists. Mitigation: `better-sqlite3@12.9.0` includes a `node-v137-win32-x64` prebuild, so Node 24 Win x64 users should not need local compilation.
- The Docker image uses Node 23, which may or may not match an available prebuild. Mitigation: verify this during the tasks phase before changing container tooling.

## Rollback Plan
If the migration introduces regressions, revert to the previous driver and script while preserving the existing schema and token data files.

## Success Criteria
- `pnpm start:dev` works on Windows, macOS, and Linux.
- SQLite loads successfully on Node 24 on Windows x64.
- Token persistence behavior remains unchanged.
- Repository docs no longer mention the obsolete Windows dev-script gotcha or sqlite3 dependency.
