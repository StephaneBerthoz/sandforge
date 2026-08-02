/** Default AI provider identifier. */
export const AI_PROVIDER = 'anthropic' as const;

/** Default AI model configuration constants. */
export const AI_CONFIG = {
  /** Default model identifier. */
  MODEL: 'claude-sonnet-4-5-20250929',
  /** Default temperature for AI requests (0-1 scale). */
  TEMPERATURE: 0.3,
  /** Default max tokens for AI responses. */
  MAX_TOKENS: 4_096,
  /** Timeout for AI requests in milliseconds (60 seconds). */
  TIMEOUT_MS: 60_000,
  /** Default Anthropic API base URL. */
  BASE_URL: 'https://api.anthropic.com',
  /** Anthropic API version header value. */
  API_VERSION: '2023-06-01',
} as const;
