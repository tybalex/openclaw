/**
 * NVIDIA Employee Info tool via Helios API.
 *
 * Fetches detailed employee information from NVIDIA's internal Helios
 * directory service, including manager chain and direct reports.
 *
 * This is a companion to the people_search tool (MS Graph):
 * - people_search: find users by name/email (MS Graph)
 * - employee_info: get detailed org info for a known user (Helios)
 *
 * Auth: API key via HELIOS_API_KEY env var (not Azure AD OBO).
 *
 * Env vars:
 *   HELIOS_API_KEY     - Helios API auth token (required to enable)
 *   HELIOS_BASE_URL    - Helios API base URL (optional, has default)
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult, readStringParam } from "./common.js";

// =============================================================================
// Configuration
// =============================================================================

const HELIOS_CONFIG = {
  apiKey: process.env.HELIOS_API_KEY ?? "",
  baseUrl: process.env.HELIOS_BASE_URL ?? "https://helios-api.nvidia.com/api",
};

const DEFAULT_TIMEOUT_MS = 30_000;

// =============================================================================
// Actions
// =============================================================================

const EMPLOYEE_ACTIONS = ["get_employee", "get_direct_reports"] as const;

// =============================================================================
// Schema
// =============================================================================

const EmployeeInfoSchema = Type.Object({
  action: stringEnum(EMPLOYEE_ACTIONS, {
    description:
      "Action to perform: get_employee (get user info + manager chain), get_direct_reports (list someone's direct reports).",
  }),
  login: Type.Optional(
    Type.String({
      description:
        'NVIDIA employee login (username part of email, e.g. "johnd" from johnd@nvidia.com). Also accepts full email — the part before @ will be extracted.',
    }),
  ),
});

// =============================================================================
// Helios API helpers
// =============================================================================

type HeliosResponse = {
  data?: HeliosUser[];
};

type HeliosUser = {
  id?: string;
  attributes?: {
    name?: string;
    email?: string;
    login?: string;
    title?: string;
    department?: string;
    managerChain?: HeliosManagerEntry[];
    [key: string]: unknown;
  };
};

type HeliosManagerEntry = {
  login?: string;
  name?: string;
};

async function heliosGet(
  path: string,
  params: Record<string, string>,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }> {
  const url = new URL(`${HELIOS_CONFIG.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "auth-token": HELIOS_CONFIG.apiKey },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, status: res.status, message: detail || res.statusText };
  }

  return { ok: true, data: (await res.json()) as unknown };
}

/**
 * Extract the login portion from an email or return as-is if already a login.
 */
function extractLogin(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) {
    return trimmed.split("@")[0] ?? trimmed;
  }
  return trimmed;
}

// =============================================================================
// Action handlers
// =============================================================================

async function handleGetEmployee(login: string): Promise<unknown> {
  // Fetch user info with manager chain
  const result = await heliosGet("/v1/users", {
    attributes: "managerChain",
    "filter[login]": login,
  });

  if (!result.ok) {
    return {
      error: "helios_api_error",
      message: `Helios API returned ${result.status}: ${result.message}`,
    };
  }

  const data = result.data as HeliosResponse;
  if (!data.data || data.data.length === 0) {
    return {
      error: "user_not_found",
      message: `No employee found with login '${login}'. Try using just the username part (before @).`,
    };
  }

  const user = data.data[0]!;
  const attrs = user.attributes ?? {};
  const managerChain = (attrs.managerChain ?? []).map((m) => ({
    login: m.login ?? "",
    name: m.name ?? "",
  }));

  // Also fetch direct reports in parallel for a complete picture
  const reportsResult = await heliosGet("/v1/users", {
    attributes: "login",
    "attributes[]": "name",
    "filter[managerLogin]": login,
  });

  let directReports: { login: string; name: string }[] = [];
  if (reportsResult.ok) {
    const reportsData = reportsResult.data as HeliosResponse;
    directReports = (reportsData.data ?? []).map((person) => ({
      login: person.id ?? person.attributes?.login ?? "",
      name: person.attributes?.name ?? "",
    }));
  }

  return {
    login: user.id ?? login,
    name: attrs.name ?? "",
    email: attrs.email ?? "",
    title: attrs.title ?? "",
    department: attrs.department ?? "",
    managerChain,
    directReports,
    directReportCount: directReports.length,
  };
}

async function handleGetDirectReports(login: string): Promise<unknown> {
  const result = await heliosGet("/v1/users", {
    attributes: "login",
    "attributes[]": "name",
    "filter[managerLogin]": login,
  });

  if (!result.ok) {
    return {
      error: "helios_api_error",
      message: `Helios API returned ${result.status}: ${result.message}`,
    };
  }

  const data = result.data as HeliosResponse;
  const reports = (data.data ?? []).map((person) => ({
    login: person.id ?? person.attributes?.login ?? "",
    name: person.attributes?.name ?? "",
  }));

  return {
    manager: login,
    count: reports.length,
    directReports: reports,
  };
}

// =============================================================================
// Tool factory
// =============================================================================

/**
 * Creates the Employee Info tool (Helios API).
 *
 * Enabled when HELIOS_API_KEY is set.
 */
export function createEmployeeInfoTool(options?: { enabled?: boolean }): AnyAgentTool | null {
  if (options?.enabled === false) {
    return null;
  }

  if (!HELIOS_CONFIG.apiKey) {
    // Silently disabled — no Helios API key configured
    return null;
  }

  return {
    label: "Employee Info",
    name: "employee_info",
    description:
      "Get detailed NVIDIA employee information from the Helios directory. Returns org structure including the employee's manager chain (all the way up) and their direct reports. Use people_search first to find someone, then use this tool with their login/email for org details.",
    parameters: EmployeeInfoSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const loginRaw = readStringParam(params, "login") ?? "";

      if (!loginRaw) {
        return jsonResult({
          error: "missing_login",
          message: "Please provide a login (username or email address).",
        });
      }

      const login = extractLogin(loginRaw);

      try {
        let result: unknown;
        switch (action) {
          case "get_employee":
            result = await handleGetEmployee(login);
            break;
          case "get_direct_reports":
            result = await handleGetDirectReports(login);
            break;
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown action: ${action}. Valid: ${EMPLOYEE_ACTIONS.join(", ")}`,
            });
        }

        return jsonResult({ action, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: "employee_info_error", message });
      }
    },
  };
}
