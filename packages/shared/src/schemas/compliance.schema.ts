import { z } from 'zod';

import {
  anonymizationMethodSchema,
  complianceFrameworkTypeSchema,
  piiCategorySchema,
  piiFieldDetectionSchema,
} from './autopilot.schema.js';

// ─── Anonymization Override Schema (needed for ComplianceProfile) ────────────

/** Zod schema for AnonymizationOverride */
export const anonymizationOverrideSchema = z.object({
  objectApiName: z.string().min(1),
  fieldApiName: z.string().min(1),
  method: z.union([anonymizationMethodSchema, z.literal('skip')]),
});

// ─── Compliance Rule Schema ──────────────────────────────────────────────────

/** Zod schema for ComplianceRule */
export const complianceRuleSchema = z.object({
  id: z.string().min(1),
  framework: complianceFrameworkTypeSchema,
  category: z.string().min(1),
  description: z.string().min(1),
  targetPiiCategories: z.array(piiCategorySchema),
  requiredMethod: z.union([anonymizationMethodSchema, z.literal('any')]),
  articleReference: z.string().optional(),
});

// ─── Compliance Profile Schema ───────────────────────────────────────────────

/** Zod schema for ComplianceProfile */
export const complianceProfileSchema = z.object({
  framework: complianceFrameworkTypeSchema,
  rules: z.array(complianceRuleSchema),
  autoDetectedPII: z.array(piiFieldDetectionSchema),
  userOverrides: z.array(anonymizationOverrideSchema),
  auditRequired: z.boolean(),
});

// ─── Compliance Report Schemas ───────────────────────────────────────────────

/** Zod schema for compliance status */
export const complianceStatusSchema = z.enum(['pass', 'partial', 'fail']);

/** Zod schema for ComplianceReportEntry */
export const complianceReportEntrySchema = z.object({
  objectApiName: z.string().min(1),
  fieldApiName: z.string().min(1),
  piiCategory: piiCategorySchema,
  anonymizationMethod: anonymizationMethodSchema,
  recordsAnonymized: z.number().int().nonnegative(),
  ruleApplied: z.string().min(1),
  userOverridden: z.boolean(),
});

/** Zod schema for ComplianceObjectSummary */
export const complianceObjectSummarySchema = z.object({
  objectApiName: z.string().min(1),
  recordCount: z.number().int().nonnegative(),
  piiFieldCount: z.number().int().nonnegative(),
  anonymizationMethods: z.array(anonymizationMethodSchema),
  status: complianceStatusSchema,
});

/** Zod schema for ComplianceReport */
export const complianceReportSchema = z.object({
  id: z.string().min(1),
  framework: complianceFrameworkTypeSchema,
  generatedAt: z.string().min(1),
  sourceOrgId: z.string().min(1),
  targetOrgId: z.string().min(1),
  totalFieldsScanned: z.number().int().nonnegative(),
  piiFieldsDetected: z.number().int().nonnegative(),
  piiFieldsAnonymized: z.number().int().nonnegative(),
  entries: z.array(complianceReportEntrySchema),
  objectSummaries: z.array(complianceObjectSummarySchema),
  overallStatus: complianceStatusSchema,
  checksumSha256: z.string().min(1),
});

// ─── Inferred Types ──────────────────────────────────────────────────────────

/** Inferred type for ComplianceRule input */
export type ComplianceRuleInput = z.infer<typeof complianceRuleSchema>;

/** Inferred type for ComplianceProfile input */
export type ComplianceProfileInput = z.infer<typeof complianceProfileSchema>;

/** Inferred type for ComplianceReportEntry input */
export type ComplianceReportEntryInput = z.infer<typeof complianceReportEntrySchema>;

/** Inferred type for ComplianceObjectSummary input */
export type ComplianceObjectSummaryInput = z.infer<typeof complianceObjectSummarySchema>;

/** Inferred type for ComplianceReport input */
export type ComplianceReportInput = z.infer<typeof complianceReportSchema>;
