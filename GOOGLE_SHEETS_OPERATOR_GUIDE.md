# Google Sheets Operator Guide (No Code)

This guide is for a teammate who works only in Google Sheets and does not change code.

## What you can manage in Sheets
- Prompt texts used by the pipeline (`prompts` tab)
- News rows and fields in the `news` tab
- Manual corrections for titles, summaries, facts, videos, and source URLs

## Where to edit
- Main mode sheet: `GOOGLE_SHEET_ID_MAIN`
- Auto mode sheet: `GOOGLE_SHEET_ID_AUTO`
- Prompt tab name: `prompts`
- Data tab name: `news`

Ask a developer for the exact sheet links if needed.

## Prompt editing workflow (no coding)
1. Open the target spreadsheet.
2. Go to tab `prompts`.
3. Find row by `name` (for example: `summarize`, `summarize:facts`, `summarize:videos`).
4. Edit only the `prompt` cell.
5. Save in Google Sheets (auto-save).
6. Inform the operator to run pipeline again. New prompt text is used on next run.

## Important rules for prompt tab
- Do not rename prompt `name` keys.
- Do not change header row (`name`, `prompt`).
- Keep one row per prompt key.
- If you remove a prompt row by mistake, operator can restore missing defaults with `npm run presummarize`.
- `npm run presummarize` adds missing prompts only. It does not overwrite existing prompt text.

## News tab: key fields and expected format
- `usedUrl`: final source URL actually used for article/screenshot.
- `alternativeUrls`: fallback URLs, one URL per line.
- `factsRu`: facts text only (no links required).
- `videoUrls`: YouTube links only, one URL per line.
- `summary`: Russian summary text for slide body.

## Quick quality checklist before run
- `summary` is not empty for required rows.
- `factsRu` contains readable bullet-like facts (text only).
- `videoUrls` contains valid YouTube links.
- `usedUrl` is present (original or chosen alternative).
- No template placeholders left in fields (`{{...}}`).

## What to do when output looks wrong
- If wrong facts/videos: update related prompt in `prompts`, rerun pipeline.
- If wrong article source: fix `usedUrl` (and optionally `alternativeUrls`) in `news`, rerun slides/screenshots.
- If a row should be ignored: set topic to `other`.

