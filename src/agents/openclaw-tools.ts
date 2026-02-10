import type { OpenClawConfig } from "../config/config.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { AnyAgentTool } from "./tools/common.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createEmployeeInfoTool } from "./tools/employee-info.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createGleanSearchTool } from "./tools/glean-search.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMeetingRoomTool } from "./tools/meeting-room.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNfdDeskTool } from "./tools/nfd-desk.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createOutlookEmailTool } from "./tools/outlook-email.js";
import { createPeopleSearchTool } from "./tools/people-search.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";

export function createOpenClawTools(options?: {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Group id for channel-level tool policy inheritance. */
  agentGroupId?: string | null;
  /** Group channel label for channel-level tool policy inheritance. */
  agentGroupChannel?: string | null;
  /** Group space label for channel-level tool policy inheritance. */
  agentGroupSpace?: string | null;
  agentDir?: string;
  sandboxRoot?: string;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  pluginToolAllowlist?: string[];
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
  /** Function to get the current user's OIDC SSO token (for Glean search). */
  getOidcToken?: () => string | null | Promise<string | null>;
  /** Function to get the Azure AD refresh token (for NFD desk, meeting rooms via silent acquisition). */
  getAzureRefreshToken?: () => string | null | Promise<string | null>;
}): AnyAgentTool[] {
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        sandboxRoot: options?.sandboxRoot,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const tools: AnyAgentTool[] = [
    createBrowserTool({
      sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      allowHostControl: options?.allowHostBrowserControl,
    }),
    createCanvasTool(),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createMessageTool({
      agentAccountId: options?.agentAccountId,
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
      currentChannelId: options?.currentChannelId,
      currentChannelProvider: options?.agentChannel,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
      sandboxRoot: options?.sandboxRoot,
    }),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
  ];

  // Add Glean search if OIDC token getter is provided and ECS is configured
  const gleanSearchTool = options?.getOidcToken
    ? createGleanSearchTool({
        getSSOToken: options.getOidcToken,
        enabled: Boolean(process.env.ECS_CONTENT_SEARCH_URL),
      })
    : null;
  if (gleanSearchTool) {
    tools.push(gleanSearchTool);
  }

  // Add NFD desk tool if refresh token getter is provided and NFD is configured
  const nfdDeskTool = options?.getAzureRefreshToken
    ? createNfdDeskTool({
        getRefreshToken: options.getAzureRefreshToken,
        enabled: Boolean(process.env.NFD_SCOPE),
      })
    : null;
  if (nfdDeskTool) {
    tools.push(nfdDeskTool);
  }

  // Add meeting room tool if refresh token getter is provided and Azure AD is configured
  const meetingRoomTool = options?.getAzureRefreshToken
    ? createMeetingRoomTool({
        getRefreshToken: options.getAzureRefreshToken,
      })
    : null;
  if (meetingRoomTool) {
    tools.push(meetingRoomTool);
  }

  // Add Outlook email tool if refresh token getter is provided and Azure AD is configured
  const outlookEmailTool = options?.getAzureRefreshToken
    ? createOutlookEmailTool({
        getRefreshToken: options.getAzureRefreshToken,
      })
    : null;
  if (outlookEmailTool) {
    tools.push(outlookEmailTool);
  }

  // Add People Search tool if refresh token getter is provided and Azure AD is configured
  const peopleSearchTool = options?.getAzureRefreshToken
    ? createPeopleSearchTool({
        getRefreshToken: options.getAzureRefreshToken,
      })
    : null;
  if (peopleSearchTool) {
    tools.push(peopleSearchTool);
  }

  // Add Employee Info tool (Helios API — enabled when HELIOS_API_KEY is set)
  const employeeInfoTool = createEmployeeInfoTool();
  if (employeeInfoTool) {
    tools.push(employeeInfoTool);
  }

  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      sessionKey: options?.agentSessionKey,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [...tools, ...pluginTools];
}
