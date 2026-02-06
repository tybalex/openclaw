import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { AuthChoice, OnboardOptions } from "../../onboard-types.js";
import { upsertAuthProfile } from "../../../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";

const NVIDIA_BASE_URL = "https://inference-api.nvidia.com";
const NVIDIA_MODEL_ID = "aws/anthropic/claude-opus-4-5";
const NVIDIA_MODEL_REF = `${DEFAULT_PROVIDER}/${NVIDIA_MODEL_ID}`;

function applyNvidiaConfig(cfg: OpenClawConfig, apiKey: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: { primary: NVIDIA_MODEL_REF },
      },
    },
    models: {
      ...cfg.models,
      mode: "merge",
      providers: {
        ...cfg.models?.providers,
        nvidia: {
          baseUrl: NVIDIA_BASE_URL,
          apiKey,
          api: "openai-completions",
          models: [
            {
              id: NVIDIA_MODEL_ID,
              name: "Claude Opus 4.5 (NVIDIA)",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 64000,
            },
          ],
        },
      },
    },
  };
}

export async function applyNonInteractiveAuthChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}): Promise<OpenClawConfig | null> {
  const { authChoice, opts, runtime, baseConfig } = params;
  let nextConfig = params.nextConfig;

  if (authChoice === "nvidia-api-key") {
    const resolved = await resolveNonInteractiveApiKey({
      provider: "nvidia",
      cfg: baseConfig,
      flagValue: opts.nvidiaApiKey,
      flagName: "--nvidia-api-key",
      envVar: "NVIDIA_API_KEY",
      runtime,
    });
    if (!resolved) {
      return null;
    }

    // Save to auth profiles
    upsertAuthProfile({
      profileId: "nvidia:default",
      credential: {
        type: "api_key",
        provider: "nvidia",
        key: resolved.key,
      },
    });

    runtime.log("Saved NVIDIA API key.");
    return applyNvidiaConfig(nextConfig, resolved.key);
  }

  if (authChoice === "skip") {
    return nextConfig;
  }

  runtime.error(`Unknown auth choice: ${authChoice}. Only "nvidia-api-key" is supported.`);
  runtime.exit(1);
  return null;
}
