import { z } from 'zod';

/**
 * Zod schema for Quick Sync configuration.
 *
 * Validates that org IDs are non-empty strings and at least one
 * object is selected for synchronization.
 */
export const QuickSyncConfigSchema = z.object({
  /** Source org identifier (non-empty). */
  sourceOrgId: z.string().min(1, 'sourceOrgId is required'),
  /** Target org identifier (non-empty). */
  targetOrgId: z.string().min(1, 'targetOrgId is required'),
  /** At least one object must be selected. */
  selectedObjects: z.array(z.string().min(1)).min(1, 'At least one object must be selected'),
  /** Auto-detected parent objects (may be empty). */
  parentObjects: z.array(z.string().min(1)).default([]),
});

/** Inferred input type for QuickSyncConfig schema. */
export type QuickSyncConfigInput = z.infer<typeof QuickSyncConfigSchema>;
