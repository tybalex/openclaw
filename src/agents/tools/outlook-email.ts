/**
 * Outlook Email tool (read-only).
 *
 * Provides email reading capabilities via Microsoft Graph API:
 * list inbox emails, read full email content, and search emails.
 *
 * Uses Azure AD refresh token → silent acquisition → OBO for Graph Mail.Read scope.
 *
 * Env vars: AZURE_AD_* for OBO (no additional env vars needed).
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
const OUTLOOK_SCOPES = "https://graph.microsoft.com/Mail.Read";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EMAIL_COUNT = 10;
const MAX_EMAIL_COUNT = 50;

// =============================================================================
// Actions
// =============================================================================

const OUTLOOK_ACTIONS = ["list_emails", "read_email", "search_emails"] as const;

// =============================================================================
// Schema
// =============================================================================

const OutlookEmailSchema = Type.Object({
  action: stringEnum(OUTLOOK_ACTIONS, {
    description:
      "Action to perform: list_emails (get recent inbox emails), read_email (get full email content by ID), search_emails (search emails by keyword).",
  }),
  message_id: Type.Optional(
    Type.String({
      description:
        "Email message ID (required for read_email). Get from list_emails or search_emails.",
    }),
  ),
  count: Type.Optional(
    Type.Number({
      description: `Number of emails to return (for list_emails/search_emails, default: ${DEFAULT_EMAIL_COUNT}, max: ${MAX_EMAIL_COUNT}).`,
      minimum: 1,
      maximum: MAX_EMAIL_COUNT,
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        'Search query string (for search_emails). Searches subject, body, and sender. Example: "quarterly report", "from:alice@nvidia.com".',
    }),
  ),
  folder: Type.Optional(
    Type.String({
      description:
        'Mail folder to search (for list_emails/search_emails). Default: "Inbox". Other options: "SentItems", "Drafts", "Archive".',
    }),
  ),
});

// =============================================================================
// Graph API Call
// =============================================================================

async function callGraphApi(
  token: string,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
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
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    const message = errorData?.error?.message ?? `Graph API error: ${res.status}`;
    throw new Error(message);
  }

  return (await res.json()) as unknown;
}

// =============================================================================
// Response types
// =============================================================================

type GraphEmailAddress = {
  emailAddress?: { name?: string; address?: string };
};

type GraphEmail = {
  id?: string;
  subject?: string;
  from?: GraphEmailAddress;
  toRecipients?: GraphEmailAddress[];
  ccRecipients?: GraphEmailAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  isRead?: boolean;
  importance?: string;
  hasAttachments?: boolean;
};

type GraphEmailList = {
  value?: GraphEmail[];
};

// =============================================================================
// Action Handlers
// =============================================================================

function formatEmailSummary(email: GraphEmail) {
  return {
    id: email.id,
    subject: email.subject ?? "(No subject)",
    from: email.from?.emailAddress?.address ?? "unknown",
    fromName: email.from?.emailAddress?.name ?? "",
    date: email.receivedDateTime,
    preview: email.bodyPreview ?? "",
    isRead: email.isRead,
    importance: email.importance,
    hasAttachments: email.hasAttachments,
  };
}

function formatEmailDetail(email: GraphEmail) {
  const to = (email.toRecipients ?? [])
    .map((r) => r.emailAddress?.address)
    .filter(Boolean)
    .join(", ");
  const cc = (email.ccRecipients ?? [])
    .map((r) => r.emailAddress?.address)
    .filter(Boolean)
    .join(", ");

  // Strip HTML tags for plain text content, keep it readable for the agent
  let bodyText = email.body?.content ?? "";
  if (email.body?.contentType === "html") {
    // Basic HTML stripping: remove tags, decode entities, collapse whitespace
    bodyText = bodyText
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Cap body length to avoid overwhelming the agent context
  const maxBodyLength = 8000;
  const truncated = bodyText.length > maxBodyLength;
  if (truncated) {
    bodyText = bodyText.slice(0, maxBodyLength);
  }

  return {
    id: email.id,
    subject: email.subject ?? "(No subject)",
    from: email.from?.emailAddress?.address ?? "unknown",
    fromName: email.from?.emailAddress?.name ?? "",
    to,
    cc: cc || undefined,
    date: email.receivedDateTime,
    importance: email.importance,
    hasAttachments: email.hasAttachments,
    body: bodyText,
    ...(truncated ? { bodyTruncated: true } : {}),
  };
}

async function handleListEmails(
  graphToken: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const count = readNumberParam(params, "count", { integer: true }) ?? DEFAULT_EMAIL_COUNT;
  const folder = readStringParam(params, "folder") ?? "Inbox";

  const data = (await callGraphApi(graphToken, `/me/mailFolders/${folder}/messages`, {
    $top: String(Math.min(count, MAX_EMAIL_COUNT)),
    $orderby: "receivedDateTime desc",
    $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,importance,hasAttachments",
  })) as GraphEmailList;

  const emails = (data.value ?? []).map(formatEmailSummary);
  return { count: emails.length, emails };
}

async function handleReadEmail(
  graphToken: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const messageId = readStringParam(params, "message_id", { required: true });

  const data = (await callGraphApi(graphToken, `/me/messages/${messageId}`, {
    $select:
      "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,importance,hasAttachments",
  })) as GraphEmail;

  return formatEmailDetail(data);
}

async function handleSearchEmails(
  graphToken: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const query = readStringParam(params, "query", { required: true });
  const count = readNumberParam(params, "count", { integer: true }) ?? DEFAULT_EMAIL_COUNT;

  const data = (await callGraphApi(graphToken, "/me/messages", {
    $search: `"${query}"`,
    $top: String(Math.min(count, MAX_EMAIL_COUNT)),
    $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,importance,hasAttachments",
  })) as GraphEmailList;

  const emails = (data.value ?? []).map(formatEmailSummary);
  return { query, count: emails.length, emails };
}

// =============================================================================
// Tool Factory
// =============================================================================

/**
 * Creates the Outlook email tool (read-only).
 *
 * @param options.getRefreshToken - Function to get the user's Azure AD refresh token.
 * @param options.enabled - Explicit enable/disable override.
 */
export function createOutlookEmailTool(options: {
  getRefreshToken: () => string | null | Promise<string | null>;
  enabled?: boolean;
}): AnyAgentTool | null {
  if (options.enabled === false) {
    return null;
  }

  if (!isAzureOBOConfigured()) {
    console.warn("[outlook_email] Azure AD credentials not configured, tool disabled");
    return null;
  }

  return {
    label: "Outlook Email",
    name: "outlook_email",
    description:
      "Read Outlook emails via Microsoft Graph. Use to list recent inbox emails, read the full content of a specific email, or search emails by keyword. Requires NVIDIA SSO authentication. This tool is read-only and cannot send or modify emails.",
    parameters: OutlookEmailSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        // search_emails / list_emails / read_email all need Graph token
        const refreshToken = await options.getRefreshToken();
        if (!refreshToken) {
          return jsonResult({
            error: "not_authenticated",
            message: "Outlook email tool requires NVIDIA SSO authentication. Please log in first.",
          });
        }

        // Two-step: refresh → OBO for Graph Mail.Read token
        const tokenResult = await acquireDownstreamToken(refreshToken, OUTLOOK_SCOPES);
        if (!tokenResult.ok) {
          return jsonResult({
            error: "token_exchange_failed",
            message: `Failed to acquire Graph token: ${"error" in tokenResult ? tokenResult.error : "unknown"}`,
          });
        }
        const graphToken = tokenResult.accessToken;

        let result: unknown;
        switch (action) {
          case "list_emails":
            result = await handleListEmails(graphToken, params);
            break;
          case "read_email":
            result = await handleReadEmail(graphToken, params);
            break;
          case "search_emails":
            result = await handleSearchEmails(graphToken, params);
            break;
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown action: ${action}. Valid: ${OUTLOOK_ACTIONS.join(", ")}`,
            });
        }

        return jsonResult({ action, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: "outlook_email_error", message });
      }
    },
  };
}
