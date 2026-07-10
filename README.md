# 🧠 context-kernel

> **Self-hostable context memory for LLMs.** Keep your professional context, preferences, and evolving knowledge in sync across Claude Code, Desktop, and chat—without re-pasting or semantic drift.

---

A lightweight, opinionated **context memory** built on Cloudflare Workers and KV. You curate Markdown files about yourself, your work, and your preferences. A Worker serves them to Claude (Claude Code, Desktop, chat) over a secure remote MCP connector. Agents extend the memory via an append-only journal—but only *you* decide what becomes permanent.

### What it solves

Running agentic sessions across machines? Stop re-pasting:
- Who you are and what you do
- Your communication style and output preferences  
- How you want figures rendered
- Evolving project status, goals, and constraints

Context-kernel puts this in **one place you control**, reachable everywhere Claude runs. Claude pulls it automatically; you never paste again.

---

## Why not vector-memory tools?

Existing personal LLM memory systems (mem0, OpenMemory MCP) use **semantic search over extracted facts**. They're comprehensive—but have a known failure mode:

- Fact stored: "Prod runs Postgres 14"
- Fact updates: "Prod now runs Postgres 16"  
- **Both sit in the index.** Similarity search hands back whichever scores higher—usually the older, reinforced one.
- Result: outdated info looks authoritative.

context-kernel avoids this by design:

| Feature | context-kernel | Vector-memory |
|---------|---|---|
| Source of truth | Hand-edited Markdown | Extracted facts in index |
| Agent write access | Append-only journal | Often can edit directly |
| Stale data retirement | Manual—you remove it | Hopes retrieval rank decays |
| Semantic search | No | Yes |
| Self-maintenance | Low | High |
| Trustworthiness | High (you control it) | Variable (retrieval can fail) |

**Tradeoff:** Less automatic, no semantic search—but the memory stays **trustworthy** because you maintain it.

---

## Architecture

```
┌──────────────────────┐
│  content/*.md        │  ← Hand-curated (sacred, never auto-written)
│  (your source truth) │
└──────────────────────┘
           │
           v
┌──────────────────────────────────────────────────────┐
│                  npm run build                       │
│   Compile → Validate → KV bulk-upload artifact      │
└──────────────────────────────────────────────────────┘
           │
           v
┌──────────────────────────────────────────────────────┐
│  Cloudflare KV                                       │
│  • context:full:md     (whole context)              │
│  • section:<name>:md   (individual sections)        │
│  • journal:*           (append-only agent notes)    │
└──────────────────────────────────────────────────────┘
           │
           v
┌──────────────────────────────────────────────────────┐
│  Cloudflare Worker (Remote MCP Server)              │
│  📡 Token-gated, constant-time auth                 │
│                                                      │
│  Read Tools (READ_TOKEN):                           │
│  • get_context() → full context or section          │
│  • list_sections() → available topics               │
│  • get_meta() → metadata (timestamps, versions)     │
│                                                      │
│  Write Tools (WRITE_TOKEN):                         │
│  • append_journal(entry) → dated note               │
└──────────────────────────────────────────────────────┘
           │
           v
┌──────────────────────────────────────────────────────┐
│  Claude Code / Desktop / Chat                       │
│  Connects via MCP connector (auto-loads context)    │
└──────────────────────────────────────────────────────┘
           │
           v
┌──────────────────────────────────────────────────────┐
│  npm run promote                                     │
│  You review journal, cherry-pick what becomes      │
│  permanent in content/ (manual gate = no rot)       │
└──────────────────────────────────────────────────────┘
```

### Key design principles

**Manual promotion gate:** Agents append to a disposable journal. You review and hand-promote what becomes curated. This is what keeps the memory from rotting—stale content is retired because *you* remove it, not by accident.

**Two-token security model:** Read token pulls context; write token appends to journal only. Give write token to servers/agents, read token to yourself. Read token never reaches write operations.

**Markdown as source of truth:** No vector embeddings, no fact extraction, no semantic search. You edit plain text, version it, deploy it. What you see is what agents know.

## Security model

| Aspect | Detail |
|--------|--------|
| **Token auth** | Every request authenticated before any data read |
| **Read token** | Serves your context to Claude. Safe to embed in Claude Code config. |
| **Write token** | Allows journal appends only. No read, no delete. Give to agents/servers. |
| **Leaked write token** | Agent can leave poisoned notes—but manual promotion means it can't silently corrupt your curated context. You see it. |
| **Leaked read token** | Attacker sees your context. Rotate immediately. |
| **Token comparison** | Constant-time (no timing attacks). |
| **Secrets storage** | Cloudflare Workers secrets (encrypted, never in repo). `wrangler.toml` and `.dev.vars` are git-ignored. |

**See [SECURITY.md](SECURITY.md)** for the detailed threat model and incident reporting.

---

## Quick start

### Self-host on Cloudflare

You bring your own `content/` (this repo ships only templates in `content.example/`).

```sh
npm install
cp wrangler.toml.example wrangler.toml     # fill in your Cloudflare KV namespace IDs + route

wrangler kv namespace create CONTEXT_KV
wrangler kv namespace create CONTEXT_KV --preview   # paste both into wrangler.toml
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview

wrangler secret put READ_TOKEN
wrangler secret put WRITE_TOKEN

cp -r content.example content               # edit content/*.md with your context

npm run build
wrangler kv bulk put artifacts/kv-bulk.json --binding CONTEXT_KV
wrangler deploy
```

Note your deployed Worker URL (e.g., `https://my-context-kernel.myname.workers.dev/mcp`).

### Connect Claude Code

```bash
claude mcp add --transport http context-kernel \
  https://my-context-kernel.myname.workers.dev/mcp \
  --header "Authorization: Bearer <READ_TOKEN>"
```

Replace `<READ_TOKEN>` with your token. On session start, `.claude/skills/context-kernel/SKILL.md` auto-loads your context.

**Known limitation:** OAuth for claude.ai chat not yet working (library runtime incompatibility). Claude Code CLI (above) and local dev work fine with Bearer tokens.

### Full deploy walkthrough

See `HANDOFF.md` §9 for step-by-step with local-dev setup.

## Journal promotion (human review gate)

`scripts/promote.ts` (`npm run promote`) lets you review journal entries before promoting them into curated `content/`. Optional subagents:

- `.claude/agents/context-promoter.md` — runs the promotion review
- `.claude/agents/mcp-tester.md` — smoke-tests a deployed Worker

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
