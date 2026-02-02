/**
 * OIDC PKCE flow for NVIDIA SSO in the Moltbot web UI.
 *
 * Handles: login initiation (redirect), callback (code exchange),
 * token storage (sessionStorage), and PKCE state (sessionStorage).
 */

// ---------------------------------------------------------------------------
// Configuration (hardcoded NVIDIA staging)
// ---------------------------------------------------------------------------

const NVIDIA_OIDC = {
  clientId: "9bONc0-8SKqkjS4GfDZuCLLCOwYGpyX4bOQetfyYzNM",
  authorizationEndpoint: "https://stg.login.nvidia.com/authorize",
  tokenEndpoint: "https://stg.login.nvidia.com/token",
  scope: "openid email profile",
  callbackPath: "/callback",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OidcTokens = {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
};

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function toBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return toBase64Url(array.buffer);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(digest);
}

function generateState(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Token storage (sessionStorage — scoped to the browser tab)
// ---------------------------------------------------------------------------

const TOKENS_KEY = "moltbot.oidc.tokens";

export function loadOidcTokens(): OidcTokens | null {
  try {
    const raw = sessionStorage.getItem(TOKENS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OidcTokens>;
    if (
      typeof parsed.id_token === "string" &&
      typeof parsed.access_token === "string" &&
      typeof parsed.expires_at === "number"
    ) {
      return parsed as OidcTokens;
    }
    return null;
  } catch {
    return null;
  }
}

export function storeOidcTokens(tokens: OidcTokens): void {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

export function clearOidcTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
}

// ---------------------------------------------------------------------------
// PKCE state (sessionStorage — cleared per tab, one-time use)
// ---------------------------------------------------------------------------

const PKCE_KEY = "moltbot.oidc.pkce";

type PkceState = { verifier: string; state: string };

function storePkceState(verifier: string, state: string): void {
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
}

function loadAndClearPkceState(): PkceState | null {
  try {
    const raw = sessionStorage.getItem(PKCE_KEY);
    sessionStorage.removeItem(PKCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PkceState>;
    if (typeof parsed.verifier === "string" && typeof parsed.state === "string") {
      return parsed as PkceState;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JWT payload decode (minimal — no signature check, just for reading claims)
// ---------------------------------------------------------------------------

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    // Restore base64 padding
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Return URL — remember where the user was before SSO redirect
// ---------------------------------------------------------------------------

const RETURN_URL_KEY = "moltbot.oidc.returnUrl";

// ---------------------------------------------------------------------------
// Login initiation — redirects browser to NVIDIA SSO
// ---------------------------------------------------------------------------

export async function startOidcLogin(): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const state = generateState();
  const nonce = generateNonce();

  storePkceState(verifier, state);
  sessionStorage.setItem(RETURN_URL_KEY, window.location.href);

  const redirectUri = `${window.location.origin}${NVIDIA_OIDC.callbackPath}`;
  const url = new URL(NVIDIA_OIDC.authorizationEndpoint);
  url.searchParams.set("client_id", NVIDIA_OIDC.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", NVIDIA_OIDC.scope);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);

  window.location.href = url.toString();
}

// ---------------------------------------------------------------------------
// Callback handling — detects ?code=&state= and exchanges for tokens
// ---------------------------------------------------------------------------

export async function handleOidcCallback(): Promise<OidcTokens | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return null;

  const pkce = loadAndClearPkceState();
  if (!pkce) {
    console.warn("[oidc] callback detected but no PKCE state found — ignoring");
    cleanCallbackParams();
    return null;
  }

  if (pkce.state !== state) {
    console.warn("[oidc] state mismatch — possible CSRF, ignoring callback");
    cleanCallbackParams();
    return null;
  }

  const redirectUri = `${window.location.origin}${NVIDIA_OIDC.callbackPath}`;
  try {
    const res = await fetch(NVIDIA_OIDC.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: NVIDIA_OIDC.clientId,
        code_verifier: pkce.verifier,
      }).toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[oidc] token exchange failed: HTTP ${res.status}`, text);
      cleanCallbackParams();
      return null;
    }

    const data = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.id_token || !data.access_token) {
      console.error("[oidc] token response missing id_token or access_token");
      cleanCallbackParams();
      return null;
    }

    const tokens: OidcTokens = {
      id_token: data.id_token,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    };

    storeOidcTokens(tokens);
    cleanCallbackParams();
    return tokens;
  } catch (err) {
    console.error("[oidc] token exchange error:", err);
    cleanCallbackParams();
    return null;
  }
}

function cleanCallbackParams(): void {
  // Restore the URL the user was on before the SSO redirect.
  const returnUrl = sessionStorage.getItem(RETURN_URL_KEY) || "/";
  sessionStorage.removeItem(RETURN_URL_KEY);
  window.history.replaceState({}, "", returnUrl);
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/** Mutex to prevent concurrent refresh requests. */
let refreshInFlight: Promise<OidcTokens | null> | null = null;

/**
 * Uses the stored refresh_token to obtain fresh id/access tokens.
 * Returns the new tokens on success, or null on failure.
 */
export async function refreshOidcTokens(): Promise<OidcTokens | null> {
  // Deduplicate concurrent refresh calls.
  if (refreshInFlight) return refreshInFlight;

  const existing = loadOidcTokens();
  if (!existing?.refresh_token) return null;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(NVIDIA_OIDC.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: existing.refresh_token!,
          client_id: NVIDIA_OIDC.clientId,
        }).toString(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[oidc] token refresh failed: HTTP ${res.status}`, text);
        return null;
      }

      const data = (await res.json()) as {
        id_token?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };

      if (!data.id_token || !data.access_token) {
        console.warn("[oidc] refresh response missing id_token or access_token");
        return null;
      }

      const tokens: OidcTokens = {
        id_token: data.id_token,
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? existing.refresh_token,
        expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      };

      storeOidcTokens(tokens);
      console.info("[oidc] token refreshed successfully");
      return tokens;
    } catch (err) {
      console.warn("[oidc] token refresh error:", err);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// Proactive refresh timer
// ---------------------------------------------------------------------------

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Refresh 5 minutes before expiry (or immediately if already within window). */
const REFRESH_BUFFER_MS = 5 * 60_000;

/**
 * Schedules a silent token refresh before the current token expires.
 * Call after any successful token acquisition (login callback, manual refresh).
 * Optionally pass an onRefreshed callback to update app state (e.g. reconnect).
 */
export function scheduleTokenRefresh(onRefreshed?: (token: string) => void): void {
  cancelTokenRefresh();
  const tokens = loadOidcTokens();
  if (!tokens?.refresh_token) return;

  const delay = Math.max(0, tokens.expires_at - Date.now() - REFRESH_BUFFER_MS);
  refreshTimer = setTimeout(async () => {
    const refreshed = await refreshOidcTokens();
    if (refreshed) {
      onRefreshed?.(refreshed.id_token);
      // Re-schedule for the next cycle.
      scheduleTokenRefresh(onRefreshed);
    } else {
      console.warn("[oidc] proactive refresh failed; SSO redirect will occur on next token check");
    }
  }, delay);
}

export function cancelTokenRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Token access
// ---------------------------------------------------------------------------

/** Returns id_token if stored and not expired (with 60s buffer), else null. */
export function getValidOidcToken(): string | null {
  const tokens = loadOidcTokens();
  if (!tokens) return null;
  if (Date.now() > tokens.expires_at - 60_000) {
    return null;
  }
  return tokens.id_token;
}

/**
 * Async version of getValidOidcToken that attempts a silent refresh
 * using the refresh_token before giving up.
 * Returns a valid id_token or null.
 */
export async function ensureValidOidcToken(): Promise<string | null> {
  const quick = getValidOidcToken();
  if (quick) return quick;

  // Token expired or missing — try refresh.
  const refreshed = await refreshOidcTokens();
  return refreshed?.id_token ?? null;
}

/** Returns email from the stored id_token, or null. */
export function getOidcUserEmail(): string | null {
  const tokens = loadOidcTokens();
  if (!tokens) return null;
  const payload = decodeJwtPayload(tokens.id_token);
  if (!payload) return null;
  return typeof payload.email === "string" ? payload.email : null;
}

/** Returns true if OIDC tokens are stored (may be expired). */
export function hasOidcTokens(): boolean {
  return loadOidcTokens() !== null;
}
