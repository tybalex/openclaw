/**
 * NFD (NVIDIA Flex Desk) tool.
 *
 * Provides desk booking capabilities: list locations, check availability,
 * view reservations, and book desks.
 *
 * Uses Azure AD refresh token → silent acquisition → OBO to access the NFD API.
 *
 * Env vars: NFD_SCOPE, NFD_API_BASE_URL (plus AZURE_AD_* for OBO).
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { stringEnum } from "../schema/typebox.js";
import { acquireDownstreamToken, isAzureOBOConfigured } from "./azure-obo.js";
import { jsonResult, readStringParam } from "./common.js";

// =============================================================================
// Configuration
// =============================================================================

const NFD_CONFIG = {
  scope: process.env.NFD_SCOPE ?? "",
  baseUrl: process.env.NFD_API_BASE_URL ?? "https://nfd-dev.nvidia.com",
};

const DEFAULT_TIMEOUT_MS = 30_000;

// =============================================================================
// Actions
// =============================================================================

const NFD_ACTIONS = ["list_locations", "available_desks", "my_reservations", "book_desk"] as const;

// =============================================================================
// Schema
// =============================================================================

const NfdDeskSchema = Type.Object({
  action: stringEnum(NFD_ACTIONS, {
    description:
      "Action to perform: list_locations (get buildings/floors), available_desks (check desk availability for a location+date), my_reservations (get user reservations), book_desk (create a desk reservation).",
  }),
  location_id: Type.Optional(
    Type.String({
      description:
        "Location ID (required for available_desks and book_desk). Get from list_locations.",
    }),
  ),
  date: Type.Optional(
    Type.String({
      description: "Date in YYYY-MM-DD format (for available_desks). Defaults to today.",
    }),
  ),
  time_block_type: Type.Optional(
    Type.String({
      description:
        'Time block type for availability check (default: "BizDay"). Options: BizDay, AM, PM.',
    }),
  ),
  reservation_body: Type.Optional(
    Type.String({
      description:
        "JSON string of the reservation body for book_desk action. Should include location, desk, and time details as returned by the NFD API.",
    }),
  ),
});

// =============================================================================
// NFD API Call
// =============================================================================

async function callNfdApi(
  token: string,
  path: string,
  options: { method?: string; body?: string } = {},
): Promise<unknown> {
  const url = `${NFD_CONFIG.baseUrl}${path}`;

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(options.body ? { body: options.body } : {}),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const data = (await res.json()) as unknown;

  if (!res.ok) {
    const message =
      data && typeof data === "object" && "message" in data
        ? (data as { message: string }).message
        : `NFD API error: ${res.status}`;
    throw new Error(message);
  }

  return data;
}

// =============================================================================
// Action Handlers
// =============================================================================

async function handleListLocations(nfdToken: string): Promise<unknown> {
  return await callNfdApi(nfdToken, "/api/locations");
}

async function handleAvailableDesks(
  nfdToken: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const locationId = readStringParam(params, "location_id", { required: true });
  const date = readStringParam(params, "date") ?? new Date().toISOString().split("T")[0];
  const timeBlockType = readStringParam(params, "time_block_type") ?? "BizDay";

  return await callNfdApi(
    nfdToken,
    `/api/available/${locationId}?SelectedDates=${date}&TimeBlockType=${timeBlockType}`,
  );
}

async function handleMyReservations(nfdToken: string): Promise<unknown> {
  return await callNfdApi(nfdToken, "/api/reservations");
}

async function handleBookDesk(nfdToken: string, params: Record<string, unknown>): Promise<unknown> {
  const bodyStr = readStringParam(params, "reservation_body", { required: true });
  let body: unknown;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    throw new Error("reservation_body must be valid JSON");
  }

  return await callNfdApi(nfdToken, "/api/reservation", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// =============================================================================
// Tool Factory
// =============================================================================

/**
 * Creates the NFD flex desk tool.
 *
 * @param options.getRefreshToken - Function to get the user's Azure AD refresh token.
 * @param options.enabled - Explicit enable/disable override.
 */
export function createNfdDeskTool(options: {
  getRefreshToken: () => string | null | Promise<string | null>;
  enabled?: boolean;
}): AnyAgentTool | null {
  if (options.enabled === false) {
    return null;
  }

  // Check if NFD is configured
  if (!NFD_CONFIG.scope) {
    console.warn("[nfd_desk] NFD_SCOPE not set, tool disabled");
    return null;
  }
  if (!isAzureOBOConfigured()) {
    console.warn("[nfd_desk] Azure AD credentials not configured, tool disabled");
    return null;
  }

  return {
    label: "NFD Desk",
    name: "nfd_desk",
    description:
      "Manage NVIDIA flex desk reservations. Use to search office locations and floors, check desk availability for a specific date, view your existing reservations, or book a flex desk. Requires NVIDIA SSO authentication.",
    parameters: NfdDeskSchema,
    execute: async (_toolCallId, args) => {
      // Get user's refresh token
      const refreshToken = await options.getRefreshToken();
      if (!refreshToken) {
        return jsonResult({
          error: "not_authenticated",
          message: "NFD desk tool requires NVIDIA SSO authentication. Please log in first.",
        });
      }

      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        // Two-step: refresh → OBO for NFD token
        const tokenResult = await acquireDownstreamToken(refreshToken, NFD_CONFIG.scope);
        if (!tokenResult.ok) {
          return jsonResult({
            error: "token_exchange_failed",
            message: `Failed to acquire NFD token: ${"error" in tokenResult ? tokenResult.error : "unknown"}`,
          });
        }
        const nfdToken = tokenResult.accessToken;

        let result: unknown;
        switch (action) {
          case "list_locations":
            result = await handleListLocations(nfdToken);
            break;
          case "available_desks":
            result = await handleAvailableDesks(nfdToken, params);
            break;
          case "my_reservations":
            result = await handleMyReservations(nfdToken);
            break;
          case "book_desk":
            result = await handleBookDesk(nfdToken, params);
            break;
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown action: ${action}. Valid: ${NFD_ACTIONS.join(", ")}`,
            });
        }

        return jsonResult({ action, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: "nfd_api_error", message });
      }
    },
  };
}
