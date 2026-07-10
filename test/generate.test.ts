/// <reference types="node" />
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generate } from "../scripts/generate-artifacts.js";

const CONTENT_EXAMPLE_DIR = join(import.meta.dirname, "..", "content.example");

describe("generate-artifacts", () => {
  it("produces the expected KV keys from content.example/", () => {
    const { kvBulk } = generate(CONTENT_EXAMPLE_DIR);
    const keys = kvBulk.map((e) => e.key);

    expect(keys).toContain("context:full:md");
    expect(keys).toContain("meta:json");

    // One section:<name>:md per file in content.example/.
    const expectedSections = [
      "answer-prefs",
      "current-work",
      "env-constants",
      "figure-prefs",
      "goals",
      "profile",
      "resume",
      "skills",
      "writing-prefs",
    ];
    for (const name of expectedSections) {
      expect(keys).toContain(`section:${name}:md`);
    }

    // No unexpected extra keys.
    expect(keys.sort()).toEqual(
      ["context:full:md", "meta:json", ...expectedSections.map((n) => `section:${n}:md`)].sort(),
    );
  });

  it("context:full:md contains content from every section file", () => {
    const { kvBulk } = generate(CONTENT_EXAMPLE_DIR);
    const full = kvBulk.find((e) => e.key === "context:full:md")!;
    const sections = kvBulk.filter((e) => e.key.startsWith("section:"));

    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(full.value).toContain(section.value.trim());
    }
  });

  it("meta:json has the expected shape", () => {
    const { kvBulk, meta } = generate(CONTENT_EXAMPLE_DIR);
    const metaEntry = kvBulk.find((e) => e.key === "meta:json")!;
    const parsed = JSON.parse(metaEntry.value);

    expect(parsed).toEqual(meta);
    expect(typeof meta.version).toBe("number");
    expect(typeof meta.generated_at).toBe("string");
    expect(() => new Date(meta.generated_at).toISOString()).not.toThrow();
    expect(new Date(meta.generated_at).toISOString()).toBe(meta.generated_at);
    expect(typeof meta.source_rev).toBe("string");
    expect(typeof meta.content_hash).toBe("string");
    expect(meta.content_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  describe("content_hash", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "context-kernel-test-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("is stable when content is unchanged", () => {
      writeFileSync(join(dir, "profile.md"), "# Profile\n\nHello.\n");
      const a = generate(dir).meta.content_hash;
      const b = generate(dir).meta.content_hash;
      expect(a).toBe(b);
    });

    it("changes when content changes", () => {
      writeFileSync(join(dir, "profile.md"), "# Profile\n\nHello.\n");
      const before = generate(dir).meta.content_hash;

      writeFileSync(join(dir, "profile.md"), "# Profile\n\nHello, changed.\n");
      const after = generate(dir).meta.content_hash;

      expect(after).not.toBe(before);
    });
  });

  it("falls back to content.example/ shape when given a directory with the same layout", () => {
    // Sanity check that generate() is a pure function of the directory passed in, not of cwd.
    const dir = mkdtempSync(join(tmpdir(), "context-kernel-test-"));
    try {
      writeFileSync(join(dir, "only-section.md"), "# Only section\n\nContent.\n");
      const { kvBulk } = generate(dir);
      const keys = kvBulk.map((e) => e.key);
      expect(keys).toEqual(["context:full:md", "section:only-section:md", "meta:json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
