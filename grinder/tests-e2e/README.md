# E2E Tests

E2E tests are opt-in and write into a dedicated **test** Google Spreadsheet.

## Setup

1. Create `grinder/.env.e2e` from `grinder/.env.e2e.template`
2. Set `GOOGLE_SHEET_ID_MAIN` to your test spreadsheet id
3. Rename the spreadsheet title to include `test` or `e2e` (safety check)

## Run

```sh
cd grinder
npm run test:e2e
```

