/**
 * Azure AD On-Behalf-Of (OBO) token exchange and silent token acquisition.
 *
 * Two-step flow for cross-resource access:
 * 1. Use the refresh token (from Glean login) to silently acquire a token
 *    scoped to our app (aud=AZURE_AD_CLIENT_ID).
 * 2. Exchange that token via OBO for a downstream API token (NFD, Graph, etc.).
 *
 * Env vars: AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET, AZURE_AD_TENANT_ID.
 */

// =============================================================================
// Configuration
// =============================================================================

export const AZURE_AD_CONFIG = {
  clientId: process.env.AZURE_AD_CLIENT_ID ?? "",
  clientSecret: process.env.AZURE_AD_CLIENT_SECRET ?? "",
  tenantId: process.env.AZURE_AD_TENANT_ID ?? "",
};

// =============================================================================
// Token Cache
// =============================================================================

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

// Cache keyed by scope string.
const tokenCache = new Map<string, CachedToken>();

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 min buffer before expiry

function getCachedToken(cacheKey: string): string | null {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return cached.accessToken;
  }
  return null;
}

function setCachedToken(cacheKey: string, accessToken: string, expiresIn: number): void {
  tokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });
}

// =============================================================================
// Result type
// =============================================================================

export type AzureTokenResult = { ok: true; accessToken: string } | { ok: false; error: string };

// =============================================================================
// Silent token acquisition via refresh token
// =============================================================================

/**
 * Use an Azure AD refresh token to silently acquire an access token for a
 * specific scope. The refresh token from the Glean login (aud=be67b199)
 * can be used to get tokens for other resources, including our own app
 * (aud=6afc7495) which is needed for OBO.
 */
export async function acquireTokenSilent(
  refreshToken: string,
  targetScopes: string | string[],
): Promise<AzureTokenResult> {
  const scopes = Array.isArray(targetScopes) ? targetScopes.join(" ") : targetScopes;

  // Check cache
  const cacheKey = `silent:${scopes}`;
  const cached = getCachedToken(cacheKey);
  if (cached) {
    return { ok: true, accessToken: cached };
  }

  const { clientId, clientSecret, tenantId } = AZURE_AD_CONFIG;
  if (!clientId || !clientSecret || !tenantId) {
    return {
      ok: false,
      error:
        "Azure AD credentials not configured. Set AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET, AZURE_AD_TENANT_ID.",
    };
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: scopes,
  });

  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Silent token acquisition error (${res.status}): ${detail || res.statusText}`,
      };
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      return { ok: false, error: "No access_token in refresh response" };
    }

    const expiresIn = data.expires_in ?? 3600;
    setCachedToken(cacheKey, data.access_token, expiresIn);

    return { ok: true, accessToken: data.access_token };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Silent token acquisition failed: ${message}` };
  }
}

// =============================================================================
// OBO Token Exchange
// =============================================================================

/**
 * Exchange a user's Azure AD token for a downstream API token via OBO.
 *
 * The assertion token MUST have aud matching AZURE_AD_CLIENT_ID.
 * Use acquireTokenSilent() first if the user's token has a different audience.
 *
 * @param userToken - Azure AD access token with aud=AZURE_AD_CLIENT_ID.
 * @param targetScopes - Scopes for the downstream API (NFD, Graph, etc.).
 */
export async function exchangeTokenOBO(
  userToken: string,
  targetScopes: string | string[],
): Promise<AzureTokenResult> {
  const scopes = Array.isArray(targetScopes) ? targetScopes.join(" ") : targetScopes;

  // Check cache
  const cacheKey = `obo:${scopes}`;
  const cached = getCachedToken(cacheKey);
  if (cached) {
    return { ok: true, accessToken: cached };
  }

  const { clientId, clientSecret, tenantId } = AZURE_AD_CONFIG;
  if (!clientId || !clientSecret || !tenantId) {
    return {
      ok: false,
      error:
        "Azure AD credentials not configured. Set AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET, AZURE_AD_TENANT_ID.",
    };
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: userToken,
    scope: scopes,
    requested_token_use: "on_behalf_of",
  });

  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `OBO token error (${res.status}): ${detail || res.statusText}` };
    }

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      return { ok: false, error: "No access_token in OBO response" };
    }

    const expiresIn = data.expires_in ?? 3600;
    setCachedToken(cacheKey, data.access_token, expiresIn);

    return { ok: true, accessToken: data.access_token };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `OBO exchange failed: ${message}` };
  }
}

// =============================================================================
// Combined: refresh → OBO (two-step)
// =============================================================================

/** Scope targeting our own app, needed to get a token with the right audience for OBO. */
const OUR_APP_SCOPE = `api://${AZURE_AD_CONFIG.clientId}/User.Access`;

/**
 * Two-step token acquisition for downstream APIs:
 * 1. Use refresh token to get a token with aud=our_app (for OBO assertion)
 * 2. Exchange via OBO for a downstream API token
 *
 * This is the main entry point for NFD/Meeting Room tools.
 */
export async function acquireDownstreamToken(
  refreshToken: string,
  targetScopes: string | string[],
): Promise<AzureTokenResult> {
  // Step 1: Get a token for our app (aud=AZURE_AD_CLIENT_ID)
  const silentResult = await acquireTokenSilent(refreshToken, OUR_APP_SCOPE);
  if (!silentResult.ok) {
    return silentResult;
  }

  // Step 2: Exchange for downstream API token via OBO
  return await exchangeTokenOBO(silentResult.accessToken, targetScopes);
}

/**
 * Check whether Azure AD OBO is configured (all required env vars present).
 */
export function isAzureOBOConfigured(): boolean {
  return !!(AZURE_AD_CONFIG.clientId && AZURE_AD_CONFIG.clientSecret && AZURE_AD_CONFIG.tenantId);
}
