/** Default AI provider identifier. */
export const AI_PROVIDER = 'anthropic' as const;

/** Default AI model configuration constants. */
export const AI_CONFIG = {
  /**
   * The model an install that sets no `sandforge.ai.model` asks. The adapter
   * falls back to this one, and the manifest declares it as the setting's
   * default: the extension's tests hold the two together.
   */
  MODEL: 'claude-sonnet-5',
  /**
   * The cap on an answer's tokens. Claude Sonnet 5 counts about 30% more
   * tokens than earlier models for the same text, and Seed asks for up to 50
   * records in one call: at 4 096, a reply of values that fitted before could
   * be cut off, and a cut-off answer is not used. It is a cap, not a target:
   * an answer costs the tokens it has, and the budget checks what goes in.
   */
  MAX_TOKENS: 8_192,
  /** Timeout for AI requests in milliseconds (60 seconds). */
  TIMEOUT_MS: 60_000,
  /** Default Anthropic API base URL. */
  BASE_URL: 'https://api.anthropic.com',
  /** Anthropic API version header value. */
  API_VERSION: '2023-06-01',
} as const;
