/** Re-exported from the central AI types module (single source of truth). */
export type { AIProvider } from './types.js';
import type { AIProvider } from './types.js';
import { ErrorResolutionReplySchema, parseModelJson } from '@sandforge/shared';
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
 * ordinary 15-letter word is not taken for one. Only a letter or a digit ends
 * an Id, so one joined to a name by an underscore is still found. A run whose
 * name goes on to a `__` suffix is a segment of a custom API name such as
 * `Q_Region2024Budge__c`, and is left alone.
 */
const SALESFORCE_ID_PATTERN =
  /(?<![A-Za-z0-9])(?=[A-Za-z]*\d)[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?(?![A-Za-z0-9])(?!\w*__)/g;

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
  private readonly language?: string;
  private readonly answers = new Map<string, RememberedAnswer>();

  /**
   * @param provider - What asks the model.
   * @param language - The editor's display language, so the answer is written
   *   in the language the notification shows it in. Passed in by the
   *   composition root: nothing here reads the host.
   */
  constructor(provider: AIProvider, language?: string) {
    this.provider = provider;
    this.language = language;
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
      buildAIPrompt(error, context, this.language),
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
function buildAIPrompt(
  error: SalesforceError,
  context: OperationContext,
  language?: string,
): string {
  // Salesforce echoes org-writable text back in error messages — a validation
  // rule's custom text (FIELD_CUSTOM_VALIDATION_EXCEPTION) or the offending
  // field value (DUPLICATE_VALUE) — so the message is untrusted input and must
  // cross the <user-data> boundary rather than land at instruction level.
  //
  // The Ids go first: a message may name the org or the record it failed on,
  // the explanation never turns on which one it was, and the caller cannot
  // strip what it has not written — a message thrown deep in a run reaches
  // the emitter through a generic catch.
  const lines = [
    'You are a Salesforce error resolution expert. Analyze the following error and provide a resolution.',
    '',
    `Error code: ${error.errorCode}`,
    `Error message: ${wrapAsUserData('errorMessage', normalizeErrorMessage(error.message))}`,
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

  if (language) {
    lines.push('');
    lines.push(`Answer in ${language}: the suggestion is shown in that language.`);
  }

  return lines.join('\n');
}

/**
 * Read the model's reply as an ErrorResolution.
 *
 * Fenced or bare, well-shaped or not, the reply is read the one way every AI
 * module reads one, so a reply nobody can parse raises the message written for
 * a reader rather than the SyntaxError of a failed `JSON.parse`.
 */
function parseAIResolution(response: string): ErrorResolution {
  const reply = parseModelJson(ErrorResolutionReplySchema, response);
  return {
    explanation: reply.explanation,
    suggestions: reply.suggestions.map(
      (suggestion): ErrorSuggestion => ({
        title: suggestion.title,
        description: suggestion.description,
        probability: suggestion.probability,
        ...(suggestion.action !== undefined ? { action: suggestion.action } : {}),
      }),
    ),
    autoFixable: reply.autoFixable,
    ...(reply.autoFixAction !== undefined ? { autoFixAction: reply.autoFixAction } : {}),
    confidence: reply.confidence,
    relatedDocs: reply.relatedDocs,
  };
}
