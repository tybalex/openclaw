#!/usr/bin/env node
/**
 * Quick setup for NVIDIA enterprise provider.
 * Usage: pnpm nvidia:setup [--port 3000] [--auth none]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NVIDIA_INFERENCE_BASE_URL = "https://inference-api.nvidia.com";
const DEFAULT_MODEL = "nvidia/aws/anthropic/bedrock-claude-sonnet-4-6";

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const port = Number(getArg("port", "3000"));
const auth = getArg("auth", "none");

const configDir = path.join(os.homedir(), ".openclaw");
const configPath = path.join(configDir, "openclaw.json");
fs.mkdirSync(configDir, { recursive: true });

let cfg: Record<string, unknown> = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch {
  // no existing config
}

cfg.gateway = {
  ...(cfg.gateway as Record<string, unknown> | undefined),
  mode: "local",
  port,
  auth: { mode: auth },
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
          id: "aws/anthropic/bedrock-claude-sonnet-4-6",
          name: "Claude Sonnet 4.6 (NVIDIA)",
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
cfg.plugins = {
  ...(cfg.plugins as Record<string, unknown> | undefined),
  entries: {
    ...((cfg.plugins as Record<string, unknown> | undefined)?.entries as
      | Record<string, unknown>
      | undefined),
    "nvidia-enterprise": { enabled: true },
  },
};

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
console.log(`Wrote ${configPath}`);
console.log(`  Provider: NVIDIA (${NVIDIA_INFERENCE_BASE_URL})`);
console.log(`  Model:    ${DEFAULT_MODEL}`);
console.log(`  Port:     ${port}`);
console.log(`  Auth:     ${auth}`);
console.log(`  Plugin:   nvidia-enterprise (enabled)`);
console.log("\nSet NVIDIA_API_KEY in your environment, then run: openclaw gateway run");
