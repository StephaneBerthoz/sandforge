/**
 * Stage-facing execution configuration for the Forge pipeline.
 *
 * The public {@link ExecuteOptions} bag (kept unchanged for back-compat) is
 * resolved once per `execute()` call into this normalized form so each
 * pipeline stage reads a single source of truth instead of re-applying
 * inline defaults (`?? false`, `?? 20`, …) throughout the executor.
 */

import { BYTES_PER_MB, FILE_COPY_CEILING_MB, FILE_COPY_DEFAULT_MAX_MB } from '@sandforge/shared';
import type { ForgeRecordTypeMapping } from '@sandforge/shared';
import type { ExecuteOptions, ForgeStreamCheckpoint, ForgeStreamPage } from '../ForgeExecutor.js';
import type { RecordTypeMapping } from '../../sync/RecordTypeMapper.js';
import type { ForgeRunAnonymization } from '../ForgeAnonymizer.js';
import type { ForgeRunStore } from '../ForgeRunStore.js';
import { RunDecisions } from './RunDecisions.js';

/**
 * What the runs this one retries or resumes wrote: the mappings the run
 * retried handed over, and what an earlier part of the journal the run goes
 * on in registered. A row found here is linked to and never written again.
 * Iterated, it gives the mappings handed over alone: an earlier part's are
 * in the journal the run writes to already.
 */
export class WrittenBefore implements Iterable<[string, string]> {
  constructor(
    private readonly given: ReadonlyMap<string, string>,
    private readonly store?: ForgeRunStore,
  ) {}

  has(sourceId: string): boolean {
    return this.given.has(sourceId) || this.store?.mapping(sourceId)?.earlier === true;
  }

  get(sourceId: string): string | undefined {
    const given = this.given.get(sourceId);
    if (given !== undefined) return given;
    const stored = this.store?.mapping(sourceId);
    return stored?.earlier ? stored.targetId : undefined;
  }

  /**
   * Where the rows written before come from, as a node's line says it: the
   * run retried, which handed them over, or the earlier parts of the run this
   * one takes up where it stopped, its journal holding them.
   */
  get from(): 'retry' | 'resume' {
    return this.given.size === 0 && (this.store?.earlierMapped ?? 0) > 0 ? 'resume' : 'retry';
  }

  /** Records written before: those handed over, and those earlier parts of the journal mapped. */
  get size(): number {
    return this.given.size + (this.store?.earlierMapped ?? 0);
  }

  /** The source ids handed over by the run retried. */
  keys(): IterableIterator<string> {
    return this.given.keys();
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.given.entries();
  }
}

/** Normalized configuration consumed by the execution stages. */
export interface ForgeStageConfig {
  /** True when both rootRecordId and rootObjectApiName are set — record-scoped mode. */
  readonly isScoped: boolean;
  /** A simulation: every stage a real run goes through, with a writer that writes nothing. */
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
  /** Objects the run leaves out by name, whether discovery reached them or not. */
  readonly excludedObjects: ReadonlySet<string>;
  /** Per-object owner remap (source `OwnerId` → target `OwnerId`). */
  readonly ownerMappings: Record<string, string>;
  /** Per-object extra WHERE fragment appended to the scope-derived clause. */
  readonly objectSoqlFilters?: Record<string, string>;
  /** Per-object source→target field rename map. */
  readonly fieldMappings: Record<string, Record<string, string>>;
  /** Fields to anonymize per object and the method per PII category; absent, none. */
  readonly anonymization?: ForgeRunAnonymization;
  /** Write email addresses and phone numbers as read; false neutralizes them, the default. */
  readonly keepContactPoints: boolean;
  /**
   * Copy the files of the records the run clones; absent, no file is read. The
   * size is held to what one call carries, whatever the caller asked.
   */
  readonly files?: { readonly maxFileBytes: number; readonly acceptedAsIs: boolean };
  /**
   * Source id to target id of every record the run this one retries left in
   * the target; empty for a run that retries none.
   */
  readonly writtenBefore: WrittenBefore;
  /** Handed every row before the first is written; absent, nothing looks at them first. */
  readonly beforeWrite?: ExecuteOptions['beforeWrite'];
  /**
   * How a run of whole tables is read and written page by page, when it is
   * asked to be; absent, every node is read whole. A run read from a record
   * is read whole all the same, through the cursor in pages when `pageSize`
   * is given, to the ceiling. See `ExecuteOptions.stream`.
   */
  readonly stream?: {
    readonly pageSize?: number;
    readonly ceiling?: number;
    /**
     * Per object, where the run this one resumes stopped: given, or, for a run
     * that goes on in the journal of the one it resumes, read from it.
     */
    readonly resumeAfter: ReadonlyMap<string, ForgeStreamCheckpoint & { done?: true }>;
    readonly onPage?: (page: ForgeStreamPage) => void | Promise<void>;
    /** The store of the run's journal: see `ExecuteOptions.stream.store`. */
    readonly store?: ForgeRunStore;
    /** Mappings past which the summary leaves the ids in the journal. */
    readonly summaryBound?: number;
    /** Lookups the second pass takes from the journal at a time. */
    readonly secondPassPageSize?: number;
  };
  /** The user's decisions about the rows, applied before they are written. */
  readonly decisions: RunDecisions;
  /**
   * The record type decision each source record type is under, by its id:
   * its rows go in with the target record type it names, or, `to: null`,
   * without `RecordTypeId`. Filled once the decisions are resolved against
   * both orgs' record types; empty before.
   */
  readonly recordTypeDecisions: ReadonlyMap<string, ForgeRecordTypeMapping>;
}

/** A count given as a positive whole number, floored; undefined for anything else. */
function positiveWhole(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
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
    excludedObjects: new Set(options?.excludedObjects ?? []),
    ownerMappings: options?.ownerMappings ?? {},
    objectSoqlFilters: options?.objectSoqlFilters,
    fieldMappings: options?.fieldMappings ?? {},
    anonymization: options?.anonymization,
    keepContactPoints: options?.keepContactPoints === true,
    files: options?.files
      ? {
          maxFileBytes: Math.min(
            options.files.maxFileBytes > 0
              ? options.files.maxFileBytes
              : FILE_COPY_DEFAULT_MAX_MB * BYTES_PER_MB,
            FILE_COPY_CEILING_MB * BYTES_PER_MB,
          ),
          acceptedAsIs: options.files.acceptedAsIs === true,
        }
      : undefined,
    writtenBefore: new WrittenBefore(
      new Map(Object.entries(options?.writtenBefore ?? {})),
      options?.stream?.store,
    ),
    beforeWrite: options?.beforeWrite,
    stream: options?.stream
      ? {
          pageSize: positiveWhole(options.stream.pageSize),
          ceiling: positiveWhole(options.stream.ceiling),
          resumeAfter: options.stream.resumeAfter
            ? new Map(Object.entries(options.stream.resumeAfter))
            : (options.stream.store?.checkpoints() ?? new Map()),
          onPage: options.stream.onPage,
          ...(options.stream.store ? { store: options.stream.store } : {}),
          ...(options.stream.summaryBound !== undefined
            ? { summaryBound: Math.max(0, Math.floor(options.stream.summaryBound)) }
            : {}),
          ...(positiveWhole(options.stream.secondPassPageSize) !== undefined
            ? { secondPassPageSize: positiveWhole(options.stream.secondPassPageSize) }
            : {}),
        }
      : undefined,
    decisions: new RunDecisions(options?.decisions),
    recordTypeDecisions: new Map<string, ForgeRecordTypeMapping>(),
  };
}
