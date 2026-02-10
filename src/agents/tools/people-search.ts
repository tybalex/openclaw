/**
 * People Search tool via Microsoft Graph API.
 *
 * Searches for people in the organization using three strategies (in order):
 * 1. /users with $search (needs User.Read.All or User.ReadBasic.All)
 * 2. /users with $filter startsWith
 * 3. /me/people (needs People.Read)
 *
 * Uses the first strategy that succeeds. In NVIDIA's tenant, strategy 1 works.
 *
 * Uses Azure AD refresh token → silent acquisition → OBO for Graph User.Read.All scope.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { stringEnum } from "../schema/typebox.js";
import { acquireDownstreamToken, isAzureOBOConfigured } from "./azure-obo.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// =============================================================================
// Configuration
// =============================================================================

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const PEOPLE_SEARCH_SCOPES = "https://graph.microsoft.com/User.Read.All";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESULT_COUNT = 10;
const MAX_RESULT_COUNT = 50;

const USER_SELECT_FIELDS =
  "displayName,mail,jobTitle,department,officeLocation,userPrincipalName,mobilePhone,businessPhones";

// =============================================================================
// Actions
// =============================================================================

const PEOPLE_ACTIONS = ["search_people", "get_profile"] as const;

// =============================================================================
// Schema
// =============================================================================

const PeopleSearchSchema = Type.Object({
  action: stringEnum(PEOPLE_ACTIONS, {
    description:
      "Action to perform: search_people (search by name or email), get_profile (get your own profile).",
  }),
  query: Type.Optional(
    Type.String({
      description:
        'Search query string (for search_people). Searches name and email. Example: "John Doe", "johnd@nvidia.com".',
    }),
  ),
  count: Type.Optional(
    Type.Number({
      description: `Number of results to return (for search_people, default: ${DEFAULT_RESULT_COUNT}, max: ${MAX_RESULT_COUNT}).`,
      minimum: 1,
      maximum: MAX_RESULT_COUNT,
    }),
  ),
});

// =============================================================================
// Graph API helpers
// =============================================================================

type GraphApiResult = { ok: true; data: unknown } | { ok: false; status: number };

async function graphGet(
  token: string,
  path: string,
  params?: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Promise<GraphApiResult> {
  const url = new URL(`${GRAPH_BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { ok: false, status: res.status };
  }

  return { ok: true, data: (await res.json()) as unknown };
}

// =============================================================================
// Response types
// =============================================================================

type GraphUser = {
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  mobilePhone?: string;
  businessPhones?: string[];
};

type GraphPerson = {
  displayName?: string;
  scoredEmailAddresses?: { address?: string }[];
  phones?: { number?: string; type?: string }[];
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  companyName?: string;
  userPrincipalName?: string;
};

type GraphListResponse = {
  value?: unknown[];
};

// =============================================================================
// Normalize results from different endpoints to a common shape
// =============================================================================

function normalizeUser(user: GraphUser) {
  return {
    name: user.displayName ?? "",
    email: user.mail ?? user.userPrincipalName ?? "",
    jobTitle: user.jobTitle ?? "",
    department: user.department ?? "",
    officeLocation: user.officeLocation ?? "",
    phone: user.mobilePhone ?? (user.businessPhones?.[0] || ""),
  };
}

function normalizePerson(person: GraphPerson) {
  const email = person.scoredEmailAddresses?.[0]?.address ?? person.userPrincipalName ?? "";
  const phone = person.phones?.[0]?.number ?? "";
  return {
    name: person.displayName ?? "",
    email,
    jobTitle: person.jobTitle ?? "",
    department: person.department ?? "",
    officeLocation: person.officeLocation ?? "",
    phone,
    ...(person.companyName ? { company: person.companyName } : {}),
  };
}

// =============================================================================
// Search strategies (tried in order)
// =============================================================================

/**
 * Strategy 1: /users with $search (needs User.Read.All or User.ReadBasic.All).
 * Requires ConsistencyLevel: eventual header and $count=true.
 */
async function searchUsersWithSearch(
  token: string,
  query: string,
  top: number,
): Promise<unknown[] | null> {
  const result = await graphGet(
    token,
    "/users",
    {
      $search: `"displayName:${query}" OR "mail:${query}"`,
      $top: String(top),
      $select: USER_SELECT_FIELDS,
      $count: "true",
    },
    { ConsistencyLevel: "eventual" },
  );

  if (!result.ok) return null;
  const data = result.data as GraphListResponse;
  return (data.value ?? []).map((u) => normalizeUser(u as GraphUser));
}

/**
 * Strategy 2: /users with $filter startsWith.
 */
async function searchUsersWithFilter(
  token: string,
  query: string,
  top: number,
): Promise<unknown[] | null> {
  const result = await graphGet(token, "/users", {
    $filter: `startsWith(displayName,'${query}') or startsWith(mail,'${query}')`,
    $top: String(top),
    $select: USER_SELECT_FIELDS,
  });

  if (!result.ok) return null;
  const data = result.data as GraphListResponse;
  return (data.value ?? []).map((u) => normalizeUser(u as GraphUser));
}

/**
 * Strategy 3: /me/people (needs People.Read).
 */
async function searchMePeople(
  token: string,
  query: string,
  top: number,
): Promise<unknown[] | null> {
  const result = await graphGet(token, "/me/people", {
    $search: `"${query}"`,
    $top: String(top),
  });

  if (!result.ok) return null;
  const data = result.data as GraphListResponse;
  return (data.value ?? []).map((p) => normalizePerson(p as GraphPerson));
}

// =============================================================================
// Action handlers
// =============================================================================

async function handleSearchPeople(
  graphToken: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const query = readStringParam(params, "query") ?? "";
  const count = readNumberParam(params, "count", { integer: true }) ?? DEFAULT_RESULT_COUNT;
  const top = Math.min(count, MAX_RESULT_COUNT);

  if (!query) {
    // No query — return relevant contacts or own profile
    const mePeople = await searchMePeople(graphToken, "", top);
    if (mePeople) {
      return { count: mePeople.length, people: mePeople };
    }

    // Fall back to own profile
    const meResult = await graphGet(graphToken, "/me", {
      $select: USER_SELECT_FIELDS,
    });
    if (meResult.ok) {
      const user = normalizeUser(meResult.data as GraphUser);
      return { count: 1, people: [user], note: "Returned your own profile (no query provided)." };
    }

    return {
      error: "people_search_unavailable",
      message: "People search not available with current permissions.",
    };
  }

  // Try strategies in order
  const strategy1 = await searchUsersWithSearch(graphToken, query, top);
  if (strategy1) {
    return { query, count: strategy1.length, people: strategy1 };
  }

  const strategy2 = await searchUsersWithFilter(graphToken, query, top);
  if (strategy2) {
    return { query, count: strategy2.length, people: strategy2 };
  }

  const strategy3 = await searchMePeople(graphToken, query, top);
  if (strategy3) {
    return { query, count: strategy3.length, people: strategy3 };
  }

  return {
    error: "people_search_unavailable",
    message:
      "People search not available. The tenant may need People.Read or User.Read.All permission granted.",
  };
}

async function handleGetProfile(graphToken: string): Promise<unknown> {
  const result = await graphGet(graphToken, "/me", {
    $select: USER_SELECT_FIELDS,
  });

  if (!result.ok) {
    return { error: "profile_error", message: `Failed to get profile (HTTP ${result.status}).` };
  }

  return normalizeUser(result.data as GraphUser);
}

// =============================================================================
// Tool factory
// =============================================================================

/**
 * Creates the People Search tool.
 *
 * @param options.getRefreshToken - Function to get the user's Azure AD refresh token.
 * @param options.enabled - Explicit enable/disable override.
 */
export function createPeopleSearchTool(options: {
  getRefreshToken: () => string | null | Promise<string | null>;
  enabled?: boolean;
}): AnyAgentTool | null {
  if (options.enabled === false) {
    return null;
  }

  if (!isAzureOBOConfigured()) {
    console.warn("[people_search] Azure AD credentials not configured, tool disabled");
    return null;
  }

  return {
    label: "People Search",
    name: "people_search",
    description:
      "Search for people in the NVIDIA organization. Find colleagues by name or email to get their contact info, job title, department, and office location. Can also retrieve your own profile. Requires NVIDIA SSO authentication.",
    parameters: PeopleSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        const refreshToken = await options.getRefreshToken();
        if (!refreshToken) {
          return jsonResult({
            error: "not_authenticated",
            message: "People search requires NVIDIA SSO authentication. Please log in first.",
          });
        }

        // Two-step: refresh → OBO for Graph User.Read.All token
        const tokenResult = await acquireDownstreamToken(refreshToken, PEOPLE_SEARCH_SCOPES);
        if (!tokenResult.ok) {
          return jsonResult({
            error: "token_exchange_failed",
            message: `Failed to acquire Graph token: ${"error" in tokenResult ? tokenResult.error : "unknown"}`,
          });
        }
        const graphToken = tokenResult.accessToken;

        let result: unknown;
        switch (action) {
          case "search_people":
            result = await handleSearchPeople(graphToken, params);
            break;
          case "get_profile":
            result = await handleGetProfile(graphToken);
            break;
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown action: ${action}. Valid: ${PEOPLE_ACTIONS.join(", ")}`,
            });
        }

        return jsonResult({ action, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: "people_search_error", message });
      }
    },
  };
}
