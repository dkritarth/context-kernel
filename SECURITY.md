# Security

context-kernel is a single-owner personal server. There is no multi-tenant threat model here:
the only thing standing between the public internet and your curated context (and your journal)
is the two bearer tokens described in the README's "Security model" section.

## If a token leaks

- **Read token leaked:** rotate it (`wrangler secret put READ_TOKEN`) and reconnect your Claude
  clients with the new value. The exposure is read-only: whoever had the token could see your
  curated context, but could not write anything.
- **Write token leaked:** rotate it immediately (`wrangler secret put WRITE_TOKEN`). This is the
  higher-risk credential: it lets a caller append arbitrary notes to the journal. Because
  promotion into curated context is a manual, human-run step (`npm run promote`), a leaked write
  token cannot corrupt your curated context on its own, but you should still review recent
  `journal:*` entries for anything suspicious before your next promotion pass, and discard
  anything you don't recognize.

Rotating a secret with `wrangler secret put` takes effect immediately; no redeploy is required.

## Reporting an issue in the engine itself

This is a personal project, not a supported product. If you find a real vulnerability in the
engine (auth bypass, token comparison timing leak, KV key confusion, etc.), open a GitHub issue
or reach the maintainer directly rather than filing a public exploit writeup.
