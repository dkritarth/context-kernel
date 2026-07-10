// KV read helpers matching the key scheme in HANDOFF.md §4 / CLAUDE.md:
//   context:full:md    - full curated context, concatenated markdown
//   section:<name>:md  - one curated section
//   meta:json          - { version, generated_at, source_rev, content_hash }
//
// Phase 4 is read-only. Write helpers for the journal (journal:<ulid>,
// journal:index) land in Phase 5.
//
// Kept thin and dependency-free (no logic beyond key-shape + KV calls) so
// tools.ts stays the place that decides what a "not found" means for a given
// tool.

import type { Meta } from "./types.js";

const FULL_CONTEXT_KEY = "context:full:md";
const META_KEY = "meta:json";
const SECTION_PREFIX = "section:";
const SECTION_SUFFIX = ":md";

/** Build the KV key for a named section. */
export function sectionKey(name: string): string {
  return `${SECTION_PREFIX}${name}${SECTION_SUFFIX}`;
}

/** Full curated context (all sections concatenated). `null` if unset/unbuilt. */
export async function getFullContext(kv: KVNamespace): Promise<string | null> {
  return kv.get(FULL_CONTEXT_KEY);
}

/** One curated section's markdown by name. `null` if that section does not exist. */
export async function getSection(kv: KVNamespace, name: string): Promise<string | null> {
  return kv.get(sectionKey(name));
}

/**
 * Names of every curated section currently in KV, sorted. Derived by listing
 * `section:*:md` keys rather than reading a separate index, since
 * `scripts/generate-artifacts.ts` does not maintain one.
 */
export async function listSectionNames(kv: KVNamespace): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await kv.list({ prefix: SECTION_PREFIX, cursor });
    for (const key of page.keys) {
      if (key.name.endsWith(SECTION_SUFFIX)) {
        names.push(key.name.slice(SECTION_PREFIX.length, -SECTION_SUFFIX.length));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return names.sort();
}

/** Build metadata (version, generated_at, source_rev, content_hash). `null` if unset/unbuilt. */
export async function getMeta(kv: KVNamespace): Promise<Meta | null> {
  return kv.get<Meta>(META_KEY, "json");
}
