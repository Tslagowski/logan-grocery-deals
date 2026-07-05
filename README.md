# logan-grocery-deals
Local grocery deals

Daily GitHub Action that emails a Logan, Utah grocery and household deal report.

Required repository secrets:

- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `DEAL_REPORT_TO_EMAIL`

Optional environment variable:

- `OPENAI_MODEL` defaults to `gpt-4.1-mini`
- `OPENAI_SEARCH_MODEL` defaults to `OPENAI_MODEL`; use this for the web-search extraction model
- `MAX_DEALS_PER_STORE` defaults to `20`
- `ENABLE_SCREENSHOT_OCR` defaults to `true`; set to `false` to skip rendered-page screenshots and reduce cost

The report uses three stages:

- Direct Playwright fetches of target store weekly ad pages, with source diagnostics.
- Store-by-store OpenAI Responses API web search using allowed domains for each Logan-area target store.
- Screenshot/OCR extraction when web search finds fewer than three deals for a store.
- Deterministic report rendering from structured deal candidates, search coverage, search sources, and direct source diagnostics.

For better coverage, set `OPENAI_SEARCH_MODEL` to a stronger web-search-capable model available on the API key. The default keeps the action inexpensive, but deeper search generally needs a stronger model and more latency.

Run a local syntax check with:

```bash
npm test
```
