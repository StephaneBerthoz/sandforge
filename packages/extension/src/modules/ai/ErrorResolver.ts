/** Re-exported from the central AI types module (single source of truth). */
export type { AIProvider } from './types.js';
import type { AIProvider } from './types.js';
import { wrapAsUserData } from '../../adapters/ai/safety/index.js';
import { ERROR_RESOLVE_SYSTEM_PROMPT } from '../../adapters/ai/systemPrompts/index.js';
import {
  resolveKnownError,
  type ErrorResolution,
  type ErrorSuggestion,
  type SalesforceError,
} from '../../core/common/errorKnowledgeBase.js';

export type {
  ErrorResolution,
  ErrorSuggestion,
  SalesforceError,
} from '../../core/common/errorKnowledgeBase.js';

/**
 * What the caller knows about the operation that failed. Every field is
 * optional: a line the caller cannot fill is left out of the prompt rather
 * than sent as "unknown".
 */
export interface OperationContext {
  module?: string;
  operation?: string;
  objectName?: string;
  batchSize?: number;
  recordCount?: number;
}

/** How long a model answer is reused for the same failure. */
const ANSWER_TTL_MS = 10 * 60 * 1000;

/** Most distinct failures whose answer is kept at once. */
const MAX_REMEMBERED_ANSWERS = 50;

/**
 * 15- or 18-character Salesforce Ids. At least one digit is required, so an
 * ordinary 15-letter word is not taken for one.
 */
const SALESFORCE_ID_PATTERN = /\b(?=[A-Za-z]*\d)[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/g;

/**
 * Replace every Salesforce Id in an error message with `<id>`.
 *
 * Two failures that differ only by the record or org they name are the same
 * failure to explain, so this is the key an answer is remembered under.
 */
export function normalizeErrorMessage(message: string): string {
  return message.replace(SALESFORCE_ID_PATTERN, '<id>');
}

/** A model answer in flight or settled, and when it stops being reused. */
interface RememberedAnswer {
  expiresAt: number;
  resolution: Promise<ErrorResolution>;
}

/**
 * Resolves Salesforce errors from the built-in table of known error codes,
 * and asks the model about the others.
 *
 * A failing run tends to fail the same way many times in a row. The model is
 * asked once per distinct failure — same code, same message once Ids are
 * stripped — and the answer is shared with every failure that arrives while
 * the call is in flight or within {@link ANSWER_TTL_MS} after it.
 */
export class ErrorResolver {
  private readonly provider: AIProvider;
  private readonly answers = new Map<string, RememberedAnswer>();

  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  /**
   * Resolve a Salesforce error by looking up the knowledge base first,
   * then falling back to AI analysis for unknown errors.
   * @param error - The Salesforce error to resolve
   * @param context - What is known about the operation when the error occurred
   * @returns A resolution with explanation, suggestions, and auto-fix info
   */
  async resolveError(error: SalesforceError, context: OperationContext): Promise<ErrorResolution> {
    const known = resolveKnownError(error, context);
    if (known) return known;

    return this.resolveWithAI(error, context);
  }

  private resolveWithAI(
    error: SalesforceError,
    context: OperationContext,
  ): Promise<ErrorResolution> {
    const now = Date.now();
    // An error code never holds a colon, so the key cannot be ambiguous.
    const key = `${error.errorCode}:${normalizeErrorMessage(error.message)}`;
    const remembered = this.answers.get(key);
    if (remembered && remembered.expiresAt > now) return remembered.resolution;

    const resolution = this.provider(
      buildAIPrompt(error, context),
      ERROR_RESOLVE_SYSTEM_PROMPT,
    ).then(parseAIResolution);
    this.remember(key, { expiresAt: now + ANSWER_TTL_MS, resolution }, now);
    // A failed call is not an answer: the next failure asks again.
    resolution.catch(() => {
      if (this.answers.get(key)?.resolution === resolution) this.answers.delete(key);
    });
    return resolution;
  }

  private remember(key: string, answer: RememberedAnswer, now: number): void {
    for (const [storedKey, stored] of this.answers) {
      if (stored.expiresAt <= now) this.answers.delete(storedKey);
    }
    this.answers.delete(key);
    this.answers.set(key, answer);
    // Map iteration follows insertion order: the first key is the oldest.
    while (this.answers.size > MAX_REMEMBERED_ANSWERS) {
      const oldest = this.answers.keys().next().value;
      if (oldest === undefined) break;
      this.answers.delete(oldest);
    }
  }
}

/**
 * Build the prompt for AI-based error resolution.
 */
function buildAIPrompt(error: SalesforceError, context: OperationContext): string {
  // Salesforce echoes org-writable text back in error messages — a validation
  // rule's custom text (FIELD_CUSTOM_VALIDATION_EXCEPTION) or the offending
  // field value (DUPLICATE_VALUE) — so the message is untrusted input and must
  // cross the <user-data> boundary rather than land at instruction level.
  const lines = [
    'You are a Salesforce error resolution expert. Analyze the following error and provide a resolution.',
    '',
    `Error code: ${error.errorCode}`,
    `Error message: ${wrapAsUserData('errorMessage', error.message)}`,
  ];

  if (error.fields) {
    lines.push(`Affected fields: ${error.fields.join(', ')}`);
  }
  if (error.objectName) {
    lines.push(`Object: ${error.objectName}`);
  }

  const contextLines: string[] = [];
  if (context.module) {
    contextLines.push(`  Module: ${context.module}`);
  }
  if (context.operation) {
    contextLines.push(`  Operation: ${context.operation}`);
  }
  if (context.objectName) {
    contextLines.push(`  Target object: ${context.objectName}`);
  }
  if (context.batchSize) {
    contextLines.push(`  Batch size: ${context.batchSize}`);
  }
  if (context.recordCount) {
    contextLines.push(`  Record count: ${context.recordCount}`);
  }
  if (contextLines.length > 0) {
    lines.push('');
    lines.push('Operation context:');
    lines.push(...contextLines);
  }

  lines.push('');
  lines.push('Respond with ONLY a JSON object in this exact format (no markdown, no extra text):');
  lines.push('{');
  lines.push('  "explanation": "Clear explanation of the error",');
  lines.push(
    '  "suggestions": [{ "title": "...", "description": "...", "probability": 0.0-1.0, "action": "optional_action" }],',
  );
  lines.push('  "autoFixable": true/false,');
  lines.push('  "autoFixAction": "optional_action_name",');
  lines.push('  "confidence": 0.0-1.0,');
  lines.push('  "relatedDocs": ["https://..."]');
  lines.push('}');

  return lines.join('\n');
}

/**
 * Parse the AI response into an ErrorResolution.
 * Handles responses wrapped in markdown code blocks.
 */
function parseAIResolution(response: string): ErrorResolution {
  const trimmed = response.trim();
  const jsonContent = extractJsonFromMarkdown(trimmed);
  const parsed: unknown = JSON.parse(jsonContent);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'AI response is not a valid JSON object. The AI model returned an unexpected format — try again or check the AI provider configuration.',
    );
  }

  const obj = parsed as Record<string, unknown>;

  const explanation =
    typeof obj['explanation'] === 'string' ? obj['explanation'] : 'Unable to determine root cause.';
  const autoFixable = typeof obj['autoFixable'] === 'boolean' ? obj['autoFixable'] : false;
  const autoFixAction = typeof obj['autoFixAction'] === 'string' ? obj['autoFixAction'] : undefined;
  const confidence = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0.5;

  const suggestions: ErrorSuggestion[] = [];
  if (Array.isArray(obj['suggestions'])) {
    for (const item of obj['suggestions'] as unknown[]) {
      if (typeof item === 'object' && item !== null) {
        const s = item as Record<string, unknown>;
        suggestions.push({
          title: typeof s['title'] === 'string' ? s['title'] : 'Unknown',
          description: typeof s['description'] === 'string' ? s['description'] : '',
          probability: typeof s['probability'] === 'number' ? s['probability'] : 0.5,
          action: typeof s['action'] === 'string' ? s['action'] : undefined,
        });
      }
    }
  }

  const relatedDocs: string[] = [];
  if (Array.isArray(obj['relatedDocs'])) {
    for (const doc of obj['relatedDocs'] as unknown[]) {
      if (typeof doc === 'string') {
        relatedDocs.push(doc);
      }
    }
  }

  return { explanation, suggestions, autoFixable, autoFixAction, confidence, relatedDocs };
}

/**
 * Extract JSON content from a string that may be wrapped in markdown code blocks.
 */
function extractJsonFromMarkdown(text: string): string {
  const codeBlockMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(text);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return text;
}
