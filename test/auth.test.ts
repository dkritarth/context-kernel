import { describe, expect, it } from "vitest";
import {
  authorize,
  READ_TOOLS,
  scopesForToken,
  WRITE_TOOLS,
  type AuthEnv,
} from "../src/mcp/auth.js";

const env: AuthEnv = {
  READ_TOKEN: "test-read-token-abc123",
  WRITE_TOKEN: "test-write-token-xyz789",
};

describe("auth", () => {
  describe("valid READ_TOKEN", () => {
    for (const tool of READ_TOOLS) {
      it(`grants access to read tool "${tool}"`, async () => {
        expect(await authorize(env.READ_TOKEN, tool, env)).toBe(true);
      });
    }

    for (const tool of WRITE_TOOLS) {
      it(`denies access to write tool "${tool}"`, async () => {
        expect(await authorize(env.READ_TOKEN, tool, env)).toBe(false);
      });
    }
  });

  describe("valid WRITE_TOKEN", () => {
    for (const tool of WRITE_TOOLS) {
      it(`grants access to write tool "${tool}"`, async () => {
        expect(await authorize(env.WRITE_TOKEN, tool, env)).toBe(true);
      });
    }

    it("grants access to list_journal specifically", async () => {
      expect(await authorize(env.WRITE_TOKEN, "list_journal", env)).toBe(true);
    });

    for (const tool of READ_TOOLS) {
      it(`denies access to read tool "${tool}" (write token is not a superset)`, async () => {
        expect(await authorize(env.WRITE_TOKEN, tool, env)).toBe(false);
      });
    }
  });

  describe("invalid/garbage token", () => {
    const garbage = "this-is-not-a-real-token-at-all";

    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      it(`denies access to "${tool}"`, async () => {
        expect(await authorize(garbage, tool, env)).toBe(false);
      });
    }

    it("resolves to an empty scope set", async () => {
      const scopes = await scopesForToken(garbage, env);
      expect(scopes.size).toBe(0);
    });

    it("denies a token that is a near-miss (off by one char) of READ_TOKEN", async () => {
      const nearMiss = env.READ_TOKEN.slice(0, -1) + "X";
      expect(await authorize(nearMiss, "get_context", env)).toBe(false);
    });

    it("denies a token that is a prefix of a real token", async () => {
      const prefix = env.WRITE_TOKEN.slice(0, 5);
      expect(await authorize(prefix, "append_journal", env)).toBe(false);
    });
  });

  describe("empty/missing token", () => {
    for (const badToken of ["", null, undefined] as const) {
      for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
        it(`denies access to "${tool}" for token=${JSON.stringify(badToken)}`, async () => {
          expect(await authorize(badToken, tool, env)).toBe(false);
        });
      }
    }

    it("resolves to an empty scope set for an empty string", async () => {
      const scopes = await scopesForToken("", env);
      expect(scopes.size).toBe(0);
    });
  });

  describe("scope isolation (core security property, D4)", () => {
    it("a READ_TOKEN cannot invoke append_journal", async () => {
      expect(await authorize(env.READ_TOKEN, "append_journal", env)).toBe(false);
    });

    it("a READ_TOKEN cannot invoke list_journal", async () => {
      expect(await authorize(env.READ_TOKEN, "list_journal", env)).toBe(false);
    });

    it("scopesForToken(READ_TOKEN) contains 'read' and not 'write'", async () => {
      const scopes = await scopesForToken(env.READ_TOKEN, env);
      expect(scopes.has("read")).toBe(true);
      expect(scopes.has("write")).toBe(false);
    });

    it("scopesForToken(WRITE_TOKEN) contains 'write' and not 'read'", async () => {
      const scopes = await scopesForToken(env.WRITE_TOKEN, env);
      expect(scopes.has("write")).toBe(true);
      expect(scopes.has("read")).toBe(false);
    });

    it("READ_TOKEN and WRITE_TOKEN are never valid for each other's tool set, exhaustively", async () => {
      for (const tool of READ_TOOLS) {
        expect(await authorize(env.WRITE_TOKEN, tool, env)).toBe(false);
      }
      for (const tool of WRITE_TOOLS) {
        expect(await authorize(env.READ_TOKEN, tool, env)).toBe(false);
      }
    });
  });
});
