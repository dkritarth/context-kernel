// Unit tests for the write-tool handlers in src/mcp/tools.ts
// (handleAppendJournal, handleListJournal) plus the underlying KV helpers in
// src/kv.ts (appendJournalEntry, listJournalEntries).
//
// Mirrors the testability approach of test/tools.test.ts: handlers are
// called directly (no MCP transport/client), and KV is a hand-rolled fake.
// Extended here with `put` (and `delete`, unused but included for interface
// completeness) since journal writes need more than the read-only `get`/
// `list` surface Phase 4's fake covered.

import { describe, expect, it } from "vitest";
import { handleAppendJournal, handleListJournal, type ToolContext } from "../src/mcp/tools.js";
import { isValidUlid } from "../src/ulid.js";
import type { Env, JournalEntryWithId } from "../src/types.js";

/**
 * In-memory KVNamespace fake covering what src/kv.ts's journal helpers call:
 * `get(key, "json")`, `put(key, value)`, plus the plain `get`/`list` Phase 4
 * already relied on. Not a full KVNamespace implementation - cast at the
 * boundary where a real one is expected, same as test/tools.test.ts's fake.
 */
class FakeKVNamespace {
  #store = new Map<string, string>();
  putCalls: { key: string; value: string }[] = [];

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.#store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.putCalls.push({ key, value });
    this.#store.set(key, value);
  }

  async list(options: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options.prefix ?? "";
    const keys = [...this.#store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }

  raw(key: string): string | undefined {
    return this.#store.get(key);
  }
}

const READ_TOKEN = "test-read-token";
const WRITE_TOKEN = "test-write-token";

function makeEnv(kv: FakeKVNamespace): Env {
  return {
    CONTEXT_KV: kv as unknown as KVNamespace,
    READ_TOKEN,
    WRITE_TOKEN,
  };
}

function writeCtx(env: Env): ToolContext {
  return { env, token: WRITE_TOKEN };
}

describe("handleAppendJournal", () => {
  it("writes a journal:<ulid> entry and appends to journal:index", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), {
      server: "laptop-1",
      note: "Started reading about ULIDs.",
      tags: ["reading"],
    });

    expect(result.isError).toBeFalsy();
    const { id } = JSON.parse(result.content[0]?.text ?? "{}") as { id: string };
    expect(id).toBeTruthy();

    const stored = kv.raw(`journal:${id}`);
    expect(stored).toBeTruthy();
    const entry = JSON.parse(stored as string);
    expect(entry).toMatchObject({
      server: "laptop-1",
      note: "Started reading about ULIDs.",
      tags: ["reading"],
    });
    expect(typeof entry.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);

    const index = JSON.parse(kv.raw("journal:index") as string) as string[];
    expect(index).toEqual([id]);
  });

  it("defaults tags to [] when omitted", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), {
      server: "laptop-1",
      note: "No tags here.",
    });

    const { id } = JSON.parse(result.content[0]?.text ?? "{}") as { id: string };
    const entry = JSON.parse(kv.raw(`journal:${id}`) as string);
    expect(entry.tags).toEqual([]);
  });

  it("returns a valid ULID as the id", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), {
      server: "laptop-1",
      note: "Check the id shape.",
    });

    const { id } = JSON.parse(result.content[0]?.text ?? "{}") as { id: string };
    expect(isValidUlid(id)).toBe(true);
  });

  it("appends multiple entries to journal:index in call order", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const r1 = await handleAppendJournal(writeCtx(env), { server: "a", note: "first" });
    const r2 = await handleAppendJournal(writeCtx(env), { server: "a", note: "second" });
    const id1 = (JSON.parse(r1.content[0]?.text ?? "{}") as { id: string }).id;
    const id2 = (JSON.parse(r2.content[0]?.text ?? "{}") as { id: string }).id;

    const index = JSON.parse(kv.raw("journal:index") as string) as string[];
    expect(index).toEqual([id1, id2]);
  });

  it("rejects a missing server without touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), { note: "orphan note" });
    expect(result.isError).toBe(true);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects an empty-string server without touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), { server: "   ", note: "note" });
    expect(result.isError).toBe(true);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects a missing note without touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), { server: "laptop-1" });
    expect(result.isError).toBe(true);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects an empty-string note without touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), { server: "laptop-1", note: "" });
    expect(result.isError).toBe(true);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects non-string tags entries without touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(writeCtx(env), {
      server: "laptop-1",
      note: "note",
      tags: ["ok", 42],
    });
    expect(result.isError).toBe(true);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects a request with no token before touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(
      { env, token: null },
      { server: "laptop-1", note: "should not be written" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unauthorized/i);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects a valid READ_TOKEN (wrong scope) before touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(
      { env, token: READ_TOKEN },
      { server: "laptop-1", note: "should not be written" },
    );
    expect(result.isError).toBe(true);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects a garbage token before touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleAppendJournal(
      { env, token: "garbage" },
      { server: "laptop-1", note: "should not be written" },
    );
    expect(result.isError).toBe(true);
    expect(kv.putCalls.length).toBe(0);
  });
});

describe("handleListJournal", () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Entries are seeded with a short real delay between them so their
  // `timestamp` fields (millisecond resolution, set server-side in
  // appendJournalEntry) are guaranteed distinct - otherwise three awaits in
  // a tight loop can all land in the same millisecond, which would make the
  // `since` filter test below flaky/meaningless.
  async function seedThreeEntries(env: Env): Promise<JournalEntryWithId[]> {
    const entries: JournalEntryWithId[] = [];
    for (const [server, note] of [
      ["a", "first note"],
      ["b", "second note"],
      ["c", "third note"],
    ] as const) {
      const result = await handleAppendJournal(writeCtx(env), { server, note });
      const { id } = JSON.parse(result.content[0]?.text ?? "{}") as { id: string };
      const raw = JSON.parse((env.CONTEXT_KV as unknown as FakeKVNamespace).raw(`journal:${id}`) as string);
      entries.push({ id, ...raw });
      await sleep(2);
    }
    return entries;
  }

  it("returns entries in append (chronological) order", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    const seeded = await seedThreeEntries(env);

    const result = await handleListJournal(writeCtx(env), {});
    expect(result.isError).toBeFalsy();
    const entries = JSON.parse(result.content[0]?.text ?? "[]") as JournalEntryWithId[];
    expect(entries.map((e) => e.id)).toEqual(seeded.map((e) => e.id));
    expect(entries.map((e) => e.note)).toEqual(["first note", "second note", "third note"]);
  });

  it("filters by since (inclusive)", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    const seeded = await seedThreeEntries(env);

    const result = await handleListJournal(writeCtx(env), { since: seeded[1]?.timestamp });
    const entries = JSON.parse(result.content[0]?.text ?? "[]") as JournalEntryWithId[];
    expect(entries.map((e) => e.note)).toEqual(["second note", "third note"]);
  });

  it("a since in the future returns no entries", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);

    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
    const result = await handleListJournal(writeCtx(env), { since: future });
    const entries = JSON.parse(result.content[0]?.text ?? "[]") as JournalEntryWithId[];
    expect(entries).toEqual([]);
  });

  it("caps results with limit, keeping the most recent entries in order", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);

    const result = await handleListJournal(writeCtx(env), { limit: 2 });
    const entries = JSON.parse(result.content[0]?.text ?? "[]") as JournalEntryWithId[];
    expect(entries.map((e) => e.note)).toEqual(["second note", "third note"]);
  });

  it("limit larger than the number of entries returns all of them", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);

    const result = await handleListJournal(writeCtx(env), { limit: 100 });
    const entries = JSON.parse(result.content[0]?.text ?? "[]") as JournalEntryWithId[];
    expect(entries.length).toBe(3);
  });

  it("returns an empty array when the journal is empty", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);

    const result = await handleListJournal(writeCtx(env), {});
    const entries = JSON.parse(result.content[0]?.text ?? "[]") as JournalEntryWithId[];
    expect(entries).toEqual([]);
  });

  it("rejects an invalid since string", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);

    const result = await handleListJournal(writeCtx(env), { since: "not-a-date" });
    expect(result.isError).toBe(true);
  });

  it("rejects a negative limit", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);

    const result = await handleListJournal(writeCtx(env), { limit: -1 });
    expect(result.isError).toBe(true);
  });

  it("rejects a request with no token before touching KV", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);
    kv.putCalls = []; // reset: only care about calls made by the rejected request below

    const result = await handleListJournal({ env, token: undefined }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unauthorized/i);
    expect(kv.putCalls.length).toBe(0);
  });

  it("rejects a valid READ_TOKEN (wrong scope) - list_journal is write-gated per HANDOFF §12.2", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);

    const result = await handleListJournal({ env, token: READ_TOKEN }, {});
    expect(result.isError).toBe(true);
  });

  it("rejects a garbage token", async () => {
    const kv = new FakeKVNamespace();
    const env = makeEnv(kv);
    await seedThreeEntries(env);

    const result = await handleListJournal({ env, token: "garbage" }, {});
    expect(result.isError).toBe(true);
  });
});
