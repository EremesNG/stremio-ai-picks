# public/

## Responsibility
Serves the user-facing configuration dashboard (`configure.html`) and static assets for the Stremio AI Picks addon. The configuration interface collects API credentials, model preferences, homepage customization, and integration settings, validates them server-side, encrypts the configuration, and produces installation URLs for Stremio.

## Files

### configure.html
**Role**: Interactive configuration dashboard for addon setup. Collects Gemini API key, TMDB API key, model selection, search parameters, homepage catalog rows, Trakt.tv OAuth, RPDB/Fanart.tv keys, language, and content filtering preferences. Validates credentials, encrypts configuration, and generates Stremio installation URLs.

**UI Sections**:
- **Basic Configuration**: Required fields for Gemini API key and TMDB API key with inline validation feedback
- **Advanced Options** (collapsible):
  - **AI/Model Settings**: Dropdown selector for Gemini model variants (default `gemini-flash-lite-latest`), MaxTurns number input (range 4–12, default 6), Number of Results (range 1–30)
  - **Homepage Customization**: Dynamic catalog row editor with title + query inputs per row, remove button per row, Add Row button to append new rows
  - **Integrations**: Trakt.tv OAuth flow with token storage in sessionStorage, RPDB API key for poster overlays, Fanart.tv API key for thumbnails
  - **Preferences**: Content Language dropdown, Adult Content toggle, FilterWatched checkbox (visible only when Trakt authenticated, default ON)
- **Issue/Idea Modal**: User feedback and bug reporting form with reCAPTCHA validation

**Patterns**:
- DOM-centric state management — no reactive framework; form state read directly from DOM elements at submission time
- Builder pattern in `generateUrl` — constructs `configData` object by iterating form fields and collecting values
- Hydration pattern in `parseHomepageQuery` — deserializes `HomepageQuery` string (format: `Title:Query|||Title:Query`) into dynamic row DOM elements on page load
- Backward compatibility — missing `FilterWatched` or `MaxTurns` fields in loaded configs default to `true` and `6` respectively

**Flow**:
1. User fills form fields (API keys, model, rows, integrations, preferences)
2. `validateApiKeys` → POST `/validate` with Gemini + TMDB keys → server validates and returns success/error
3. `getAddonUrl` → gathers all form values into `{ configData, traktAuthData }` object
4. POST `/encrypt` with `configData` → server encrypts and returns encrypted config ID
5. Config ID embedded in two installation URLs: `stremio://` (direct) and `https://` (web fallback)
6. User copies URL and installs addon in Stremio

**Config Output**:
- `GeminiApiKey`: User-provided Gemini API key
- `TmdbApiKey`: User-provided TMDB API key
- `GeminiModel`: Selected model variant (default `gemini-flash-lite-latest`)
- `MaxTurns`: Number of AI conversation turns (4–12, default 6)
- `NumResults`: Number of search results to return (1–30)
- `HomepageQuery`: Serialized homepage catalog rows as `Title:Query|||Title:Query|||...` (delimiter changed from `,` to `|||` to avoid conflicts with query text containing commas)
- `FilterWatched`: Boolean, visible only when Trakt authenticated (default `true`)
- `Language`: Selected content language
- `AdultContent`: Boolean toggle for adult content filtering
- `RpdbApiKey`: Optional RPDB API key for poster overlays
- `FanartApiKey`: Optional Fanart.tv API key for thumbnails
- Trakt OAuth tokens (stored in sessionStorage, passed separately to backend)

**Integration**:
- Backend endpoints: `/validate` (POST), `/encrypt` (POST)
- External services: Google AI Studio (Gemini API), TMDB, Trakt.tv OAuth, RPDB, Fanart.tv
- Session storage: Trakt OAuth tokens cached in `sessionStorage` for UI state (FilterWatched visibility)

## Data Flow
```
User Input (Form)
  ↓
validateApiKeys() → POST /validate
  ↓ (success)
getAddonUrl() → collect all form values into configData
  ↓
POST /encrypt { configData }
  ↓ (returns encrypted ID)
Embed encrypted ID in stremio:// and https:// URLs
  ↓
User copies URL → installs addon in Stremio
```

## Integration Map
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/validate` | POST | Validate Gemini + TMDB API keys |
| `/encrypt` | POST | Encrypt configuration object, return config ID |

| External Service | Used For |
|------------------|----------|
| Google AI Studio (Gemini) | API key validation, model selection |
| TMDB | API key validation |
| Trakt.tv | OAuth authorization flow, token exchange |
| RPDB | Poster overlay API key (optional) |
| Fanart.tv | Thumbnail API key (optional) |
