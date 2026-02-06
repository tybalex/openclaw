import type { AuthChoice } from "./onboard-types.js";

const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<AuthChoice, string>> = {
  "nvidia-api-key": "nvidia",
};

export function resolvePreferredProviderForAuthChoice(choice: AuthChoice): string | undefined {
  return PREFERRED_PROVIDER_BY_AUTH_CHOICE[choice];
}
