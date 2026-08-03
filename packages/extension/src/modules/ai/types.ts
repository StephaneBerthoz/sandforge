/**
 * Shared types for the AI modules (Tier 2).
 *
 * Single source of truth for the prompt-function signature — previously
 * redeclared identically in NL2SOQL, ErrorResolver, AIPersonaManager and
 * SmartSuggestions. Those modules re-export it for backward compatibility.
 */

/** Function signature for calling an AI model. */
export type AIProvider = (prompt: string) => Promise<string>;
