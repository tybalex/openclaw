import { describe, expect, it } from "vitest";
import type { OidcVerifier } from "./oidc.js";
import { authorizeGatewayConnect } from "./auth.js";

function createMockOidcVerifier(opts?: {
  user?: string;
  ok?: boolean;
  reason?: string;
}): OidcVerifier {
  return {
    verify: async () => {
      if (opts?.ok === false) {
        return { ok: false, reason: opts.reason ?? "oidc_token_invalid" };
      }
      return {
        ok: true,
        user: opts?.user ?? "oidc-user",
        claims: { sub: opts?.user ?? "oidc-user" },
      };
    },
  };
}

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });

  it("accepts valid OIDC token in oidc mode", async () => {
    const verifier = createMockOidcVerifier({ user: "sso-user@corp.com" });
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "oidc",
        allowTailscale: false,
        oidcConfig: { issuer: "https://idp.example.com", audience: "test" },
      },
      connectAuth: { oidcToken: "valid-jwt" },
      oidcVerifier: verifier,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("oidc");
    expect(res.user).toBe("sso-user@corp.com");
  });

  it("rejects invalid OIDC token in oidc mode", async () => {
    const verifier = createMockOidcVerifier({ ok: false, reason: "oidc_token_expired" });
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "oidc",
        allowTailscale: false,
        oidcConfig: { issuer: "https://idp.example.com", audience: "test" },
      },
      connectAuth: { oidcToken: "expired-jwt" },
      oidcVerifier: verifier,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("oidc_token_expired");
  });

  it("rejects missing OIDC token in oidc mode", async () => {
    const verifier = createMockOidcVerifier();
    const res = await authorizeGatewayConnect({
      auth: {
        mode: "oidc",
        allowTailscale: false,
        oidcConfig: { issuer: "https://idp.example.com", audience: "test" },
      },
      connectAuth: null,
      oidcVerifier: verifier,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("oidc_token_missing");
  });

  it("falls through to token auth when OIDC fails in token mode", async () => {
    const verifier = createMockOidcVerifier({ ok: false, reason: "oidc_token_invalid" });
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret", oidcToken: "bad-jwt" },
      oidcVerifier: verifier,
    });
    // Should fall through to token check and succeed
    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("OIDC succeeds even in token mode when JWT is valid", async () => {
    const verifier = createMockOidcVerifier({ user: "oidc-user" });
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong-token", oidcToken: "good-jwt" },
      oidcVerifier: verifier,
    });
    // OIDC should succeed first, before token check
    expect(res.ok).toBe(true);
    expect(res.method).toBe("oidc");
    expect(res.user).toBe("oidc-user");
  });
});
