# Tasks: Minimum TMDB Rating Filter per Custom Catalog Entry

## Phase 1: Foundation
- [x] 1.1 Verify the wire format contract in `openspec/changes/min-tmdb-rating-filter/proposal.md` uses the `@@` suffix separator and is consistent throughout.
  - The proposal is the source of truth for the contract: `title:query@@minRating` per entry, joined by `|||` between entries.
  - Confirm parsing rules, validation rules, and backward compatibility are documented in the proposal.
  - No separate documentation file is needed — the proposal IS the contract.
- [x] 1.2 Propagate TMDB rating in normalized TMDB results (`utils/agent-tools.js`) by extending `normalizeSearchResult` to return `tmdbRating` from `item.tmdbRating` with fallback to `item.vote_average`.

### Verification
- Run: `node -c utils/agent-tools.js`
- Expected: Syntax check passes with no errors.

## Phase 2: Config Serialization and Parsing Consistency
- [x] 2.1 Extend custom catalog UI row model in `public/configure.html` (`addCatalogRow`) to include optional `minTmdbRating` input (`0..10`, step `0.1`) without making it required.
- [x] 2.2 Update `public/configure.html` `updateHomepageQueryHidden()` to serialize each filled row as `title:query@@minRating` when rating is present, or `title:query` when absent; keep `|||` as entry delimiter.
- [x] 2.3 Update `public/configure.html` `parseHomepageQuery()` to deserialize the same contract (`title:query@@minRating`) and prefill the rating input; preserve `title:query` compatibility.
- [x] 2.4 Update homepage-query parsing in `addon.js` (catalog request path around lines 3122-3161) to parse query and optional `minTmdbRating` using the same suffix contract used by the UI, then pass both values into runtime deps.
- [x] 2.5 Update homepage-query parsing in `server.js` manifest path (around lines 313-323) to parse entry titles/queries using the same contract, stripping any `@@minRating` suffix before intent detection and catalog naming.

### Verification
- Run: `node -c addon.js; node -c server.js`
- Expected: Syntax checks pass and parsing contract is implemented consistently across `public/configure.html` (`updateHomepageQueryHidden`, `parseHomepageQuery`), `addon.js`, and `server.js`.

## Phase 3: Agent Integration and Enforcement
- [x] 3.1 Extend `runAgentLoop` dependency contract in `utils/agent.js` to accept optional `minTmdbRating` from parsed homepage/custom catalog config.
- [x] 3.2 Add deterministic hard filtering in `applyTurnFilter` (`utils/agent.js`) so items with `item.tmdbRating < minTmdbRating` are rejected as `lowRating` when a threshold exists.
- [x] 3.3 Extend rejection accounting and between-turn refinement messaging in `utils/agent.js` to include `lowRating` alongside existing buckets (`watched`, `rated`, `history`, `duplicate`, `typeMismatch`, `notFound`).
- [x] 3.4 Update `TURN_RESULT` telemetry in `utils/agent.js` to include `droppedLowRating` while preserving existing fields for compatibility.
- [x] 3.5 Update `utils/prompts.js` (`buildTurnMessage`) with threshold-aware soft guidance: recommend items with TMDB rating >= configured `minTmdbRating` when present.

### Verification
- Run: `node -c utils/agent.js; node -c utils/prompts.js`
- Expected: Syntax checks pass and no undefined-field regressions in `lowRating` accounting paths.

## Phase 4: End-to-End Validation
- [x] 4.1 Validate parsing/serialization compatibility matrix across all three parsing locations:
  - Legacy: `title:query`
  - New with rating: `title:query@@7.5`
  - Multi-entry: `title:query@@7.5|||title:query`
  - Query containing colons remains intact because rating is parsed from trailing `@@<number>` suffix only.
- [x] 4.2 Validate proposal success criteria end-to-end: optional UI threshold, legacy config compatibility, prompt guidance only when configured, deterministic `lowRating` rejections, and telemetry/reporting updates.
- [x] 4.3 Run final syntax verification sweep for all changed JS files.

### Verification
- Run: `node -c utils/agent-tools.js; node -c addon.js; node -c server.js; node -c utils/agent.js; node -c utils/prompts.js`
- Expected: All commands complete successfully; no syntax errors across modified files.
