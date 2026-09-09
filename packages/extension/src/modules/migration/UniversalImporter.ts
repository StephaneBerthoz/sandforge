import { z } from 'zod';
import type { SyncConfig, SyncObjectConfig, FieldMapping, MappingType } from '@sandforge/shared';

// ── Import Options Zod Schema ─────────────────────────────

/** Schema for universal import options */
export const importOptionsSchema = z.object({
  objectApiName: z.string().min(1).optional(),
  operation: z.enum(['insert', 'update', 'upsert', 'delete']).optional().default('upsert'),
  externalIdField: z.string().optional(),
  batchSize: z.number().int().positive().optional().default(200),
  delimiter: z.string().optional().default(','),
  fieldMappingOverrides: z.record(z.string(), z.string()).optional(),
  excludeColumns: z.array(z.string()).optional().default([]),
  sourceOrgId: z.string().optional(),
  targetOrgId: z.string().optional(),
});

/** Import options type */
export type ImportOptions = z.infer<typeof importOptionsSchema>;

// ── File reader interface ─────────────────────────────────

/** Interface for reading files — allows easy mocking in tests */
export interface FileReader {
  readFile(filePath: string): Promise<string>;
}

// ── Detected format ───────────────────────────────────────

/** Detected file format */
export type DetectedFormat = 'csv' | 'json';

/** Column detection result */
export interface DetectedColumn {
  name: string;
  sampleValues: unknown[];
  inferredSfField: string;
  inferredType: 'string' | 'number' | 'boolean' | 'date' | 'id';
}

// ── UniversalImporter ─────────────────────────────────────

/**
 * Imports any CSV or JSON file and converts it to a SandForge SyncConfig.
 *
 * Features:
 * - Auto-detects CSV vs JSON format from file content
 * - Extracts column names from CSV headers or JSON keys
 * - Performs intelligent mapping of column names to Salesforce field names
 * - Supports custom field mapping overrides
 * - Supports column exclusion
 */
export class UniversalImporter {
  private readonly fileReader: FileReader;

  constructor(fileReader: FileReader) {
    this.fileReader = fileReader;
  }

  /**
   * Import a CSV or JSON file and convert to SyncConfig.
   * @param filePath - Path to the CSV or JSON file
   * @param options - Optional import configuration
   * @returns Parsed and converted SyncConfig
   */
  async import(filePath: string, options?: Partial<ImportOptions>): Promise<SyncConfig> {
    const content = await this.fileReader.readFile(filePath);
    return this.importContent(content, filePath, options);
  }

  /**
   * Import from already-read file content — same conversion as {@link import}
   * without the disk read, for callers that already hold the content (e.g. the
   * MigrationHandler, which also needs it for format detection).
   * @param content - Raw file content
   * @param filePath - File path (used for format hint and object-name inference)
   * @param options - Optional import configuration
   * @returns Parsed and converted SyncConfig
   */
  importContent(content: string, filePath: string, options?: Partial<ImportOptions>): SyncConfig {
    const validatedOptions = importOptionsSchema.parse(options ?? {});
    const format = this.detectFormat(content, filePath);
    const records = this.parseContent(content, format, validatedOptions.delimiter);

    if (records.length === 0) {
      throw new Error('No records found in imported file');
    }

    const objectApiName = validatedOptions.objectApiName ?? inferObjectName(filePath);
    const columns = this.detectColumns(records);
    const filteredColumns = columns.filter(
      (col) => !validatedOptions.excludeColumns.includes(col.name),
    );
    const fieldMappings = this.buildFieldMappings(
      filteredColumns,
      validatedOptions.fieldMappingOverrides,
    );

    return this.buildSyncConfig(objectApiName, fieldMappings, validatedOptions);
  }

  /**
   * Detect the format of the file content.
   * @param content - Raw file content
   * @param filePath - File path for extension-based hint
   * @returns Detected format
   */
  detectFormat(content: string, filePath: string): DetectedFormat {
    const extension = filePath.split('.').pop()?.toLowerCase();
    if (extension === 'json') {
      return 'json';
    }
    if (extension === 'csv') {
      return 'csv';
    }

    const trimmed = content.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      return 'json';
    }

    return 'csv';
  }

  /**
   * Detect columns and their types from parsed records.
   * @param records - Array of parsed records
   * @returns Array of detected column information
   */
  detectColumns(records: Record<string, unknown>[]): DetectedColumn[] {
    if (records.length === 0) {
      return [];
    }

    const allKeys = new Set<string>();
    for (const record of records) {
      for (const key of Object.keys(record)) {
        allKeys.add(key);
      }
    }

    const columns: DetectedColumn[] = [];
    for (const key of allKeys) {
      const sampleValues: unknown[] = [];
      for (let i = 0; i < Math.min(records.length, 5); i++) {
        sampleValues.push(records[i][key]);
      }

      columns.push({
        name: key,
        sampleValues,
        inferredSfField: mapColumnToSfField(key),
        inferredType: inferValueType(sampleValues),
      });
    }

    return columns;
  }

  /**
   * Parse file content based on detected format.
   * @param content - Raw file content
   * @param format - Detected format
   * @param delimiter - CSV delimiter character
   * @returns Array of parsed records
   */
  private parseContent(
    content: string,
    format: DetectedFormat,
    delimiter: string,
  ): Record<string, unknown>[] {
    if (format === 'json') {
      return this.parseJson(content);
    }
    return this.parseCsv(content, delimiter);
  }

  /**
   * Parse JSON content into records.
   * @param content - JSON string
   * @returns Array of records
   */
  private parseJson(content: string): Record<string, unknown>[] {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const parsed: unknown = JSON.parse(trimmed);

    if (Array.isArray(parsed)) {
      const records: Record<string, unknown>[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!isRecord(item)) {
          throw new Error(`JSON array element at index ${i} is not an object`);
        }
        records.push(item);
      }
      return records;
    }

    if (isRecord(parsed)) {
      return [parsed];
    }

    throw new Error('JSON content must be an array of objects or a single object');
  }

  /**
   * Parse CSV content into records.
   * @param content - CSV string
   * @param delimiter - Field delimiter character
   * @returns Array of records
   */
  private parseCsv(content: string, delimiter: string): Record<string, unknown>[] {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const rows = parseCsvRows(trimmed, delimiter);
    if (rows.length < 2) {
      return [];
    }

    const headers = rows[0];
    const records: Record<string, unknown>[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length === 0 || (row.length === 1 && row[0] === '')) {
        continue;
      }

      const record: Record<string, unknown> = {};
      for (let j = 0; j < headers.length; j++) {
        const value = j < row.length ? row[j] : '';
        record[headers[j]] = parseCsvValue(value);
      }
      records.push(record);
    }

    return records;
  }

  /**
   * Build field mappings from detected columns.
   * @param columns - Detected column information
   * @param overrides - Optional field mapping overrides
   * @returns Array of FieldMapping
   */
  private buildFieldMappings(
    columns: DetectedColumn[],
    overrides?: Record<string, string>,
  ): FieldMapping[] {
    return columns.map((col) => {
      const targetField = overrides?.[col.name] ?? col.inferredSfField;
      const type: MappingType = col.name === targetField ? 'direct' : 'rename';
      return {
        sourceField: col.name,
        targetField,
        type,
      };
    });
  }

  /**
   * Build the final SyncConfig from parsed data.
   * @param objectApiName - Target Salesforce object API name
   * @param fieldMappings - Computed field mappings
   * @param options - Validated import options
   * @returns Complete SyncConfig
   */
  private buildSyncConfig(
    objectApiName: string,
    fieldMappings: FieldMapping[],
    options: ImportOptions,
  ): SyncConfig {
    const now = new Date().toISOString();

    const objectConfig: SyncObjectConfig = {
      objectApiName,
      externalIdField: options.externalIdField,
      operation: options.operation,
      fieldMappings,
      transformRules: [],
      excludedFields: options.excludeColumns,
      addOnFields: [],
      batchSize: options.batchSize,
      insertOrder: 1,
    };

    return {
      id: generateId(),
      name: `Import ${objectApiName}`,
      description: `Universal import for ${objectApiName}`,
      sourceOrgId: options.sourceOrgId ?? generateId(),
      targetOrgId: options.targetOrgId ?? generateId(),
      direction: 'source_to_target',
      mode: 'full',
      objects: [objectConfig],
      conflictStrategy: 'source_wins',
      enableRollback: false,
      dryRun: false,
      createdAt: now,
      updatedAt: now,
    };
  }
}

/**
 * Infer the Salesforce object API name from a file path.
 * @param filePath - File path to infer from
 * @returns Inferred object API name
 */
function inferObjectName(filePath: string): string {
  const fileName = filePath.split('/').pop()?.split('\\').pop() ?? '';
  const baseName = fileName.replace(/\.(csv|json)$/i, '');

  if (baseName.length === 0) {
    return 'CustomObject__c';
  }

  const pascalCase = baseName
    .replace(/[_\-\s]+(.)/g, (_match, char: string) => char.toUpperCase())
    .replace(/^(.)/, (_match, char: string) => char.toUpperCase());

  return pascalCase;
}

/**
 * Map a column name to the most likely Salesforce field API name.
 * Handles common naming patterns from spreadsheets and databases.
 * @param columnName - Source column name
 * @returns Inferred Salesforce field API name
 */
function mapColumnToSfField(columnName: string): string {
  const standardMappings: Record<string, string> = {
    id: 'Id',
    name: 'Name',
    first_name: 'FirstName',
    firstname: 'FirstName',
    'first name': 'FirstName',
    last_name: 'LastName',
    lastname: 'LastName',
    'last name': 'LastName',
    email: 'Email',
    phone: 'Phone',
    mobile: 'MobilePhone',
    mobile_phone: 'MobilePhone',
    fax: 'Fax',
    title: 'Title',
    department: 'Department',
    company: 'Company',
    website: 'Website',
    industry: 'Industry',
    description: 'Description',
    street: 'BillingStreet',
    city: 'BillingCity',
    state: 'BillingState',
    zip: 'BillingPostalCode',
    zipcode: 'BillingPostalCode',
    postal_code: 'BillingPostalCode',
    country: 'BillingCountry',
    type: 'Type',
    status: 'Status',
    rating: 'Rating',
    revenue: 'AnnualRevenue',
    annual_revenue: 'AnnualRevenue',
    employees: 'NumberOfEmployees',
    number_of_employees: 'NumberOfEmployees',
    owner: 'OwnerId',
    owner_id: 'OwnerId',
    created_date: 'CreatedDate',
    modified_date: 'LastModifiedDate',
    account_id: 'AccountId',
    contact_id: 'ContactId',
    opportunity_id: 'OpportunityId',
  };

  const lower = columnName.toLowerCase().trim();
  if (standardMappings[lower]) {
    return standardMappings[lower];
  }

  // If already looks like an API name (PascalCase or contains __c), keep it
  if (/^[A-Z]/.test(columnName) && !columnName.includes(' ')) {
    return columnName;
  }

  // Convert to PascalCase
  return columnName
    .replace(/[_\-\s]+(.)/g, (_match, char: string) => char.toUpperCase())
    .replace(/^(.)/, (_match, char: string) => char.toUpperCase());
}

/**
 * Infer the value type from sample values.
 * @param values - Sample values from the column
 * @returns Inferred type string
 */
function inferValueType(values: unknown[]): 'string' | 'number' | 'boolean' | 'date' | 'id' {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== '');

  if (nonEmpty.length === 0) {
    return 'string';
  }

  if (nonEmpty.every((v) => typeof v === 'boolean')) {
    return 'boolean';
  }

  if (nonEmpty.every((v) => typeof v === 'number')) {
    return 'number';
  }

  const allStrings = nonEmpty.filter((v): v is string => typeof v === 'string');
  if (allStrings.length === nonEmpty.length) {
    // Check for Salesforce ID pattern (15 or 18 char alphanumeric)
    if (allStrings.every((s) => /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(s))) {
      return 'id';
    }
    // Check for date patterns
    if (allStrings.every((s) => /^\d{4}-\d{2}-\d{2}/.test(s))) {
      return 'date';
    }
  }

  return 'string';
}

/**
 * Parse CSV rows respecting quoted fields.
 * @param text - CSV text content
 * @param delimiter - Field delimiter
 * @returns Array of row arrays
 */
function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      currentField += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === delimiter) {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r') {
      i++;
      continue;
    }

    if (char === '\n') {
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  currentRow.push(currentField);
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Parse a CSV value to its appropriate type.
 * @param value - Raw string value
 * @returns Parsed value
 */
function parseCsvValue(value: string): unknown {
  if (value === '') {
    return '';
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
    return null;
  }

  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') {
    return num;
  }

  return value;
}

/**
 * Type guard for record objects.
 * @param value - Value to check
 * @returns True if value is a non-null, non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Generate a placeholder UUID-like string.
 * @returns Generated ID string
 */
function generateId(): string {
  return globalThis.crypto.randomUUID();
}
