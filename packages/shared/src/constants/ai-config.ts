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
} as const;

/**
 * The model a `sandforge.ai.model` value asks: the value, or
 * {@link AI_CONFIG.MODEL} when it names none.
 *
 * Emptied in the Settings editor, the setting holds an empty string rather than
 * its default, and a settings.json edited by hand can hold anything. An empty
 * name went out as the model's, and the 400 that came back did not point at the
 * setting. A value that is not text, or holds only whitespace, names no model.
 *
 * @param configured - What the setting holds.
 */
export function resolveAIModel(configured: unknown): string {
  return typeof configured === 'string' && configured.trim() !== '' ? configured : AI_CONFIG.MODEL;
}
