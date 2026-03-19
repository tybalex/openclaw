/**
 * NVIDIA Enterprise plugin.
 *
 * Provides enterprise tools: Glean search, People search, Outlook email,
 * NFD desk booking, Meeting room booking, Employee info (Helios).
 *
 * The NVIDIA model provider is configured via `pnpm nvidia:setup` which
 * writes the config and enables this plugin.
 */

import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { createEmployeeInfoTool } from "./src/employee-info.js";
import { createGleanSearchTool } from "./src/glean-search.js";
import { createMeetingRoomTool } from "./src/meeting-room.js";
import { createNfdDeskTool } from "./src/nfd-desk.js";
import { createOutlookEmailTool } from "./src/outlook-email.js";
import { createPeopleSearchTool } from "./src/people-search.js";

// =============================================================================
// Auth Token Helpers
// =============================================================================

function getSSOToken(): string | null {
  return process.env.NVIDIA_SSO_TOKEN ?? null;
}

function getRefreshToken(): string | null {
  return process.env.AZURE_AD_REFRESH_TOKEN ?? null;
}

// =============================================================================
// Plugin Entry
// =============================================================================

export default definePluginEntry({
  id: "nvidia-enterprise",
  name: "NVIDIA Enterprise Plugin",
  description:
    "NVIDIA enterprise tools: Glean search, People search, Outlook email, NFD desk, Meeting rooms, Employee info",
  register(api) {
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
