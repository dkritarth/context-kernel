// Unit tests for the pure logic in scripts/promote.ts: reviewed-id tracking,
// entry filtering/grouping/formatting, and CLI arg parsing.
//
// `fetchJournalEntries` (the MCP-over-HTTP call) is intentionally NOT tested
// here with a live server - it's a thin wrapper around the MCP SDK client
// that's already exercised end-to-end by the mcp-tester subagent against a
// running Worker. What's worth covering with vitest is the logic that runs
// regardless of transport: which entries get shown, in what grouping, and
// how the reviewed-ids file round-trips.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterEntries,
  formatEntry,
  groupByServer,
  loadReviewedIds,
  parseArgs,
  saveReviewedIds,
} from "../scripts/promote.js";
import type { JournalEntryWithId } from "../src/types.js";

function entry(overrides: Partial<JournalEntryWithId> = {}): JournalEntryWithId {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    server: "laptop-1",
    timestamp: "2026-07-01T00:00:00.000Z",
    tags: [],
    note: "A note.",
    ...overrides,
  };
}

describe("filterEntries", () => {
  it("hides reviewed ids by default", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" }), entry({ id: "c" })];
    const reviewed = new Set(["b"]);

    const visible = filterEntries(entries, reviewed, false);

    expect(visible.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("shows everything when includeAll is true, regardless of reviewed state", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    const reviewed = new Set(["a", "b"]);

    const visible = filterEntries(entries, reviewed, true);

    expect(visible.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns everything when nothing has been reviewed yet", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];

    const visible = filterEntries(entries, new Set(), false);

    expect(visible).toHaveLength(2);
  });
});

describe("groupByServer", () => {
  it("groups entries by server, preserving each group's incoming order", () => {
    const entries = [
      entry({ id: "1", server: "laptop-1" }),
      entry({ id: "2", server: "server-a" }),
      entry({ id: "3", server: "laptop-1" }),
    ];

    const groups = groupByServer(entries);

    expect([...groups.keys()].sort()).toEqual(["laptop-1", "server-a"]);
    expect(groups.get("laptop-1")?.map((e) => e.id)).toEqual(["1", "3"]);
    expect(groups.get("server-a")?.map((e) => e.id)).toEqual(["2"]);
  });

  it("returns an empty map for no entries", () => {
    expect(groupByServer([])).toEqual(new Map());
  });
});

describe("formatEntry", () => {
  it("includes timestamp, id, and note", () => {
    const text = formatEntry(entry({ note: "Read about ULIDs." }));

    expect(text).toContain("2026-07-01T00:00:00.000Z");
    expect(text).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(text).toContain("Read about ULIDs.");
  });

  it("appends tags in brackets when present", () => {
    const text = formatEntry(entry({ tags: ["reading", "cloudflare"] }));

    expect(text).toContain("[reading, cloudflare]");
  });

  it("omits the tag bracket entirely when there are no tags", () => {
    const text = formatEntry(entry({ tags: [] }));

    expect(text).not.toContain("[]");
  });
});

describe("parseArgs", () => {
  it("defaults to list mode with all=false and no mark-reviewed id", () => {
    expect(parseArgs([])).toEqual({ all: false, markReviewedId: null });
  });

  it("accepts --list as an explicit no-op", () => {
    expect(parseArgs(["--list"])).toEqual({ all: false, markReviewedId: null });
  });

  it("sets all=true for --all", () => {
    expect(parseArgs(["--all"])).toEqual({ all: true, markReviewedId: null });
  });

  it("captures the id after --mark-reviewed", () => {
    expect(parseArgs(["--mark-reviewed", "01ARZ3NDEKTSV4RRFFQ69G5FAV"])).toEqual({
      all: false,
      markReviewedId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
  });

  it("throws when --mark-reviewed has no id argument", () => {
    expect(() => parseArgs(["--mark-reviewed"])).toThrow();
  });

  it("throws when --mark-reviewed is followed by another flag", () => {
    expect(() => parseArgs(["--mark-reviewed", "--all"])).toThrow();
  });

  it("throws on an unrecognized argument", () => {
    expect(() => parseArgs(["--bogus"])).toThrow();
  });
});

describe("loadReviewedIds / saveReviewedIds", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "promote-test-"));
    filePath = join(dir, ".promoted-ids.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty set when the file does not exist", () => {
    expect(loadReviewedIds(filePath)).toEqual(new Set());
  });

  it("round-trips ids through save then load", () => {
    saveReviewedIds(new Set(["b", "a", "c"]), filePath);

    expect(loadReviewedIds(filePath)).toEqual(new Set(["a", "b", "c"]));
  });

  it("writes ids sorted, for a stable diffable file", () => {
    saveReviewedIds(new Set(["z", "a", "m"]), filePath);

    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).toEqual(["a", "m", "z"]);
  });

  it("treats a corrupt file as an empty set rather than throwing", () => {
    saveReviewedIds(new Set(["a"]), filePath);
    // Overwrite with invalid JSON.
    writeFileSync(filePath, "not json");

    expect(loadReviewedIds(filePath)).toEqual(new Set());
  });

  it("treats a JSON file that isn't an array as an empty set", () => {
    writeFileSync(filePath, JSON.stringify({ not: "an array" }));

    expect(loadReviewedIds(filePath)).toEqual(new Set());
  });
});
