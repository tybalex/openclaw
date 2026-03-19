/**
 * OIDC login flow via plugin HTTP routes.
 *
 * Implements PKCE Authorization Code flow against NVIDIA SSO.
 * Tokens are stored in-memory and accessible to enterprise tools.
 *
 * Routes (registered via registerHttpRoute):
 *   GET /nvidia-oidc/login    → redirect to NVIDIA SSO
 *   GET /nvidia-oidc/callback → exchange code for tokens
 *   GET /nvidia-oidc/status   → JSON login status
 *   GET /nvidia-oidc/logout   → clear tokens
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// =============================================================================
// Configuration
// =============================================================================

const OIDC_CONFIG = {
  issuer: process.env.NVIDIA_OIDC_ISSUER ?? "https://stg.login.nvidia.com",
  clientId: process.env.NVIDIA_OIDC_CLIENT_ID ?? "9bONc0-8SKqkjS4GfDZuCLLCOwYGpyX4bOQetfyYzNM",
  scopes: "openid email profile",
};

function resolveCallbackUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${host}/nvidia-oidc/callback`;
}

// =============================================================================
// PKCE Helpers
// =============================================================================

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// =============================================================================
// Token Store (in-memory, per-process)
// =============================================================================

type TokenSet = {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
};

let currentTokens: TokenSet | null = null;
let pendingPkce: { verifier: string; state: string } | null = null;

export function getOidcIdToken(): string | null {
  if (!currentTokens) return null;
  if (Date.now() > currentTokens.expiresAt) return null;
  return currentTokens.idToken;
}

export function getOidcAccessToken(): string | null {
  if (!currentTokens) return null;
  if (Date.now() > currentTokens.expiresAt) return null;
  return currentTokens.accessToken;
}

export function getOidcRefreshToken(): string | null {
  return currentTokens?.refreshToken ?? null;
}

export function getOidcEmail(): string | null {
  return currentTokens?.email ?? null;
}

export function isOidcLoggedIn(): boolean {
  return currentTokens !== null && Date.now() < currentTokens.expiresAt;
}

// =============================================================================
// Token Refresh
// =============================================================================

async function refreshTokens(): Promise<boolean> {
  const rt = currentTokens?.refreshToken;
  if (!rt) return false;

  try {
    const tokenUrl = `${OIDC_CONFIG.issuer}/token`;
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OIDC_CONFIG.clientId,
        refresh_token: rt,
      }),
    });
    if (!res.ok) return false;

    const data = (await res.json()) as Record<string, unknown>;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    currentTokens = {
      idToken: String(data.id_token ?? currentTokens?.idToken ?? ""),
      accessToken: String(data.access_token ?? ""),
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : rt,
      expiresAt: Date.now() + expiresIn * 1000,
      email: currentTokens?.email,
    };
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Combo Getters (with env var fallback + auto-refresh)
// =============================================================================

/** Get SSO token for Glean — prefers OIDC, falls back to env var. */
export function getSSOToken(): string | null {
  // Try OIDC first
  const oidcToken = getOidcIdToken();
  if (oidcToken) return oidcToken;
  // Auto-refresh if we have a refresh token
  const rt = getOidcRefreshToken();
  if (rt) {
    void refreshTokens(); // fire-and-forget, next call will get the new token
  }
  // Fall back to env var
  return process.env.NVIDIA_SSO_TOKEN ?? null;
}

/** Get Azure AD refresh token — prefers OIDC, falls back to env var. */
export function getRefreshToken(): string | null {
  return process.env.AZURE_AD_REFRESH_TOKEN ?? getOidcRefreshToken() ?? null;
}

// =============================================================================
// HTTP Route Handlers
// =============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendRedirect(res: ServerResponse, url: string): void {
  res.writeHead(302, { Location: url });
  res.end();
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}

export function handleLogin(req: IncomingMessage, res: ServerResponse): void {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = crypto.randomBytes(16).toString("hex");
  pendingPkce = { verifier, state };

  const callbackUrl = resolveCallbackUrl(req);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OIDC_CONFIG.clientId,
    redirect_uri: callbackUrl,
    scope: OIDC_CONFIG.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  sendRedirect(res, `${OIDC_CONFIG.issuer}/authorize?${params}`);
}

export async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    sendHtml(
      res,
      `<h2>Login failed</h2><p>${error}: ${url.searchParams.get("error_description") ?? ""}</p><p><a href="/nvidia-oidc/login">Try again</a></p>`,
    );
    return;
  }

  if (!code || !pendingPkce || state !== pendingPkce.state) {
    sendHtml(
      res,
      '<h2>Invalid callback</h2><p>State mismatch or missing code.</p><p><a href="/nvidia-oidc/login">Try again</a></p>',
    );
    return;
  }

  const callbackUrl = resolveCallbackUrl(req);
  const tokenUrl = `${OIDC_CONFIG.issuer}/token`;

  try {
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OIDC_CONFIG.clientId,
        code,
        redirect_uri: callbackUrl,
        code_verifier: pendingPkce.verifier,
      }),
    });

    pendingPkce = null;

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      sendHtml(
        res,
        `<h2>Token exchange failed</h2><pre>${errBody}</pre><p><a href="/nvidia-oidc/login">Try again</a></p>`,
      );
      return;
    }

    const data = (await tokenRes.json()) as Record<string, unknown>;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;

    // Decode email from id_token (JWT payload)
    let email: string | undefined;
    try {
      const idToken = String(data.id_token ?? "");
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
      email = payload.email ?? payload.sub;
    } catch {
      // ignore
    }

    currentTokens = {
      idToken: String(data.id_token ?? ""),
      accessToken: String(data.access_token ?? ""),
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresAt: Date.now() + expiresIn * 1000,
      email,
    };

    sendHtml(
      res,
      `<h2>Login successful</h2><p>Logged in as <strong>${email ?? "unknown"}</strong>.</p><p>You can close this tab. Enterprise tools are now active.</p>`,
    );
  } catch (err) {
    sendHtml(
      res,
      `<h2>Token exchange error</h2><pre>${String(err)}</pre><p><a href="/nvidia-oidc/login">Try again</a></p>`,
    );
  }
}

export function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    loggedIn: isOidcLoggedIn(),
    email: getOidcEmail(),
    expiresAt: currentTokens?.expiresAt ?? null,
    hasRefreshToken: Boolean(currentTokens?.refreshToken),
  });
}

export function handleLogout(_req: IncomingMessage, res: ServerResponse): void {
  currentTokens = null;
  pendingPkce = null;
  sendJson(res, 200, { loggedIn: false });
}
