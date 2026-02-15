# OpenAI Models For `grinder` Summarization

`grinder/src/ai.js` uses the OpenAI **Assistants API** for article summarization.
`grinder/src/enrich.js` uses **Chat Completions + Web Search** for facts/videos enrichment.

## Selecting A Model

Set one of these environment variables:

- `OPENAI_SUMMARIZE_MODEL` (preferred)
- `OPENAI_MODEL` (fallback)

Default (if none is set): `gpt-5-mini`.

If the default model is not available in your account, the code falls back to `gpt-4o-mini`. If you explicitly set `OPENAI_SUMMARIZE_MODEL` / `OPENAI_MODEL` and it fails, it will fail fast (no fallback).

Examples:

```sh
cd grinder
OPENAI_SUMMARIZE_MODEL=gpt-5.2 npm run summarize
```

Pin a snapshot for reproducible results:

```sh
cd grinder
OPENAI_SUMMARIZE_MODEL=gpt-5-mini-2025-08-07 npm run summarize
```

## Web Search (Facts, Videos)

Facts and video links are generated via `grinder/src/enrich.js` using Chat Completions with `web_search_options`.

Env vars:

- `OPENAI_FACTS_MODEL` (default: `gpt-4o-mini-search-preview`)
- `OPENAI_VIDEOS_MODEL` (default: `gpt-4o-mini-search-preview`)
- `OPENAI_WEBSEARCH_MODEL` (optional shared default for both)
- `OPENAI_WEBSEARCH_CONTEXT_SIZE` (optional)
- `OPENAI_WEBSEARCH_COUNTRY` / `OPENAI_WEBSEARCH_CITY` / `OPENAI_WEBSEARCH_REGION` / `OPENAI_WEBSEARCH_TIMEZONE` (optional)

Search-capable model IDs (per OpenAI docs):

- `gpt-5-search-api`
- `gpt-4o-search-preview`
- `gpt-4o-mini-search-preview`

## GPT Model Options (IDs + Snapshots)

These are official GPT model IDs from OpenAI docs (some accounts may not have access to all of them):

- GPT‑5.2: `gpt-5.2` (`gpt-5.2-2025-12-11`)
- GPT‑5.1: `gpt-5.1` (`gpt-5.1-2025-11-13`)
- GPT‑5: `gpt-5` (`gpt-5-2025-08-07`)
- GPT‑5 mini: `gpt-5-mini` (`gpt-5-mini-2025-08-07`)
- GPT‑5 nano: `gpt-5-nano` (`gpt-5-nano-2025-08-07`)
- GPT‑4.1: `gpt-4.1` (`gpt-4.1-2025-04-14`)
- GPT‑4.1 mini: `gpt-4.1-mini` (`gpt-4.1-mini-2025-04-14`)
- GPT‑4.1 nano: `gpt-4.1-nano` (`gpt-4.1-nano-2025-04-14`)
- GPT‑4o: `gpt-4o` (`gpt-4o-2024-11-20`, `gpt-4o-2024-08-06`)
- GPT‑4o mini: `gpt-4o-mini` (`gpt-4o-mini-2024-07-18`)

Source of truth:

- Models index: https://developers.openai.com/api/docs/models
- Each model page includes snapshots and endpoint support (verify Assistants support there).
