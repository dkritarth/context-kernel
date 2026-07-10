// Worker entry point: MCP server over HTTP, token-gated. See HANDOFF.md §5-6.
//
// Pattern used: `createMcpHandler` from the Cloudflare Agents SDK
// (`agents/mcp`), which builds a *stateless* MCP fetch handler backed by the
// MCP TypeScript SDK's streamable-HTTP transport - no Durable Object
// required. Confirmed against current docs on 2026-07-10:
//   https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
//     ("Use it when you want a stateless MCP server that runs in a plain
//     Worker (no Durable Object). For stateful MCP servers ... use the
//     McpAgent class instead.")
// This project has no per-session state to persist (every read tool is a
// pure KV lookup keyed only by the request's own arguments), so the
// stateless handler is the right fit and keeps the dependency footprint to
// `agents` + `@modelcontextprotocol/sdk` + `zod` - no `durable_objects`
// binding or SQLite migration needed in wrangler.toml.
//
// MCP SDK >= 1.26 requires a *new* McpServer instance per request for
// stateless handlers (a fix for a response cross-leak vulnerability - see
// the handler-api doc above), so `createServer()` is called fresh on every
// `fetch`, not hoisted to module scope.
//
// Auth handshake: static bearer token (`Authorization: Bearer <token>`),
// per the owner's locked decision in HANDOFF.md §6 and §12.1. Checked
// against Anthropic's current MCP connector docs
// (https://platform.claude.com/docs/en/agents-and-tools/mcp-connector,
// 2026-07-10): the API's `mcp_servers[].authorization_token` field is sent
// as a plain bearer credential to the server URL - there is no requirement
// that a remote MCP server implement an OAuth flow itself; OAuth is only
// what the *caller* uses to obtain that token when calling a third-party
// service, not a protocol requirement this server must speak. A static,
// owner-issued token is exactly the "already have a token" case that field
// exists for, so HANDOFF's bearer-token assumption stands - no deviation.
// (Cloudflare's own "Securing MCP servers" guide only documents the OAuth-
// proxy pattern for servers fronting third-party providers like GitHub,
// which does not apply here - there is no third party to proxy to.)
//
// Two-layer auth, per HANDOFF.md §6 ("checks a bearer token before
// dispatching any MCP request or touching KV. Unauthorized -> 401, no KV
// read"):
//   1. Here: a token that matches *neither* READ_TOKEN nor WRITE_TOKEN is
//      rejected with a bare 401 before createMcpHandler/KV is ever touched.
//   2. In src/mcp/tools.ts: each individual tool handler re-checks that the
//      token's scope matches what *that* tool requires (e.g. a valid
//      READ_TOKEN must still be refused by a future write tool). That
//      mismatch surfaces as a normal JSON-RPC tool-call error, not a second
//      HTTP-level 401, since MCP dispatch has legitimately started by then.

import { createMcpHandler } from "agents/mcp";
import { scopesForToken } from "./mcp/auth.js";
import { createServer } from "./mcp/tools.js";
import type { Env } from "./types.js";

const MCP_ROUTE = "/mcp";

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="context-kernel"' },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== MCP_ROUTE) {
      return new Response("Not found", { status: 404 });
    }

    const token = extractBearerToken(request);
    const scopes = await scopesForToken(token, env);

    // Layer 1: no token, or a token that matches neither secret at all.
    // Reject before any MCP dispatch and before any KV read.
    if (scopes.size === 0) {
      return unauthorized();
    }

    // New McpServer per request (see file header) with tool handlers closed
    // over this request's token; per-tool scope enforcement (layer 2)
    // happens inside each handler via authorize().
    const server = createServer({ env, token });
    const response = await createMcpHandler(server, { route: MCP_ROUTE })(request, env, ctx);

    // Token-gated responses: never cache across users/tokens at a shared
    // proxy, but allow a short private cache per HANDOFF.md §6.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, max-age=60");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
