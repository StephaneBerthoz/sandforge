/** Function signature for calling an AI model. */
export type AIProvider = (prompt: string) => Promise<string>;

/** Represents a Salesforce API error. */
export interface SalesforceError {
  errorCode: string;
  message: string;
  fields?: string[];
  objectName?: string;
}

/** Contextual information about the operation that triggered the error. */
export interface OperationContext {
  module: string;
  operation: string;
  orgId: string;
  objectName?: string;
  batchSize?: number;
  recordCount?: number;
}

/** A single suggestion for resolving an error. */
export interface ErrorSuggestion {
  title: string;
  description: string;
  probability: number;
  action?: string;
}

/** Full resolution for a Salesforce error. */
export interface ErrorResolution {
  explanation: string;
  suggestions: ErrorSuggestion[];
  autoFixable: boolean;
  autoFixAction?: string;
  confidence: number;
  relatedDocs: string[];
}

/** Entry in the resolution history log. */
export interface ResolutionHistoryEntry {
  error: SalesforceError;
  resolution: ErrorResolution;
  timestamp: string;
}

/** An entry in the learned resolutions store. */
interface LearnedResolution {
  resolution: ErrorResolution;
  successCount: number;
}

/** A single entry in the built-in knowledge base. */
interface KnowledgeBaseEntry {
  explanation: string;
  suggestions: ErrorSuggestion[];
  autoFixable: boolean;
  autoFixAction?: string;
  relatedDocs: string[];
}

/** Built-in knowledge base of common Salesforce error codes with known resolutions. */
const KNOWLEDGE_BASE: Record<string, KnowledgeBaseEntry> = {
  FIELD_CUSTOM_VALIDATION_EXCEPTION: {
    explanation:
      'A custom validation rule on the object is preventing the record from being saved. The rule evaluates to true, blocking the DML operation.',
    suggestions: [
      {
        title: 'Review validation rules',
        description:
          'Check the validation rules on the target object and ensure the data meets all criteria.',
        probability: 0.9,
        action: 'review_validation_rules',
      },
      {
        title: 'Temporarily deactivate rule',
        description:
          'If loading test data, consider temporarily deactivating the validation rule in the sandbox.',
        probability: 0.6,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_concepts_core_data_objects.htm',
    ],
  },
  INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: {
    explanation:
      'The running user does not have the required access to a related record referenced in the operation. This often occurs with lookup or master-detail relationships.',
    suggestions: [
      {
        title: 'Check record sharing',
        description: 'Verify the user has at least read access to the referenced parent record.',
        probability: 0.8,
        action: 'check_sharing',
      },
      {
        title: 'Verify profile permissions',
        description: 'Ensure the user profile has CRUD permissions on the related object.',
        probability: 0.7,
      },
      {
        title: 'Check owner assignment',
        description:
          'If changing record ownership, ensure the new owner has the correct role/profile.',
        probability: 0.5,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_concepts_core_data_objects.htm',
    ],
  },
  DUPLICATE_VALUE: {
    explanation:
      'A record with the same value already exists for a field marked as unique, or a duplicate rule is blocking the insert.',
    suggestions: [
      {
        title: 'Check unique fields',
        description:
          'Identify which field has a duplicate value and either update the existing record or use a unique value.',
        probability: 0.9,
        action: 'check_duplicates',
      },
      {
        title: 'Review duplicate rules',
        description:
          'Check if a duplicate rule is active that might be matching on field combinations.',
        probability: 0.6,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_methods_system_database_duplicateresult.htm',
    ],
  },
  REQUIRED_FIELD_MISSING: {
    explanation:
      'A required field is missing a value. This can be triggered by page layout requirements, validation rules, or field-level settings.',
    suggestions: [
      {
        title: 'Provide missing field values',
        description: 'Check which fields are required on the object and ensure all are populated.',
        probability: 0.95,
        action: 'add_missing_fields',
      },
      {
        title: 'Check record type layout',
        description: 'Different record types may have different required fields via page layouts.',
        probability: 0.5,
      },
    ],
    autoFixable: true,
    autoFixAction: 'add_missing_fields',
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_concepts_core_data_objects.htm',
    ],
  },
  STRING_TOO_LONG: {
    explanation:
      'A text field value exceeds its maximum allowed length. Each Salesforce text field has a defined character limit.',
    suggestions: [
      {
        title: 'Truncate field values',
        description: 'Shorten the text value to fit within the field maximum length.',
        probability: 0.95,
        action: 'truncate_fields',
      },
      {
        title: 'Use a Long Text Area',
        description:
          'If longer content is required, consider using a Long Text Area field instead.',
        probability: 0.3,
      },
    ],
    autoFixable: true,
    autoFixAction: 'truncate_fields',
    relatedDocs: ['https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm'],
  },
  INVALID_CROSS_REFERENCE_KEY: {
    explanation:
      'A lookup or relationship field references a record ID that does not exist or belongs to a different object type.',
    suggestions: [
      {
        title: 'Verify reference IDs',
        description:
          'Ensure all lookup field values point to existing records of the correct object type.',
        probability: 0.9,
        action: 'verify_references',
      },
      {
        title: 'Check insertion order',
        description:
          'When inserting related records, ensure parent records are created before children.',
        probability: 0.7,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_concepts_core_data_objects.htm',
    ],
  },
  ENTITY_IS_DELETED: {
    explanation:
      'The operation references a record that has been soft-deleted (moved to the Recycle Bin).',
    suggestions: [
      {
        title: 'Undelete the record',
        description: 'Restore the referenced record from the Recycle Bin before retrying.',
        probability: 0.8,
        action: 'undelete_record',
      },
      {
        title: 'Update the reference',
        description: 'Point the lookup field to an active, non-deleted record.',
        probability: 0.7,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_undelete.htm',
    ],
  },
  DELETE_FAILED: {
    explanation:
      'The record cannot be deleted because it is referenced by other records or protected by a before-delete trigger.',
    suggestions: [
      {
        title: 'Remove child references first',
        description:
          'Delete or reparent child records that reference this record before attempting deletion.',
        probability: 0.8,
        action: 'remove_child_references',
      },
      {
        title: 'Check triggers',
        description: 'Review before-delete triggers that might be preventing the operation.',
        probability: 0.5,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_delete.htm',
    ],
  },
  UNABLE_TO_LOCK_ROW: {
    explanation:
      'Another transaction is currently locking the record(s). This commonly happens with concurrent bulk operations on the same records.',
    suggestions: [
      {
        title: 'Retry the operation',
        description: 'Wait a moment and retry. Row locks are usually transient.',
        probability: 0.9,
        action: 'retry',
      },
      {
        title: 'Reduce batch size',
        description: 'Smaller batch sizes reduce the chance of lock contention.',
        probability: 0.7,
        action: 'reduce_batch_size',
      },
      {
        title: 'Reorder records',
        description:
          'Sort records by ID before processing to reduce cross-transaction lock conflicts.',
        probability: 0.5,
      },
    ],
    autoFixable: true,
    autoFixAction: 'retry',
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_transaction.htm',
    ],
  },
  REQUEST_LIMIT_EXCEEDED: {
    explanation:
      'The Salesforce API request limit for the org has been exceeded. Each org has a 24-hour rolling limit based on edition and licenses.',
    suggestions: [
      {
        title: 'Wait and retry',
        description: 'API limits reset on a rolling 24-hour basis. Wait before retrying.',
        probability: 0.8,
        action: 'retry',
      },
      {
        title: 'Reduce API calls',
        description:
          'Use Bulk API or Composite API to consolidate multiple operations into fewer requests.',
        probability: 0.7,
        action: 'use_bulk_api',
      },
      {
        title: 'Check API usage',
        description: 'Review Sforce-Limit-Info headers to monitor current usage levels.',
        probability: 0.6,
      },
    ],
    autoFixable: true,
    autoFixAction: 'retry',
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_api.htm',
    ],
  },
  CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: {
    explanation:
      'A trigger, workflow rule, or process builder on the object is causing a DML failure, often due to an unhandled exception in Apex code.',
    suggestions: [
      {
        title: 'Check Apex triggers',
        description:
          'Review triggers on the object for unhandled exceptions or recursive behavior.',
        probability: 0.8,
      },
      {
        title: 'Review process builders',
        description: 'Check active process builders and flows that fire on this object.',
        probability: 0.6,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers.htm',
    ],
  },
  FIELD_INTEGRITY_EXCEPTION: {
    explanation:
      'A field value does not meet integrity constraints. This happens when a value is outside the allowed range or violates a field type constraint.',
    suggestions: [
      {
        title: 'Validate field values',
        description:
          'Ensure all field values match the expected type and are within allowed ranges.',
        probability: 0.9,
        action: 'validate_fields',
      },
    ],
    autoFixable: false,
    relatedDocs: ['https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm'],
  },
  INVALID_FIELD_FOR_INSERT_UPDATE: {
    explanation:
      'An attempt was made to set a value on a field that is read-only, calculated, or not creatable/updatable.',
    suggestions: [
      {
        title: 'Remove read-only fields',
        description:
          'Exclude formula fields, auto-number fields, and other non-writable fields from the payload.',
        probability: 0.95,
        action: 'remove_readonly_fields',
      },
    ],
    autoFixable: true,
    autoFixAction: 'remove_readonly_fields',
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_create.htm',
    ],
  },
  MALFORMED_ID: {
    explanation:
      'A Salesforce record ID in the request is malformed. IDs must be 15 or 18 alphanumeric characters.',
    suggestions: [
      {
        title: 'Fix ID format',
        description: 'Ensure all record IDs are valid 15 or 18 character Salesforce IDs.',
        probability: 0.95,
        action: 'fix_ids',
      },
    ],
    autoFixable: false,
    relatedDocs: ['https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm'],
  },
  STORAGE_LIMIT_EXCEEDED: {
    explanation:
      'The org has exceeded its data storage or file storage limit. No new records can be inserted until storage is freed.',
    suggestions: [
      {
        title: 'Free up storage',
        description:
          'Delete old records, empty the Recycle Bin, or archive data to reduce storage usage.',
        probability: 0.8,
      },
      {
        title: 'Reduce batch size',
        description: 'Insert fewer records at a time to stay within limits.',
        probability: 0.5,
        action: 'reduce_batch_size',
      },
    ],
    autoFixable: false,
    relatedDocs: ['https://help.salesforce.com/s/articleView?id=sf.admin_monitorresources.htm'],
  },
  INVALID_TYPE: {
    explanation:
      'The specified sObject type does not exist or the user does not have access to it.',
    suggestions: [
      {
        title: 'Verify object API name',
        description: 'Check the object API name for typos and ensure it exists in the target org.',
        probability: 0.9,
      },
      {
        title: 'Check user permissions',
        description: 'Verify the connected user has object-level access.',
        probability: 0.6,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_describeSObjects_describeSObjectResult.htm',
    ],
  },
  INVALID_SESSION_ID: {
    explanation:
      'The session or OAuth token has expired or is invalid. Re-authentication is required.',
    suggestions: [
      {
        title: 'Re-authenticate',
        description: 'Refresh the OAuth token or re-authenticate the Salesforce connection.',
        probability: 0.95,
        action: 'reauthenticate',
      },
    ],
    autoFixable: true,
    autoFixAction: 'reauthenticate',
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_understanding_authentication.htm',
    ],
  },
  ALL_OR_NONE_OPERATION_ROLLED_BACK: {
    explanation:
      'A batch operation with allOrNone=true failed on one or more records, causing the entire batch to roll back.',
    suggestions: [
      {
        title: 'Disable allOrNone',
        description: 'Set allOrNone to false to allow partial successes.',
        probability: 0.7,
        action: 'disable_all_or_none',
      },
      {
        title: 'Fix failing records',
        description: 'Identify and fix the records that are causing the batch to fail.',
        probability: 0.8,
      },
    ],
    autoFixable: true,
    autoFixAction: 'disable_all_or_none',
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_create.htm',
    ],
  },
  NUMBER_OUTSIDE_VALID_RANGE: {
    explanation:
      'A numeric field value is outside the acceptable range defined by the field precision and scale.',
    suggestions: [
      {
        title: 'Adjust numeric values',
        description:
          'Ensure numeric values fit within the field precision (total digits) and scale (decimal places).',
        probability: 0.95,
        action: 'fix_numeric_values',
      },
    ],
    autoFixable: true,
    autoFixAction: 'fix_numeric_values',
    relatedDocs: ['https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm'],
  },
  INVALID_EMAIL_ADDRESS: {
    explanation:
      'An email field contains a value that does not match the expected email address format.',
    suggestions: [
      {
        title: 'Fix email format',
        description:
          'Ensure all email fields contain valid email addresses in the format user@domain.com.',
        probability: 0.95,
        action: 'fix_email_format',
      },
    ],
    autoFixable: true,
    autoFixAction: 'fix_email_format',
    relatedDocs: ['https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm'],
  },
  LIMIT_EXCEEDED: {
    explanation:
      'A governor limit has been exceeded (e.g., too many SOQL queries, DML statements, or future calls in a single transaction).',
    suggestions: [
      {
        title: 'Reduce batch size',
        description: 'Process fewer records per batch to stay within governor limits.',
        probability: 0.8,
        action: 'reduce_batch_size',
      },
      {
        title: 'Use Bulk API',
        description:
          'Switch to Bulk API 2.0 for large data volumes to avoid per-transaction limits.',
        probability: 0.7,
        action: 'use_bulk_api',
      },
    ],
    autoFixable: true,
    autoFixAction: 'reduce_batch_size',
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm',
    ],
  },
  INVALID_OPERATION: {
    explanation:
      'The requested operation is not allowed on the given object or in the current context.',
    suggestions: [
      {
        title: 'Check object capabilities',
        description: 'Verify the object supports the requested operation (create, update, delete).',
        probability: 0.8,
      },
      {
        title: 'Check user permissions',
        description: 'Ensure the user has the required CRUD permissions for this operation.',
        probability: 0.6,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_concepts_core_data_objects.htm',
    ],
  },
  TRANSFER_REQUIRES_READ: {
    explanation:
      'A record ownership transfer failed because the new owner does not have read access to the record or related objects.',
    suggestions: [
      {
        title: 'Grant read access',
        description: 'Ensure the new owner has read access to the object and its related records.',
        probability: 0.9,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_update.htm',
    ],
  },
  FIELD_FILTER_VALIDATION_EXCEPTION: {
    explanation:
      'A lookup field value does not meet the lookup filter criteria defined on the field.',
    suggestions: [
      {
        title: 'Check lookup filters',
        description:
          'Review the lookup filter on the field and ensure the referenced record meets all criteria.',
        probability: 0.9,
      },
    ],
    autoFixable: false,
    relatedDocs: ['https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/field_types.htm'],
  },
  CIRCULAR_DEPENDENCY: {
    explanation:
      'The operation would create a circular reference between records, which Salesforce does not allow in hierarchy relationships.',
    suggestions: [
      {
        title: 'Break the circular reference',
        description: 'Restructure the parent-child relationships to avoid loops in the hierarchy.',
        probability: 0.9,
      },
    ],
    autoFixable: false,
    relatedDocs: [
      'https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_calls_create.htm',
    ],
  },
};

/**
 * Resolves Salesforce errors by combining a built-in knowledge base
 * of common error codes with AI-powered analysis for unknown errors.
 * Tracks resolution history and learns from successful fixes.
 */
export class ErrorResolver {
  private readonly provider: AIProvider;
  private readonly resolutionHistory: ResolutionHistoryEntry[] = [];
  private readonly learnedResolutions: Map<string, LearnedResolution[]> = new Map();

  constructor(provider: AIProvider) {
    this.provider = provider;
  }

  /**
   * Resolve a Salesforce error by looking up the knowledge base first,
   * then falling back to AI analysis for unknown errors.
   * @param error - The Salesforce error to resolve
   * @param context - The operation context when the error occurred
   * @returns A resolution with explanation, suggestions, and auto-fix info
   */
  async resolveError(error: SalesforceError, context: OperationContext): Promise<ErrorResolution> {
    // Check learned resolutions first (prioritize what worked before)
    const learned = this.getLearnedResolution(error.errorCode);
    if (learned) {
      this.recordHistory(error, learned);
      return learned;
    }

    // Check built-in knowledge base
    const knownEntry = KNOWLEDGE_BASE[error.errorCode];
    if (knownEntry) {
      const resolution = buildResolutionFromKnowledge(knownEntry, error, context);
      this.recordHistory(error, resolution);
      return resolution;
    }

    // Fall back to AI for unknown errors
    const resolution = await this.resolveWithAI(error, context);
    this.recordHistory(error, resolution);
    return resolution;
  }

  /**
   * Get the full resolution history.
   * @returns Array of resolution history entries
   */
  getResolutionHistory(): ResolutionHistoryEntry[] {
    return [...this.resolutionHistory];
  }

  /**
   * Record a successful resolution so it can be prioritized in the future.
   * @param errorCode - The error code that was resolved
   * @param resolution - The resolution that worked
   */
  learnFromSuccess(errorCode: string, resolution: ErrorResolution): void {
    const existing = this.learnedResolutions.get(errorCode) ?? [];
    const match = existing.find((e) => e.resolution.explanation === resolution.explanation);

    if (match) {
      match.successCount += 1;
    } else {
      existing.push({ resolution, successCount: 1 });
    }

    this.learnedResolutions.set(errorCode, existing);
  }

  /**
   * Get the number of entries in the built-in knowledge base.
   * @returns Count of known error codes
   */
  getKnowledgeBaseSize(): number {
    return Object.keys(KNOWLEDGE_BASE).length;
  }

  private getLearnedResolution(errorCode: string): ErrorResolution | undefined {
    const entries = this.learnedResolutions.get(errorCode);
    if (!entries || entries.length === 0) return undefined;

    // Return the resolution with the highest success count
    const sorted = [...entries].sort((a, b) => b.successCount - a.successCount);
    return sorted[0].resolution;
  }

  private async resolveWithAI(
    error: SalesforceError,
    context: OperationContext,
  ): Promise<ErrorResolution> {
    const prompt = buildAIPrompt(error, context);
    const raw = await this.provider(prompt);
    return parseAIResolution(raw);
  }

  private recordHistory(error: SalesforceError, resolution: ErrorResolution): void {
    this.resolutionHistory.push({
      error,
      resolution,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Build an ErrorResolution from a knowledge base entry, adding context-specific details.
 */
function buildResolutionFromKnowledge(
  entry: KnowledgeBaseEntry,
  error: SalesforceError,
  context: OperationContext,
): ErrorResolution {
  const suggestions = [...entry.suggestions];

  // Add context-specific suggestions for batch operations
  if (context.batchSize && context.batchSize > 200) {
    suggestions.push({
      title: 'Reduce batch size',
      description: `Current batch size is ${context.batchSize}. Consider reducing to 200 or less.`,
      probability: 0.6,
      action: 'reduce_batch_size',
    });
  }

  return {
    explanation: enrichExplanation(entry.explanation, error),
    suggestions,
    autoFixable: entry.autoFixable,
    autoFixAction: entry.autoFixAction,
    confidence: 0.95,
    relatedDocs: entry.relatedDocs,
  };
}

/**
 * Enrich the explanation with specific details from the error.
 */
function enrichExplanation(baseExplanation: string, error: SalesforceError): string {
  const parts = [baseExplanation];

  if (error.fields && error.fields.length > 0) {
    parts.push(`Affected fields: ${error.fields.join(', ')}.`);
  }
  if (error.objectName) {
    parts.push(`Object: ${error.objectName}.`);
  }
  if (error.message && error.message !== error.errorCode) {
    parts.push(`Details: ${error.message}`);
  }

  return parts.join(' ');
}

/**
 * Build the prompt for AI-based error resolution.
 */
function buildAIPrompt(error: SalesforceError, context: OperationContext): string {
  const lines = [
    'You are a Salesforce error resolution expert. Analyze the following error and provide a resolution.',
    '',
    `Error code: ${error.errorCode}`,
    `Error message: ${error.message}`,
  ];

  if (error.fields) {
    lines.push(`Affected fields: ${error.fields.join(', ')}`);
  }
  if (error.objectName) {
    lines.push(`Object: ${error.objectName}`);
  }

  lines.push('');
  lines.push('Operation context:');
  lines.push(`  Module: ${context.module}`);
  lines.push(`  Operation: ${context.operation}`);

  if (context.objectName) {
    lines.push(`  Target object: ${context.objectName}`);
  }
  if (context.batchSize) {
    lines.push(`  Batch size: ${context.batchSize}`);
  }
  if (context.recordCount) {
    lines.push(`  Record count: ${context.recordCount}`);
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
