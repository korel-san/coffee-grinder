# E2E Tests

E2E tests are opt-in and write into a dedicated **test** Google Spreadsheet.

## Setup

1. Keep your usual secrets in `grinder/.env` (Google auth, API keys, etc.)
2. Create `grinder/.env.e2e` from `grinder/.env.e2e.template` for E2E overrides
3. Set `GOOGLE_SHEET_ID_MAIN` in `.env.e2e` to your test spreadsheet id
4. Rename the spreadsheet title to include `test` or `e2e` (safety check)

Note: If `SERVICE_ACCOUNT_EMAIL` + `SERVICE_ACCOUNT_KEY` are set, the E2E test will prefer the service account auth (more stable for automation).

## Cases

Provide multiple URLs via one of:

- `E2E_CASES` (recommended): `expect|label|url` separated by `;`
  - `expect`: `ok` or `fail`
  - Example: `ok|normal|https://...;fail|missing|https://example.invalid/...`
- `E2E_ARTICLE_URLS`: comma-separated list of URLs (all treated as `ok`)
- `E2E_ARTICLE_URL`: single URL (treated as `ok`)

## Run

```sh
cd grinder
npm run test:e2e
```
