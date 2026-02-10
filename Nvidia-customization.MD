# NVIDIA Customization Summary

This document describes all NVIDIA-specific customizations made to the OpenClaw project, covering SSO authentication, Glean enterprise search, and NVIDIA workspace integrations (flex desk booking and meeting rooms).

---

## Table of Contents

1. [NVIDIA SSO (OIDC Authentication)](#1-nvidia-sso-oidc-authentication)
2. [Glean / Enterprise Content Search (ECS)](#2-glean--enterprise-content-search-ecs)
3. [Azure AD On-Behalf-Of (OBO) Token Exchange](#3-azure-ad-on-behalf-of-obo-token-exchange)
4. [NFD Flex Desk Booking](#4-nfd-flex-desk-booking)
5. [Meeting Room Search & Booking](#5-meeting-room-search--booking)
6. [UI Changes](#6-ui-changes)
7. [Token Flow Architecture](#7-token-flow-architecture)
8. [Environment Variables](#8-environment-variables)
9. [File Inventory](#9-file-inventory)

---

## 1. NVIDIA SSO (OIDC Authentication)

**Prior work** (commits `a0d8763`, `e7ec3ee`): Gateway OIDC auth support and Glean search integration.

The gateway supports OIDC-based authentication, allowing users to sign in with NVIDIA SSO. This produces an OIDC token that flows through the system for user-context API calls.

### Key files (pre-existing)

- `src/gateway/auth.ts` — Gateway auth logic, accepts `oidcToken` in WebSocket connect frame.
- `src/gateway/protocol/schema/frames.ts` — Protocol schema for the WebSocket `hello` frame including auth fields.

---

## 2. Glean / Enterprise Content Search (ECS)

**Prior work** (commit `e7ec3ee`): Full Glean search integration.

The Glean search tool allows the AI agent to search NVIDIA's internal enterprise knowledge base (Confluence, Slack, Google Drive, Jira, SharePoint, etc.) on behalf of the authenticated user.

### How it works

1. **Authentication**: Uses a two-token model:
   - **SSA token** (Starfleet service-to-service): Acquired via client credentials (`STARFLEET_CLIENT_ID` / `STARFLEET_CLIENT_SECRET`). Sent as `Authorization: Bearer` header.
   - **User's SSO token**: The user's Azure AD access token (audience `be67b199-...`), sent as `Nv-Actor-Token` header. This identifies who is searching so results respect the user's permissions.

2. **Client-side login**: `ui/src/ui/glean-auth.ts` implements Azure AD OAuth with PKCE in a popup window. The scope targets `api://be67b199-.../Chat.Access` so the token has the correct audience for ECS.

3. **Backend proxy**: `src/gateway/glean-auth-http.ts` proxies the OAuth code-for-token exchange to avoid CORS issues (browser cannot POST directly to Azure AD token endpoint).

4. **Tool**: `src/agents/tools/glean-search.ts` — The `glean_search` agent tool. Takes a search query, optional datasource filters, and pagination parameters. Returns titles, URLs, content snippets, and metadata.

### Key files

| File | Role |
|---|---|
| `src/agents/tools/glean-search.ts` | Glean search tool (SSA token + user SSO token) |
| `ui/src/ui/glean-auth.ts` | Client-side Azure AD login (PKCE popup flow) |
| `src/gateway/glean-auth-http.ts` | Backend proxy for token exchange / refresh |

---

## 3. Azure AD On-Behalf-Of (OBO) Token Exchange

**New file**: `src/agents/tools/azure-obo.ts`

This is the shared utility for acquiring downstream API tokens. It supports two flows:

### Silent token acquisition (via refresh token)

Azure AD refresh tokens are multi-resource — a refresh token obtained for one resource (e.g., `be67b199-...` for Glean) can be used to silently acquire tokens for a different resource (e.g., `6afc7495-...` for OBO).

```
Refresh Token → POST /oauth2/v2.0/token (grant_type=refresh_token, scope=api://6afc7495-.../User.Access)
             → Access Token (aud=6afc7495-...)
```

### OBO exchange (for downstream APIs)

Once we have a token with the correct audience (`aud=6afc7495-...`, matching `AZURE_AD_CLIENT_ID`), we can exchange it via OBO for downstream API tokens:

```
Access Token (aud=6afc7495-...) → POST /oauth2/v2.0/token (grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer)
                                → Downstream Token (e.g., NFD or Graph API)
```

### Combined two-step flow

The `acquireDownstreamToken()` function chains both steps:

```
Refresh Token → Silent Acquisition → OBO Exchange → Downstream API Token
```

### Why two steps?

The user's SSO token from the Glean login has `aud=be67b199-...` (a different app). OBO requires the assertion token's audience to match the OBO client's `client_id` (`6afc7495-...`). We cannot change the Glean login audience without breaking ECS (which only recognizes `be67b199-...` tokens). The refresh token bridge solves this cleanly.

### Caching

All tokens are cached in-memory with a 5-minute expiry buffer to avoid redundant Azure AD calls.

---

## 4. NFD Flex Desk Booking

**New file**: `src/agents/tools/nfd-desk.ts`

The `nfd_desk` agent tool provides desk booking capabilities via the NFD (NVIDIA Flex Desk) API.

### Actions

| Action | Description | Parameters |
|---|---|---|
| `list_locations` | Get all buildings and floors | — |
| `available_desks` | Check desk availability | `location_id` (required), `date`, `time_block_type` |
| `my_reservations` | Get user's existing reservations | — |
| `book_desk` | Create a desk reservation | `reservation_body` (JSON string) |

### Token flow

```
User's Azure AD Refresh Token
  → acquireDownstreamToken(refreshToken, NFD_SCOPE)
    → Silent: get token for api://6afc7495-.../User.Access
    → OBO: exchange for NFD token (scope from NFD_SCOPE env var)
  → Call NFD API with Bearer token
```

### API base

Default: `https://nfd-dev.nvidia.com` (configurable via `NFD_API_BASE_URL`).

---

## 5. Meeting Room Search & Booking

**New file**: `src/agents/tools/meeting-room.ts`

The `meeting_room` agent tool provides meeting room capabilities using two data sources:
- **meet.nvidia.com** — Room inventory/directory (no auth required, internal API)
- **Microsoft Graph API** — Availability checks and calendar event creation (requires auth)

### Actions

| Action | Description | Auth Required | Parameters |
|---|---|---|---|
| `search_rooms` | Find rooms by location | No | `location` (optional filter) |
| `check_availability` | Check if rooms are free | Yes (Graph) | `room_emails`, `start_time`, `end_time`, `timezone` |
| `book_room` | Book a room (create calendar event) | Yes (Graph) | `room_email`, `subject`, `start_time`, `end_time`, `timezone` |

### Token flow (for check_availability / book_room)

```
User's Azure AD Refresh Token
  → acquireDownstreamToken(refreshToken, GRAPH_SCOPES)
    → Silent: get token for api://6afc7495-.../User.Access
    → OBO: exchange for Graph token (Calendars.ReadWrite, Group.Read.All)
  → Call Microsoft Graph API with Bearer token
```

---

## 6. UI Changes

### Overview page (`ui/src/ui/views/overview.ts`)

- Renamed the "Glean Search" connect button to **"NVIDIA Services"** since it now powers Glean search, desk booking, and meeting rooms.
- Button text changed from "Connect to Glean" to "Connect NVIDIA Services".

### Client-side auth (`ui/src/ui/glean-auth.ts`)

- Login scope: `api://be67b199-.../Chat.Access openid profile offline_access`
  - The `offline_access` scope ensures a refresh token is returned.
  - The `be67b199-...` audience keeps Glean/ECS working.
- Added `getAzureRefreshToken()` export — returns the stored refresh token for downstream tool use.

### Gateway client (`ui/src/ui/gateway.ts`, `ui/src/ui/app-gateway.ts`)

- Added `azureRefreshToken` to the WebSocket client options.
- Passes the refresh token alongside `gleanToken` when connecting to the gateway.

---

## 7. Token Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (UI)                                                    │
│                                                                  │
│  Azure AD Login (popup)                                          │
│    scope: api://be67b199-.../Chat.Access openid profile          │
│           offline_access                                         │
│    ↓                                                             │
│  Code → Backend proxy (glean-auth-http.ts) → Azure AD token EP  │
│    ↓                                                             │
│  Stores: access_token (aud=be67b199) + refresh_token             │
│    ↓                                                             │
│  WebSocket connect → sends both as auth fields                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Gateway Server                                                  │
│                                                                  │
│  ConnectAuth { gleanToken, azureRefreshToken, ... }              │
│    ↓                                                             │
│  MsgContext { GleanToken, AzureRefreshToken, ... }               │
│    ↓                                                             │
│  Runner params { gleanToken, azureRefreshToken, ... }            │
│    ↓                                                             │
│  Tool callbacks:                                                 │
│    getOidcToken()          → gleanToken (for Glean search)       │
│    getAzureRefreshToken()  → refreshToken (for NFD/Graph OBO)    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Agent Tools                                                     │
│                                                                  │
│  glean_search:                                                   │
│    SSA token (client creds) + GleanToken (Nv-Actor-Token)        │
│    → ECS API                                                     │
│                                                                  │
│  nfd_desk / meeting_room:                                        │
│    Refresh Token                                                 │
│      → acquireTokenSilent(scope=api://6afc7495-.../User.Access)  │
│      → exchangeTokenOBO(scope=NFD_SCOPE or GRAPH_SCOPES)        │
│      → Call downstream API                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. Environment Variables

All variables are set in `.env` (gitignored).

### Azure AD (shared across all NVIDIA services)

| Variable | Description | Example |
|---|---|---|
| `AZURE_AD_CLIENT_ID` | Azure AD app registration client ID | (see `.env`) |
| `AZURE_AD_CLIENT_SECRET` | Azure AD app registration client secret | (see `.env`) |
| `AZURE_AD_TENANT_ID` | Azure AD tenant ID | (see `.env`) |
| `AZURE_AD_SCOPES` | Scopes for initial login (informational) | `openid email profile offline_access api://{CLIENT_ID}/User.Access` |

### Glean / ECS

| Variable | Description | Example |
|---|---|---|
| `ECS_CONTENT_SEARCH_URL` | ECS search API endpoint | `https://enterprise-content-intelligence.nvidia.com/v1/content/search` |
| `STARFLEET_CLIENT_ID` | Starfleet SSA client ID | (see `.env`) |
| `STARFLEET_CLIENT_SECRET` | Starfleet SSA client secret | (see `.env`) |
| `STARFLEET_TOKEN_URL` | Starfleet SSA token endpoint | (see `.env`) |
| `STARFLEET_SCOPE` | SSA scopes | `content:search content:retrieve` |

### NFD Flex Desk

| Variable | Description | Default |
|---|---|---|
| `NFD_SCOPE` | Azure AD scope for NFD API (enables the tool) | — |
| `NFD_API_BASE_URL` | NFD API base URL | `https://nfd-dev.nvidia.com` |

### Meeting Rooms

| Variable | Description | Default |
|---|---|---|
| `GRAPH_SCOPES` | Microsoft Graph scopes for OBO | `https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Group.Read.All` |
| `MEET_API_URL` | meet.nvidia.com room inventory API | `https://meet.nvidia.com/api/v1` |

---

## 9. File Inventory

### New files (created in this integration)

| File | Description |
|---|---|
| `src/agents/tools/azure-obo.ts` | Azure AD OBO token exchange + silent acquisition utility |
| `src/agents/tools/nfd-desk.ts` | NFD flex desk agent tool (`nfd_desk`) |
| `src/agents/tools/meeting-room.ts` | Meeting room agent tool (`meeting_room`) |

### Modified files

| File | Change |
|---|---|
| `src/agents/openclaw-tools.ts` | Wire NFD desk + meeting room tools, accept `getAzureRefreshToken` |
| `src/agents/pi-tools.ts` | Accept `getAzureRefreshToken` option, pass to tool factory |
| `src/agents/pi-embedded-runner/run.ts` | Thread `azureRefreshToken` to attempt params |
| `src/agents/pi-embedded-runner/run/attempt.ts` | Pass `getAzureRefreshToken` callback to tool creation |
| `src/agents/pi-embedded-runner/run/params.ts` | Add `azureRefreshToken` to runner params type |
| `src/agents/pi-embedded-runner/run/types.ts` | Add `azureRefreshToken` to runner types |
| `src/auto-reply/reply/agent-runner-execution.ts` | Thread `azureRefreshToken` from session context |
| `src/auto-reply/reply/agent-runner-memory.ts` | Thread `azureRefreshToken` from session context |
| `src/auto-reply/reply/followup-runner.ts` | Thread `azureRefreshToken` from queued run |
| `src/auto-reply/reply/get-reply-inline-actions.ts` | Pass `getAzureRefreshToken` to inline action tools |
| `src/auto-reply/reply/get-reply-run.ts` | Thread `azureRefreshToken` from session context to runner |
| `src/auto-reply/reply/queue/types.ts` | Add `azureRefreshToken` to queued run type |
| `src/auto-reply/templating.ts` | Add `AzureRefreshToken` to `MsgContext` type |
| `src/gateway/auth.ts` | Add `azureRefreshToken` to `ConnectAuth` type |
| `src/gateway/glean-auth-http.ts` | Unified env vars: `GLEAN_AZURE_*` → `AZURE_AD_*` |
| `src/gateway/protocol/schema/frames.ts` | Add `azureRefreshToken` to auth frame schema |
| `src/gateway/server-methods/chat.ts` | Pass `AzureRefreshToken` to `MsgContext` |
| `ui/src/ui/app-gateway.ts` | Import + pass `getAzureRefreshToken` when connecting |
| `ui/src/ui/gateway.ts` | Add `azureRefreshToken` to client options + auth frame |
| `ui/src/ui/glean-auth.ts` | Reverted scope to `be67b199`, added `getAzureRefreshToken()` export |
| `ui/src/ui/views/overview.ts` | Renamed "Glean Search" → "NVIDIA Services" in UI |

### Pre-existing files (for reference)

| File | Description |
|---|---|
| `src/agents/tools/glean-search.ts` | Glean search tool (unchanged) |
| `ui/src/ui/glean-auth.ts` | Client-side Azure AD OAuth (modified scope + added refresh token getter) |
| `src/gateway/glean-auth-http.ts` | Backend proxy for Azure AD token exchange (env var rename only) |
