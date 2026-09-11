import type { UUID, ISODateString, ApiName } from './common.types.js';

/** Seed generation strategy */
export type SeedStrategy = 'ai' | 'faker' | 'template' | 'csv_import' | 'clone';

/** Field generation rule type */
export type FieldRuleType =
  | 'static'
  | 'random'
  | 'sequence'
  | 'formula'
  | 'reference'
  | 'picklist_random'
  | 'ai_generate'
  | 'faker'
  | 'regex'
  | 'from_csv';

/** Seed template — full configuration for a seed operation */
export interface SeedTemplate {
  id: UUID;
  name: string;
  description: string;
  version: number;
  strategy: SeedStrategy;
  objects: SeedObjectConfig[];
  aiPersona?: string;
  tags: string[];
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

/** Per-object seed configuration */
export interface SeedObjectConfig {
  objectApiName: ApiName;
  recordCount: number;
  recordTypeId?: string;
  fieldRules: FieldRule[];
  excludedFields: string[];
  insertOrder: number;
  batchSize: number;
}

/** Field generation rule */
export interface FieldRule {
  fieldApiName: string;
  ruleType: FieldRuleType;
  config: FieldRuleConfig;
}

/** Field rule configuration — varies by rule type */
export interface FieldRuleConfig {
  staticValue?: string | number | boolean;
  fakerMethod?: string;
  fakerLocale?: string;
  sequenceStart?: number;
  sequenceStep?: number;
  sequencePrefix?: string;
  formula?: string;
  referenceObject?: string;
  referenceField?: string;
  picklistValues?: string[];
  regexPattern?: string;
  csvColumn?: string;
  minValue?: number;
  maxValue?: number;
  minLength?: number;
  maxLength?: number;
  aiPrompt?: string;
}

/** Seed execution result */
export interface SeedExecutionResult {
  templateId: UUID;
  operationId: UUID;
  status: 'success' | 'partial' | 'failure';
  objectResults: SeedObjectResult[];
  totalRecordsCreated: number;
  totalRecordsFailed: number;
  duration: number;
  timestamp: ISODateString;
}

/** Per-object seed result */
export interface SeedObjectResult {
  objectApiName: ApiName;
  recordsCreated: number;
  recordsFailed: number;
  createdIds: string[];
  errors: string[];
}

/** Seed data plan — preview of what will be created */
export interface SeedDataPlan {
  objects: SeedDataPlanObject[];
  totalRecords: number;
  estimatedApiCalls: number;
  estimatedDuration: number;
  grappeRecommended: boolean;
}

/** Per-object preview in the seed data plan */
export interface SeedDataPlanObject {
  objectApiName: ApiName;
  recordCount: number;
  sampleRecords: Record<string, unknown>[];
  dependsOn: string[];
}

// ── Schema Analysis (ERD) ────────────────────────────────

/** Salesforce field metadata from describe */
export interface SeedFieldInfo {
  apiName: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  picklistValues?: string[];
  referenceTo?: string;
  unique: boolean;
  externalId: boolean;
  maxLength?: number;
}

/** Relationship between two objects */
export interface SeedRelationship {
  fieldName: string;
  targetObject: string;
  type: 'Lookup' | 'MasterDetail';
  required: boolean;
}

/** Object node in the ERD graph */
export interface ObjectNode {
  apiName: string;
  label: string;
  recordCount: number;
  fields: SeedFieldInfo[];
  relationships: SeedRelationship[];
}

/** ERD data produced by SchemaAnalyzer */
export interface ERDData {
  nodes: ObjectNode[];
  edges: ERDEdge[];
  insertionOrder: string[];
  circularDeps: string[][];
  warnings: string[];
}

/** Edge in the ERD graph */
export interface ERDEdge {
  source: string;
  target: string;
  field: string;
  type: 'Lookup' | 'MasterDetail';
}

// ── Smart Field Generation ───────────────────────────────

/** Field generation mode carried by a {@link FieldGenerationConfig}. */
export type FieldGenerationMode =
  | 'auto'
  | 'faker'
  | 'fixed'
  | 'sequence'
  | 'null'
  | 'picklist_random';

/** Configuration for generating a single field */
export interface FieldGenerationConfig {
  fieldName: string;
  fieldType: string;
  generationMode: FieldGenerationMode;
  fakerMethod?: string;
  fixedValue?: unknown;
  sequencePattern?: string;
  constraints: FieldGenerationConstraints;
}

/** Constraints on generated field values */
export interface FieldGenerationConstraints {
  required: boolean;
  unique: boolean;
  maxLength?: number;
  minLength?: number;
  picklistValues?: string[];
  min?: number;
  max?: number;
  /** Whether this field is a multipicklist (values separated by semicolons) */
  multipicklist?: boolean;
}

// ── Validation Rule Pre-Check ────────────────────────────

/** Constraint extracted from a validation rule formula */
export interface VRFieldConstraint {
  /** Field API name referenced in the formula */
  fieldName: string;
  /** Type of constraint detected */
  constraintType: 'required' | 'picklist_value' | 'length' | 'regex' | 'cross_field';
  /** Expected picklist value (for picklist_value constraints) */
  expectedValue?: string;
  /** Minimum length (for length constraints) */
  minLength?: number;
  /** Maximum length (for length constraints) */
  maxLength?: number;
  /** Regex pattern (for regex constraints) */
  regexPattern?: string;
  /** Related field name (for cross_field constraints) */
  relatedField?: string;
}

// ── CSV Import ──────────────────────────────────────────────

/** Mapping between a CSV column header and a Salesforce field. */
export interface CsvColumnMapping {
  csvHeader: string;
  sfFieldApiName: string;
  sfFieldType: string;
  sfFieldLength: number | null;
}

/** Full payload for a CSV import execution request. */
export interface CsvImportConfig {
  orgId: string;
  objectApiName: string;
  records: Record<string, string>[];
  columnMappings: CsvColumnMapping[];
  externalIdField?: string;
}

/** Single validation error found in CSV data. */
export interface CsvValidationError {
  row: number;
  column: string;
  field: string;
  errorType:
    | 'type_mismatch'
    | 'missing_required'
    | 'length_exceeded'
    | 'duplicate_external_id'
    | 'invalid_picklist';
  message: string;
  value: string;
}

/** Result of validating CSV data against Salesforce metadata. */
export interface CsvValidationResult {
  valid: boolean;
  errors: CsvValidationError[];
  warningCount: number;
}

/** Validation rule analysis result */
export interface VRCheckResult {
  ruleName: string;
  objectName: string;
  formula: string;
  errorMessage: string;
  potentialConflicts: string[];
  risk: 'low' | 'medium' | 'high';
  /** Structured constraints extracted from the formula */
  fieldConstraints: VRFieldConstraint[];
}
