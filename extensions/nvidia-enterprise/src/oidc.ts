/**
 * Azure AD OAuth login flow via plugin HTTP routes.
 *
 * Single login that provides tokens for all enterprise tools
 * (Outlook, People, NFD, Meeting rooms) via OBO exchange.
 * Glean search uses SSA (service creds) independently.
 *
 * Routes (registered via registerHttpRoute):
 *   GET /azure-ad/login                → redirect to Azure AD
 *   GET /api/auth/callback/nvlogin     → exchange code for tokens (registered in Azure AD)
 *   GET /azure-ad/status               → JSON login status
 *   GET /azure-ad/logout               → clear tokens
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// =============================================================================
// Configuration
// =============================================================================

const AZURE_AD_CONFIG = {
  clientId: process.env.AZURE_AD_CLIENT_ID ?? "6afc7495-bf0b-493a-9ffe-b3dbe390ec52",
  clientSecret: process.env.AZURE_AD_CLIENT_SECRET ?? "",
  tenantId: process.env.AZURE_AD_TENANT_ID ?? "43083d15-7273-40c1-b7db-39efd9ccc17a",
  scope:
    process.env.AZURE_AD_SCOPES ??
    "api://be67b199-7e7c-4767-a248-b518f85d6c75/Chat.Access openid profile offline_access",
  callbackPath: "/api/auth/callback/nvlogin",
};

function authorizationEndpoint(): string {
  return `https://login.microsoftonline.com/${AZURE_AD_CONFIG.tenantId}/oauth2/v2.0/authorize`;
}

function tokenEndpoint(): string {
  return `https://login.microsoftonline.com/${AZURE_AD_CONFIG.tenantId}/oauth2/v2.0/token`;
}

function resolveCallbackUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${host}${AZURE_AD_CONFIG.callbackPath}`;
}

// =============================================================================
// PKCE Helpers
// =============================================================================

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// =============================================================================
// Token Store (in-memory, per-process)
// =============================================================================

type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  email?: string;
};

let currentTokens: TokenSet | null = null;
let pendingPkce: { verifier: string; state: string } | null = null;

export function getAccessToken(): string | null {
  if (!currentTokens) return null;
  if (Date.now() > currentTokens.expiresAt) return null;
  return currentTokens.accessToken;
}

export function getRefreshToken(): string | null {
  return currentTokens?.refreshToken ?? process.env.AZURE_AD_REFRESH_TOKEN ?? null;
}

export function getIdToken(): string | null {
  return currentTokens?.idToken ?? null;
}

export function getEmail(): string | null {
  return currentTokens?.email ?? null;
}

export function isLoggedIn(): boolean {
  return currentTokens !== null && Date.now() < currentTokens.expiresAt;
}

// =============================================================================
// Token Refresh
// =============================================================================

async function refreshTokens(): Promise<boolean> {
  const rt = currentTokens?.refreshToken;
  if (!rt) return false;

  try {
    const res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: AZURE_AD_CONFIG.clientId,
        ...(AZURE_AD_CONFIG.clientSecret ? { client_secret: AZURE_AD_CONFIG.clientSecret } : {}),
        refresh_token: rt,
        scope: AZURE_AD_CONFIG.scope,
      }),
    });
    if (!res.ok) return false;

    const data = (await res.json()) as Record<string, unknown>;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
    currentTokens = {
      accessToken: String(data.access_token ?? ""),
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : rt,
      idToken: typeof data.id_token === "string" ? data.id_token : currentTokens?.idToken,
      expiresAt: Date.now() + expiresIn * 1000,
      email: currentTokens?.email,
    };
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Combo Getters (with auto-refresh + env var fallback)
// =============================================================================

/** Get SSO token for Glean — falls back to env var. */
export function getSSOToken(): string | null {
  return process.env.NVIDIA_SSO_TOKEN ?? getIdToken() ?? null;
}

/** Get Azure AD refresh token for OBO tools. */
export function getAzureRefreshToken(): string | null {
  const rt = getRefreshToken();
  if (rt) return rt;
  // Try auto-refresh if we have an expired session with a refresh token
  if (currentTokens?.refreshToken) {
    void refreshTokens();
  }
  return currentTokens?.refreshToken ?? null;
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
    client_id: AZURE_AD_CONFIG.clientId,
    response_type: "code",
    redirect_uri: callbackUrl,
    scope: AZURE_AD_CONFIG.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  sendRedirect(res, `${authorizationEndpoint()}?${params}`);
}

export async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    sendHtml(
      res,
      `<h2>Login failed</h2><p>${error}: ${url.searchParams.get("error_description") ?? ""}</p><p><a href="/azure-ad/login">Try again</a></p>`,
    );
    return;
  }

  if (!code || !pendingPkce || state !== pendingPkce.state) {
    sendHtml(
      res,
      '<h2>Invalid callback</h2><p>State mismatch or missing code.</p><p><a href="/azure-ad/login">Try again</a></p>',
    );
    return;
  }

  const callbackUrl = resolveCallbackUrl(req);

  try {
    const tokenRes = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: AZURE_AD_CONFIG.clientId,
        ...(AZURE_AD_CONFIG.clientSecret ? { client_secret: AZURE_AD_CONFIG.clientSecret } : {}),
        code,
        redirect_uri: callbackUrl,
        code_verifier: pendingPkce.verifier,
        scope: AZURE_AD_CONFIG.scope,
      }),
    });

    pendingPkce = null;

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      sendHtml(
        res,
        `<h2>Token exchange failed</h2><pre>${errBody}</pre><p><a href="/azure-ad/login">Try again</a></p>`,
      );
      return;
    }

    const data = (await tokenRes.json()) as Record<string, unknown>;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;

    // Decode email from id_token
    let email: string | undefined;
    try {
      const idToken = String(data.id_token ?? "");
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
      email = payload.preferred_username ?? payload.email ?? payload.sub;
    } catch {
      // ignore
    }

    currentTokens = {
      accessToken: String(data.access_token ?? ""),
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      idToken: typeof data.id_token === "string" ? data.id_token : undefined,
      expiresAt: Date.now() + expiresIn * 1000,
      email,
    };

    sendRedirect(res, "/");
  } catch (err) {
    sendHtml(
      res,
      `<h2>Token exchange error</h2><pre>${String(err)}</pre><p><a href="/azure-ad/login">Try again</a></p>`,
    );
  }
}

export function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    loggedIn: isLoggedIn(),
    email: getEmail(),
    expiresAt: currentTokens?.expiresAt ?? null,
    hasRefreshToken: Boolean(currentTokens?.refreshToken),
  });
}

export function handleLogout(_req: IncomingMessage, res: ServerResponse): void {
  currentTokens = null;
  pendingPkce = null;
  sendJson(res, 200, { loggedIn: false });
}

/**
 * Auth gate: redirect unauthenticated browser requests to Azure AD login.
 * Returns false (pass-through) for auth routes, API calls, WebSocket upgrades,
 * and non-browser requests. Returns true (handled) when redirecting.
 */
export function handleAuthGate(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? "/";

  // Don't gate auth routes
  if (url.startsWith("/azure-ad/") || url.startsWith("/api/auth/") || url.startsWith("/callback")) {
    return false;
  }

  // Don't gate API/RPC paths
  if (url.startsWith("/api/") || url.startsWith("/rpc/") || url.startsWith("/v1/")) {
    return false;
  }

  // Don't gate WebSocket upgrades
  if (req.headers.upgrade?.toLowerCase() === "websocket") {
    return false;
  }

  // Don't gate non-browser requests (curl, SDK, etc.)
  const accept = req.headers.accept ?? "";
  if (!accept.includes("text/html")) {
    return false;
  }

  // If already logged in, pass through
  if (isLoggedIn()) {
    return false;
  }

  // Redirect to Azure AD login
  sendRedirect(res, "/azure-ad/login");
  return true;
}
