/**
 * Separate Azure AD authentication specifically for Glean/ECS API access.
 * This is independent of the main OpenClaw OIDC auth.
 */

const AZURE_AD_CONFIG = {
  clientId: "6afc7495-bf0b-493a-9ffe-b3dbe390ec52",
  tenantId: "43083d15-7273-40c1-b7db-39efd9ccc17a",
  authorizationEndpoint: "https://login.microsoftonline.com/43083d15-7273-40c1-b7db-39efd9ccc17a/oauth2/v2.0/authorize",
  // Token exchange goes through our backend proxy (avoids CORS issues)
  tokenExchangeEndpoint: "/api/glean-auth/token",
  tokenRefreshEndpoint: "/api/glean-auth/refresh",
  scope: "api://be67b199-7e7c-4767-a248-b518f85d6c75/Chat.Access openid profile offline_access",
  // Use the same callback path that's already registered in Azure AD
  callbackPath: "/api/auth/callback/nvlogin",
};

const STORAGE_KEY = "glean_azure_ad_tokens";
const PKCE_KEY = "glean_azure_ad_pkce";

interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // Unix timestamp in ms
}

// PKCE helpers
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getStoredTokens(): TokenData | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

function storeTokens(tokens: TokenData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

function clearTokens(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PKCE_KEY);
}

/**
 * Check if user has a valid Glean/Azure AD token
 */
export function hasGleanAuth(): boolean {
  const tokens = getStoredTokens();
  if (!tokens) return false;
  // Consider expired if less than 5 minutes remaining
  return tokens.expires_at > Date.now() + 5 * 60 * 1000;
}

/**
 * Get the current Glean access token (Azure AD token for ECS API)
 */
export function getGleanToken(): string | null {
  const tokens = getStoredTokens();
  if (!tokens) return null;
  if (tokens.expires_at <= Date.now()) {
    // Token expired - could try refresh here
    return null;
  }
  return tokens.access_token;
}

/**
 * Get the stored Azure AD refresh token.
 * Used server-side to silently acquire tokens for other resources (NFD, Graph)
 * without requiring a separate login.
 */
export function getAzureRefreshToken(): string | null {
  const tokens = getStoredTokens();
  return tokens?.refresh_token ?? null;
}

/**
 * Start the Azure AD login flow for Glean access.
 * Opens a popup window for the OAuth flow.
 */
export async function startGleanLogin(): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  
  // Store PKCE verifier for the callback
  localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier }));
  
  const redirectUri = `${window.location.origin}${AZURE_AD_CONFIG.callbackPath}`;
  const state = crypto.randomUUID();
  
  const params = new URLSearchParams({
    client_id: AZURE_AD_CONFIG.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: AZURE_AD_CONFIG.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account", // Always show account picker
  });
  
  const authUrl = `${AZURE_AD_CONFIG.authorizationEndpoint}?${params}`;
  
  // Open popup for login
  const popup = window.open(authUrl, "glean_login", "width=500,height=700,popup=yes");
  
  if (!popup) {
    console.error("[glean-auth] Failed to open login popup");
    throw new Error("Failed to open login popup. Please allow popups for this site.");
  }
}

/**
 * Handle the OAuth callback. Call this from the callback page.
 */
export async function handleGleanCallback(): Promise<boolean> {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const error = urlParams.get("error");
  
  if (error) {
    console.error("[glean-auth] OAuth error:", error, urlParams.get("error_description"));
    clearTokens();
    return false;
  }
  
  if (!code) {
    return false;
  }

  // Get stored PKCE verifier
  const pkceStored = localStorage.getItem(PKCE_KEY);
  if (!pkceStored) {
    console.error("[glean-auth] No PKCE verifier found");
    return false;
  }
  
  const { verifier } = JSON.parse(pkceStored);
  const redirectUri = `${window.location.origin}${AZURE_AD_CONFIG.callbackPath}`;
  
  try {
    // Use backend proxy to exchange code for tokens (avoids CORS issues)
    const res = await fetch(AZURE_AD_CONFIG.tokenExchangeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    
    if (!res.ok) {
      console.error("[glean-auth] Token exchange failed:", res.status);
      clearTokens();
      return false;
    }
    
    const data = await res.json();
    
    // Calculate expiration (Azure AD returns expires_in in seconds)
    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    
    storeTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
    });
    
    // Clean up PKCE
    localStorage.removeItem(PKCE_KEY);
    
    // Clean URL params
    window.history.replaceState({}, document.title, AZURE_AD_CONFIG.callbackPath);
    
    return true;
  } catch (err) {
    console.error("[glean-auth] Token exchange error:", err);
    clearTokens();
    return false;
  }
}

/**
 * Refresh the Glean token if we have a refresh token
 */
export async function refreshGleanToken(): Promise<boolean> {
  const tokens = getStoredTokens();
  if (!tokens?.refresh_token) return false;
  
  try {
    // Use backend proxy for token refresh
    const res = await fetch(AZURE_AD_CONFIG.tokenRefreshEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refresh_token: tokens.refresh_token,
      }),
    });
    
    if (!res.ok) {
      console.warn("[glean-auth] Token refresh failed");
      return false;
    }
    
    const data = await res.json();
    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    
    storeTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: expiresAt,
    });
    
    return true;
  } catch (err) {
    console.error("[glean-auth] Token refresh error:", err);
    return false;
  }
}

/**
 * Log out of Glean (clear Azure AD tokens)
 */
export function logoutGlean(): void {
  clearTokens();
}

/**
 * Check if we're on the Glean callback page.
 * We detect this by checking the path AND if we have a pending PKCE verifier stored.
 */
export function isGleanCallbackPage(): boolean {
  const isCorrectPath = window.location.pathname === AZURE_AD_CONFIG.callbackPath;
  const hasCode = new URLSearchParams(window.location.search).has("code");
  const hasPkceState = Boolean(localStorage.getItem(PKCE_KEY));
  return isCorrectPath && hasCode && hasPkceState;
}
