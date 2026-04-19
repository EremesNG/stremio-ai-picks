# utils/

## Responsibility
Shared infrastructure layer providing cross-cutting concerns: observability, resilience, security, and external integrations.

## Design
Four independent utility modules unified by a central logging dependency:

- **logger.js** — Singleton file-based logging system with Strategy pattern for log routing (app, query, error). Central dependency for all other utils.
- **apiRetry.js** — Decorator/Wrapper pattern implementing `withRetry` for API calls with exponential backoff and jitter for transient error resilience.
- **crypto.js** — AES-256-CBC encryption/decryption utility for configuration data. Exports `encryptConfig`, `decryptConfig`, `isValidEncryptedFormat`.
- **issueHandler.js** — Handler pattern for user feedback/issue submission via reCAPTCHA validation + GitHub API integration. Exports `handleIssueSubmission`.

## Flow
1. `logger.js` initializes on first require → creates log directory and file streams (Singleton)
2. Other utils import `logger` for consistent observability
3. `crypto.js` reads encryption key from env vars via `dotenv`
4. `apiRetry.js` wraps async API calls, retrying on transient failures with backoff
5. `issueHandler.js` validates reCAPTCHA tokens, then posts issues to GitHub API

## Integration
- **Consumed by**: `addon.js` (apiRetry, crypto), `server.js` (crypto, logger, issueHandler)
- **Internal dependency graph**: `logger.js` ← `apiRetry.js`, `crypto.js`, `issueHandler.js`
- **External deps**: `crypto` (Node built-in), `fs`, `path`, `dotenv`
