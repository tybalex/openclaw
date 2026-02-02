import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export type OidcVerifierConfig = {
  issuer: string;
  audience: string;
  jwksUri?: string;
  userClaim?: string;
  allowedDomains?: string[];
  allowedEmails?: string[];
};

export type OidcVerifyResult =
  | { ok: true; user: string; claims: JWTPayload }
  | { ok: false; reason: string };

export type OidcVerifier = {
  verify(token: string): Promise<OidcVerifyResult>;
};

/** Discover the JWKS URI from the issuer's OpenID configuration endpoint. */
async function discoverJwksUri(issuer: string): Promise<string> {
  const wellKnownUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(wellKnownUrl);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: HTTP ${res.status} from ${wellKnownUrl}`);
  }
  const doc = (await res.json()) as { jwks_uri?: string };
  if (!doc.jwks_uri) {
    throw new Error(`OIDC discovery: missing jwks_uri in ${wellKnownUrl}`);
  }
  return doc.jwks_uri;
}

function extractUserClaim(payload: JWTPayload, claim: string): string | undefined {
  const val = payload[claim];
  if (typeof val === "string" && val.trim()) return val.trim();
  return undefined;
}

function checkDomainRestriction(email: string | undefined, allowedDomains: string[]): boolean {
  if (!email) return false;
  return allowedDomains.some((d) => email.endsWith(`@${d}`));
}

function checkEmailAllowlist(email: string | undefined, allowedEmails: string[]): boolean {
  if (!email) return false;
  return allowedEmails.some((e) => e.toLowerCase() === email.toLowerCase());
}

/**
 * Create an OIDC token verifier. Fetches the JWKS from the issuer's well-known
 * endpoint (or a custom jwksUri) at creation time, then validates JWTs using
 * the cached key set.
 */
export async function createOidcVerifier(config: OidcVerifierConfig): Promise<OidcVerifier> {
  const jwksUri = config.jwksUri ?? (await discoverJwksUri(config.issuer));
  const JWKS: JWTVerifyGetKey = createRemoteJWKSet(new URL(jwksUri));
  const userClaim = config.userClaim ?? "sub";
  // Normalize issuer: strip trailing slashes so the jwtVerify iss check
  // matches regardless of whether the config has a trailing slash.
  const normalizedIssuer = config.issuer.replace(/\/+$/, "");

  return {
    async verify(token: string): Promise<OidcVerifyResult> {
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: normalizedIssuer,
          audience: config.audience,
        });

        const user = extractUserClaim(payload, userClaim);
        if (!user) {
          return { ok: false, reason: "oidc_user_claim_missing" };
        }

        const email = typeof payload.email === "string" ? payload.email : undefined;

        if (config.allowedDomains?.length) {
          if (!checkDomainRestriction(email, config.allowedDomains)) {
            return { ok: false, reason: "oidc_domain_not_allowed" };
          }
        }

        if (config.allowedEmails?.length) {
          if (!checkEmailAllowlist(email, config.allowedEmails)) {
            return { ok: false, reason: "oidc_email_not_allowed" };
          }
        }

        return { ok: true, user, claims: payload };
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err ? (err as { code: string }).code : "";
        if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "oidc_token_expired" };
        if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED")
          return { ok: false, reason: "oidc_signature_invalid" };
        return { ok: false, reason: "oidc_token_invalid" };
      }
    },
  };
}
