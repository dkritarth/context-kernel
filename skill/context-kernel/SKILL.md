---
name: context-kernel
description: |
  Use at the start of a session, or the first time the user references their own background,
  goals, current work, or preferences, to pull the owner's curated personal context from the
  context-kernel MCP connector. This is the owner's private memory (identity, goals, current
  work, resume, writing/figure/answer preferences, skills, env constants) — not a general
  knowledge or web-search tool, and not relevant to tasks that don't touch who the owner is or
  how they work.
---

# context-kernel

A thin pointer skill. The memory itself lives behind the `context-kernel` MCP connector; this
skill's only job is to steer Claude to read it early and treat it as authoritative.

## What to do

1. Early in a session — ideally before responding to the user's first substantive request — check
   whether the `context-kernel` MCP connector is available.
2. If available, call `context_kernel_get_context` once, with no arguments, to fetch the full
   curated context. If you only need one part (e.g. the user asks specifically about writing style
   or how to format an answer), call it with `section` set to the relevant section name instead
   (`profile`, `goals`, `current-work`, `resume`, `writing-prefs`, `figure-prefs`, `answer-prefs`,
   `skills`, `env-constants`).
3. Treat the returned Markdown as authoritative context about the owner: identity, goals, current
   work, resume, writing/figure/answer preferences, skills, and env constants. Prefer it over
   assumptions or anything stated generically elsewhere.
4. If the connector isn't configured, isn't reachable, or the call fails, proceed without it.
   Don't error out, don't retry repeatedly, and don't mention the failure to the user unless it's
   directly relevant to their request.

## What not to do

This skill is about reading context, not writing to it. Do not call `context_kernel_append_journal`
proactively or as part of routine session start — the journal is owner-curated raw material, and
auto-appending low-value notes on every session defeats the point of the manual promotion gate
(see this repo's `CLAUDE.md` and `content` rules). Only append a journal note when the user
explicitly asks you to remember or note something for later, the same bar Claude's own memory
features use for writing anything down.
