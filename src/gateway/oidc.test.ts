import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import type { OidcVerifier } from "./oidc.js";
import { createOidcVerifier } from "./oidc.js";

const TEST_AUDIENCE = "test-client-id";

async function setupTestJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key-1";
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  const jwks = { keys: [publicJwk] };
  return { publicKey, privateKey, jwks };
}

function startJwksServer(jwks: { keys: unknown[] }): Promise<{
  server: Server;
  issuer: string;
  jwksUri: string;
}> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: `http://127.0.0.1:${port}`,
            jwks_uri: `http://127.0.0.1:${port}/.well-known/jwks.json`,
          }),
        );
        return;
      }
      if (req.url === "/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(jwks));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        issuer: baseUrl,
        jwksUri: `${baseUrl}/.well-known/jwks.json`,
      });
    });
  });
}

async function createTestToken(params: {
  privateKey: CryptoKey;
  issuer: string;
  audience: string;
  subject?: string;
  email?: string;
  expiresIn?: string;
  claims?: Record<string, unknown>;
}): Promise<string> {
  let builder = new SignJWT({
    email: params.email,
    ...params.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt()
    .setIssuer(params.issuer)
    .setAudience(params.audience);

  if (params.subject !== undefined) {
    builder = builder.setSubject(params.subject);
  }

  if (params.expiresIn) {
    builder = builder.setExpirationTime(params.expiresIn);
  } else {
    builder = builder.setExpirationTime("1h");
  }

  return builder.sign(params.privateKey);
}

describe("oidc verifier", () => {
  let testKeys: Awaited<ReturnType<typeof setupTestJwks>>;
  let jwksServer: { server: Server; issuer: string; jwksUri: string };
  let verifier: OidcVerifier;

  // Shared setup: start a JWKS server and create a verifier
  const setup = async () => {
    testKeys = await setupTestJwks();
    jwksServer = await startJwksServer(testKeys.jwks);
    verifier = await createOidcVerifier({
      issuer: jwksServer.issuer,
      audience: TEST_AUDIENCE,
      jwksUri: jwksServer.jwksUri,
    });
    return () => {
      jwksServer.server.close();
    };
  };

  it("accepts a valid JWT with correct issuer and audience", async () => {
    const cleanup = await setup();
    try {
      const token = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-123",
        email: "user@example.com",
      });

      const result = await verifier.verify(token);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.user).toBe("user-123");
        expect(result.claims.email).toBe("user@example.com");
      }
    } finally {
      cleanup();
    }
  });

  it("rejects an expired JWT", async () => {
    const cleanup = await setup();
    try {
      // Create a token that expired 1 hour ago
      const token = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
        .setIssuer(jwksServer.issuer)
        .setAudience(TEST_AUDIENCE)
        .setSubject("user-123")
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(testKeys.privateKey);

      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("oidc_token_expired");
      }
    } finally {
      cleanup();
    }
  });

  it("rejects a JWT with wrong audience", async () => {
    const cleanup = await setup();
    try {
      const token = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: "wrong-audience",
        subject: "user-123",
      });

      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("oidc_token_invalid");
      }
    } finally {
      cleanup();
    }
  });

  it("rejects a JWT with wrong issuer", async () => {
    const cleanup = await setup();
    try {
      const token = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: "https://wrong-issuer.example.com",
        audience: TEST_AUDIENCE,
        subject: "user-123",
      });

      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("oidc_token_invalid");
      }
    } finally {
      cleanup();
    }
  });

  it("rejects a JWT signed with a different key", async () => {
    const cleanup = await setup();
    try {
      const { privateKey: otherKey } = await generateKeyPair("RS256");
      const token = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "unknown-key" })
        .setIssuedAt()
        .setIssuer(jwksServer.issuer)
        .setAudience(TEST_AUDIENCE)
        .setSubject("user-123")
        .setExpirationTime("1h")
        .sign(otherKey);

      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects a JWT missing the user claim (sub)", async () => {
    const cleanup = await setup();
    try {
      // Create token without subject
      const token = await new SignJWT({ email: "user@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuedAt()
        .setIssuer(jwksServer.issuer)
        .setAudience(TEST_AUDIENCE)
        .setExpirationTime("1h")
        .sign(testKeys.privateKey);

      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("oidc_user_claim_missing");
      }
    } finally {
      cleanup();
    }
  });

  it("uses custom userClaim when specified", async () => {
    const cleanup = await setup();
    try {
      const customVerifier = await createOidcVerifier({
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        jwksUri: jwksServer.jwksUri,
        userClaim: "email",
      });

      const token = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-123",
        email: "user@example.com",
      });

      const result = await customVerifier.verify(token);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.user).toBe("user@example.com");
      }
    } finally {
      cleanup();
    }
  });

  it("enforces allowedDomains restriction", async () => {
    const cleanup = await setup();
    try {
      const domainVerifier = await createOidcVerifier({
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        jwksUri: jwksServer.jwksUri,
        allowedDomains: ["mycompany.com"],
      });

      // Allowed domain
      const goodToken = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-123",
        email: "user@mycompany.com",
      });
      const goodResult = await domainVerifier.verify(goodToken);
      expect(goodResult.ok).toBe(true);

      // Disallowed domain
      const badToken = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-456",
        email: "user@other.com",
      });
      const badResult = await domainVerifier.verify(badToken);
      expect(badResult.ok).toBe(false);
      if (!badResult.ok) {
        expect(badResult.reason).toBe("oidc_domain_not_allowed");
      }

      // Missing email fails domain check
      const noEmailToken = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-789",
      });
      const noEmailResult = await domainVerifier.verify(noEmailToken);
      expect(noEmailResult.ok).toBe(false);
      if (!noEmailResult.ok) {
        expect(noEmailResult.reason).toBe("oidc_domain_not_allowed");
      }
    } finally {
      cleanup();
    }
  });

  it("enforces allowedEmails restriction", async () => {
    const cleanup = await setup();
    try {
      const emailVerifier = await createOidcVerifier({
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        jwksUri: jwksServer.jwksUri,
        allowedEmails: ["admin@example.com", "dev@example.com"],
      });

      // Allowed email
      const goodToken = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-1",
        email: "admin@example.com",
      });
      const goodResult = await emailVerifier.verify(goodToken);
      expect(goodResult.ok).toBe(true);

      // Case-insensitive match
      const upperToken = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-2",
        email: "Admin@Example.com",
      });
      const upperResult = await emailVerifier.verify(upperToken);
      expect(upperResult.ok).toBe(true);

      // Disallowed email
      const badToken = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-3",
        email: "random@example.com",
      });
      const badResult = await emailVerifier.verify(badToken);
      expect(badResult.ok).toBe(false);
      if (!badResult.ok) {
        expect(badResult.reason).toBe("oidc_email_not_allowed");
      }
    } finally {
      cleanup();
    }
  });

  it("discovers JWKS from well-known endpoint", async () => {
    const cleanup = await setup();
    try {
      // Create verifier without explicit jwksUri — should discover via well-known
      const discoveryVerifier = await createOidcVerifier({
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
      });

      const token = await createTestToken({
        privateKey: testKeys.privateKey,
        issuer: jwksServer.issuer,
        audience: TEST_AUDIENCE,
        subject: "user-discover",
      });

      const result = await discoveryVerifier.verify(token);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.user).toBe("user-discover");
      }
    } finally {
      cleanup();
    }
  });

  it("rejects garbage input", async () => {
    const cleanup = await setup();
    try {
      const result = await verifier.verify("not-a-jwt");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("oidc_token_invalid");
      }
    } finally {
      cleanup();
    }
  });
});
