/**
 * Meeting Room tool.
 *
 * Provides meeting room capabilities: search rooms (via meet.nvidia.com),
 * check availability (via Microsoft Graph), and book rooms (via Microsoft Graph).
 *
 * Room inventory comes from meet.nvidia.com (no auth required).
 * Availability and booking use Microsoft Graph API via Azure AD refresh → OBO.
 *
 * Env vars: GRAPH_SCOPES, MEET_API_URL (plus AZURE_AD_* for OBO).
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { stringEnum } from "../schema/typebox.js";
import { acquireDownstreamToken, isAzureOBOConfigured } from "./azure-obo.js";
import { jsonResult, readStringParam } from "./common.js";

// =============================================================================
// Configuration
// =============================================================================

const GRAPH_CONFIG = {
  scopes: (
    process.env.GRAPH_SCOPES ??
    "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Group.Read.All"
  )
    .split(" ")
    .filter(Boolean),
  baseUrl: "https://graph.microsoft.com/v1.0",
};

const MEET_API_URL = process.env.MEET_API_URL ?? "https://meet.nvidia.com/api/v1";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEZONE = "America/Los_Angeles";

// =============================================================================
// Actions
// =============================================================================

const MEETING_ROOM_ACTIONS = ["search_rooms", "check_availability", "book_room"] as const;

// =============================================================================
// Schema
// =============================================================================

const MeetingRoomSchema = Type.Object({
  action: stringEnum(MEETING_ROOM_ACTIONS, {
    description:
      "Action to perform: search_rooms (find meeting rooms by location), check_availability (check if rooms are free at a given time), book_room (create a calendar event to book a room).",
  }),
  location: Type.Optional(
    Type.String({
      description:
        "Filter rooms by location/building name (for search_rooms). Leave empty for all locations.",
    }),
  ),
  room_emails: Type.Optional(
    Type.String({
      description:
        "Comma-separated room email addresses (for check_availability). Get emails from search_rooms.",
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description:
        "Start time in ISO 8601 format, e.g. 2025-01-15T10:00:00 (for check_availability and book_room).",
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description:
        "End time in ISO 8601 format, e.g. 2025-01-15T11:00:00 (for check_availability and book_room).",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description: `Timezone for the meeting (default: "${DEFAULT_TIMEZONE}"). Example: "America/New_York".`,
    }),
  ),
  room_email: Type.Optional(
    Type.String({
      description: "Room email address to book (for book_room).",
    }),
  ),
  subject: Type.Optional(
    Type.String({
      description: 'Meeting subject/title (for book_room). Defaults to "Meeting".',
    }),
  ),
});

// =============================================================================
// Graph API Call
// =============================================================================

async function callGraphApi(
  token: string,
  path: string,
  options: { method?: string; body?: string } = {},
): Promise<unknown> {
  const url = `${GRAPH_CONFIG.baseUrl}${path}`;

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(options.body ? { body: options.body } : {}),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const message = errorData?.error?.message ?? `Graph API error: ${res.status}`;
    throw new Error(message);
  }

  return (await res.json()) as unknown;
}

// =============================================================================
// Action Handlers
// =============================================================================

type MeetRoom = {
  name?: string;
  email?: string;
  location?: string;
  isMTRSupported?: boolean;
};

async function handleSearchRooms(params: Record<string, unknown>): Promise<unknown> {
  const locationFilter = readStringParam(params, "location");

  const res = await fetch(`${MEET_API_URL}/room`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Meet API returned ${res.status}: ${res.statusText}`);
  }

  const rooms = (await res.json()) as MeetRoom[];

  // Filter by location if provided
  const filtered = locationFilter
    ? rooms.filter(
        (r) => r.location && r.location.toLowerCase().includes(locationFilter.toLowerCase()),
      )
    : rooms;

  // Extract unique locations
  const locations = Array.from(new Set(filtered.map((r) => r.location).filter(Boolean))).sort();

  // Return summary (cap at 30 rooms to avoid overwhelming the agent)
  const maxResults = 30;
  return {
    total: filtered.length,
    locations,
    rooms: filtered.slice(0, maxResults).map((r) => ({
      name: r.name,
      email: r.email,
      location: r.location,
      isMTRSupported: r.isMTRSupported,
    })),
    ...(filtered.length > maxResults
      ? {
          note: `Showing first ${maxResults} of ${filtered.length}. Use location filter to narrow.`,
        }
      : {}),
  };
}

type ScheduleValue = {
  scheduleId?: string;
  availabilityView?: string;
  scheduleItems?: unknown[];
};

async function handleCheckAvailability(
  graphToken: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const roomEmailsStr = readStringParam(params, "room_emails", { required: true });
  const startTime = readStringParam(params, "start_time", { required: true });
  const endTime = readStringParam(params, "end_time", { required: true });
  const timezone = readStringParam(params, "timezone") ?? DEFAULT_TIMEZONE;

  const schedules = roomEmailsStr
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (schedules.length === 0) {
    throw new Error("At least one room email is required");
  }

  const data = (await callGraphApi(graphToken, "/me/calendar/getSchedule", {
    method: "POST",
    body: JSON.stringify({
      schedules,
      startTime: { dateTime: startTime, timeZone: timezone },
      endTime: { dateTime: endTime, timeZone: timezone },
      availabilityViewInterval: 30,
    }),
  })) as { value?: ScheduleValue[] };

  // Format availability info for the agent
  const availability = (data.value ?? []).map((s) => ({
    room: s.scheduleId,
    available: s.availabilityView === "0" || s.availabilityView === "00" ? "YES" : "NO (busy)",
    availabilityView: s.availabilityView,
    scheduleItems: s.scheduleItems,
  }));

  return { schedules: availability };
}

type GraphEvent = {
  id?: string;
  subject?: string;
  start?: unknown;
  end?: unknown;
  webLink?: string;
};

async function handleBookRoom(
  graphToken: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const roomEmail = readStringParam(params, "room_email", { required: true });
  const subject = readStringParam(params, "subject") ?? "Meeting";
  const startTime = readStringParam(params, "start_time", { required: true });
  const endTime = readStringParam(params, "end_time", { required: true });
  const timezone = readStringParam(params, "timezone") ?? DEFAULT_TIMEZONE;

  const data = (await callGraphApi(graphToken, "/me/events", {
    method: "POST",
    body: JSON.stringify({
      subject,
      start: { dateTime: startTime, timeZone: timezone },
      end: { dateTime: endTime, timeZone: timezone },
      attendees: [
        {
          emailAddress: { address: roomEmail, name: roomEmail },
          type: "resource",
        },
      ],
    }),
  })) as GraphEvent;

  return {
    success: !!data.id,
    eventId: data.id,
    subject: data.subject,
    start: data.start,
    end: data.end,
    webLink: data.webLink,
  };
}

// =============================================================================
// Tool Factory
// =============================================================================

/**
 * Creates the meeting room tool.
 *
 * @param options.getRefreshToken - Function to get the user's Azure AD refresh token.
 * @param options.enabled - Explicit enable/disable override.
 */
export function createMeetingRoomTool(options: {
  getRefreshToken: () => string | null | Promise<string | null>;
  enabled?: boolean;
}): AnyAgentTool | null {
  if (options.enabled === false) {
    return null;
  }

  if (!isAzureOBOConfigured()) {
    console.warn("[meeting_room] Azure AD credentials not configured, tool disabled");
    return null;
  }

  return {
    label: "Meeting Room",
    name: "meeting_room",
    description:
      "Search and book NVIDIA meeting rooms. Use to find available meeting rooms by location, check room availability for a specific time, or book a room by creating a calendar event. Room search uses the meet.nvidia.com directory; availability and booking use Microsoft Graph. Requires NVIDIA SSO authentication for availability checks and booking.",
    parameters: MeetingRoomSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        // search_rooms doesn't need auth (meet.nvidia.com is internal)
        if (action === "search_rooms") {
          const result = await handleSearchRooms(params);
          return jsonResult({ action, result });
        }

        // Other actions need Graph token via refresh → OBO
        const refreshToken = await options.getRefreshToken();
        if (!refreshToken) {
          return jsonResult({
            error: "not_authenticated",
            message:
              "Meeting room availability/booking requires NVIDIA SSO authentication. Please log in first.",
          });
        }

        // Two-step: refresh → OBO for Graph token
        const tokenResult = await acquireDownstreamToken(refreshToken, GRAPH_CONFIG.scopes);
        if (!tokenResult.ok) {
          return jsonResult({
            error: "token_exchange_failed",
            message: `Failed to acquire Graph token: ${"error" in tokenResult ? tokenResult.error : "unknown"}`,
          });
        }
        const graphToken = tokenResult.accessToken;

        let result: unknown;
        switch (action) {
          case "check_availability":
            result = await handleCheckAvailability(graphToken, params);
            break;
          case "book_room":
            result = await handleBookRoom(graphToken, params);
            break;
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown action: ${action}. Valid: ${MEETING_ROOM_ACTIONS.join(", ")}`,
            });
        }

        return jsonResult({ action, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: "meeting_room_error", message });
      }
    },
  };
}
