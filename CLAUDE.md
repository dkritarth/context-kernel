# CLAUDE.md: context-kernel

Working conventions for any Claude Code session in this repo.

## What this project is

A personal, self-hostable **context memory** for LLMs. Hand-curated Markdown is the source of truth;
a Cloudflare Worker serves it as a **remote MCP server**; agents extend it only through an
append-only journal that a human promotes by hand. Not a website, not a public API, no UI.

## Hard rules (never violate)

- **`content/` is sacred and gitignored.** It holds the owner's real curated context. Never commit
  it. Never let an automated process edit it. Only `content.example/` (fake templates) is committed.
- **No curated-write tool.** MCP exposes read tools + an append-only `append_journal`. Nothing an
  agent can call may modify curated context. Promotion is a local, human-run script.
- **Two tokens, two scopes.** `READ_TOKEN` serves context; `WRITE_TOKEN` gates journal writes. Read
  token must never reach write tools. Use constant-time token comparison.
- **Secrets stay in Cloudflare.** Never hardcode tokens or KV namespace IDs. `wrangler.toml` (real)
  and `.dev.vars` are gitignored; only `wrangler.toml.example` is committed.
- **No personal data in URLs, query strings, logs, or cache keys.**
- **Verify moving APIs against live docs.** MCP transport and Cloudflare remote-MCP + Claude
  connector auth change often. Confirm current shape before implementing; do not guess an API.

## Stack

- Runtime: Cloudflare Workers (V8 isolate). Keep deps minimal.
- Storage: Cloudflare KV.
- Language: TypeScript.
- Protocol: remote MCP over HTTP, dual auth (plain bearer + OAuth via `@cloudflare/workers-oauth-provider`),
  both converging on `/mcp`. See `src/worker.ts` and `src/mcp/oauth.ts` for the routing and scope model.

## Commands

```sh
npm run typecheck
npm test
npm run build      # content/*.md -> artifacts/kv-bulk.json + meta.json
npm run dev        # wrangler dev, reads .dev.vars
npm run promote    # review journal:* entries; never auto-edits content/
```

Every change must end green on `npm run typecheck && npm test && npm run build`.

## KV key scheme

- `context:full:md`, `section:<name>:md`, `meta:json`: curated (read path).
- `journal:<ulid>`, `journal:index`: journal buffer (write path).

## Style

- Small, reviewable commits.
- Prose in docs and READMEs: clear and plain. No em-dashes in owner-facing docs (owner preference).
- Do not add dependencies without a reason noted in the commit message.

## When in doubt

Raise it rather than deciding silently. The owner wants the curation gate and the read/write split
preserved above all.
