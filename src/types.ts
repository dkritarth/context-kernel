// Shared types for the Worker runtime. See HANDOFF.md §4 (KV key scheme) and
// §7 (repo layout: src/types.ts).

/**
 * Workers `Env` binding shape for this Worker. Matches the bindings declared
 * in wrangler.toml(.example): a single KV namespace plus the two auth
 * secrets. This is also structurally compatible with `AuthEnv` from
 * `src/mcp/auth.ts` (which only needs the two token fields), so it can be
 * passed anywhere an `AuthEnv` is expected.
 */
export interface Env {
  /** Curated context (read path) + journal buffer (write path, Phase 5). */
  CONTEXT_KV: KVNamespace;
  READ_TOKEN: string;
  WRITE_TOKEN: string;
}

/**
 * One entry in the `list_sections` tool response. `hash` is a sha256 hex
 * digest of that section's current markdown, computed at read time (not
 * stored in KV), so a client can detect when a section it previously fetched
 * has changed.
 */
export interface SectionInfo {
  name: string;
  hash: string;
}

/**
 * Shape of the `meta:json` KV value. Mirrors the `Meta` interface produced by
 * `scripts/generate-artifacts.ts` (kept in sync by hand: this is a small,
 * stable, rarely-changing shape, and the generator is a Node script that
 * should not be imported into the Workers runtime bundle).
 */
export interface Meta {
  version: number;
  generated_at: string;
  source_rev: string;
  content_hash: string;
}
