// MCP tool definitions + handlers. See HANDOFF.md §5.
//
// Read tools (Phase 4): get_context, list_sections, get_meta.
// Write tools (Phase 5): append_journal, list_journal - NOT implemented here yet.
//
// Every handler calls `authorize()` from `./auth.js` before touching KV, per
// HANDOFF.md §6 ("Worker fetch handler checks a bearer token before
// dispatching any MCP request or touching KV"). The Worker also gates at the
// transport level (src/worker.ts): a request with no valid token at all
// (matching neither READ_TOKEN nor WRITE_TOKEN) never reaches these handlers
// and gets a 401 before any MCP dispatch. The per-handler check here is the
// second, finer-grained gate: it rejects a *validly-authenticated-but-wrong-
// scope* token (e.g. a READ_TOKEN calling a write tool) with a normal
// JSON-RPC tool error rather than an HTTP-level failure, since MCP dispatch
// has already legitimately started for that request by the time a specific
// tool is invoked.
//
// Handler bodies are exported as plain async functions (handleGetContext,
// handleListSections, handleGetMeta) separate from the `server.registerTool`
// wiring, so they can be unit-tested directly with a fake KVNamespace
// without spinning up an MCP transport/client - the same testability
// approach auth.ts uses (see test/tools.test.ts).
//
// Tool names are namespaced `context_kernel_*` per HANDOFF.md §5 ("Namespace
// them context_kernel_* if the client shows raw tool names"). The bare names
// (get_context, list_sections, get_meta) are used as the canonical
// `ToolName` passed to authorize() - that identifier is an auth-module
// concept, independent of what the MCP transport exposes to a client.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authorize } from "./auth.js";
import { getFullContext, getMeta as getMetaFromKv, getSection, listSectionNames } from "../kv.js";
import type { Env, SectionInfo } from "../types.js";

/** Everything a tool handler needs: the Worker env (KV + secrets) and the caller's bearer token. */
export interface ToolContext {
  env: Env;
  token: string | null | undefined;
}

/** Minimal MCP tool result shape (subset of the SDK's CallToolResult) used by all handlers below. */
interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function unauthorizedResult(): ToolResult {
  return errorResult("Unauthorized: token does not grant access to this tool.");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * get_context(section?) -> markdown
 * No `section` -> the full curated context. A `section` name that does not
 * exist in KV -> an error result (not an empty string), so a caller can tell
 * "this section is missing/mistyped" apart from "this section is present but
 * empty".
 */
export async function handleGetContext(
  ctx: ToolContext,
  args: { section?: string },
): Promise<ToolResult> {
  if (!(await authorize(ctx.token, "get_context", ctx.env))) return unauthorizedResult();

  if (args.section === undefined) {
    const full = await getFullContext(ctx.env.CONTEXT_KV);
    return textResult(full ?? "");
  }

  const section = await getSection(ctx.env.CONTEXT_KV, args.section);
  if (section === null) {
    return errorResult(`Unknown section: "${args.section}"`);
  }
  return textResult(section);
}

/** list_sections() -> {name, hash}[]. Hash is computed at read time, not stored in KV. */
export async function handleListSections(ctx: ToolContext): Promise<ToolResult> {
  if (!(await authorize(ctx.token, "list_sections", ctx.env))) return unauthorizedResult();

  const names = await listSectionNames(ctx.env.CONTEXT_KV);
  const sections: SectionInfo[] = await Promise.all(
    names.map(async (name) => {
      const text = (await getSection(ctx.env.CONTEXT_KV, name)) ?? "";
      return { name, hash: await sha256Hex(text) };
    }),
  );
  return textResult(JSON.stringify(sections));
}

/** get_meta() -> {version, generated_at, source_rev, content_hash}. */
export async function handleGetMeta(ctx: ToolContext): Promise<ToolResult> {
  if (!(await authorize(ctx.token, "get_meta", ctx.env))) return unauthorizedResult();

  const meta = await getMetaFromKv(ctx.env.CONTEXT_KV);
  if (meta === null) {
    return errorResult("meta:json not found in KV - has `npm run build` been run and uploaded?");
  }
  return textResult(JSON.stringify(meta));
}

/** Wire the read-tool handlers onto an McpServer instance. */
export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "context_kernel_get_context",
    {
      description:
        "Return the owner's curated context as markdown: the full context, or one named section if `section` is given.",
      inputSchema: { section: z.string().optional() },
    },
    async ({ section }) => handleGetContext(ctx, { section }),
  );

  server.registerTool(
    "context_kernel_list_sections",
    {
      description:
        "List the curated context sections currently available, each with a content hash for staleness detection.",
      inputSchema: {},
    },
    async () => handleListSections(ctx),
  );

  server.registerTool(
    "context_kernel_get_meta",
    {
      description: "Return build metadata for the curated context (version, generated_at, source_rev, content_hash).",
      inputSchema: {},
    },
    async () => handleGetMeta(ctx),
  );
}

// Phase 5 adds a parallel `registerWriteTools(server, ctx)` here
// (append_journal, list_journal), called from createServer() below alongside
// registerReadTools. Nothing above needs to change to accommodate it.

/**
 * Build a fresh McpServer with all tools registered, scoped to one request's
 * auth context. MCP SDK >= 1.26 requires a new McpServer instance per
 * request for stateless handlers (sharing one across requests can leak
 * responses between clients) - see src/worker.ts.
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "context-kernel", version: "1.0.0" });
  registerReadTools(server, ctx);
  return server;
}
