/**
 * NVIDIA Enterprise plugin.
 *
 * Provides enterprise tools and OIDC login for NVIDIA SSO.
 * Run `pnpm nvidia:setup` to configure, then visit
 * http://localhost:3000/nvidia-oidc/login to authenticate.
 */

import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { createEmployeeInfoTool } from "./src/employee-info.js";
import { createGleanSearchTool } from "./src/glean-search.js";
import { createMeetingRoomTool } from "./src/meeting-room.js";
import { createNfdDeskTool } from "./src/nfd-desk.js";
import {
  getSSOToken,
  getRefreshToken,
  handleLogin,
  handleCallback,
  handleStatus,
  handleLogout,
} from "./src/oidc.js";
import { createOutlookEmailTool } from "./src/outlook-email.js";
import { createPeopleSearchTool } from "./src/people-search.js";

// =============================================================================
// Plugin Entry
// =============================================================================

export default definePluginEntry({
  id: "nvidia-enterprise",
  name: "NVIDIA Enterprise Plugin",
  description:
    "NVIDIA enterprise tools + OIDC SSO login for Glean, People, Outlook, NFD, Meeting rooms, Employee info",
  register(api) {
    // -------------------------------------------------------------------------
    // 1. OIDC HTTP routes (no gateway auth — handles its own auth)
    // -------------------------------------------------------------------------
    api.registerHttpRoute({
      path: "/nvidia-oidc/login",
      auth: "plugin",
      handler: (req, res) => {
        handleLogin(req, res);
      },
    });
    api.registerHttpRoute({
      path: "/nvidia-oidc/callback",
      auth: "plugin",
      handler: async (req, res) => {
        await handleCallback(req, res);
      },
    });
    api.registerHttpRoute({
      path: "/nvidia-oidc/status",
      auth: "plugin",
      handler: (req, res) => {
        handleStatus(req, res);
      },
    });
    api.registerHttpRoute({
      path: "/nvidia-oidc/logout",
      auth: "plugin",
      handler: (req, res) => {
        handleLogout(req, res);
      },
    });

    // -------------------------------------------------------------------------
    // 2. Enterprise tools (token getters use OIDC store with env var fallback)
    // -------------------------------------------------------------------------
    const tools: Array<AnyAgentTool | null> = [
      createGleanSearchTool({ getSSOToken }),
      createPeopleSearchTool({ getRefreshToken }),
      createOutlookEmailTool({ getRefreshToken }),
      createNfdDeskTool({ getRefreshToken }),
      createMeetingRoomTool({ getRefreshToken }),
      createEmployeeInfoTool(),
    ];

    for (const tool of tools) {
      if (tool) {
        api.registerTool(tool);
      }
    }
  },
});
