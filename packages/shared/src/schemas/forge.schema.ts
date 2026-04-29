import { z } from 'zod';

// ─── Enum Schemas ────────────────────────────────────────────────────────────

/** Zod schema for ForgeInputMode enum */
export const forgeInputModeSchema = z.enum(['record', 'soql', 'template', 'ai']);

/** Zod schema for ForgeDepth enum */
export const forgeDepthSchema = z.enum(['direct', 'full', 'custom']);

/** Zod schema for ForgeNodeStatus enum */
export const forgeNodeStatusSchema = z.enum(['idle', 'scanning', 'running', 'done', 'error', 'skipped']);

/** Zod schema for ForgeGraphEdge relationship type */
export const forgeEdgeTypeSchema = z.enum(['master-detail', 'lookup']);

/** Zod schema for ForgeExecutionResult status */
export const forgeExecutionStatusSchema = z.enum(['success', 'partial', 'failure']);

/** Zod schema for ForgeBatchStrategy */
export const forgeBatchStrategySchema = z.enum(['rest', 'bulk', 'auto']);

/** Zod schema for ForgeAnonymizationCategory */
export const forgeAnonymizationCategorySchema = z.enum(['email', 'phone', 'name', 'address', 'ssn_id', 'financial', 'other']);

/** Zod schema for ForgeCycleStrategy */
export const forgeCycleStrategySchema = z.enum(['two_pass', 'upsert_external_id', 'nullable_lookup']);

// ─── Config Schema ──────────────────────────────────────────────────────────

/** Zod schema for ForgeConfig */
export const forgeConfigSchema = z.object({
  inputMode: forgeInputModeSchema,
  recordId: z.string().min(1).optional(),
  soqlQuery: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  aiPrompt: z.string().min(1).optional(),
  depth: forgeDepthSchema,
  customDepth: z.number().int().positive().optional(),
  sourceOrgId: z.string().min(1),
  targetOrgId: z.string().min(1),
  anonymizePII: z.boolean(),
  skipEmpty: z.boolean(),
  batchSize: z.union([z.literal('auto'), z.number().int().positive()]),
});

// ─── Graph Schemas ──────────────────────────────────────────────────────────

/** Zod schema for ForgeGraphNode */
export const forgeGraphNodeSchema = z.object({
  objectApiName: z.string().min(1),
  recordCount: z.number().int().nonnegative(),
  fieldCount: z.number().int().nonnegative(),
  status: forgeNodeStatusSchema,
  progress: z.number().min(0).max(100),
  included: z.boolean(),
  piiFields: z.array(z.string()),
  anonymizeFields: z.array(z.string()),
  level: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  createableFieldCount: z.number().int().nonnegative(),
  estimatedSizeMB: z.number().nonnegative(),
  estimatedApiCalls: z.number().int().nonnegative(),
  batchStrategy: forgeBatchStrategySchema,
});

/** Zod schema for ForgeGraphEdge */
export const forgeGraphEdgeSchema = z.object({
  sourceObject: z.string().min(1),
  targetObject: z.string().min(1),
  relationshipName: z.string().min(1),
  type: forgeEdgeTypeSchema,
});

/** Zod schema for ForgeGraph */
export const forgeGraphSchema = z.object({
  nodes: z.array(forgeGraphNodeSchema),
  edges: z.array(forgeGraphEdgeSchema),
  totalRecords: z.number().int().nonnegative(),
  estimatedSizeMB: z.number().nonnegative(),
  estimatedDurationSeconds: z.number().nonnegative(),
  truncated: z.boolean().optional(),
});

// ─── Execution Result Schema ────────────────────────────────────────────────

/** Zod schema for ForgeExecutionResult */
export const forgeExecutionResultSchema = z.object({
  forgeId: z.string().min(1),
  status: forgeExecutionStatusSchema,
  graph: forgeGraphSchema,
  duration: z.number().nonnegative(),
  timestamp: z.string().min(1),
  idRemapCount: z.number().int().nonnegative(),
});

// ─── Template Schema ────────────────────────────────────────────────────────

/** Zod schema for ForgeTemplate */
export const forgeTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  config: forgeConfigSchema.omit({ sourceOrgId: true, targetOrgId: true }),
  objectCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  lastUsedAt: z.string().min(1),
});

// ─── Forge v2 Schemas ──────────────────────────────────────────────────────

/** Zod schema for ForgeWave */
export const forgeWaveSchema = z.object({
  order: z.number().int().nonnegative(),
  objectApiNames: z.array(z.string()),
  totalRecords: z.number().int().nonnegative(),
  estimatedDurationSeconds: z.number().nonnegative(),
  estimatedApiCalls: z.number().int().nonnegative(),
});

/** Zod schema for ForgeCycleResolution */
export const forgeCycleResolutionSchema = z.object({
  objects: z.array(z.string()),
  strategy: forgeCycleStrategySchema,
  description: z.string(),
});

/** Zod schema for ForgePlan */
export const forgePlanSchema = z.object({
  waves: z.array(forgeWaveSchema),
  totalRecords: z.number().int().nonnegative(),
  totalApiCalls: z.number().int().nonnegative(),
  estimatedDurationSeconds: z.number().nonnegative(),
  cycleResolutions: z.array(forgeCycleResolutionSchema),
});

/** Zod schema for ForgeCheckpoint */
export const forgeCheckpointSchema = z.object({
  forgeId: z.string(),
  config: forgeConfigSchema,
  graph: forgeGraphSchema,
  plan: forgePlanSchema,
  currentWaveIndex: z.number().int().nonnegative(),
  currentObjectIndex: z.number().int().nonnegative(),
  currentBatchIndex: z.number().int().nonnegative(),
  remapperState: z.record(z.string()),
  completedObjects: z.array(z.string()),
  timestamp: z.string(),
});

// ─── Inferred Types ─────────────────────────────────────────────────────────

/** Inferred type for ForgeConfig input */
export type ForgeConfigInput = z.infer<typeof forgeConfigSchema>;

/** Inferred type for ForgeGraphNode input */
export type ForgeGraphNodeInput = z.infer<typeof forgeGraphNodeSchema>;

/** Inferred type for ForgeGraphEdge input */
export type ForgeGraphEdgeInput = z.infer<typeof forgeGraphEdgeSchema>;

/** Inferred type for ForgeGraph input */
export type ForgeGraphInput = z.infer<typeof forgeGraphSchema>;

/** Inferred type for ForgeExecutionResult input */
export type ForgeExecutionResultInput = z.infer<typeof forgeExecutionResultSchema>;

/** Inferred type for ForgeTemplate input */
export type ForgeTemplateInput = z.infer<typeof forgeTemplateSchema>;

/** Inferred type for ForgeWave input */
export type ForgeWaveInput = z.infer<typeof forgeWaveSchema>;

/** Inferred type for ForgePlan input */
export type ForgePlanInput = z.infer<typeof forgePlanSchema>;

/** Inferred type for ForgeCycleResolution input */
export type ForgeCycleResolutionInput = z.infer<typeof forgeCycleResolutionSchema>;

/** Inferred type for ForgeCheckpoint input */
export type ForgeCheckpointInput = z.infer<typeof forgeCheckpointSchema>;
