// Defaults for agent metadata when upstream does not supply them.
// Model id uses NVIDIA inference API.
export const DEFAULT_PROVIDER = "nvidia";
export const DEFAULT_MODEL = "aws/anthropic/claude-opus-4-5";
// Context window: Opus 4.5 supports ~200k tokens.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
