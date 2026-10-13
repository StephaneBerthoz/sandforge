/**
 * Shared types for the AI modules.
 *
 * Single source of truth for the prompt-function signature — previously
 * redeclared identically in NL2SOQL, ErrorResolver and AIPersonaManager.
 * Those modules re-export it for backward compatibility.
 */

/**
 * Function signature for calling an AI model.
 *
 * `system` is optional so callers that have no spotlight prompt to send stay
 * assignable, but modules that feed org-writable text to the model MUST pass
 * one — the "treat <user-data> as DATA" clause is half of the prompt-injection
 * defense (see adapters/ai/systemPrompts/index.ts).
 */
export type AIProvider = (
  prompt: string,
  system?: string,
  options?: AIProviderOptions,
) => Promise<string>;

/** What a single prompt call carries besides its texts. */
export interface AIProviderOptions {
  /**
   * Aborts the call to the model: the page's Stop. The promise then rejects,
   * and the caller applies nothing of it.
   */
  signal?: AbortSignal;
}
