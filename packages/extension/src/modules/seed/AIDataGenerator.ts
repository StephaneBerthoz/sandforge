import type { FieldRule } from '@sandforge/shared';

/** Function signature for calling an AI model */
export type CallAIFn = (prompt: string) => Promise<string>;

/** Maximum number of records to request per AI call to avoid token limits */
const MAX_RECORDS_PER_CALL = 50;

/**
 * Generates data records using an AI model.
 * Builds structured prompts from field rules and an optional persona,
 * then parses JSON array responses from the AI.
 */
export class AIDataGenerator {
  private readonly callAI: CallAIFn;

  constructor(callAI: CallAIFn) {
    this.callAI = callAI;
  }

  /**
   * Generate records by prompting the AI with field rules and persona context.
   * Splits large requests into batches to respect token limits.
   */
  async generate(
    fieldRules: FieldRule[],
    count: number,
    persona?: string
  ): Promise<Record<string, unknown>[]> {
    if (count <= 0 || fieldRules.length === 0) {
      return [];
    }

    const results: Record<string, unknown>[] = [];
    let remaining = count;

    while (remaining > 0) {
      const batchSize = Math.min(remaining, MAX_RECORDS_PER_CALL);
      const prompt = buildPrompt(fieldRules, batchSize, persona);
      const response = await this.callAI(prompt);
      const parsed = parseAIResponse(response);
      results.push(...parsed);
      remaining -= batchSize;
    }

    return results.slice(0, count);
  }
}

/**
 * Build a structured prompt describing the fields and desired output format.
 * Includes persona context when provided.
 */
export function buildPrompt(
  fieldRules: FieldRule[],
  count: number,
  persona?: string
): string {
  const fieldDescriptions = fieldRules.map((rule) => {
    const parts = [`- ${rule.fieldApiName} (${rule.ruleType})`];
    if (rule.config.aiPrompt) {
      parts.push(`: ${rule.config.aiPrompt}`);
    }
    if (rule.config.minValue !== undefined || rule.config.maxValue !== undefined) {
      parts.push(` [range: ${rule.config.minValue ?? ''}..${rule.config.maxValue ?? ''}]`);
    }
    if (rule.config.minLength !== undefined || rule.config.maxLength !== undefined) {
      parts.push(` [length: ${rule.config.minLength ?? ''}..${rule.config.maxLength ?? ''}]`);
    }
    return parts.join('');
  });

  const lines: string[] = [];

  if (persona) {
    lines.push(`Persona: ${persona}`);
    lines.push('');
  }

  lines.push(`Generate exactly ${count} JSON objects with these fields:`);
  lines.push(...fieldDescriptions);
  lines.push('');
  lines.push('Return ONLY a JSON array of objects. No markdown, no explanation.');

  return lines.join('\n');
}

/**
 * Parse the AI response string into an array of record objects.
 * Handles responses wrapped in markdown code blocks.
 */
export function parseAIResponse(response: string): Record<string, unknown>[] {
  const trimmed = response.trim();

  const jsonContent = extractJsonFromMarkdown(trimmed);
  const parsed: unknown = JSON.parse(jsonContent);

  if (Array.isArray(parsed)) {
    return parsed.filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
    );
  }

  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return [parsed as Record<string, unknown>];
  }

  return [];
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
