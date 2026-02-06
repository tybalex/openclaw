import type { OpenClawConfig } from "../config/config.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "./auth-choice.api-key.js";

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

export async function applyAuthChoiceNvidia(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  const { authChoice, prompter, config } = params;

  if (authChoice !== "nvidia-api-key") {
    return null;
  }

  // Check for existing API key in environment
  const envKey = process.env.NVIDIA_API_KEY?.trim();
  if (envKey) {
    const useExisting = await prompter.confirm({
      message: `Use existing NVIDIA_API_KEY from environment?`,
      initialValue: true,
    });
    if (useExisting) {
      upsertAuthProfile({
        profileId: "nvidia:default",
        credential: {
          type: "api_key",
          provider: "nvidia",
          key: envKey,
        },
      });
      const nextConfig = applyNvidiaConfig(config, envKey);
      await prompter.note(`Using NVIDIA API key from environment.`, "NVIDIA API key");
      return { config: nextConfig };
    }
  }

  // Prompt for API key
  const key = await prompter.text({
    message: "Enter NVIDIA API key",
    validate: validateApiKeyInput,
  });

  const trimmed = normalizeApiKeyInput(String(key));

  // Save to auth profiles
  upsertAuthProfile({
    profileId: "nvidia:default",
    credential: {
      type: "api_key",
      provider: "nvidia",
      key: trimmed,
    },
  });

  const nextConfig = applyNvidiaConfig(config, trimmed);
  await prompter.note(`Saved NVIDIA API key.`, "NVIDIA API key");

  return { config: nextConfig };
}
