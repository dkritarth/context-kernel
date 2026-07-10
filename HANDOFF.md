# HANDOFF: context-kernel

> A personal, self-hostable **context memory** for LLMs. Curated by hand, extended by agents,
> served to any Claude surface (Claude Code, Desktop, browser chat) over a single remote MCP
> connector. This document is the build brief for a fresh Claude Code agent. Read it fully before
> writing code.

---

## 0. Read this first

**Step 0 for the building agent:** MCP transport details, Cloudflare's remote-MCP story, and
Anthropic's custom-connector auth all move quickly. Before implementing the Worker, verify the
current shape of:

- Cloudflare "Build a remote MCP server on Workers" guide (Agents SDK / `McpAgent`, or the MCP
  TypeScript SDK with a Workers HTTP transport).
- Anthropic custom connector / remote MCP auth (bearer token vs OAuth; what the Claude connector UI
  accepts).

The **architecture and product decisions below are settled** — do not relitigate them. Only the
exact SDK calls and auth handshake should be confirmed against current docs. If current docs
contradict a specific API named here, follow the docs and note the deviation in a commit message.

---

## 1. What this is (and is not)

**Is:** infrastructure that answers one question — *"What context should Claude know about me and my
work right now?"* — and answers it with small, fast, structured payloads that Claude pulls itself.

**Is not:** a personal website, resume renderer, CMS, chatbot, or public profile API. No HTML
frontend. No public unauthenticated access.

**The problem it solves:** the owner runs agentic sessions across ~6 servers plus browser LLM chats
and is tired of re-feeding identity, goals, preferences, and current-work context every session.
This is a single controllable "memory" the owner curates, that agents can extend, reachable from
everywhere Claude runs.

**Original repo name was `identity-kernel`.** Scope has shifted from "identity" to "context memory";
`context-kernel` is the recommended name. Renaming is optional but preferred.

---

## 2. Settled decisions (do not change without owner sign-off)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Source of truth = a git repo of hand-curated Markdown.** Sacred. Never auto-written. | Auditable, versioned, owner-controlled. Prevents memory-rot. |
| D2 | **Growth via Model B: append-only journal + manual promotion.** Agents append dated raw notes to a journal buffer. They never touch curated files. Owner periodically promotes journal notes into curated Markdown by hand. | Gets self-extension without letting agents corrupt the source of truth. The promotion gate is the owner's control point. |
| D3 | **Protocol = remote MCP server, not plain REST.** One Cloudflare Worker exposes MCP tools. | Consumer is Claude everywhere (Code, Desktop, browser). MCP is auto-invoked; kills the manual copy-paste that is the actual pain. Collapses the "filesystem-having vs filesystem-blind" consumer split into one mechanism. |
| D4 | **Two tool classes with separate auth: read and write.** Read token serves context; a distinct write token gates journal appends. | A read leak exposes the owner's context (bad). A write compromise would let an attacker poison the memory across every session (worse). Separate keys + manual promotion contain both. |
| D5 | **Engine and content are separated.** The machinery is public-shareable; the owner's actual context is private. Curated Markdown lives in a gitignored `content/` dir; the repo ships `content.example/` templates. | Lets the repo go public on GitHub without leaking the owner's resume/goals. |
| D6 | **Deploy target = Cloudflare Workers + KV.** Owner already has a domain on Cloudflare. | No warm server, low latency, already paid for. |
| D7 | **A thin personal Skill sits on top of the MCP connector.** It steers Claude to call `get_context` at session start. | Skill = *how* to use the memory; MCP = *what* the memory is. Standard pairing. |

---

## 3. Architecture

```text
  content/  (gitignored, SACRED, hand-edited)      content.example/  (committed templates)
  profile.md  goals.md  writing-prefs.md
  figure-prefs.md  answer-prefs.md
  resume.md  current-work.md  skills.md  ...
          |
          v
  scripts/generate-artifacts.ts   (compile content/*.md -> KV bulk payload + meta)
          |
          v
  artifacts/kv-bulk.json  ---->  Cloudflare KV
                                      |
                                      v
                               src/worker.ts  (MCP server over HTTP, token-gated)
                                      |
                         +------------+-------------+
                         | read tools               | write tools
                         | get_context / list /     | append_journal / list_journal
                         | get_meta (READ_TOKEN)     | (WRITE_TOKEN)
                         v                           v
                    curated context in KV      journal:* entries in KV
                                                     |
                                                     v
                                    scripts/promote.ts  (owner pulls journal,
                                    curates by hand into content/, commits, rebuilds)
```

**Why journal lives in KV, not git:** the journal is disposable working memory. Only *curated*
content needs version history. Keeping the journal in KV means the 6 servers never need git
credentials — they hold only a write token.

---

## 4. Data model

Curated sections (each a Markdown file in `content/`, mirrored to KV):

| Section | Purpose |
|---|---|
| `profile` | Compact identity summary + research interests |
| `goals` | Current objectives, short and long term |
| `current-work` | What the owner is actively doing (courses, projects, this term) |
| `resume` | Condensed CV / background |
| `writing-prefs` | How the owner wants prose written (tone, structure, what to avoid) |
| `figure-prefs` | How figures/plots should be produced (style, tools, conventions) |
| `answer-prefs` | How the owner wants answers delivered (format, depth, verbosity) |
| `skills` | Skill categories, retrieval-optimized |
| `env-constants` | Non-secret runtime/config constants |

Exclude contact-heavy fields (phone, direct email). Add only what an authorized Claude session
should see.

**KV keys:**

| KV key | Content |
|---|---|
| `context:full:md` | Full curated context, concatenated Markdown |
| `section:<name>:md` | One curated section |
| `meta:json` | Version, generated timestamp, source revision, content hash |
| `journal:<ulid>` | One journal entry (JSON: server, timestamp, tags, note) |
| `journal:index` | Optional ordered index of journal ULIDs for fast listing |

---

## 5. MCP tools to implement

Namespace them `context_kernel_*` if the client shows raw tool names.

**Read tools — require `READ_TOKEN`:**

- `get_context(section?: string) -> markdown`
  Returns the full curated context, or one section if `section` is supplied. This is what a
  session-start hook / skill calls.
- `list_sections() -> {name, hash}[]`
  Lets Claude discover available sections and detect staleness.
- `get_meta() -> {version, generated_at, source_rev, content_hash}`

**Write tools — require `WRITE_TOKEN`:**

- `append_journal(server: string, note: string, tags?: string[]) -> {id}`
  Appends a dated raw note to the journal buffer. Never writes to curated keys. Assigns a ULID,
  stores `journal:<ulid>`, updates `journal:index`.
- `list_journal(since?: ISO8601, limit?: number) -> entries[]`
  Read-back for the promotion workflow. (Consider gating this behind the write token too, since it
  exposes raw unpromoted notes.)

**Explicitly NOT a tool:** anything that writes curated context. Promotion is a local, human-driven
script (`scripts/promote.ts`), never an agent-callable tool. This is the enforcement of D2/D4.

---

## 6. Auth model

- Worker `fetch` handler checks a bearer token **before** dispatching any MCP request or touching
  KV. Unauthorized → `401`, no KV read.
- Two secrets: `READ_TOKEN` and `WRITE_TOKEN`. The Worker maps each incoming token to an allowed
  tool set. Read token cannot invoke write tools.
- Use a constant-time comparison for token checks (no early-exit string compare).
- If the Claude connector UI requires OAuth rather than a static bearer, use Cloudflare's MCP OAuth
  provider library and issue the owner a single-user client. Confirm current requirement in Step 0.
- Secrets live in Cloudflare (`wrangler secret put`), never in the repo.
- Token-gated responses: `Cache-Control: private, max-age=60`.

---

## 7. Repository layout to produce

```text
context-kernel/
  content.example/          # committed template sections
    profile.md
    goals.md
    ...
  content/                  # gitignored; owner's real curated context
  src/
    worker.ts               # MCP server entry (Cloudflare Worker)
    mcp/
      tools.ts              # tool definitions + handlers
      auth.ts               # token gate, constant-time compare
    kv.ts                   # KV key helpers
    types.ts
  scripts/
    generate-artifacts.ts   # content/*.md -> artifacts/kv-bulk.json + meta.json
    promote.ts              # interactive journal-review + promotion helper
  artifacts/                # gitignored, generated
  test/
    auth.test.ts
    tools.test.ts
    generate.test.ts
  .claude/
    agents/
      context-promoter.md   # subagent that runs the promotion review
      mcp-tester.md         # subagent that smoke-tests deployed tools
  skill/
    context-kernel/
      SKILL.md              # thin personal skill: "call get_context at session start"
  CLAUDE.md
  README.md
  wrangler.toml.example
  .gitignore
  package.json
  tsconfig.json
```

---

## 8. Build phases

Work in small, reviewable commits. Suggested order:

1. **Scaffold + tooling.** `package.json`, `tsconfig.json`, `.gitignore`, wrangler example, empty
   `content.example/` templates. Set up test runner.
2. **Artifact generator.** `scripts/generate-artifacts.ts`: read `content/*.md`, produce
   `artifacts/kv-bulk.json` (KV bulk format) + `meta.json` with a content hash. Test with the
   example content.
3. **Auth gate.** `src/mcp/auth.ts` with constant-time token comparison; unit tests for
   read/write/deny.
4. **MCP server, read tools.** `src/worker.ts` + `get_context` / `list_sections` / `get_meta`.
   Test locally with `wrangler dev` and an MCP client.
5. **Write tools + journal.** `append_journal` / `list_journal`, ULID keys, index. Enforce write
   token.
6. **Promotion script.** `scripts/promote.ts`: pull `journal:*`, print entries, let the owner mark
   entries handled; the owner edits `content/` by hand. The script does NOT auto-edit curated files.
7. **Personal skill.** `skill/context-kernel/SKILL.md` — instruct Claude to call `get_context` early
   in a session and treat the result as authoritative owner context.
8. **Docs + GitHub hygiene.** README, CLAUDE.md, ensure `content/`, `artifacts/`, `.dev.vars`, real
   `wrangler.toml` are all gitignored. Verify no personal data is committed.

Each phase ends green: `npm run typecheck && npm test && npm run build`.

---

## 9. Deployment (owner-facing; put a copy in README)

Prerequisites: a Cloudflare account with the owner's domain, `wrangler` CLI logged in, Node ≥ 20.

```sh
# 1. Install and configure
npm install
cp wrangler.toml.example wrangler.toml      # then fill in KV namespace IDs + route/domain

# 2. Create KV namespaces and paste their ids (and preview ids) into wrangler.toml
#    - CONTEXT_KV: for curated context + journal entries
#    - OAUTH_KV: for OAuth provider state (clients, grants, tokens) — needed for claude.ai connector UI
wrangler kv namespace create CONTEXT_KV
wrangler kv namespace create CONTEXT_KV --preview
wrangler kv namespace create OAUTH_KV
wrangler kv namespace create OAUTH_KV --preview

# 3. Set secrets (generate long random tokens; store them in a password manager)
wrangler secret put READ_TOKEN
wrangler secret put WRITE_TOKEN

# 4. Author real context locally
cp -r content.example content
#   ...edit content/*.md by hand...

# 5. Build artifacts and upload to KV
npm run build
wrangler kv bulk put artifacts/kv-bulk.json --binding CONTEXT_KV

# 6. Deploy the Worker (route it under your Cloudflare domain)
wrangler deploy
```

**Connect it to Claude:** 
- **claude.ai web/Desktop UI**: Use the OAuth flow (the OAuth provider will walk through client registration).
- **Claude Code CLI / other clients**: Add a custom connector / remote MCP server pointing at the deployed Worker URL, 
  with the plain-bearer read token as the credential. For the 6 servers that write journal entries, 
  give them the **write** token only.
  
Both flows (OAuth and plain-bearer) work simultaneously; they share the same MCP tools and KV storage.

**Local dev:**

```sh
printf "READ_TOKEN=dev-read\nWRITE_TOKEN=dev-write\n" > .dev.vars
npm run dev
# smoke test with any MCP client, or curl the MCP HTTP endpoint per current transport docs
```

---

## 10. GitHub readiness

The goal: someone can fork the repo, drop in their own `content/`, deploy their own Worker, and get
their own private context memory — **without ever seeing the owner's data.**

- `content/`, `artifacts/`, `.dev.vars`, real `wrangler.toml`, `node_modules/`, `dist/` are all
  gitignored.
- Only `content.example/` (generic templates) is committed.
- README explains: what it is, the Model-B curation philosophy, the security model, and the deploy
  steps from §9, framed as "here's how to run your own."
- Add a short **SECURITY note**: tokens are the only thing between the internet and the owner's
  context; rotate them if leaked; the write token is higher-risk than the read token.
- License: suggest MIT, but leave the final choice to the owner (flag it, don't assume).
- Commit `content.example/` with obviously-fake placeholder data so no real detail leaks by
  accident.

---

## 11. Non-goals / guardrails for the building agent

- Do not add an HTML frontend.
- Do not add a curated-write MCP tool. Promotion stays human-driven and local.
- Do not commit anything from `content/`. If `content/` is missing, fall back to `content.example/`.
- Do not put personal data in URLs, query strings, logs, or cache keys.
- Do not invent citations or reference libraries/APIs you have not verified against current docs.
  If unsure about an MCP/Cloudflare API, check the live docs (Step 0) rather than guessing.
- Keep runtime dependencies minimal; this runs in a V8 isolate.

---

## 12. Open questions to raise with the owner (do not block scaffolding on these)

1. Auth handshake: static bearer token vs OAuth single-user client — resolve against the current
   Claude connector requirement, then confirm the owner's preference.
2. Should `list_journal` be read-token or write-token gated? (Recommend write-token, since it
   exposes raw unpromoted notes.)
3. Final name: keep `identity-kernel` or rename to `context-kernel`?
4. License choice for the public repo.

---

## Suggested skills for the building agent

- **frontend-design** — not needed (no UI). Skip.
- **mcp-builder** (`/mnt/skills/examples/mcp-builder`) — **use this.** It is the guide for building
  high-quality MCP servers in Node/TypeScript; this project is exactly that.
- **skill-creator** (`/mnt/skills/examples/skill-creator`) — use when authoring
  `skill/context-kernel/SKILL.md` in Phase 7.
- **doc-coauthoring** — optional, for polishing the README.

See `CLAUDE.md` in this package for the repo working conventions, and `.claude/agents/` for two
subagents (promotion review + deployed-tool smoke test).
