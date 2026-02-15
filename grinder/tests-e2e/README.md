# E2E Tests

E2E tests are opt-in and write into a dedicated **test** Google Spreadsheet.

## Setup

1. Keep your usual secrets in `grinder/.env` (Google auth, API keys, etc.)
2. Create `grinder/.env.e2e` from `grinder/.env.e2e.template` for E2E overrides
3. Set `GOOGLE_SHEET_ID_MAIN` in `.env.e2e` to your test spreadsheet id
4. Rename the spreadsheet title to include `test` or `e2e` (safety check)

## Run

```sh
cd grinder
npm run test:e2e
```
