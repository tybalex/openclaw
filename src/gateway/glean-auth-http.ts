/**
 * Backend proxy for Glean/Azure AD token exchange.
 *
 * This handles the OAuth token exchange server-side to avoid CORS issues
 * with browser-to-Azure-AD requests.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const AZURE_AD_CONFIG = {
  clientId: process.env.AZURE_AD_CLIENT_ID ?? "",
  clientSecret: process.env.AZURE_AD_CLIENT_SECRET ?? "",
  tenantId: process.env.AZURE_AD_TENANT_ID ?? "",
  get tokenEndpoint() {
    return `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
  },
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Handle Glean auth token exchange requests.
 *
 * POST /api/glean-auth/token
 * Body: { code, redirect_uri, code_verifier }
 *
 * POST /api/glean-auth/refresh
 * Body: { refresh_token }
 */
export async function handleGleanAuthHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Handle CORS preflight
  if (req.method === "OPTIONS" && url.pathname.startsWith("/api/glean-auth/")) {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return true;
  }

  if (req.method !== "POST") {
    return false;
  }

  // Token exchange endpoint
  if (url.pathname === "/api/glean-auth/token") {
    try {
      const body = (await readJsonBody(req)) as {
        code?: string;
        redirect_uri?: string;
        code_verifier?: string;
      };

      if (!body.code || !body.redirect_uri || !body.code_verifier) {
        sendJson(res, 400, { error: "Missing required fields: code, redirect_uri, code_verifier" });
        return true;
      }

      // Exchange code for tokens with Azure AD
      const tokenRes = await fetch(AZURE_AD_CONFIG.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: body.code,
          redirect_uri: body.redirect_uri,
          client_id: AZURE_AD_CONFIG.clientId,
          client_secret: AZURE_AD_CONFIG.clientSecret,
          code_verifier: body.code_verifier,
        }).toString(),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok) {
        console.error("[glean-auth-http] Token exchange failed:", tokenRes.status, tokenData);
        sendJson(res, tokenRes.status, tokenData);
        return true;
      }

      sendJson(res, 200, tokenData);
      return true;
    } catch (err) {
      console.error("[glean-auth-http] Token exchange error:", err);
      sendJson(res, 500, { error: "Token exchange failed" });
      return true;
    }
  }

  // Token refresh endpoint
  if (url.pathname === "/api/glean-auth/refresh") {
    try {
      const body = (await readJsonBody(req)) as {
        refresh_token?: string;
      };

      if (!body.refresh_token) {
        sendJson(res, 400, { error: "Missing required field: refresh_token" });
        return true;
      }

      const tokenRes = await fetch(AZURE_AD_CONFIG.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: body.refresh_token,
          client_id: AZURE_AD_CONFIG.clientId,
          client_secret: AZURE_AD_CONFIG.clientSecret,
        }).toString(),
      });

      const tokenData = await tokenRes.json();

      if (!tokenRes.ok) {
        console.error("[glean-auth-http] Token refresh failed:", tokenRes.status, tokenData);
        sendJson(res, tokenRes.status, tokenData);
        return true;
      }

      sendJson(res, 200, tokenData);
      return true;
    } catch (err) {
      console.error("[glean-auth-http] Token refresh error:", err);
      sendJson(res, 500, { error: "Token refresh failed" });
      return true;
    }
  }

  return false;
}
