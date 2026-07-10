// Unit tests for the read-tool handlers in src/mcp/tools.ts.
//
// These test the exported handler functions (handleGetContext,
// handleListSections, handleGetMeta) directly, not through an MCP
// client/transport. That mirrors the testability approach already used by
// auth.ts/auth.test.ts: no Workers runtime is required, so no
// `@cloudflare/vitest-pool-workers` dependency is added here. The only new
// piece needed is a KVNamespace fake, hand-rolled below since the handlers
// only use three methods (`get`, `get` with "json", and `list`) - adding a
// full Workers-runtime test pool would be a lot of new dependency weight for
// a KV surface this small.

import { describe, expect, it } from "vitest";
import {
  handleGetContext,
  handleGetMeta,
  handleListSections,
  type ToolContext,
} from "../src/mcp/tools.js";
import type { Env, Meta } from "../src/types.js";

/**
 * Minimal in-memory KVNamespace fake covering exactly what src/kv.ts calls:
 * `get(key)`, `get(key, "json")`, and `list({ prefix, cursor })`. Not a full
 * KVNamespace implementation - cast at the boundary where a real one is
 * expected, same as any test double.
 */
class FakeKVNamespace {
  #store = new Map<string, string>();

  set(key: string, value: string): void {
    this.#store.set(key, value);
  }

  async get(key: string, type?: "json"): Promise<unknown> {
    const value = this.#store.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) : value;
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
}

const READ_TOKEN = "test-read-token";
const WRITE_TOKEN = "test-write-token";

function makeEnv(kv: FakeKVNamespace): Env {
  return {
    // FakeKVNamespace only implements the KVNamespace surface src/kv.ts
    // actually calls; cast at this one boundary rather than reimplementing
    // the full (large) real interface.
    CONTEXT_KV: kv as unknown as KVNamespace,
    READ_TOKEN,
    WRITE_TOKEN,
  };
}

function seedKv(): FakeKVNamespace {
  const kv = new FakeKVNamespace();
  kv.set("section:profile:md", "# Profile\n\nHello.");
  kv.set("section:goals:md", "# Goals\n\nShip Phase 4.");
  kv.set(
    "context:full:md",
    "# Profile\n\nHello.\n\n# Goals\n\nShip Phase 4.",
  );
  const meta: Meta = {
    version: 1,
    generated_at: "2026-07-10T00:00:00.000Z",
    source_rev: "abc1234",
    content_hash: "deadbeef".repeat(8),
  };
  kv.set("meta:json", JSON.stringify(meta));
  return kv;
}

function readCtx(env: Env): ToolContext {
  return { env, token: READ_TOKEN };
}

describe("handleGetContext", () => {
  it("returns the full curated context when no section is given", async () => {
    const env = makeEnv(seedKv());
    const result = await handleGetContext(readCtx(env), {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe(
      "# Profile\n\nHello.\n\n# Goals\n\nShip Phase 4.",
    );
  });

  it("returns just one section's markdown when a valid section is given", async () => {
    const env = makeEnv(seedKv());
    const result = await handleGetContext(readCtx(env), { section: "profile" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe("# Profile\n\nHello.");
  });

  it("returns an error result for an unknown section name (not empty string, not 200-ok-empty)", async () => {
    const env = makeEnv(seedKv());
    const result = await handleGetContext(readCtx(env), { section: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("does-not-exist");
  });

  it("rejects a request with no token before touching KV", async () => {
    const kv = seedKv();
    const env = makeEnv(kv);
    const getSpy = kv.get.bind(kv);
    let getCalled = false;
    kv.get = async (...args: Parameters<typeof getSpy>) => {
      getCalled = true;
      return getSpy(...args);
    };

    const result = await handleGetContext({ env, token: null }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unauthorized/i);
    expect(getCalled).toBe(false);
  });

  it("rejects a request with a valid WRITE_TOKEN (wrong scope) before touching KV", async () => {
    const kv = seedKv();
    const env = makeEnv(kv);
    const getSpy = kv.get.bind(kv);
    let getCalled = false;
    kv.get = async (...args: Parameters<typeof getSpy>) => {
      getCalled = true;
      return getSpy(...args);
    };

    const result = await handleGetContext({ env, token: WRITE_TOKEN }, {});
    expect(result.isError).toBe(true);
    expect(getCalled).toBe(false);
  });

  it("rejects a garbage token", async () => {
    const env = makeEnv(seedKv());
    const result = await handleGetContext({ env, token: "garbage" }, {});
    expect(result.isError).toBe(true);
  });
});

describe("handleListSections", () => {
  it("returns expected section names with hashes", async () => {
    const env = makeEnv(seedKv());
    const result = await handleListSections(readCtx(env));
    expect(result.isError).toBeFalsy();
    const sections = JSON.parse(result.content[0]?.text ?? "[]") as {
      name: string;
      hash: string;
    }[];
    const names = sections.map((s) => s.name).sort();
    expect(names).toEqual(["goals", "profile"]);
    for (const section of sections) {
      expect(section.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is unauthorized without a valid read token", async () => {
    const env = makeEnv(seedKv());
    const result = await handleListSections({ env, token: undefined });
    expect(result.isError).toBe(true);
  });
});

describe("handleGetMeta", () => {
  it("returns the expected meta shape", async () => {
    const env = makeEnv(seedKv());
    const result = await handleGetMeta(readCtx(env));
    expect(result.isError).toBeFalsy();
    const meta = JSON.parse(result.content[0]?.text ?? "{}") as Meta;
    expect(meta).toEqual({
      version: 1,
      generated_at: "2026-07-10T00:00:00.000Z",
      source_rev: "abc1234",
      content_hash: "deadbeef".repeat(8),
    });
  });

  it("returns an error result when meta:json is missing", async () => {
    const kv = new FakeKVNamespace(); // empty - simulates an un-built/un-uploaded KV
    const env = makeEnv(kv);
    const result = await handleGetMeta(readCtx(env));
    expect(result.isError).toBe(true);
  });

  it("is unauthorized without a valid read token", async () => {
    const env = makeEnv(seedKv());
    const result = await handleGetMeta({ env, token: "wrong" });
    expect(result.isError).toBe(true);
  });
});
