/** Re-exported from the central AI types module (single source of truth). */
export type { AIProvider } from './types.js';
import type { AIProvider, AIProviderOptions } from './types.js';
import type { z } from 'zod';
import { NL2SOQLReplySchema, parseModelJson } from '@sandforge/shared';
import { wrapAsUserData } from '../../adapters/ai/safety/index.js';
import { NL2SOQL_SYSTEM_PROMPT } from '../../adapters/ai/systemPrompts/index.js';

/**
 * Schema context describing Salesforce objects and their fields.
 *
 * An empty `fields` array means "not described", not "no fields": describing
 * every object in an org costs one REST round trip each, so the caller
 * describes a handful and leaves the rest as bare API names. The prompt reads
 * the distinction, and invents no field for an object nobody fetched.
 */
export interface SchemaContext {
  objects: Array<{
    apiName: string;
    label: string;
    fields: Array<{
      apiName: string;
      label: string;
      type: string;
      /** The name a lookup is followed by in a path (`Account` for `AccountId`). Not sent to the model. */
      relationshipName?: string;
    }>;
  }>;
}

/** Result of a natural language to SOQL conversion. */
export interface NL2SOQLResult {
  soql: string;
  explanation: string;
  confidence: number;
  alternatives?: string[];
}

/** A saved SOQL query with a user-defined label. */
export interface SOQLFavorite {
  soql: string;
  label: string;
}

/**
 * Converts natural language queries into SOQL statements using an AI
 * provider, with history tracking and favorites management. The draft is
 * checked by its caller: Forge's AI tab checks it against the source org
 * (`checkForgeRootQuery`).
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
   * @param options - The signal that stops the call to the model
   * @returns The generated SOQL result
   */
  async generateSOQL(
    naturalLanguage: string,
    schema: SchemaContext,
    options: AIProviderOptions = {},
  ): Promise<NL2SOQLResult> {
    const prompt = buildPrompt(naturalLanguage, schema);
    const raw = await this.provider(prompt, NL2SOQL_SYSTEM_PROMPT, options);
    const result = parseAIResponse(raw);

    this.history.push(result);
    return result;
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
  let reply: z.output<typeof NL2SOQLReplySchema>;
  try {
    reply = parseModelJson(NL2SOQLReplySchema, response);
  } catch {
    throw new Error(
      'AI response is not a valid JSON object. The AI model returned an unexpected format — try rephrasing your query or check the AI provider configuration.',
    );
  }

  const result: NL2SOQLResult = {
    soql: reply.soql,
    explanation: reply.explanation,
    confidence: reply.confidence,
  };

  if (reply.confidence < 0.8 && reply.alternatives) {
    result.alternatives = reply.alternatives;
  }

  return result;
}
