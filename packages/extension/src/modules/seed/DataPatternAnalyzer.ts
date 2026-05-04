import type { FieldRuleType } from '@sandforge/shared';

/** Function signature for fetching sample data from an org */
export type FetchSampleDataFn = (orgId: string, objectName: string) => Promise<SampleDataResponse>;

/** Response from fetching sample data */
export interface SampleDataResponse {
  records: Record<string, unknown>[];
  fields: FieldMetadata[];
  totalCount: number;
}

/** Metadata about a Salesforce field */
export interface FieldMetadata {
  name: string;
  type: string;
  nillable: boolean;
  referenceTo?: string[];
  picklistValues?: string[];
}

/** Analyzed data pattern for an object */
export interface DataPattern {
  objectName: string;
  fieldPatterns: FieldPattern[];
  recordCount: number;
}

/** Analyzed pattern for a single field */
export interface FieldPattern {
  fieldName: string;
  dataType: string;
  nullPercent: number;
  uniquePercent: number;
  sampleValues: unknown[];
  suggestedRule: FieldRuleType;
}

/** Maximum number of sample values to keep per field */
const MAX_SAMPLE_VALUES = 5;

/**
 * Analyzes existing data patterns in an org to suggest
 * appropriate field rules for seed template creation.
 */
export class DataPatternAnalyzer {
  private readonly fetchSampleData: FetchSampleDataFn;

  constructor(fetchSampleData: FetchSampleDataFn) {
    this.fetchSampleData = fetchSampleData;
  }

  /**
   * Analyze the data patterns for a given object in an org.
   * Fetches sample records and computes statistics for each field.
   */
  async analyze(orgId: string, objectName: string): Promise<DataPattern> {
    const response = await this.fetchSampleData(orgId, objectName);
    const { records, fields, totalCount } = response;

    const fieldPatterns = fields.map((field) => analyzeField(field, records));

    return {
      objectName,
      fieldPatterns,
      recordCount: totalCount,
    };
  }
}

/**
 * Analyze a single field across all sample records.
 * Computes null percentage, uniqueness, and suggests a field rule type.
 */
function analyzeField(field: FieldMetadata, records: Record<string, unknown>[]): FieldPattern {
  const values = records.map((r) => r[field.name]);
  const totalValues = values.length;

  const nullCount = values.filter((v) => v === null || v === undefined).length;
  const nullPercent = totalValues > 0 ? (nullCount / totalValues) * 100 : 0;

  const nonNullValues = values.filter((v) => v !== null && v !== undefined);
  const uniqueValues = new Set(nonNullValues.map(String));
  const uniquePercent =
    nonNullValues.length > 0 ? (uniqueValues.size / nonNullValues.length) * 100 : 0;

  const sampleValues = nonNullValues.slice(0, MAX_SAMPLE_VALUES);

  const suggestedRule = suggestFieldRule(field, uniquePercent, nonNullValues);

  return {
    fieldName: field.name,
    dataType: field.type,
    nullPercent: Math.round(nullPercent * 100) / 100,
    uniquePercent: Math.round(uniquePercent * 100) / 100,
    sampleValues,
    suggestedRule,
  };
}

/**
 * Suggest the most appropriate field rule type based on
 * field metadata and data distribution.
 */
function suggestFieldRule(
  field: FieldMetadata,
  uniquePercent: number,
  values: unknown[],
): FieldRuleType {
  if (field.referenceTo && field.referenceTo.length > 0) {
    return 'reference';
  }

  if (field.picklistValues && field.picklistValues.length > 0) {
    return 'picklist_random';
  }

  if (field.type === 'id' || field.type === 'reference') {
    return 'reference';
  }

  if (field.type === 'email' || field.type === 'phone' || field.type === 'url') {
    return 'faker';
  }

  if (uniquePercent < 10 && values.length > 0) {
    return 'static';
  }

  if (uniquePercent >= 90) {
    return 'sequence';
  }

  return 'random';
}
