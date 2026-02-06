/**
 * Glean Enterprise Content Search tool.
 *
 * Uses NVIDIA SSO token from OIDC + Starfleet SSA token to search Glean/ECS API.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// =============================================================================
// Configuration
// =============================================================================

const ECS_CONFIG = {
  // Starfleet SSA credentials (service-to-service auth)
  clientId: process.env.STARFLEET_CLIENT_ID ?? process.env.AZURE_CLIENT_ID_PRD ?? "",
  clientSecret: process.env.STARFLEET_CLIENT_SECRET ?? process.env.AZURE_CLIENT_SECRET_PRD ?? "",
  tokenUrl: process.env.STARFLEET_TOKEN_URL ?? process.env.ECS_CONTENT_SEARCH_TOKEN_URL ?? "",
  scope: process.env.STARFLEET_SCOPE ?? "content:search content:retrieve",

  // ECS API endpoint
  searchUrl: process.env.ECS_CONTENT_SEARCH_URL ?? "",
};

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 30_000;

// SSA token cache
let ssaTokenCache: { token: string; expiresAt: number } | null = null;

// =============================================================================
// Schema
// =============================================================================

const GleanSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  page_size: Type.Optional(
    Type.Number({
      description: `Number of results to return (default: ${DEFAULT_PAGE_SIZE}, range: 1-${MAX_PAGE_SIZE}).`,
      minimum: 1,
      maximum: MAX_PAGE_SIZE,
    }),
  ),
  datasources: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Filter by specific datasources (e.g., ['confluence', 'gdrive', 'slack']). Leave empty for all.",
    }),
  ),
  max_snippet_size: Type.Optional(
    Type.Number({
      description:
        "Maximum characters of content per result (default: 5000, range: 100-50000). Increase to get more text from each document.",
      minimum: 100,
      maximum: 50000,
    }),
  ),
  expanded_snippet_size: Type.Optional(
    Type.Number({
      description:
        "Characters of surrounding context around matched text (default: 1000, range: 100-10000). Increase to see more context around where search terms appear.",
      minimum: 100,
      maximum: 10000,
    }),
  ),
});

// =============================================================================
// SSA Token (Starfleet service-to-service auth)
// =============================================================================

async function getSSAToken(): Promise<string> {
  // Check cache
  if (ssaTokenCache && ssaTokenCache.expiresAt > Date.now() + 60_000) {
    return ssaTokenCache.token;
  }

  if (!ECS_CONFIG.clientId || !ECS_CONFIG.clientSecret || !ECS_CONFIG.tokenUrl) {
    throw new Error(
      "Starfleet SSA credentials not configured. Set STARFLEET_CLIENT_ID, STARFLEET_CLIENT_SECRET, STARFLEET_TOKEN_URL.",
    );
  }

  const credentials = `${ECS_CONFIG.clientId}:${ECS_CONFIG.clientSecret}`;
  const encodedCreds = Buffer.from(credentials).toString("base64");

  const res = await fetch(ECS_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodedCreds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=client_credentials&scope=${ECS_CONFIG.scope.replace(/ /g, "+")}`,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SSA token error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("No access_token in SSA response");
  }

  // Cache token (with 5 min buffer before expiry)
  const expiresIn = data.expires_in ?? 3600;
  ssaTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return data.access_token;
}

// =============================================================================
// ECS API Call
// =============================================================================

type GleanResult = {
  title: string;
  url: string;
  content: string;
  source: string;
  author?: string;
  lastModified?: string;
};

type ECSSearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    snippets?: Array<{ text?: string; snippet?: string }>;
    document?: {
      metadata?: {
        datasource?: string;
        author?: { name?: string };
        updateTime?: string;
      };
    };
  }>;
};

const DEFAULT_MAX_SNIPPET_SIZE = 5000;
const DEFAULT_EXPANDED_SNIPPET_SIZE = 1000;

async function callECSSearch(params: {
  query: string;
  ssaToken: string;
  ssoToken: string;
  pageSize: number;
  datasources?: string[];
  maxSnippetSize?: number;
  expandedSnippetSize?: number;
}): Promise<GleanResult[]> {
  if (!ECS_CONFIG.searchUrl) {
    throw new Error("ECS_CONTENT_SEARCH_URL not configured");
  }

  const requestBody: Record<string, unknown> = {
    query: params.query,
    pageSize: params.pageSize,
    maxSnippetSize: params.maxSnippetSize ?? DEFAULT_MAX_SNIPPET_SIZE,
    requestOptions: {
      responseHints: ["RESULTS"],
      returnLlmContentOverSnippets: false,
      expandedSnippetSize: params.expandedSnippetSize ?? DEFAULT_EXPANDED_SNIPPET_SIZE,
    },
  };

  if (params.datasources && params.datasources.length > 0) {
    requestBody.datasourcesFilter = {
      datasources: params.datasources.map((ds) => ({
        datasource: ds,
        datasourceCategory: "ENTERPRISE_DATASOURCE",
      })),
    };
  }

  const res = await fetch(ECS_CONFIG.searchUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.ssaToken}`,
      "Content-Type": "application/json",
      "Nv-Actor-Token": params.ssoToken,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ECS API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as ECSSearchResponse;

  // Transform results
  return (data.results ?? []).map((r) => {
    const snippets = r.snippets ?? [];
    const content = snippets
      .map((s) => s.text || s.snippet || "")
      .filter(Boolean)
      .join("\n\n");

    return {
      title: r.title ?? "Untitled",
      url: r.url ?? "",
      content,
      source: r.document?.metadata?.datasource ?? "unknown",
      author: r.document?.metadata?.author?.name,
      lastModified: r.document?.metadata?.updateTime,
    };
  });
}

// =============================================================================
// Tool Factory
// =============================================================================

/**
 * Creates a Glean search tool.
 *
 * @param options.getSSOToken - Function to get the current user's SSO token (OIDC id_token).
 *                              This should come from the request context / OIDC session.
 */
export function createGleanSearchTool(options: {
  getSSOToken: () => string | null | Promise<string | null>;
  enabled?: boolean;
}): AnyAgentTool | null {
  if (options.enabled === false) {
    return null;
  }

  // Check if ECS is configured
  if (!ECS_CONFIG.searchUrl) {
    console.warn("[glean_search] ECS_CONTENT_SEARCH_URL not set, tool disabled");
    return null;
  }

  return {
    label: "Glean Search",
    name: "glean_search",
    description:
      "Search NVIDIA internal enterprise knowledge base (Glean). Use for company-specific questions: policies, benefits, internal procedures, org information, employee resources, internal documentation. Searches Confluence, Slack, Google Drive, Jira, SharePoint, and other internal sources. NOT for public/external information - use web_search for that instead.",
    parameters: GleanSearchSchema,
    execute: async (_toolCallId, args) => {
      // Get user's SSO token
      const ssoToken = await options.getSSOToken();
      if (!ssoToken) {
        return jsonResult({
          error: "not_authenticated",
          message: "Glean search requires NVIDIA SSO authentication. Please log in first.",
        });
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const pageSize = readNumberParam(params, "page_size", { integer: true }) ?? DEFAULT_PAGE_SIZE;
      const datasources = Array.isArray(params.datasources)
        ? (params.datasources as string[])
        : undefined;
      const maxSnippetSize = readNumberParam(params, "max_snippet_size", { integer: true });
      const expandedSnippetSize = readNumberParam(params, "expanded_snippet_size", {
        integer: true,
      });

      try {
        // Get SSA token (cached)
        const ssaToken = await getSSAToken();

        // Call ECS API
        const results = await callECSSearch({
          query,
          ssaToken,
          ssoToken,
          pageSize: Math.min(pageSize, MAX_PAGE_SIZE),
          datasources,
          maxSnippetSize: maxSnippetSize ?? undefined,
          expandedSnippetSize: expandedSnippetSize ?? undefined,
        });

        return jsonResult({
          query,
          count: results.length,
          results,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          error: "search_failed",
          message,
        });
      }
    },
  };
}
