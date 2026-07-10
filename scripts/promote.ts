#!/usr/bin/env node
// Phase 6 (HANDOFF.md §8 step 6): journal-review CLI for the owner.
//
// What this script does, and does NOT do:
//   - It pulls entries out of the journal buffer (`journal:*` in KV) and
//     prints them for the owner to read.
//   - It lets the owner mark individual entries "reviewed" so they stop
//     cluttering future `--list` runs.
//   - It NEVER writes to `content/` and NEVER touches a curated KV key
//     (`context:full:md`, `section:*:md`, `meta:json`). Promotion into
//     curated context is a manual edit the owner makes by hand, per
//     CLAUDE.md's "No curated-write tool" hard rule and HANDOFF.md §5/§11.
//     This script's job ends at "show me the journal, let me mark entries
//     as reviewed" - it deliberately has no --apply/--auto-promote flag.
//   - It NEVER deletes journal entries in KV. There is intentionally no
//     agent-callable (or owner-callable, from here) delete/update tool for
//     the journal - see src/kv.ts's `appendJournalEntry` doc comment. What
//     counts as "already looked at" is tracked entirely client-side (see
//     "Reviewed-entry tracking" below), which is non-destructive and
//     trivially reversible (delete the tracking file to see everything
//     again).
//
// KV access approach: this runs as a plain Node CLI, not inside the
// Workers runtime, so it cannot import src/kv.ts (that module takes a bound
// `KVNamespace`, which only exists inside workerd). Instead it speaks MCP
// over HTTP to a *running* Worker - local (`wrangler dev`, default
// http://localhost:8787) or deployed (set WORKER_URL) - and calls the
// already-built, already-tested `context_kernel_list_journal` tool using
// the MCP TypeScript SDK's own client (`Client` +
// `StreamableHTTPClientTransport`, the same package already a runtime
// dependency here). This was chosen over shelling out to
// `wrangler kv key list`/`key get` because it reuses tool logic that's
// already covered by test/journal.test.ts (auth gating, entry shape,
// since/limit filtering) instead of re-deriving KV key names and JSON
// shapes in a second place that could drift from src/kv.ts, and it doesn't
// depend on the exact current flag syntax of `wrangler kv key *` (which
// HANDOFF.md's Step 0 already flags as the kind of thing that moves).
// `list_journal` is WRITE_TOKEN-gated (src/mcp/auth.ts), which is fine
// here: this script is meant to run with the owner's write token, the only
// credential the CLI needs.
//
// Reviewed-entry tracking: journal entries themselves aren't curated
// content (HANDOFF.md D2 draws that line at content/), so "stop showing me
// entries I've already looked at" doesn't need a new MCP write tool - that
// would be scope creep against "no curated-write tool" for no reason, since
// this is purely a local presentation concern. Instead this script keeps a
// small local JSON file, `.promoted-ids.json` at the repo root, listing
// journal IDs the owner has marked reviewed via `--mark-reviewed`. It is
// gitignored (added alongside content/, artifacts/, etc.) since it's local
// owner state, not something to share or version. `--list` hides reviewed
// IDs by default; `--all` shows everything regardless of review state.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JournalEntryWithId } from "../src/types.js";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REVIEWED_IDS_PATH = path.join(REPO_ROOT, ".promoted-ids.json");
const DEFAULT_WORKER_URL = "http://localhost:8787";
const MCP_ROUTE = "/mcp";
const LIST_JOURNAL_TOOL = "context_kernel_list_journal";

// --- Reviewed-ID tracking (local file, non-destructive, reversible) -------

/** Read the set of journal IDs the owner has already marked reviewed. Missing/corrupt file -> empty set. */
export function loadReviewedIds(filePath: string = REVIEWED_IDS_PATH): Set<string> {
  if (!existsSync(filePath)) return new Set();
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    if (Array.isArray(raw)) {
      return new Set(raw.filter((entry): entry is string => typeof entry === "string"));
    }
    return new Set();
  } catch {
    // Corrupt tracking file shouldn't crash the CLI - treat as "nothing reviewed yet".
    return new Set();
  }
}

/** Persist the reviewed-ID set, sorted for a stable/diffable file on disk. */
export function saveReviewedIds(ids: Set<string>, filePath: string = REVIEWED_IDS_PATH): void {
  writeFileSync(filePath, `${JSON.stringify([...ids].sort(), null, 2)}\n`);
}

// --- Pure filtering / formatting (unit-testable without a live server) ----

/** Entries to actually show: everything if `includeAll`, else only not-yet-reviewed ones. */
export function filterEntries(
  entries: JournalEntryWithId[],
  reviewedIds: Set<string>,
  includeAll: boolean,
): JournalEntryWithId[] {
  if (includeAll) return entries;
  return entries.filter((entry) => !reviewedIds.has(entry.id));
}

/** Group entries by their `server` field, preserving each group's incoming (oldest-first) order. */
export function groupByServer(entries: JournalEntryWithId[]): Map<string, JournalEntryWithId[]> {
  const groups = new Map<string, JournalEntryWithId[]>();
  for (const entry of entries) {
    const group = groups.get(entry.server);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.server, [entry]);
    }
  }
  return groups;
}

/** One human-readable block for a single journal entry. */
export function formatEntry(entry: JournalEntryWithId): string {
  const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
  return `${entry.timestamp}  ${entry.id}${tags}\n  ${entry.note}`;
}

// --- CLI argument parsing --------------------------------------------------

export interface CliArgs {
  all: boolean;
  markReviewedId: string | null;
}

/** Parse argv (already stripped of `node script.ts`). `--list` is the default action and needs no flag. */
export function parseArgs(argv: string[]): CliArgs {
  let all = false;
  let markReviewedId: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--mark-reviewed") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--mark-reviewed requires a journal entry id argument.");
      }
      markReviewedId = value;
      i++;
    } else if (arg === "--list") {
      // Default action; explicit flag is accepted as a no-op for clarity.
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }

  return { all, markReviewedId };
}

// --- Fetching journal entries over MCP -------------------------------------

/**
 * Call the deployed/local Worker's `context_kernel_list_journal` MCP tool
 * over HTTP and return the parsed entries. Requires a WRITE_TOKEN-scoped
 * bearer token, since `list_journal` is write-gated (src/mcp/auth.ts).
 */
export async function fetchJournalEntries(
  workerUrl: string,
  writeToken: string,
): Promise<JournalEntryWithId[]> {
  const client = new Client({ name: "context-kernel-promote", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_ROUTE, workerUrl), {
    requestInit: { headers: { Authorization: `Bearer ${writeToken}` } },
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: LIST_JOURNAL_TOOL, arguments: {} });

    if (result.isError) {
      const message = extractText(result.content);
      throw new Error(`${LIST_JOURNAL_TOOL} returned an error: ${message}`);
    }

    const text = extractText(result.content);
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error(`${LIST_JOURNAL_TOOL} returned an unexpected shape (expected an array).`);
    }
    return parsed as JournalEntryWithId[];
  } finally {
    await client.close();
  }
}

function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    const first = content[0] as { type?: string; text?: string } | undefined;
    if (first && first.type === "text" && typeof first.text === "string") {
      return first.text;
    }
  }
  return "";
}

// --- Main --------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.markReviewedId !== null) {
    const reviewed = loadReviewedIds();
    reviewed.add(args.markReviewedId);
    saveReviewedIds(reviewed);
    console.log(`Marked ${args.markReviewedId} as reviewed. It will be hidden from future --list runs.`);
    return;
  }

  const workerUrl = process.env.WORKER_URL ?? DEFAULT_WORKER_URL;
  const writeToken = process.env.WRITE_TOKEN;
  if (!writeToken) {
    console.error(
      "WRITE_TOKEN is not set. Export it (matching the deployed/local Worker's secret) before running:\n" +
        "  WRITE_TOKEN=... npm run promote -- --list\n" +
        "For local dev against `wrangler dev`, use the value from .dev.vars.",
    );
    process.exitCode = 1;
    return;
  }

  let entries: JournalEntryWithId[];
  try {
    entries = await fetchJournalEntries(workerUrl, writeToken);
  } catch (err) {
    console.error(`Failed to fetch journal entries from ${workerUrl}${MCP_ROUTE}:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const reviewed = loadReviewedIds();
  const visible = filterEntries(entries, reviewed, args.all);

  if (visible.length === 0) {
    console.log(
      args.all
        ? "Journal is empty."
        : `No unreviewed journal entries (${reviewed.size} already reviewed; ${entries.length} total). Pass --all to see everything.`,
    );
    return;
  }

  const groups = groupByServer(visible);
  const serverNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  for (const server of serverNames) {
    const serverEntries = groups.get(server) ?? [];
    console.log(`\n=== ${server} (${serverEntries.length}) ===`);
    for (const entry of serverEntries) {
      console.log(formatEntry(entry));
      console.log("");
    }
  }

  const suffix = args.all ? "" : ` (of ${entries.length} total; ${reviewed.size} already reviewed)`;
  console.log(`${visible.length} entr${visible.length === 1 ? "y" : "ies"} shown${suffix}.`);
  console.log("Mark an entry reviewed with: npm run promote -- --mark-reviewed <id>");
  console.log("Remember: promotion into content/ is manual - this script only lists and tracks review state.");
}

const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
