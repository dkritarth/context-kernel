// Worker entry point: MCP server over HTTP + OAuth layer.
//
// Dual-mode auth (HANDOFF.md §6 + oauth.ts):
//   - Plain-bearer tokens (READ_TOKEN, WRITE_TOKEN) continue to work as before
//     for Claude Code CLI and trusted servers. These are validated at the /mcp
//     endpoint before any MCP dispatch.
//   - OAuth flow for claude.ai connector UI: clients register via DCR (/.well-known/oauth-protected-resource,
//     /authorize, /token, /register) and receive read-scoped access tokens.
//
// Routing:
//   - OAuth paths (/.well-known/*, /authorize, /token, /register) → OAuthProvider
//   - /mcp → plain-bearer auth + MCP handler (backward-compatible)
//   - Everything else → 404
//
// The OAuthProvider wraps the MCP handler as its `defaultHandler`, so OAuth endpoints
// are routed by the provider and everything else falls through to the MCP handler.
//
// MCP SDK >= 1.26 requires a *new* McpServer instance per request for stateless
// handlers (a fix for a response cross-leak vulnerability). `createServer()` is
// called fresh on every /mcp request, not hoisted to module scope.

import { createMcpHandler } from "agents/mcp";
import { scopesForToken } from "./mcp/auth.js";
import { createServer } from "./mcp/tools.js";
import { createOAuthProvider } from "./mcp/oauth.js";
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

/**
 * MCP handler for plain-bearer token flow (backward-compatible with Claude Code CLI).
 * This is wrapped as the OAuthProvider's defaultHandler, so it gets called for
 * /mcp requests and any other non-OAuth paths.
 */
const mcpHandler: ExportedHandler<Env> = {
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
};

/**
 * OAuth provider instance created at module initialization (not per-request).
 * This is safe because OAuthProvider manages its own state in KV and is
 * stateless across requests. The provider wraps the MCP handler as its
 * defaultHandler to delegate non-OAuth requests.
 */
let oauthProvider: ReturnType<typeof createOAuthProvider> | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Lazy-initialize OAuth provider on first request with the MCP handler.
    if (!oauthProvider) {
      oauthProvider = createOAuthProvider(env, mcpHandler);
    }

    // Route through OAuth provider, which:
    //   - Handles OAuth paths internally
    //   - Delegates /mcp and non-OAuth paths to mcpHandler (defaultHandler)
    return oauthProvider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
