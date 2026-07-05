# logan-grocery-deals
Local grocery deals

Daily GitHub Action that emails a Logan, Utah grocery and household deal report.

Required repository secrets:

- `OPENAI_API_KEY`
- `RESEND_API_KEY`
- `DEAL_REPORT_TO_EMAIL`

Optional environment variable:

- `OPENAI_MODEL` defaults to `gpt-4.1-mini`

The report uses two inputs:

- Direct Playwright fetches of target store weekly ad pages, with source diagnostics.
- OpenAI Responses API web search to find current public item-level prices when store pages render as JavaScript shells or block automation.

Run a local syntax check with:

```bash
npm test
```
