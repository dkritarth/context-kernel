// Minimal ULID (Universally Unique Lexicographically Sortable Identifier)
// generator, implemented locally rather than pulling in a dependency.
//
// Why hand-rolled instead of a package: the two well-known options on npm
// (`ulid`, `ulidx`) are tiny, but so is the spec - a ULID is just a 48-bit
// millisecond timestamp + 80 bits of randomness, Crockford Base32-encoded to
// 26 characters. Implementing it directly with the Web Crypto API
// (`crypto.getRandomValues`, available in both Workers/workerd and Node >=
// 20's vitest environment - no Node-only APIs) keeps this project's stated
// "keep runtime dependencies minimal" rule (CLAUDE.md) satisfied without
// trading a two-function surface for a whole extra package + its transitive
// tree, and it means one fewer supply-chain dependency for a server that
// holds someone's personal context.
//
// This matters for journal:index ordering specifically: journal:<ulid> keys
// need to sort chronologically as *strings* (KV list() and a JSON array both
// only give you string/insertion order, not a real sort-by-timestamp query),
// which is exactly what ULID's encoding guarantees - unlike a random UUID or
// a bare Date.now() counter (which collides under concurrent writes and
// isn't opaque/unguessable on its own).
//
// Monotonicity within the same millisecond: the spec's optional monotonic
// increment-the-random-part scheme requires persisting the last generated
// ULID across calls, which is meaningful for a hot loop generating many IDs
// per millisecond. This server appends journal entries one MCP tool call at
// a time (network round-trip per call), so two entries landing in the same
// millisecond is already astronomically unlikely; plain fresh randomness
// per call is sufficient and keeps the generator stateless/side-effect-free.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32 (no I, L, O, U)
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(time: number): string {
  let mutableTime = time;
  let str = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = mutableTime % 32;
    str = ENCODING[mod] + str;
    mutableTime = (mutableTime - mod) / 32;
  }
  return str;
}

function encodeRandom(): string {
  // 80 bits of randomness = 10 bytes, encoded 5 bits at a time (16 chars).
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);

  // Treat the 10 bytes as a big-endian 80-bit integer and emit 5-bit groups,
  // most-significant first, via a running bit buffer.
  let str = "";
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let byteIndex = 0;

  while (str.length < RANDOM_LEN) {
    if (bitsInBuffer < 5) {
      bitBuffer = (bitBuffer << 8) | (bytes[byteIndex] as number);
      bitsInBuffer += 8;
      byteIndex++;
    }
    bitsInBuffer -= 5;
    const index = (bitBuffer >> bitsInBuffer) & 0x1f;
    str += ENCODING[index];
  }

  return str;
}

/**
 * Generate a new ULID: 26 Crockford-Base32 characters, the first 10 encoding
 * the current millisecond timestamp (lexicographically sortable), the last
 * 16 encoding 80 bits of cryptographically-random data.
 */
export function newUlid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** True if `value` has the shape of a valid ULID (26 chars, Crockford Base32 alphabet). */
export function isValidUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
