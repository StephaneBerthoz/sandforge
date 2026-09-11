/** Re-exported from the central AI types module (single source of truth). */
export type { AIProvider } from './types.js';
import type { AIProvider } from './types.js';
import { wrapAsUserData } from '../../adapters/ai/safety/index.js';
import { NL2SOQL_SYSTEM_PROMPT } from '../../adapters/ai/systemPrompts/index.js';

/**
 * Schema context describing Salesforce objects and their fields.
 *
 * An empty `fields` array means "not described", not "no fields": describing
 * every object in an org costs one REST round trip each, so the caller
 * describes a handful and leaves the rest as bare API names. Both the prompt
 * and {@link NL2SOQL.validateSOQL} read the distinction — neither invents
 * fields for an object nobody fetched.
 */
export interface SchemaContext {
  objects: Array<{
    apiName: string;
    label: string;
    fields: Array<{ apiName: string; label: string; type: string }>;
  }>;
}

/** Result of a natural language to SOQL conversion. */
export interface NL2SOQLResult {
  soql: string;
  explanation: string;
  confidence: number;
  alternatives?: string[];
}

/** Validation result for a SOQL query against a schema. */
export interface SOQLValidationResult {
  valid: boolean;
  errors: string[];
  /**
   * Whether the field list was actually checked against a describe.
   *
   * `false` when the queried object carries no described fields — the query
   * may still reference fields that do not exist. A caller must not report a
   * `valid: true, verified: false` result as a checked query.
   */
  verified: boolean;
}

/** A saved SOQL query with a user-defined label. */
export interface SOQLFavorite {
  soql: string;
  label: string;
}

/**
 * Converts natural language queries into SOQL statements
 * using an AI provider, with validation, history tracking,
 * and favorites management.
 */
export class NL2SOQL {
  private readonly provider: AIProvider;
  private readonly history: NL2SOQLResult[] = [];
  private readonly favorites: SOQLFavorite[] = [];

  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  /**
   * Generate a SOQL query from a natural language description.
   * Builds a prompt including the schema context and user query,
   * then parses the AI response. Returns alternatives when confidence is below 0.8.
   * @param naturalLanguage - The user's query in plain language
   * @param schema - The Salesforce schema context
   * @returns The generated SOQL result
   */
  async generateSOQL(naturalLanguage: string, schema: SchemaContext): Promise<NL2SOQLResult> {
    const prompt = buildPrompt(naturalLanguage, schema);
    const raw = await this.provider(prompt, NL2SOQL_SYSTEM_PROMPT);
    const result = parseAIResponse(raw);

    this.history.push(result);
    return result;
  }

  /**
   * Validate a SOQL query against the provided schema.
   *
   * Checks that the queried object exists in the catalog and that every plain
   * field in the SELECT list exists on it. Fields are only checked when the
   * object carries a describe: against an object left as a bare API name the
   * result comes back `verified: false` rather than flagging every field as
   * unknown — an empty `fields` array means nobody fetched them, so calling
   * them all invented would be a lie in the other direction.
   *
   * @param soql - The SOQL query to validate
   * @param schema - The Salesforce schema context
   * @returns Validation result with any errors found
   */
  validateSOQL(soql: string, schema: SchemaContext): SOQLValidationResult {
    const errors: string[] = [];

    if (!soql.trim()) {
      return { valid: false, errors: ['SOQL query is empty'], verified: true };
    }

    const objectMatch = /FROM\s+(\w+)/i.exec(soql);
    if (!objectMatch) {
      errors.push('No FROM clause found in SOQL query');
      return { valid: false, errors, verified: true };
    }

    const objectName = objectMatch[1];
    const objectDef = schema.objects.find(
      (o) => o.apiName.toLowerCase() === objectName.toLowerCase(),
    );

    if (!objectDef) {
      errors.push(`Object "${objectName}" not found in schema`);
      return { valid: false, errors, verified: true };
    }

    const selectMatch = /SELECT\s+(.+?)\s+FROM/i.exec(soql);
    if (!selectMatch) {
      errors.push('No SELECT clause found in SOQL query');
      return { valid: false, errors, verified: true };
    }

    const selectClause = selectMatch[1];
    if (selectClause.trim() === '*') {
      errors.push('Wildcard (*) is not supported in SOQL');
      return { valid: false, errors, verified: true };
    }

    if (objectDef.fields.length === 0) {
      return { valid: true, errors, verified: false };
    }

    const fieldNames = selectClause.split(',').map((f) => f.trim());
    const knownFieldNames = new Set(objectDef.fields.map((f) => f.apiName.toLowerCase()));

    for (const fieldName of fieldNames) {
      if (fieldName === '') continue;
      // Skip aggregate functions and relationship fields
      if (/\(/.test(fieldName) || fieldName.includes('.')) continue;

      if (!knownFieldNames.has(fieldName.toLowerCase())) {
        errors.push(`Field "${fieldName}" not found on object "${objectName}"`);
      }
    }

    return { valid: errors.length === 0, errors, verified: true };
  }

  /**
   * Get the history of all generated SOQL results.
   * @returns Array of past results
   */
  getHistory(): NL2SOQLResult[] {
    return [...this.history];
  }

  /**
   * Clear the history of generated SOQL results.
   */
  clearHistory(): void {
    this.history.length = 0;
  }

  /**
   * Add a SOQL query to favorites with a label.
   * @param soql - The SOQL query
   * @param label - A user-defined label
   */
  addToFavorites(soql: string, label: string): void {
    this.favorites.push({ soql, label });
  }

  /**
   * Get all saved favorite SOQL queries.
   * @returns Array of favorites
   */
  getFavorites(): SOQLFavorite[] {
    return [...this.favorites];
  }
}

/**
 * Build the AI prompt from the user query and schema context.
 *
 * Described objects get their full field list; the rest are listed as names
 * only, on one line. Spelling out `Name (Label):` plus an empty field list for
 * every object in the org cost ~21 500 tokens on a measured Developer Edition
 * (1453 SObjects) and carried no field name at all — the model had nothing to
 * write a SELECT from but its own guesses.
 */
function buildPrompt(naturalLanguage: string, schema: SchemaContext): string {
  const described = schema.objects.filter((o) => o.fields.length > 0);
  const nameOnly = schema.objects.filter((o) => o.fields.length === 0);

  const schemaLines: string[] = [];
  if (described.length > 0) {
    schemaLines.push('Objects described in full — use ONLY these field API names:');
    for (const obj of described) {
      schemaLines.push(`  ${obj.apiName} (${obj.label}):`);
      for (const f of obj.fields) {
        schemaLines.push(`    - ${f.apiName} (${f.type}): ${f.label}`);
      }
    }
  }
  if (nameOnly.length > 0) {
    schemaLines.push(
      'Objects present in the org whose fields were NOT loaded. Query one only if none of the objects above fits, and then restrict the SELECT list to Id and Name:',
    );
    schemaLines.push(`  ${nameOnly.map((o) => `${o.apiName} (${o.label})`).join(', ')}`);
  }

  const lines = [
    'You are a Salesforce SOQL expert. Convert the following natural language query into a valid SOQL query.',
    '',
    'Available schema:',
    ...schemaLines,
    '',
    'Never invent a field API name. If the request needs a field that is not listed above, leave it out and say so in the explanation.',
    '',
    // The query is free text the user pastes — and may itself have been copied
    // out of a record — so it crosses the <user-data> boundary instead of
    // sitting at instruction level next to the schema description.
    `User query: ${wrapAsUserData('userQuery', naturalLanguage)}`,
    '',
    'Respond with ONLY a JSON object in this exact format (no markdown, no explanation outside the JSON):',
    '{',
    '  "soql": "SELECT ... FROM ...",',
    '  "explanation": "Brief explanation of the query",',
    '  "confidence": 0.0 to 1.0,',
    '  "alternatives": ["optional alternative SOQL queries if confidence < 0.8"]',
    '}',
  ];

  return lines.join('\n');
}

/**
 * Parse the AI response string into an NL2SOQLResult.
 * Handles responses wrapped in markdown code blocks.
 */
function parseAIResponse(response: string): NL2SOQLResult {
  const trimmed = response.trim();
  const jsonContent = extractJsonFromMarkdown(trimmed);
  const parsed: unknown = JSON.parse(jsonContent);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'AI response is not a valid JSON object. The AI model returned an unexpected format — try rephrasing your query or check the AI provider configuration.',
    );
  }

  const obj = parsed as Record<string, unknown>;
  const soql = typeof obj['soql'] === 'string' ? obj['soql'] : '';
  const explanation = typeof obj['explanation'] === 'string' ? obj['explanation'] : '';
  const confidence = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0;

  const result: NL2SOQLResult = { soql, explanation, confidence };

  if (confidence < 0.8 && Array.isArray(obj['alternatives'])) {
    result.alternatives = (obj['alternatives'] as unknown[]).filter(
      (a): a is string => typeof a === 'string',
    );
  }

  return result;
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
