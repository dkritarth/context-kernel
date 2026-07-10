# context-kernel

A small, self-hostable **context memory** for LLMs. You curate a set of Markdown files about
yourself and your work; a Cloudflare Worker serves them to Claude (Claude Code, Desktop, and browser
chat) over a single authenticated remote MCP connector. Your agents can extend the memory through an
append-only journal, but only *you* promote journal notes into the curated source of truth.

It is deliberately narrow. It is not a personal website, resume renderer, CMS, or chatbot. It is an
infrastructure layer that answers one question: "what context should an authorized Claude session
know about me right now?" It answers with fast, predictable payloads.

## Why

If you run agentic sessions across several machines and browser chats, you end up re-feeding the
same context every session: who you are, your goals, how you like prose written, how figures should
look, how you want answers delivered. context-kernel puts that in one place you control, reachable
everywhere Claude runs, that Claude pulls itself instead of you pasting it.

## How it works

```text
content/*.md  (you hand-edit; the source of truth)
      |
      v
  build step  ->  Cloudflare KV  ->  Worker (remote MCP server, token-gated)
                                          |
                        read tools: get_context / list_sections / get_meta
                        write tool: append_journal   (agents leave dated notes)
                                          |
                                          v
                   you promote journal notes into content/ by hand
```

The curated files are sacred and never auto-written. Agents can only append to a disposable journal.
You review the journal and decide what becomes permanent. This "manual promotion" gate is what keeps
the memory from rotting.

## Security model

- Every request needs a token; unauthorized requests are rejected before any data read.
- Two scopes: a **read** token serves your context, a separate **write** token allows journal
  appends only. Give servers only the write token.
- The write token is the higher-risk credential: a leak lets someone add notes, but because
  promotion is manual, poisoned notes cannot reach your curated context without you seeing them.
- Rotate tokens if leaked. Secrets live in Cloudflare, never in the repo.

See [SECURITY.md](SECURITY.md) for the short version of this and how to report a leak.

## Connection (Claude Code CLI)

**Status:** Live at `https://context-kernel.dkritarth.workers.dev/mcp` with real curated content.

Add to Claude Code:
```sh
claude mcp add --transport http context-kernel https://context-kernel.dkritarth.workers.dev/mcp \
  --header "Authorization: Bearer <READ_TOKEN>"
```

Replace `<READ_TOKEN>` with your token (stored in GitHub Actions encrypted secrets, or your password
manager). The skill `skill/context-kernel/SKILL.md` is auto-enabled and pulls your context on
session start.

**Known limitation:** OAuth for claude.ai chat is not yet working (the @cloudflare/workers-oauth-provider
library had runtime incompatibility; would need a custom OAuth implementation). Claude Code CLI
(above) and local servers/scripts work fine with plain-bearer auth.

## Run your own

You bring your own `content/` (this repo ships only fake templates in `content.example/`).

```sh
npm install
cp wrangler.toml.example wrangler.toml     # fill in your KV namespace ids + route

wrangler kv namespace create CONTEXT_KV
wrangler kv namespace create CONTEXT_KV --preview   # paste both ids into wrangler.toml
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview    # (optional, for future OAuth support)
wrangler secret put READ_TOKEN
wrangler secret put WRITE_TOKEN

cp -r content.example content               # then edit content/*.md with your real context

npm run build
wrangler kv bulk put artifacts/kv-bulk.json --binding CONTEXT_KV
wrangler deploy
```

Then add to Claude Code (as above). See `HANDOFF.md` §9 for the full deploy walkthrough and
local-dev setup.

`scripts/promote.ts` (`npm run promote`) is the human-run review step for journal entries;
`.claude/agents/context-promoter.md` and `.claude/agents/mcp-tester.md` are optional subagents
for running that review and for smoke-testing a deployed Worker.

## Prior art, and why not just use it

Personal memory layers for LLMs already exist and are more mature than this project. Worth
naming honestly:

- **OpenMemory MCP** (mem0): self-hostable, user-owned memory across MCP clients, with a
  dashboard, per-client ACLs, and audit logs.
- **mem0-mcp-selfhosted**: self-hosted memory for Claude Code with an optional knowledge graph.
- **Claude Code's own Auto Memory / Session Memory**: already extracts and carries forward notes
  and summaries between sessions, no extra infra required.

If the goal were only "stop re-pasting who I am," any of these would work today.

The reason this project exists anyway: those tools are **vector-store-backed**, they extract
facts automatically and retrieve by semantic similarity. That design has a known failure mode,
described plainly by one such tool's own author: self-hosting fixes *where* memory lives, it does
not fix *what happens when a stored fact stops being true*. If an agent writes "prod runs on
Postgres 14" and it later becomes 16, both rows sit in the store, and similarity search hands back
whichever scores higher, usually the older, more-reinforced one. Nothing retracts a fact.

That failure mode maps directly onto how a research context actually changes: current projects,
course load, and priorities shift term to term, and a system that quietly keeps surfacing
last term's status alongside this term's is worse than no memory at all, because it looks
authoritative.

context-kernel avoids this by construction, not by tuning:

- The curated store is **hand-edited Markdown**, not extracted facts in a vector index. Nothing
  becomes "memory" without a human writing or approving the sentence.
- Agents can only **append** to a disposable journal. They cannot edit curated context, so they
  cannot silently overwrite or contradict it.
- **Promotion is a manual, human-run step.** Stale or superseded content is retired because the
  owner removes it, not because a retrieval score happened to favor the newer entry.

The tradeoff is honest: this is less automatic than a vector-memory tool, and it does not do
semantic search over your history. It optimizes for the memory being *trustworthy* over it being
*self-maintaining*.

## Sections

`profile`, `goals`, `current-work`, `resume`, `writing-prefs`, `figure-prefs`, `answer-prefs`,
`skills`, `env-constants`. Add only what an authorized Claude session should see; leave out
contact-heavy details.

## Repository hygiene

Committed: engine source, tests, artifact generator, promotion script, personal skill, subagent
definitions, `content.example/` templates, config example.
Ignored: `content/` (your real data), generated `artifacts/`, `node_modules/`, real `wrangler.toml`,
`.dev.vars`, `.promoted-ids.json` (local promotion-review state).

## License

MIT. See [LICENSE](LICENSE).
