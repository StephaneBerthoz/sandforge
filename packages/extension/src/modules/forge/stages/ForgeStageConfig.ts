/**
 * Stage-facing execution configuration for the Forge pipeline.
 *
 * The public {@link ExecuteOptions} bag (kept unchanged for back-compat) is
 * resolved once per `execute()` call into this normalized form so each
 * pipeline stage reads a single source of truth instead of re-applying
 * inline defaults (`?? false`, `?? 20`, …) throughout the executor.
 */

import type { ExecuteOptions } from '../ForgeExecutor.js';
import type { RecordTypeMapping } from '../../sync/RecordTypeMapper.js';

/** Normalized configuration consumed by the execution stages. */
export interface ForgeStageConfig {
  /** True when both rootRecordId and rootObjectApiName are set — record-scoped mode. */
  readonly isScoped: boolean;
  /** Query + populate caches but skip all writes to the target org. */
  readonly dryRun: boolean;
  /**
   * Orphan-FK handling — `'nullify'` replaces unmapped references with
   * `null`, `'keep'` preserves the source-org ID. Defaults to `'nullify'`
   * in scoped mode, `'keep'` otherwise.
   */
  readonly referenceFallback: 'nullify' | 'keep';
  /** Root record ID supplied by the user (scoped mode only). */
  readonly rootRecordId?: string;
  /** API name of the root object (scoped mode only). */
  readonly rootObjectApiName?: string;
  /** Cross-org RecordType ID translations (matched by `developerName`). */
  readonly recordTypeMappings?: RecordTypeMapping[];
  /** Per-object hard cap on records to clone (appended as `LIMIT N`). */
  readonly maxRecordsPerObject?: number;
  /**
   * Object API names whose rows are *mapped* to existing target records
   * (matched on `Name` / `DeveloperName`) instead of inserted.
   */
  readonly referenceDataObjects: ReadonlySet<string>;
  /** Single-hop orphan parent expansion toggle. */
  readonly expandOrphanParents: boolean;
  /** Cap on orphan parent expansions per `execute()` call. */
  readonly maxOrphanParentExpansions: number;
  /** Insert vs upsert behaviour — `'auto'` upserts via external Id when available. */
  readonly upsertMode: 'auto' | 'off';
  /** Per-object field exclusions (stripped before insert even when createable). */
  readonly fieldExclusions: Record<string, string[]>;
  /** Per-object owner remap (source `OwnerId` → target `OwnerId`). */
  readonly ownerMappings: Record<string, string>;
  /** Per-object extra WHERE fragment appended to the scope-derived clause. */
  readonly objectSoqlFilters?: Record<string, string>;
  /** Per-object source→target field rename map. */
  readonly fieldMappings: Record<string, Record<string, string>>;
}

/**
 * Normalize the public {@link ExecuteOptions} into stage configuration.
 * Pure — no I/O, no side effects.
 */
export function resolveStageConfig(options: ExecuteOptions | undefined): ForgeStageConfig {
  const isScoped = !!(options?.rootRecordId && options.rootObjectApiName);
  return {
    isScoped,
    dryRun: options?.dryRun ?? false,
    referenceFallback: options?.referenceFallback ?? (isScoped ? 'nullify' : 'keep'),
    rootRecordId: options?.rootRecordId,
    rootObjectApiName: options?.rootObjectApiName,
    recordTypeMappings: options?.recordTypeMappings,
    maxRecordsPerObject: options?.maxRecordsPerObject,
    referenceDataObjects: new Set(
      options?.referenceDataObjects ?? ['BusinessHours', 'OperatingHours'],
    ),
    expandOrphanParents: options?.expandOrphanParents ?? false,
    maxOrphanParentExpansions: options?.maxOrphanParentExpansions ?? 20,
    upsertMode: options?.upsertMode === 'auto' ? 'auto' : 'off',
    fieldExclusions: options?.fieldExclusions ?? {},
    ownerMappings: options?.ownerMappings ?? {},
    objectSoqlFilters: options?.objectSoqlFilters,
    fieldMappings: options?.fieldMappings ?? {},
  };
}
