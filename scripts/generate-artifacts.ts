/// <reference types="node" />
// Phase 2: content/*.md -> artifacts/kv-bulk.json + artifacts/meta.json. See HANDOFF.md §8 phase 2.
//
// Reads every *.md file from content/ (the owner's real, gitignored curated context). If content/
// does not exist, falls back to content.example/ (committed placeholder templates) per HANDOFF.md
// §11: "Do not commit anything from content/. If content/ is missing, fall back to content.example/."
//
// Produces:
//   artifacts/kv-bulk.json  - array of {key, value} objects in the shape `wrangler kv bulk put`
//                              expects (also the shape of the Cloudflare KV bulk-write REST API:
//                              https://developers.cloudflare.com/api/resources/kv/subresources/
//                              namespaces/subresources/keys/methods/bulk_update/ - each item is
//                              {key: string, value: string, base64?, expiration?, expiration_ttl?,
//                              metadata?}; we only ever set key/value).
//   artifacts/meta.json      - the same object stored under the "meta:json" KV key, also written as
//                              a standalone readable file per the HANDOFF.md §3 pipeline diagram.
//
// KV keys produced (HANDOFF.md §4):
//   context:full:md   - all sections concatenated, in filename-sorted order
//   section:<name>:md - one per content file, <name> = filename without ".md"
//   meta:json         - { version, generated_at, source_rev, content_hash }

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const CONTENT_DIR = join(REPO_ROOT, "content");
const CONTENT_EXAMPLE_DIR = join(REPO_ROOT, "content.example");
const ARTIFACTS_DIR = join(REPO_ROOT, "artifacts");

interface KvEntry {
  key: string;
  value: string;
}

interface Meta {
  version: number;
  generated_at: string;
  source_rev: string;
  content_hash: string;
}

/** Directory to read *.md sections from: content/ if present, else content.example/. */
function resolveContentDir(): string {
  try {
    const entries = readdirSync(CONTENT_DIR);
    if (entries.length > 0) return CONTENT_DIR;
  } catch {
    // content/ does not exist - fall through to the example dir.
  }
  return CONTENT_EXAMPLE_DIR;
}

/** Sorted list of {name, text} for every *.md file directly inside dir. */
function readSections(dir: string): { name: string; text: string }[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  return files.map((file) => ({
    name: file.slice(0, -".md".length),
    text: readFileSync(join(dir, file), "utf8"),
  }));
}

/** Best-effort current commit hash; "unknown" if not in a git repo or no commits yet. */
function resolveSourceRev(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function generate(contentDir: string = resolveContentDir()): {
  kvBulk: KvEntry[];
  meta: Meta;
} {
  const sections = readSections(contentDir);

  const fullMarkdown = sections.map((s) => s.text).join("\n\n");

  const kvBulk: KvEntry[] = [
    { key: "context:full:md", value: fullMarkdown },
    ...sections.map((s) => ({ key: `section:${s.name}:md`, value: s.text })),
  ];

  const meta: Meta = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_rev: resolveSourceRev(),
    content_hash: sha256(fullMarkdown),
  };

  kvBulk.push({ key: "meta:json", value: JSON.stringify(meta) });

  return { kvBulk, meta };
}

export function writeArtifacts(
  outDir: string = ARTIFACTS_DIR,
  contentDir: string = resolveContentDir(),
): { kvBulk: KvEntry[]; meta: Meta } {
  const { kvBulk, meta } = generate(contentDir);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "kv-bulk.json"), JSON.stringify(kvBulk, null, 2) + "\n");
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

  return { kvBulk, meta };
}

// Only run when executed directly (`npm run build`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const usedContentDir = resolveContentDir();
  const { kvBulk, meta } = writeArtifacts();
  console.log(
    `generate-artifacts: read sections from ${usedContentDir === CONTENT_DIR ? "content/" : "content.example/"}`,
  );
  console.log(`generate-artifacts: wrote ${kvBulk.length} KV entries to artifacts/kv-bulk.json`);
  console.log(`generate-artifacts: source_rev=${meta.source_rev} content_hash=${meta.content_hash.slice(0, 12)}...`);
}
