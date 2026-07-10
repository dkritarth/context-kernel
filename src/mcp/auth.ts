// Auth gate for the context-kernel MCP server. See HANDOFF.md §5-6.
//
// Two secrets, two scopes:
//   READ_TOKEN  -> read tools  (get_context, list_sections, get_meta)
//   WRITE_TOKEN -> write tools (append_journal, list_journal)
//
// list_journal is WRITE_TOKEN-gated (not read) because it exposes raw,
// unpromoted journal notes — see HANDOFF.md §5 and §12.2.
//
// Functions here take tokens as plain string params (no Worker `env` object
// required beyond a small shape) so they're unit-testable without a Worker
// runtime, per Phase 3 instructions.

/** The two auth scopes this server recognizes. */
export type Scope = "read" | "write";

/** Minimal shape of the secrets this module needs. Matches Worker env bindings. */
export interface AuthEnv {
  READ_TOKEN: string;
  WRITE_TOKEN: string;
}

/** Read tools: require READ_TOKEN. */
export const READ_TOOLS = ["get_context", "list_sections", "get_meta"] as const;

/**
 * Write tools: require WRITE_TOKEN.
 * list_journal lives here (not in READ_TOOLS) — it's a "list" verb but it
 * reads back raw unpromoted notes, so the owner decided it's write-scoped.
 */
export const WRITE_TOOLS = ["append_journal", "list_journal"] as const;

export type ReadTool = (typeof READ_TOOLS)[number];
export type WriteTool = (typeof WRITE_TOOLS)[number];
export type ToolName = ReadTool | WriteTool;

/** Static map from tool name to the scope required to call it. */
const TOOL_SCOPE: Record<ToolName, Scope> = {
  get_context: "read",
  list_sections: "read",
  get_meta: "read",
  append_journal: "write",
  list_journal: "write",
};

/**
 * Constant-time equality check for two secrets, safe to use in the Workers
 * V8 isolate.
 *
 * Node's `crypto.timingSafeEqual` is not available in Workers. Workers does
 * expose a Cloudflare-specific extension, `crypto.subtle.timingSafeEqual`,
 * but relying on it here would make this function untestable under plain
 * Node/vitest (Node's Web Crypto `SubtleCrypto` does not implement it), and
 * this module is required to be testable without a Worker runtime.
 *
 * Instead we use only standard Web Crypto (`crypto.subtle.digest`), which is
 * present in both Workers (workerd) and Node >= 20: SHA-256-hash both inputs
 * to fixed-length (32-byte) digests, then XOR-accumulate compare the digests
 * with no early exit. Hashing first also means the comparison never branches
 * on the *length* of the secret (a would-be timing leak if we compared raw
 * strings/bytes of unequal length directly).
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);

  // Both are SHA-256 digests, so both are always 32 bytes. No length branch.
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= (bytesA[i] as number) ^ (bytesB[i] as number);
  }
  return diff === 0;
}

/**
 * Resolve which scopes (if any) a provided bearer token grants, by comparing
 * it against both secrets in constant time. Always compares against *both*
 * secrets (no early exit after the first match) so response timing can't be
 * used to infer which secret an invalid token was "closer" to.
 *
 * Returns a Set, not a single Scope, so the pathological case of
 * READ_TOKEN === WRITE_TOKEN (a misconfiguration, not something this module
 * should silently paper over) is represented honestly rather than forcing a
 * single winner.
 */
export async function scopesForToken(
  providedToken: string | null | undefined,
  env: AuthEnv,
): Promise<Set<Scope>> {
  const scopes = new Set<Scope>();

  // Empty/missing tokens are rejected outright. This branches on whether the
  // caller supplied input at all, not on any property of the secrets, so it
  // introduces no secret-dependent timing signal.
  if (!providedToken) {
    return scopes;
  }

  const [matchesRead, matchesWrite] = await Promise.all([
    constantTimeEqual(providedToken, env.READ_TOKEN),
    constantTimeEqual(providedToken, env.WRITE_TOKEN),
  ]);

  if (matchesRead) scopes.add("read");
  if (matchesWrite) scopes.add("write");

  return scopes;
}

/**
 * Authorize a single tool call: does `providedToken` grant the scope that
 * `toolName` requires? This is the one function the Worker fetch handler
 * should call before dispatching any MCP request or touching KV.
 */
export async function authorize(
  providedToken: string | null | undefined,
  toolName: ToolName,
  env: AuthEnv,
): Promise<boolean> {
  const required = TOOL_SCOPE[toolName];
  const granted = await scopesForToken(providedToken, env);
  return granted.has(required);
}
