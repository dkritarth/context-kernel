// KV helpers matching the key scheme in HANDOFF.md §4 / CLAUDE.md:
//   context:full:md    - full curated context, concatenated markdown
//   section:<name>:md  - one curated section
//   meta:json          - { version, generated_at, source_rev, content_hash }
//   journal:<ulid>     - one journal entry (JSON: server, timestamp, tags, note)
//   journal:index      - ordered JSON array of journal ULIDs, append-only
//
// Phase 4 covered the read path (curated context). Phase 5 adds the journal
// write path below - append-only, never touches the curated keys above (see
// CLAUDE.md's "no curated-write tool" hard rule).
//
// Kept thin and dependency-free (no logic beyond key-shape + KV calls) so
// tools.ts stays the place that decides what a "not found"/validation error
// means for a given tool.

import { newUlid } from "./ulid.js";
import type { JournalEntry, JournalEntryWithId, Meta } from "./types.js";

const FULL_CONTEXT_KEY = "context:full:md";
const META_KEY = "meta:json";
const SECTION_PREFIX = "section:";
const SECTION_SUFFIX = ":md";
const JOURNAL_PREFIX = "journal:";
const JOURNAL_INDEX_KEY = "journal:index";

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

/** Build the KV key for a journal entry. `id` is expected to be a ULID (see src/ulid.ts). */
export function journalKey(id: string): string {
  return `${JOURNAL_PREFIX}${id}`;
}

/** Read the current `journal:index` array (ULIDs, oldest first). `[]` if unset. */
async function getJournalIndex(kv: KVNamespace): Promise<string[]> {
  const index = await kv.get<string[]>(JOURNAL_INDEX_KEY, "json");
  return index ?? [];
}

/**
 * Append one journal entry: writes `journal:<ulid>` and appends the new
 * ULID to `journal:index`.
 *
 * Append-only, matching HANDOFF.md's D2 (agents extend the journal, never
 * curated content) - this function has no update/delete counterpart.
 *
 * Not transactional across the two `put`s: KV has no multi-key transaction
 * primitive, and this server has a single owner appending from a handful of
 * trusted servers (not a high-concurrency multi-writer system), so a rare
 * lost update to `journal:index` under truly concurrent writes is an
 * accepted tradeoff rather than something worth a distributed-lock
 * workaround. If it ever matters, `listJournalEntries` could fall back to
 * `kv.list({ prefix: "journal:" })` (minus the index key itself) to
 * reconcile - not implemented here since HANDOFF.md calls the index only a
 * fast-listing optimization.
 */
export async function appendJournalEntry(
  kv: KVNamespace,
  input: { server: string; note: string; tags?: string[] },
): Promise<JournalEntryWithId> {
  const id = newUlid();
  const entry: JournalEntry = {
    server: input.server,
    timestamp: new Date().toISOString(),
    tags: input.tags ?? [],
    note: input.note,
  };

  await kv.put(journalKey(id), JSON.stringify(entry));

  const index = await getJournalIndex(kv);
  index.push(id);
  await kv.put(JOURNAL_INDEX_KEY, JSON.stringify(index));

  return { id, ...entry };
}

/**
 * List journal entries via `journal:index`, oldest first, optionally
 * filtered by `since` (inclusive, compares `entry.timestamp >= since` as
 * ISO 8601 strings - safe because ISO 8601 with a fixed UTC `Z` offset
 * sorts lexicographically the same as chronologically) and capped by
 * `limit`.
 *
 * `limit` returns the `limit` *most recent* matching entries (not the
 * oldest) - the more useful default for "what's new since I last checked",
 * per §5's promotion-workflow use case - while the returned array itself
 * stays in oldest-first order.
 */
export async function listJournalEntries(
  kv: KVNamespace,
  filter: { since?: string; limit?: number } = {},
): Promise<JournalEntryWithId[]> {
  const ids = await getJournalIndex(kv);

  const entries = await Promise.all(
    ids.map(async (id) => {
      const entry = await kv.get<JournalEntry>(journalKey(id), "json");
      return entry ? { id, ...entry } : null;
    }),
  );

  let result = entries.filter((e): e is JournalEntryWithId => e !== null);

  if (filter.since !== undefined) {
    result = result.filter((e) => e.timestamp >= filter.since!);
  }

  if (filter.limit !== undefined) {
    result = result.slice(Math.max(0, result.length - filter.limit));
  }

  return result;
}
