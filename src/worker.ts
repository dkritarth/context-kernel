// Worker entry point: MCP server over HTTP + OAuth layer. See HANDOFF.md §5-6.
//
// Dual-mode auth:
//   - Plain-bearer tokens (READ_TOKEN, WRITE_TOKEN) continue to work as before
//     for Claude Code CLI and trusted servers.
//   - OAuth flow for claude.ai connector UI: clients register via DCR
//     (/.well-known/oauth-authorization-server, /authorize, /token, /register)
//     and receive read-scoped access tokens.
//
// Both flows converge on /mcp, which the OAuthProvider library intercepts as
// an "API route" (`apiRoute`/`apiHandler`). The library validates whatever
// token is presented — either one it issued itself via the OAuth flow, or a
// plain-bearer token resolved via `resolveExternalToken` (see mcp/oauth.ts)
// — and only then invokes `apiHandler` with the resolved scope in
// `ctx.props`. Requests to /mcp without a valid token, and all non-API
// paths, fall through to `defaultHandler`.
//
// Pattern: `createMcpHandler` from Cloudflare Agents SDK (`agents/mcp`),
// stateless MCP server with no Durable Object. MCP SDK >= 1.26 requires
// a new McpServer per request, so `createServer()` is called fresh on
// every /mcp request.

import { createMcpHandler } from "agents/mcp";
import { createServer } from "./mcp/tools.js";
import { createOAuthProvider, handleAuthorize } from "./mcp/oauth.js";
import type { Env } from "./types.js";

const MCP_ROUTE = "/mcp";
const AUTHORIZE_ROUTE = "/authorize";

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="context-kernel"' },
  });
}

/** Props the library attaches to ctx after resolving a token at apiRoute. */
interface AuthedProps {
  scope?: string[];
  originalScopes?: string[];
}

/**
 * Handler for authenticated /mcp requests (apiHandler). The library has
 * already validated the presented token — either an OAuth-issued token
 * (props.scope = ["read"], no originalScopes) or a plain-bearer token
 * resolved via resolveExternalToken (props.originalScopes carries what the
 * raw token actually matched: "read" and/or "write").
 *
 * We can't hand the OAuth library's opaque token to createServer/authorize()
 * — those compare against the real READ_TOKEN/WRITE_TOKEN secrets — so we
 * synthesize the equivalent real secret from the resolved scope instead.
 * This preserves write access for the CLI's plain-bearer WRITE_TOKEN (via
 * originalScopes) while pure OAuth grants (claude.ai) stay read-only.
 */
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx.props as AuthedProps | undefined) ?? {};
    const scope = props.scope ?? [];
    const originalScopes = props.originalScopes ?? [];

    if (!scope.includes("read")) {
      return unauthorized();
    }

    const syntheticToken = originalScopes.includes("write") ? env.WRITE_TOKEN : env.READ_TOKEN;
    const server = createServer({ env, token: syntheticToken });
    const response = await createMcpHandler(server, { route: MCP_ROUTE })(request, env, ctx);

    // Token-gated responses: never cache across users/tokens at a shared proxy,
    // but allow a short private cache per HANDOFF.md §6.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, max-age=60");
    return new Response(response.body, { status: response.status, headers });
  },
};

/**
 * Fallback for non-API paths and for /mcp requests that failed token
 * resolution. /mcp with no valid token → 401; /authorize → the login form
 * (see mcp/oauth.ts, since the library only reports this URL and expects
 * the app to implement it); everything else → 404.
 */
const defaultHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MCP_ROUTE) {
      return unauthorized();
    }
    if (url.pathname === AUTHORIZE_ROUTE) {
      return handleAuthorize(request, env, apiHandler, defaultHandler, url);
    }
    return new Response("Not found", { status: 404 });
  },
};

/**
 * OAuth provider instance created at module initialization (not per-request).
 * This is safe because OAuthProvider manages its own state in KV and is
 * stateless across requests.
 */
let oauthProvider: ReturnType<typeof createOAuthProvider> | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Lazy-initialize OAuth provider on first request.
    if (!oauthProvider) {
      oauthProvider = createOAuthProvider(env, apiHandler, defaultHandler, new URL(request.url));
    }
    return oauthProvider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
