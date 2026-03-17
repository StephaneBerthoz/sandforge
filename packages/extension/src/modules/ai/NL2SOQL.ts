/** Function signature for calling an AI model. */
export type AIProvider = (prompt: string) => Promise<string>;

/** Schema context describing Salesforce objects and their fields. */
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
    const raw = await this.provider(prompt);
    const result = parseAIResponse(raw);

    this.history.push(result);
    return result;
  }

  /**
   * Validate a SOQL query against the provided schema.
   * Checks that referenced objects and fields exist.
   * @param soql - The SOQL query to validate
   * @param schema - The Salesforce schema context
   * @returns Validation result with any errors found
   */
  validateSOQL(soql: string, schema: SchemaContext): SOQLValidationResult {
    const errors: string[] = [];

    if (!soql.trim()) {
      return { valid: false, errors: ['SOQL query is empty'] };
    }

    const objectMatch = /FROM\s+(\w+)/i.exec(soql);
    if (!objectMatch) {
      errors.push('No FROM clause found in SOQL query');
      return { valid: false, errors };
    }

    const objectName = objectMatch[1];
    const objectDef = schema.objects.find(
      (o) => o.apiName.toLowerCase() === objectName.toLowerCase(),
    );

    if (!objectDef) {
      errors.push(`Object "${objectName}" not found in schema`);
      return { valid: false, errors };
    }

    const selectMatch = /SELECT\s+(.+?)\s+FROM/i.exec(soql);
    if (!selectMatch) {
      errors.push('No SELECT clause found in SOQL query');
      return { valid: false, errors };
    }

    const selectClause = selectMatch[1];
    if (selectClause.trim() === '*') {
      errors.push('Wildcard (*) is not supported in SOQL');
      return { valid: false, errors };
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

    return { valid: errors.length === 0, errors };
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
 */
function buildPrompt(naturalLanguage: string, schema: SchemaContext): string {
  const objectDescriptions = schema.objects.map((obj) => {
    const fieldList = obj.fields
      .map((f) => `    - ${f.apiName} (${f.type}): ${f.label}`)
      .join('\n');
    return `  ${obj.apiName} (${obj.label}):\n${fieldList}`;
  });

  const lines = [
    'You are a Salesforce SOQL expert. Convert the following natural language query into a valid SOQL query.',
    '',
    'Available schema:',
    ...objectDescriptions,
    '',
    `User query: ${naturalLanguage}`,
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
    throw new Error('AI response is not a valid JSON object. The AI model returned an unexpected format — try rephrasing your query or check the AI provider configuration.');
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
