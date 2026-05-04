import { z } from 'zod';

// ─── Enum Schemas ────────────────────────────────────────────────────────────

/** Zod schema for AutopilotNodeStatus enum */
export const autopilotNodeStatusSchema = z.enum([
  'pending',
  'queued',
  'extracting',
  'anonymizing',
  'loading',
  'completed',
  'failed',
  'skipped',
]);

/** Zod schema for RelationshipType enum */
export const autopilotRelationshipTypeSchema = z.enum([
  'lookup',
  'master_detail',
  'hierarchical',
  'polymorphic',
]);

/** Zod schema for AnonymizationMethod enum */
export const anonymizationMethodSchema = z.enum([
  'fake',
  'mask',
  'hash',
  'nullify',
  'redact',
  'shuffle',
  'truncate',
  'preserve_format',
  'age_band',
  'generalize',
]);

/** Zod schema for PIICategory enum */
export const piiCategorySchema = z.enum(['PII', 'PHI', 'PCI', 'SENSITIVE', 'NONE']);

/** Zod schema for ComplianceFrameworkType enum */
export const complianceFrameworkTypeSchema = z.enum([
  'gdpr',
  'ccpa',
  'hipaa',
  'pci_dss',
  'custom',
  'none',
]);

// ─── Detection Method Schema ─────────────────────────────────────────────────

/** Zod schema for PII detection method */
export const detectionMethodSchema = z.enum(['field_name', 'regex', 'content_sampling', 'ai']);

// ─── Leaf Schemas ────────────────────────────────────────────────────────────

/** Zod schema for PIIFieldDetection */
export const piiFieldDetectionSchema = z.object({
  objectApiName: z.string().min(1),
  fieldApiName: z.string().min(1),
  fieldLabel: z.string().min(1),
  fieldType: z.string().min(1),
  piiCategory: piiCategorySchema,
  detectionMethod: detectionMethodSchema,
  confidence: z.number().min(0).max(1),
  suggestedMethod: anonymizationMethodSchema,
});

/** Zod schema for AnonymizationRule */
export const anonymizationRuleSchema = z.object({
  objectApiName: z.string().min(1),
  fieldApiName: z.string().min(1),
  method: anonymizationMethodSchema,
  piiCategory: piiCategorySchema,
  aiConfidence: z.number().min(0).max(1),
  userOverridden: z.boolean(),
});

/** Zod schema for AnonymizedPersona */
export const anonymizedPersonaSchema = z.object({
  sourceRecordId: z.string().min(1),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
  address: z.string(),
  city: z.string(),
  postalCode: z.string(),
  company: z.string(),
});

// ─── Graph Schemas ───────────────────────────────────────────────────────────

/** Zod schema for AutopilotNode */
export const autopilotNodeSchema = z.object({
  objectApiName: z.string().min(1),
  recordCount: z.number().int().nonnegative(),
  estimatedApiCalls: z.number().int().nonnegative(),
  piiFields: z.array(piiFieldDetectionSchema),
  anonymizationRules: z.array(anonymizationRuleSchema),
  status: autopilotNodeStatusSchema,
  progress: z.number().min(0).max(100),
  insertOrder: z.number().int().nonnegative(),
  level: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  elapsedMs: z.number().nonnegative(),
  apiCallsUsed: z.number().int().nonnegative(),
});

/** Zod schema for AutopilotEdge */
export const autopilotEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  fieldApiName: z.string().min(1),
  relationshipType: autopilotRelationshipTypeSchema,
  required: z.boolean(),
});

/** Zod schema for CycleResolutionStrategy enum */
export const cycleResolutionStrategySchema = z.enum([
  'two_pass',
  'upsert_external_id',
  'nullable_lookup',
]);

/** Zod schema for CycleResolution */
export const cycleResolutionSchema = z.object({
  objects: z.array(z.string().min(1)).min(2),
  strategy: cycleResolutionStrategySchema,
  description: z.string().min(1),
});

/** Zod schema for GraphStats */
export const graphStatsSchema = z.object({
  totalObjects: z.number().int().nonnegative(),
  totalRelationships: z.number().int().nonnegative(),
  cycleCount: z.number().int().nonnegative(),
  maxDepth: z.number().int().nonnegative(),
  totalRecords: z.number().int().nonnegative(),
  totalEstimatedApiCalls: z.number().int().nonnegative(),
});

/** Zod schema for AutopilotGraph */
export const autopilotGraphSchema = z.object({
  nodes: z.array(autopilotNodeSchema),
  edges: z.array(autopilotEdgeSchema),
  cycles: z.array(cycleResolutionSchema),
  stats: graphStatsSchema,
});

// ─── Execution Schemas ───────────────────────────────────────────────────────

/** Zod schema for ExecutionWave */
export const executionWaveSchema = z.object({
  order: z.number().int().nonnegative(),
  objects: z.array(z.string().min(1)),
  dependsOn: z.array(z.number().int().nonnegative()),
});

/** Zod schema for AnonymizationSummary */
export const anonymizationSummarySchema = z.object({
  totalPiiFields: z.number().int().nonnegative(),
  totalFieldsToAnonymize: z.number().int().nonnegative(),
  methodBreakdown: z.record(anonymizationMethodSchema, z.number().int().nonnegative()),
  objectsWithPii: z.array(z.string().min(1)),
});

/** Zod schema for ExecutionPlan */
export const executionPlanSchema = z.object({
  waves: z.array(executionWaveSchema),
  totalRecords: z.number().int().nonnegative(),
  estimatedDurationSec: z.number().nonnegative(),
  estimatedApiCalls: z.number().int().nonnegative(),
  complianceFramework: complianceFrameworkTypeSchema,
  anonymizationSummary: anonymizationSummarySchema,
  cycleResolutions: z.array(cycleResolutionSchema),
});

// ─── Config Schema ───────────────────────────────────────────────────────────

/** Zod schema for AutopilotConfig */
export const autopilotConfigSchema = z.object({
  sourceOrgId: z.string().min(1),
  targetOrgId: z.string().min(1),
  selectedObjects: z.array(z.string().min(1)),
  complianceFramework: complianceFrameworkTypeSchema,
  maxRecordsPerObject: z.number().int().nonnegative(),
  objectFilters: z.record(z.string()),
  includeStandardObjects: z.boolean(),
  grappeThreshold: z.number().int().positive(),
});

// ─── Event Schemas (Discriminated Union) ─────────────────────────────────────

/** Base fields shared by all autopilot events */
const autopilotEventBaseSchema = z.object({
  timestamp: z.string().min(1),
});

/** Zod schema for simple autopilot events (no extra payload) */
const simpleEventSchema = autopilotEventBaseSchema.extend({
  type: z.enum([
    'scan-started',
    'scan-completed',
    'plan-generated',
    'execution-started',
    'wave-completed',
    'execution-completed',
    'execution-failed',
    'paused',
    'resumed',
  ]),
});

/** Zod schema for AutopilotNodeProgressEvent */
const nodeProgressEventSchema = autopilotEventBaseSchema.extend({
  type: z.literal('node-progress'),
  objectApiName: z.string().min(1),
  progress: z.number().min(0).max(100),
  recordsProcessed: z.number().int().nonnegative(),
  recordsTotal: z.number().int().nonnegative(),
  apiCallsUsed: z.number().int().nonnegative(),
});

/** Zod schema for AutopilotNodeCompletedEvent */
const nodeCompletedEventSchema = autopilotEventBaseSchema.extend({
  type: z.literal('node-completed'),
  objectApiName: z.string().min(1),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(),
  apiCallsUsed: z.number().int().nonnegative(),
});

/** Zod schema for AutopilotNodeFailedEvent */
const nodeFailedEventSchema = autopilotEventBaseSchema.extend({
  type: z.literal('node-failed'),
  objectApiName: z.string().min(1),
  errors: z.array(z.string()),
  partialSuccessCount: z.number().int().nonnegative(),
});

/** Zod schema for AutopilotNodeSkippedEvent */
const nodeSkippedEventSchema = autopilotEventBaseSchema.extend({
  type: z.literal('node-skipped'),
  objectApiName: z.string().min(1),
});

/** Zod schema for AutopilotEvent — discriminated union on `type` */
export const autopilotEventSchema = z.discriminatedUnion('type', [
  simpleEventSchema,
  nodeProgressEventSchema,
  nodeCompletedEventSchema,
  nodeFailedEventSchema,
  nodeSkippedEventSchema,
]);

// ─── Inferred Types ──────────────────────────────────────────────────────────

/** Inferred type for AutopilotNode input */
export type AutopilotNodeInput = z.infer<typeof autopilotNodeSchema>;

/** Inferred type for AutopilotEdge input */
export type AutopilotEdgeInput = z.infer<typeof autopilotEdgeSchema>;

/** Inferred type for AutopilotGraph input */
export type AutopilotGraphInput = z.infer<typeof autopilotGraphSchema>;

/** Inferred type for ExecutionPlan input */
export type ExecutionPlanInput = z.infer<typeof executionPlanSchema>;

/** Inferred type for AutopilotConfig input */
export type AutopilotConfigInput = z.infer<typeof autopilotConfigSchema>;

/** Inferred type for AutopilotEvent input */
export type AutopilotEventInput = z.infer<typeof autopilotEventSchema>;
