/**
 * NVIDIA Enterprise plugin.
 *
 * Provides:
 * - NVIDIA inference API provider (Claude Opus 4.5 via NVIDIA)
 * - Enterprise tools: Glean search, People search, Outlook email,
 *   NFD desk booking, Meeting room booking, Employee info (Helios)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";
import { createEmployeeInfoTool } from "./src/employee-info.js";
import { createGleanSearchTool } from "./src/glean-search.js";
import { createMeetingRoomTool } from "./src/meeting-room.js";
import { createNfdDeskTool } from "./src/nfd-desk.js";
import { createOutlookEmailTool } from "./src/outlook-email.js";
import { createPeopleSearchTool } from "./src/people-search.js";

// =============================================================================
// Provider Configuration
// =============================================================================

const PROVIDER_ID = "nvidia";
const NVIDIA_INFERENCE_BASE_URL = "https://inference-api.nvidia.com";
const DEFAULT_MODEL = `${PROVIDER_ID}/aws/anthropic/claude-opus-4-5`;

function buildNvidiaEnterpriseProvider(): ModelProviderConfig {
  return {
    baseUrl: NVIDIA_INFERENCE_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "aws/anthropic/claude-opus-4-5",
        name: "Claude Opus 4.5 (NVIDIA)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ],
  };
}

// =============================================================================
// Auth Token Helpers
// =============================================================================

// Placeholder token accessors. In a real deployment these would be wired to
// the OIDC/SSO session managed by the gateway. Env-var fallbacks allow simple
// local testing.

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
    "NVIDIA enterprise integrations: inference API provider and enterprise tools (Glean, People, Outlook, NFD, Meeting Rooms, Employee Info)",
  register(api) {
    // -------------------------------------------------------------------------
    // 1. Register the NVIDIA inference provider
    // -------------------------------------------------------------------------
    api.registerProvider({
      id: PROVIDER_ID,
      label: "NVIDIA",
      docsPath: "/providers/nvidia",
      envVars: ["NVIDIA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "NVIDIA API Key",
          hint: "NVIDIA inference API key",
          optionKey: "nvidiaApiKey",
          flagName: "--nvidia-api-key",
          envVar: "NVIDIA_API_KEY",
          promptMessage: "Enter NVIDIA API key",
          defaultModel: DEFAULT_MODEL,
          expectedProviders: [PROVIDER_ID],
          wizard: {
            choiceId: "nvidia-api-key",
            choiceLabel: "NVIDIA API Key",
            groupId: "nvidia",
            groupLabel: "NVIDIA",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildNvidiaEnterpriseProvider,
          }),
      },
    });

    // -------------------------------------------------------------------------
    // 2. Register enterprise tools (each factory returns null if not configured)
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

    // -------------------------------------------------------------------------
    // 3. Register CLI: `openclaw nvidia setup`
    // -------------------------------------------------------------------------
    api.registerCli(
      ({ program }) => {
        const nvidia = program.command("nvidia").description("NVIDIA enterprise plugin commands");

        nvidia
          .command("setup")
          .description("Configure OpenClaw to use NVIDIA as the default provider")
          .option("--port <port>", "Gateway port (default: 3000)", "3000")
          .option("--auth <mode>", "Gateway auth mode (default: none)", "none")
          .action((opts: { port: string; auth: string }) => {
            const configDir = path.join(os.homedir(), ".openclaw");
            const configPath = path.join(configDir, "openclaw.json");
            fs.mkdirSync(configDir, { recursive: true });

            // Read existing config or start fresh
            let cfg: Record<string, unknown> = {};
            try {
              cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            } catch {
              // no existing config
            }

            // Apply NVIDIA defaults
            cfg.gateway = {
              ...(cfg.gateway as Record<string, unknown> | undefined),
              mode: "local",
              port: Number(opts.port),
              auth: { mode: opts.auth },
            };
            cfg.agents = {
              ...(cfg.agents as Record<string, unknown> | undefined),
              defaults: {
                ...((cfg.agents as Record<string, unknown> | undefined)?.defaults as
                  | Record<string, unknown>
                  | undefined),
                model: { primary: DEFAULT_MODEL },
              },
            };
            cfg.models = {
              ...(cfg.models as Record<string, unknown> | undefined),
              mode: "merge",
              providers: {
                ...((cfg.models as Record<string, unknown> | undefined)?.providers as
                  | Record<string, unknown>
                  | undefined),
                nvidia: {
                  baseUrl: NVIDIA_INFERENCE_BASE_URL,
                  apiKey: "${NVIDIA_API_KEY}",
                  api: "openai-completions",
                  models: [
                    {
                      id: "aws/anthropic/claude-opus-4-5",
                      name: "Claude Opus 4.5 (NVIDIA)",
                      reasoning: true,
                      input: ["text", "image"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 200000,
                      maxTokens: 32000,
                    },
                  ],
                },
              },
            };

            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
            console.log(`Wrote ${configPath}`);
            console.log(`  Provider: NVIDIA (${NVIDIA_INFERENCE_BASE_URL})`);
            console.log(`  Model:    ${DEFAULT_MODEL}`);
            console.log(`  Port:     ${opts.port}`);
            console.log(`  Auth:     ${opts.auth}`);
            console.log("\nSet NVIDIA_API_KEY in your environment, then run: openclaw gateway run");
          });
      },
      { commands: ["nvidia"] },
    );
  },
});
