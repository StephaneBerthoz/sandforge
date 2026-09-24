import {
  syncConfigSchema,
  syncObjectConfigSchema,
  seedConfigSchema,
  seedObjectConfigSchema,
  seedRelationSchema,
  complianceFrameworkTypeSchema,
  anonymizationMethodSchema,
  QuickSyncConfigSchema,
  COMPLIANCE_MAX_OBJECTS,
  isSubjectEmail,
  isSubjectName,
  isSubjectPhone,
  QUALITY_SCAN_MAX_OBJECTS,
  QUALITY_SCAN_MAX_STALE_DAYS,
  DEPLOYABLE_COMPONENT_TYPES,
  DEPLOY_MAX_COMPONENTS,
  DEPLOY_MAX_TESTS,
  DEPLOY_TEST_LEVELS,
  DEPLOY_TEST_NAME_PATTERN,
  SUBJECT_SEARCH_LIMIT,
  SAVED_TEMPLATE_METHODS,
  TEMPLATE_FIELD_PATTERN,
  TEMPLATE_MAX_RULES,
  TEMPLATE_NAME_MAX_LENGTH,
} from '@sandforge/shared';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  isSafeSoqlOrderBy,
  isSafeSoqlWhere,
  SOQL_WHERE_RULE,
} from '../core/common/soqlValidator.js';
import type { HandlerDeps, InboundRequest } from './handlers/HandlerTypes.js';
import { AUDIT_TRAIL_LIMIT } from '../modules/audit/auditTrail.js';
import { sendHandlerError } from './handlers/HandlerTypes.js';
import { isUncopyableObject } from '@sandforge/shared';

/**
 * Generic webview-payload validation (defense-in-depth against a compromised
 * or buggy webview).
 *
 * The MessageBroker validates the message *envelope*; handlers historically
 * cast `msg.payload` with `as` and trusted every field. This module provides
 * a single Zod-based choke point: `validatePayload` returns the parsed,
 * typed payload on success; on failure it posts a handler error
 * (`INVALID_PAYLOAD`) through the existing `sendHandlerError` channel and
 * returns null so the caller can early-return.
 *
 * Payload schemas below mirror what the webview actually sends (verified
 * against `packages/webview/src/pages/*`). Org ids are Salesforce 18-char
 * org IDs (not UUIDs), so the shared `syncConfigSchema` is extended with a
 * permissive org-id field rather than reused blindly. `.passthrough()` keeps
 * extra keys the webview legitimately sends (config `id`, `createdAt`, …);
 * the sync schemas declare those keys instead and strip the rest, because what
 * they accept is persisted as-is.
 */

/** Permissive org-id schema (accepts SF 18-char org IDs as well as UUIDs). */
export const orgIdSchema = z.string().min(1).max(128);

/** Salesforce object/field API name: letter first, then alphanumerics/underscore. */
export const sfApiNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Invalid Salesforce API name')
  .max(80);

/** Bounded opaque identifier (operation ids, template ids, alert ids, config ids). */
export const opaqueIdSchema = z.string().min(1).max(200);

/**
 * Free-text SOQL WHERE fragment: a filter and nothing else. A clause that goes
 * on past the filter — `LIMIT 1`, `FOR UPDATE`, a comment, a subquery — would
 * still run, so it is refused here (literals are set aside first, so
 * `Status = 'Delete pending'` stays legal). The same rule is re-applied where
 * the fragment becomes query text (`SyncOpsHandler`, `CloneRecordFetcher`).
 */
export const whereClauseSchema = z
  .string()
  .max(2000)
  .refine(isSafeSoqlWhere, { message: SOQL_WHERE_RULE });

/**
 * SOQL ORDER BY fragment. Only field paths, `ASC`/`DESC` and `NULLS
 * FIRST`/`LAST` — the clause ends the statement, so a trailing `LIMIT 1`,
 * `OFFSET` or `FOR UPDATE` would ride along with it. Configs converted from a
 * third-party file (`SfdmuImporter`) carry this field verbatim, so it is
 * checked here exactly as `where` is, and re-checked when the delta query is
 * built (defense-in-depth, both layers stay).
 */
export const orderByClauseSchema = z.string().refine(isSafeSoqlOrderBy, {
  message:
    'ORDER BY clause must list only field names with optional ASC/DESC and NULLS FIRST/LAST ' +
    '(no LIMIT, OFFSET, FOR UPDATE or subquery).',
});

/** Max objects accepted per data operation (bounds API-call fan-out per request). */
const MAX_OBJECTS_PER_REQUEST = 100;

/** Max records a single seed object may generate (bounds memory + API usage). */
const MAX_SEED_RECORDS_PER_OBJECT = 1_000_000;

/** Max batch size accepted from the webview (matches manifest caps). */
const MAX_BATCH_SIZE = 10_000;

// ── sync:* payload schemas ────────────────────────────────────────────────

/**
 * Whether `objectApiName` is one no copy can carry.
 *
 * Kept as a named export because the sync boundary and the object picker both
 * call it, and re-exported rather than redefined: the list lived here, in
 * `RelationshipDetector` and nowhere else, so Autopilot and Seed asked
 * Salesforce `createable` and were told yes about `User`.
 */
export function isSyncFileObject(objectApiName: string): boolean {
  return isUncopyableObject(objectApiName);
}

/**
 * Per-object sync config as sent by the webview. `batchSize` is made optional
 * so the handler can fall back to the `sandforge.sync.defaultBatchSize`
 * setting (the shared schema hard-codes 200 otherwise). `externalIdField` is
 * the upsert key and the match key of a bidirectional run, so it is a field
 * name like every other key the bridge accepts.
 */
export const syncObjectPayloadSchema = syncObjectConfigSchema
  .extend({
    objectApiName: sfApiNameSchema.refine(
      (name) => !isSyncFileObject(name),
      (name) => ({
        message:
          `Sync does not transfer files: "${name}" keeps its content in a file body that no ` +
          `sync stage moves. Remove it from this configuration; the sync was not started.`,
      }),
    ),
    // The External ID box is shown for every operation and sends what it holds:
    // a box left empty is no key, not a malformed one.
    externalIdField: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      sfApiNameSchema.optional(),
    ),
    where: whereClauseSchema.optional(),
    orderBy: orderByClauseSchema.optional(),
    batchSize: z.number().int().positive().max(MAX_BATCH_SIZE).optional(),
  })
  .strip()
  /*
   * An upsert needs a key the target org can match on, and `Id` is not one.
   *
   * The writer fell back to `Id` whenever no External ID field was named, so
   * every Quick Sync and most built-in templates ran as "upsert on Id" — a
   * source-org record id the target has never issued, on a payload that does
   * not even carry it (`Id` is not createable, so the auto-mapper never maps
   * it). The run reached Salesforce and failed there, or wrote nothing, and
   * the reason never surfaced. Refused here instead, with the two ways out.
   */
  .refine(
    (object) => object.operation !== 'upsert' || (object.externalIdField ?? 'Id') !== 'Id',
    (object) => ({
      path: ['externalIdField'],
      message:
        `An upsert of "${object.objectApiName}" needs an External ID field: matching on Id cannot ` +
        `work, because the id belongs to the source org and the target has never issued it. ` +
        `Name an External ID field both orgs share, or set the operation to insert. ` +
        `The sync was not started.`,
    }),
  );

/**
 * An Apex hook a sync config used to carry. A sync moves data and never runs
 * code in an org, so the field is declared only to be refused rather than
 * dropped: a configuration saved when it still ran must say so out loud
 * instead of quietly syncing without the script its author expected. An
 * explicit `undefined` (a stored config round-tripping through JSON) passes.
 */
function removedScriptField(field: string): z.ZodUndefined {
  return z.undefined({
    errorMap: () => ({
      message:
        `Sync does not run Apex: remove "${field}" from this configuration. ` +
        `The sync was not started so the script cannot be skipped without you knowing.`,
    }),
  });
}

/**
 * Sync config accepted by `sync:execute` / `sync:config:save`.
 *
 * Unknown keys are stripped: the config store saves the parsed config and
 * history snapshots it, so anything accepted here is persisted and replayed.
 * The keys SandForge itself writes on a config are declared so they survive.
 */
export const syncConfigPayloadSchema = syncConfigSchema
  .extend({
    id: opaqueIdSchema.optional(),
    sourceOrgId: orgIdSchema,
    targetOrgId: orgIdSchema,
    objects: z.array(syncObjectPayloadSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
    createdAt: z.string().max(40).optional(),
    updatedAt: z.string().max(40).optional(),
    preScript: removedScriptField('preScript'),
    postScript: removedScriptField('postScript'),
    // A sync run always writes to the target org; there is no simulated path
    // behind this flag. `false` stays legal — every config SandForge wrote
    // carries it with that value, and history reruns replay those snapshots.
    dryRun: z
      .literal(false, {
        errorMap: () => ({
          message:
            `Sync has no dry run: remove "dryRun" from this configuration. ` +
            `A sync run writes to the target org, and the run was not started ` +
            `so it cannot write while you believed it was only reporting.`,
        }),
      })
      .optional(),
  })
  .strip()
  .superRefine((config, ctx) => {
    // The orchestrator branches on `bidirectional` alone; every other value
    // writes source to target, so this one would write into the org the user
    // meant to read from.
    if (config.direction === 'target_to_source') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direction'],
        message:
          `Sync writes source to target only: direction "target_to_source" is not supported. ` +
          `Swap the source and target orgs to copy the other way. The sync was not started, ` +
          `so it cannot write into the org you meant to read from.`,
      });
    }

    // Only a full sync exists: any other mode would replay the whole object
    // set while the configuration said otherwise.
    if (config.mode !== 'full') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message:
          `Sync runs a full sync only: mode "${config.mode}" is not implemented. ` +
          `Set mode to "full". The sync was not started, so it cannot replay the whole ` +
          `object set while you believed it was reading changes only.`,
      });
    }

    // There is no screen on which a conflict could be reviewed, and the
    // resolver answers `manual` with the source values — the same write as
    // source wins, under a name that promises a decision.
    if (config.conflictStrategy === 'manual') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conflictStrategy'],
        message:
          `Manual conflict review is not available: pick source wins, target wins, ` +
          `newest wins or merge. The sync was not started.`,
      });
    }
  });

/**
 * `file:save` — an export the user asked for.
 *
 * `content` is bounded because it crosses the bridge as a string: a runaway
 * export should be refused at the boundary rather than serialised twice and
 * handed to a dialog. 32 MB is far above any CSV this product produces and far
 * below anything that would trouble the host.
 */
export const fileSavePayloadSchema = z.object({
  suggestedName: z
    .string()
    .min(1)
    .max(255)
    // The dialog pre-fills this; a path separator in it would silently move
    // where the dialog opens.
    .refine((n) => !n.includes('/') && !n.includes('\\'), 'suggestedName must not contain a path'),
  content: z.string().max(32 * 1024 * 1024),
  extensions: z
    .array(z.string().regex(/^[A-Za-z0-9]+$/))
    .max(8)
    .optional(),
});

export const syncExecutePayloadSchema = z.object({ config: syncConfigPayloadSchema });
export const syncConfigSavePayloadSchema = z.object({ config: syncConfigPayloadSchema });
export const syncConfigIdPayloadSchema = z.object({ id: opaqueIdSchema });
export const syncDescribeGlobalPayloadSchema = z.object({ orgId: orgIdSchema });
export const syncDescribeFieldsPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
  objectApiName: sfApiNameSchema,
});

// ── realtime:* payload schemas ──────────────────────────────────────────────
// Mirror what `useCDCLiveStore`, `useConflictStore` and `RealTimeSyncPanel` post.

const conflictStrategyPayloadSchema = z.enum([
  'source_wins',
  'target_wins',
  'newest_wins',
  'manual',
  'merge',
]);

/** How the target record of a change is found: shared ids, an external id, or a saved mapping. */
const realtimeMatchPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('id') }),
  z.object({ kind: z.literal('externalId'), field: sfApiNameSchema }),
  z.object({ kind: z.literal('syncConfig'), configId: opaqueIdSchema }),
]);

/**
 * A session start. Only a watched object can be applied — a change is applied
 * because it was received — and a batch never exceeds what one sObject
 * Collections write takes.
 */
export const realtimeStartPayloadSchema = z
  .object({
    sourceOrgId: orgIdSchema,
    targetOrgId: orgIdSchema,
    watchedObjects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
    apply: z
      .array(
        z.object({
          objectApiName: sfApiNameSchema,
          match: realtimeMatchPayloadSchema,
          applyDeletes: z.boolean(),
        }),
      )
      .max(MAX_OBJECTS_PER_REQUEST),
    conflictStrategy: conflictStrategyPayloadSchema,
    flushIntervalMs: z.number().int().min(50).max(60_000),
    maxBatchSize: z.number().int().min(1).max(200),
  })
  .refine((p) => p.apply.every((a) => p.watchedObjects.includes(a.objectApiName)), {
    message: 'Every applied object must be watched.',
    path: ['apply'],
  });
export const realtimeStopPayloadSchema = z.object({ sessionId: z.string().max(200) });
export const realtimeObjectsPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
});
export const realtimeResolveConflictPayloadSchema = z.object({
  conflictId: z.string().min(1).max(500),
  eventReplayId: z.number().optional(),
  resolution: conflictStrategyPayloadSchema,
  fieldResolutions: z
    .record(
      z.string(),
      z.object({ value: z.unknown(), source: z.enum(['source', 'target', 'manual']) }),
    )
    .optional(),
});

// ── sync:history:* payload schemas ──────────────────────────────────────────
// Mirror what `useSyncHistoryStore` posts (fetchDetail/rerun/exportHistory).

export const syncHistoryEntryIdPayloadSchema = z.object({ entryId: opaqueIdSchema });
export const syncHistoryExportPayloadSchema = z.object({
  format: z.enum(['csv', 'json']),
  entryIds: z.array(opaqueIdSchema).max(500).optional(),
});

// ── sync:schedule:* payload schemas ─────────────────────────────────────────
// Mirror what `useSyncScheduleStore` / `SyncSchedulePanel` actually post.
// Runtime fields (nextRunAt/lastRunAt/lastResult) are computed extension-side
// by SyncScheduleExecutor, so the upsert payload must NOT carry them.

/**
 * Schedule entry as sent by the webview (Omit<SyncScheduleEntry, runtime fields>).
 * Unknown keys are stripped: `SyncScheduleExecutor.upsert` spreads the entry
 * into storage.
 */
export const syncScheduleEntryPayloadSchema = z
  .object({
    id: opaqueIdSchema,
    name: z.string().min(1).max(200),
    configId: opaqueIdSchema,
    // 5-field cron expression. Whether it reads, and falls due within the
    // coming year, is checked by SyncScheduleHandler before the upsert, which
    // refuses the schedule with the reason (see `nextCronRun`).
    cron: z.string().min(1).max(100),
    // IANA timezone string (e.g. "Europe/Paris").
    timezone: z.string().min(1).max(100),
    enabled: z.boolean(),
    maxRetries: z.number().int().min(0).max(10),
    notifyOnComplete: z.boolean(),
    notifyOnFailure: z.boolean(),
    createdAt: z.string().max(40),
    updatedAt: z.string().max(40),
    version: z.number().int().positive(),
  })
  .strip();

export const syncScheduleUpsertPayloadSchema = z.object({
  schedule: syncScheduleEntryPayloadSchema,
});
export const syncScheduleTogglePayloadSchema = z.object({
  scheduleId: opaqueIdSchema,
  enabled: z.boolean(),
});
export const syncScheduleIdPayloadSchema = z.object({ scheduleId: opaqueIdSchema });

// ── seed:* payload schemas ────────────────────────────────────────────────

/** Per-object seed config as sent by the webview (see sync note on batchSize). */
export const seedObjectPayloadSchema = seedObjectConfigSchema
  .extend({
    objectApiName: sfApiNameSchema,
    recordCount: z.number().int().positive().max(MAX_SEED_RECORDS_PER_OBJECT),
    batchSize: z.number().int().positive().max(MAX_BATCH_SIZE).optional(),
  })
  .passthrough();

/**
 * A relation as sent by the webview. Its names become query text when the
 * parents are read from the org, and so does its filter: both are held to the
 * rules the sync read applies here, and again where the query is built.
 */
export const seedRelationPayloadSchema = seedRelationSchema
  .extend({
    childObject: sfApiNameSchema,
    lookupField: sfApiNameSchema,
    parentObject: sfApiNameSchema,
  })
  .superRefine((relation, ctx) => {
    if (
      relation.parents.kind === 'existing' &&
      relation.parents.where !== undefined &&
      !isSafeSoqlWhere(relation.parents.where)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parents', 'where'],
        message: SOQL_WHERE_RULE,
      });
    }
  });

/** Seed template accepted by `seed:execute`. */
export const seedTemplatePayloadSchema = seedConfigSchema
  .extend({
    objects: z.array(seedObjectPayloadSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
    relations: z.array(seedRelationPayloadSchema).max(MAX_OBJECTS_PER_REQUEST).optional(),
  })
  .passthrough();

export const seedExecutePayloadSchema = z.object({
  orgId: orgIdSchema,
  template: seedTemplatePayloadSchema,
  /**
   * Accepted only so the request can be refused with DRY_RUN_UNSUPPORTED.
   *
   * Seed has no way to generate records without writing them, so a dry run
   * that was quietly downgraded to a real one wrote to the org. Dropping the
   * field from the schema would make such a payload INVALID_PAYLOAD, which
   * says nothing about why; keeping it lets the handler answer with the
   * reason. The response type carries no dry-run shape either.
   */
  dryRun: z.boolean().optional(),
});
export const seedDescribeGlobalPayloadSchema = z.object({ orgId: orgIdSchema });
export const seedDescribeObjectPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectApiName: sfApiNameSchema,
});
export const seedTemplateIdPayloadSchema = z.object({ id: opaqueIdSchema });
export const seedTemplateSavePayloadSchema = z.object({
  template: z.record(z.unknown()),
});
export const seedCreatePersonaPayloadSchema = z.object({
  // Empty descriptions stay legal here: the handler answers with a graceful
  // `success: false` response (existing webview flow) instead of INVALID_PAYLOAD.
  description: z.string().max(10_000),
});

// ── seed:clone:* payload schemas ────────────────────────────────────────────
// Mirror what `useClone` posts (describe-source / preview / execute).

/** Max cell/field value length accepted in clone/csv payloads. */
const MAX_FIELD_VALUE_LENGTH = 131_072; // SF long-text-area cap

/** Max rows accepted in a single CSV import (bounds memory + API usage). */
const MAX_CSV_ROWS = 50_000;

export const seedCloneObjectPayloadSchema = z
  .object({
    objectApiName: sfApiNameSchema,
    whereClause: whereClauseSchema.optional(),
  })
  .passthrough();

export const seedCloneDescribeSourcePayloadSchema = z.object({ sourceOrgId: orgIdSchema });

/**
 * Clone config as sent by the webview. `upsert` + `externalIdField` are
 * optional extensions (the current UI always inserts; the CLI shows the
 * upsert flow for re-runs against orgs with external Id fields).
 */
export const seedCloneExecutePayloadSchema = z
  .object({
    sourceOrgId: orgIdSchema,
    targetOrgId: orgIdSchema,
    objects: z.array(seedCloneObjectPayloadSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
    upsert: z.boolean().optional(),
    externalIdField: sfApiNameSchema.optional(),
  })
  .refine((data) => !data.upsert || data.externalIdField !== undefined, {
    message: 'externalIdField is required when upsert is true',
    path: ['externalIdField'],
  });

// ── seed:csv:* payload schemas ──────────────────────────────────────────────
// Mirror what `useCsvImport` posts (records pre-parsed by PapaParse webview-side).

export const csvColumnMappingPayloadSchema = z
  .object({
    csvHeader: z.string().min(1).max(500),
    // Empty string = column intentionally left unmapped (skipped on import).
    sfFieldApiName: z.string().max(80),
    sfFieldType: z.string().max(40),
    sfFieldLength: z.number().int().positive().nullable(),
  })
  .passthrough();

export const seedCsvPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectApiName: sfApiNameSchema,
  records: z
    .array(z.record(z.string().max(MAX_FIELD_VALUE_LENGTH)))
    .min(1)
    .max(MAX_CSV_ROWS),
  columnMappings: z.array(csvColumnMappingPayloadSchema).min(1).max(500),
  externalIdField: sfApiNameSchema.optional(),
});

// ── dataops:* / backup payload schemas ────────────────────────────────────

export const dataOpsBackupPayloadSchema = z.object({
  orgId: orgIdSchema,
  objects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
});
export const dataOpsBackupListPayloadSchema = z.object({
  orgId: orgIdSchema,
});
export const dataOpsBackupExportPayloadSchema = z.object({
  orgId: orgIdSchema,
  operationId: z.string().min(1).max(200),
});
export const dataOpsRollbackPayloadSchema = z.object({
  orgId: orgIdSchema,
  operationId: opaqueIdSchema,
});
export const dataOpsAnonymizePayloadSchema = z.object({
  orgId: orgIdSchema,
  templateId: opaqueIdSchema,
  objects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST).optional(),
});
/**
 * Rules the user saves as a template of their own: each an `Object.Field` and
 * a method a DataOps run applies with no setting (SAVED_TEMPLATE_METHODS), no
 * field twice.
 */
export const anonymizationTemplateSavePayloadSchema = z.object({
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX_LENGTH),
  rules: z
    .array(
      z.object({
        fieldPattern: z.string().max(170).regex(TEMPLATE_FIELD_PATTERN, 'Expected Object.Field'),
        ruleType: z.enum(SAVED_TEMPLATE_METHODS),
      }),
    )
    .min(1)
    .max(TEMPLATE_MAX_RULES)
    .refine(
      (rules) => new Set(rules.map((r) => r.fieldPattern.toLowerCase())).size === rules.length,
      'A field has two rules',
    ),
});
export const anonymizationTemplateDeletePayloadSchema = z.object({ templateId: opaqueIdSchema });
export const piiScanPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectNames: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
});
/**
 * `dataops:quality-scan`: a few objects, each at most once, a duplicate key
 * each may name, and the staleness threshold in whole days. Both names reach
 * SOQL text, so both are held to the API-name shape here.
 */
export const dataOpsQualityScanPayloadSchema = z.object({
  orgId: orgIdSchema,
  objects: z
    .array(
      z.object({
        objectApiName: sfApiNameSchema,
        duplicateKey: sfApiNameSchema.optional(),
      }),
    )
    .min(1)
    .max(QUALITY_SCAN_MAX_OBJECTS)
    .refine(
      (objects) =>
        new Set(objects.map((o) => o.objectApiName.toLowerCase())).size === objects.length,
      { message: 'Each object may be named once per scan' },
    ),
  staleDays: z.number().int().min(1).max(QUALITY_SCAN_MAX_STALE_DAYS),
});

/** A few objects, each named once: what an inventory or a subject search reads. */
const complianceObjectsSchema = z
  .array(sfApiNameSchema)
  .min(1)
  .max(COMPLIANCE_MAX_OBJECTS)
  .refine((objects) => new Set(objects.map((o) => o.toLowerCase())).size === objects.length, {
    message: 'Each object may be named once per request',
  });

/** `dataops:pii-inventory`: the objects whose personal data to list. */
export const dataOpsPiiInventoryPayloadSchema = z.object({
  orgId: orgIdSchema,
  objects: complianceObjectsSchema,
});

/**
 * `dataops:dsr:search`: at least one identifier, each held to the rule the
 * page offers it under. All three reach SOQL text — escaped there — so their
 * shape is checked here too.
 */
export const dataOpsSubjectSearchPayloadSchema = z
  .object({
    orgId: orgIdSchema,
    objects: complianceObjectsSchema,
    requestId: z.string().uuid().optional(),
    email: z.string().trim().refine(isSubjectEmail, 'Not an email address').optional(),
    name: z.string().refine(isSubjectName, 'Not a name').optional(),
    phone: z.string().refine(isSubjectPhone, 'Not a phone number').optional(),
  })
  .refine((p) => p.email !== undefined || p.name !== undefined || p.phone !== undefined, {
    message: 'A search needs an email address, a name or a phone number',
  });

/** A request the local log holds, on one org. */
export const dataOpsSubjectRequestPayloadSchema = z.object({
  orgId: orgIdSchema,
  requestId: z.string().uuid(),
});

/** A Salesforce record Id, 15 or 18 characters. */
const recordIdSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'Not a record Id');

/** `dataops:dsr:erase`: records of the request, per object, and how to erase them. */
export const dataOpsSubjectErasePayloadSchema = dataOpsSubjectRequestPayloadSchema.extend({
  mode: z.enum(['anonymize', 'delete']),
  records: z
    .array(
      z.object({
        objectApiName: sfApiNameSchema,
        ids: z.array(recordIdSchema).min(1).max(SUBJECT_SEARCH_LIMIT),
      }),
    )
    .min(1)
    .max(COMPLIANCE_MAX_OBJECTS)
    .refine(
      (records) =>
        new Set(records.map((r) => r.objectApiName.toLowerCase())).size === records.length,
      { message: 'Each object may be named once per request' },
    ),
  dryRun: z.boolean(),
});

/** A cleanup recommendation, as the page names one. */
const cleanupRecommendationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stale'),
    days: z.number().int().min(1).max(QUALITY_SCAN_MAX_STALE_DAYS),
  }),
  z.object({ kind: z.literal('orphans'), fieldApiName: sfApiNameSchema }),
  z.object({ kind: z.literal('duplicates'), keyField: sfApiNameSchema }),
]);

/** `dataops:cleanup:export`: the records one recommendation names. */
export const dataOpsCleanupExportPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectApiName: sfApiNameSchema,
  recommendation: cleanupRecommendationSchema,
});

/** `dataops:cleanup:delete`: the same, and whether to delete or only say what would go. */
export const dataOpsCleanupDeletePayloadSchema = dataOpsCleanupExportPayloadSchema.extend({
  dryRun: z.boolean(),
});

// ── monitor:* payload schemas ─────────────────────────────────────────────

export const monitorOrgPayloadSchema = z.object({ orgId: orgIdSchema });
/**
 * `monitor:open-apex-jobs`: an org id and nothing else. Strict, because the
 * address opened is built from the org's stored instance URL; a `url` or
 * `path` sent by a page is refused, never read.
 */
export const monitorOpenApexJobsPayloadSchema = z.object({ orgId: orgIdSchema }).strict();
export const monitorAlertIdPayloadSchema = z.object({ alertId: opaqueIdSchema });

// ── compare:* payload schemas ─────────────────────────────────────────────

export const compareOrgsPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
});
export const compareExecutePayloadSchema = compareOrgsPayloadSchema.extend({
  types: z.array(z.string().min(1).max(80)).min(1).max(50),
  /** False leaves out what a managed package installed; absent compares it. */
  includeManaged: z.boolean().optional(),
});

/**
 * A component a deployment is asked to carry. Only a type a deployment
 * carries passes (a profile, a permission set or a name that is no Metadata
 * API type is refused); its name as listMetadata gave it, with no control
 * character — it goes into the package manifest the source is asked for.
 */
const deploymentComponentSchema = z.object({
  componentType: z.enum(DEPLOYABLE_COMPONENT_TYPES),
  fullName: z
    .string()
    .min(1)
    .max(400)
    // eslint-disable-next-line no-control-regex -- the control characters are what is refused.
    .regex(/^[^\u0000-\u001f\u007f]+$/, 'A component name holds no control character'),
});

/** `compare:validate-deployment`: what to retrieve from the source, and the tests to run in the target. */
export const compareValidateDeploymentPayloadSchema = compareOrgsPayloadSchema
  .extend({
    components: z
      .array(deploymentComponentSchema)
      .min(1)
      .max(DEPLOY_MAX_COMPONENTS)
      .refine(
        (components) =>
          new Set(components.map((c) => `${c.componentType}:${c.fullName}`)).size ===
          components.length,
        { message: 'Each component may be named once per deployment' },
      ),
    testLevel: z.enum(DEPLOY_TEST_LEVELS),
    runTests: z
      .array(z.string().max(255).regex(DEPLOY_TEST_NAME_PATTERN, 'Not an Apex class name'))
      .max(DEPLOY_MAX_TESTS)
      .optional(),
  })
  .refine((p) => p.sourceOrgId !== p.targetOrgId, {
    message: 'The source and the target are the same org',
    path: ['targetOrgId'],
  })
  .refine((p) => p.testLevel !== 'RunSpecifiedTests' || (p.runTests?.length ?? 0) > 0, {
    message: 'RunSpecifiedTests names at least one test class',
    path: ['runTests'],
  });

/**
 * `compare:deploy`: the validation to deploy and the org it was run in.
 * Strict: what is deployed is the package the extension kept from that
 * validation, so a page that sends components or options is refused.
 */
export const compareDeployPayloadSchema = z
  .object({
    validationId: z
      .string()
      .regex(/^0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/, 'Not a deployment id'),
    targetOrgId: orgIdSchema,
  })
  .strict();

// ── frozen:* payload schemas ──────────────────────────────────────────────
// Mirror the FrozenProjectConfig DTO (shared/types/frozen.types.ts). Every
// list is bounded; SOQL fragments reuse the where-clause keyword guard.

/** Semver string (dataset / rules versions). */
const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'Invalid semver');

/** `Object.field` key used by placeholder/default/picklist rule maps. */
const objectFieldKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/, 'Expected an Object.field key')
  .max(170);

export const frozenCoverageAxisPayloadSchema = z.object({
  name: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  filterField: sfApiNameSchema,
  // Aggregate SOQL enumerating axis values (SELECT ... AS axisValue). Bounded;
  // DML keywords are rejected by the extractor's read-only query path.
  valuesSoql: z.string().min(1).max(4000),
});

export const frozenEdgeCasePayloadSchema = z.object({
  name: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  whereFragment: whereClauseSchema,
});

export const frozenPicklistRulePayloadSchema = z.union([
  z.object({ action: z.literal('clear') }),
  z.object({ action: z.literal('replace'), value: z.string().max(255) }),
]);

export const frozenProjectConfigPayloadSchema = z.object({
  rootObject: sfApiNameSchema,
  axes: z.array(frozenCoverageAxisPayloadSchema).max(20),
  edgeCases: z.array(frozenEdgeCasePayloadSchema).max(50),
  budgetMaxRecords: z.number().int().positive().max(100_000).optional(),
  candidatesPerCombination: z.number().int().positive().max(20).optional(),
  expectedObjects: z.array(sfApiNameSchema).max(100).optional(),
  // Same bounds as Forge's cap: the two drive the same discovery.
  maxNodes: z.number().int().min(10).max(500).optional(),
  excludedObjects: z.array(sfApiNameSchema).max(200).optional(),
  excludedFields: z.record(sfApiNameSchema, z.array(sfApiNameSchema).max(500)).optional(),
  sasDir: z.string().min(1).max(500).optional(),
  datasetDir: z.string().min(1).max(500).optional(),
  rulesFilePath: z.string().min(1).max(500).optional(),
  datasetVersion: semverSchema.optional(),
  protectedOrgIds: z.array(orgIdSchema).max(50).optional(),
  identityKeys: z.record(sfApiNameSchema, z.array(sfApiNameSchema).min(1).max(10)).optional(),
  undeletableObjects: z.record(sfApiNameSchema, sfApiNameSchema).optional(),
  requiredLookupPlaceholders: z
    .record(
      objectFieldKeySchema,
      z.object({
        name: z.string().min(1).max(200),
        recordTypeDeveloperName: z.string().min(1).max(80).optional(),
        targetObjectApiName: sfApiNameSchema.optional(),
      }),
    )
    .optional(),
  requiredFieldDefaults: z.record(objectFieldKeySchema, z.unknown()).optional(),
  picklistRules: z.record(objectFieldKeySchema, frozenPicklistRulePayloadSchema).optional(),
  defaultPicklistRule: frozenPicklistRulePayloadSchema.optional(),
  duplicateErrorPatterns: z.array(z.string().min(1).max(200)).max(50).optional(),
  mockDetection: z
    .object({
      metadataTypeApiName: sfApiNameSchema,
      isMockedFieldApiName: sfApiNameSchema,
    })
    .optional(),
  mandatoryLookups: z.record(sfApiNameSchema, z.array(sfApiNameSchema).min(1).max(50)).optional(),
  presenceKeys: z.record(sfApiNameSchema, sfApiNameSchema).optional(),
});

export const frozenConfigSavePayloadSchema = z.object({
  config: frozenProjectConfigPayloadSchema,
});
export const frozenSelectPayloadSchema = z.object({ sourceOrgId: orgIdSchema });
export const frozenExtractPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  author: z.string().min(1).max(120).optional(),
});
export const frozenLoadPayloadSchema = z.object({
  targetOrgId: orgIdSchema,
  pilot: z.boolean().optional(),
  reload: z.boolean().optional(),
});
export const frozenVerifyPayloadSchema = z.object({ targetOrgId: orgIdSchema });
// The load is named — its org, when it wrote its last record — never its
// records: what is removed is what the sas mapping says the load created.
export const frozenRemovePayloadSchema = z.object({
  targetOrgId: orgIdSchema,
  loadedAt: z.string().min(1).max(64),
  includeChanged: z.boolean().optional(),
});

// ── autopilot:* payload schemas ─────────────────────────────────────────────
// Mirror the shared request contracts (shared/types/messages/autopilot.messages.ts).
// Fields the handler never reads stay optional so a partial payload that used
// to work keeps working; every field the handler consumes is validated.

/** Scan request: both orgs, optional explicit object selection (empty = auto-detect). */
export const autopilotScanSchemaPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
  selectedObjects: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST),
  includeStandardObjects: z.boolean(),
});

/** Plan request: the framework is the only field the handler consumes. */
export const autopilotGeneratePlanPayloadSchema = z.object({
  complianceFramework: complianceFrameworkTypeSchema,
  maxRecordsPerObject: z.number().int().nonnegative().max(MAX_SEED_RECORDS_PER_OBJECT).optional(),
  objectFilters: z.record(whereClauseSchema).optional(),
  overrides: z
    .array(
      z.object({
        objectApiName: sfApiNameSchema,
        fieldApiName: sfApiNameSchema,
        method: z.union([anonymizationMethodSchema, z.literal('skip')]),
      }),
    )
    .max(500)
    .optional(),
});

/** Execute request: 0 disables the grappe threshold (handler acts on truthy values only). */
export const autopilotExecutePayloadSchema = z.object({
  grappeThreshold: z.number().int().nonnegative(),
});

export const autopilotSkipNodePayloadSchema = z.object({
  objectApiName: sfApiNameSchema,
});

// ── quicksync:* payload schemas ─────────────────────────────────────────────
// Mirror what the QuickSync webview flow posts (useQuickSyncFlow,
// QuickSyncObjectStep). The canonical shapes are the ones the handler consumes
// (`orgId` / `objectApiName` / `{ config }`); the earlier flat spellings
// (`sourceOrgId`, top-level execute fields) stay accepted so no previously
// working payload breaks — the schema bounds types and sizes without picking
// a side.

export const quickSyncSuggestObjectsPayloadSchema = z
  .object({
    orgId: orgIdSchema.optional(),
    sourceOrgId: orgIdSchema.optional(),
    alreadySelected: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST).optional(),
  })
  .passthrough();

export const quickSyncDetectRelationshipsPayloadSchema = z
  .object({
    orgId: orgIdSchema.optional(),
    sourceOrgId: orgIdSchema.optional(),
    objectApiName: sfApiNameSchema.optional(),
    alreadySelected: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST).optional(),
    selectedObjects: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST).optional(),
    availableObjects: z.array(sfApiNameSchema).max(500).optional(),
  })
  .passthrough();

export const quickSyncPreviewPayloadSchema = z
  .object({
    sourceOrgId: orgIdSchema,
    // Sent by the webview flow; not consumed by the handler today.
    targetOrgId: orgIdSchema.optional(),
    selectedObjects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
    parentObjects: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST).optional(),
  })
  .passthrough();

/** Quick Sync config as sent inside `quicksync:execute` (`{ config }`). */
export const quickSyncConfigPayloadSchema = QuickSyncConfigSchema.extend({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
  selectedObjects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
  parentObjects: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST).default([]),
}).passthrough();

export const quickSyncExecutePayloadSchema = z
  .object({
    config: quickSyncConfigPayloadSchema.optional(),
    // Legacy flat shape previously posted by the webview flow
    // (useQuickSyncFlow). The handler only reads `config`; the flat fields
    // stay accepted (and ignored) so old payloads are not rejected outright.
    sourceOrgId: orgIdSchema.optional(),
    targetOrgId: orgIdSchema.optional(),
    selectedObjects: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST).optional(),
    parentObjects: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST).optional(),
  })
  .passthrough();

// ── ai:* payload schemas ──────────────────────────────────────────────────
// Mirror what AIPage / useAIFeatures / BridgeProvider / useSeedNL2SOQL post.

/** Bounded free-text prompt sent to the AI provider. */
const aiPromptSchema = z.string().min(1).max(50_000);

export const aiChatPayloadSchema = z.object({
  conversationId: opaqueIdSchema,
  // Empty messages stay legal (the webview input guards them) — bound only.
  message: z.string().max(50_000),
});
export const aiConversationCreatePayloadSchema = z.object({
  title: z.string().min(1).max(300),
});
export const aiConversationIdPayloadSchema = z.object({ conversationId: opaqueIdSchema });
export const aiSaveKeyPayloadSchema = z.object({
  apiKey: z.string().min(1).max(500),
});

export const aiAnomalyScanPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectName: sfApiNameSchema,
  sampleSize: z.number().int().positive().max(10_000).optional(),
});
export const aiSchemaAdvicePayloadSchema = z.object({
  orgId: orgIdSchema,
  objectNames: z.array(sfApiNameSchema).max(MAX_OBJECTS_PER_REQUEST).optional(),
});

export const aiNl2SoqlPayloadSchema = z.object({
  query: z.string().min(1).max(2_000),
  orgId: orgIdSchema,
});
/**
 * Forge's AI tab: a description to draft from, or a query the user edited to
 * check again — one or the other. The query bound is the one Forge's own
 * config puts on `soqlQuery`.
 */
export const aiForgePlanPayloadSchema = z
  .object({
    orgId: orgIdSchema,
    prompt: z.string().trim().min(1).max(2_000).optional(),
    soql: z.string().trim().min(1).max(20_000).optional(),
  })
  .refine((p) => (p.prompt === undefined) !== (p.soql === undefined), {
    message: 'Send a prompt to draft from or a query to check, not both and not neither',
  });
export const aiGeneratePipelinePayloadSchema = z.object({
  description: aiPromptSchema,
  orgIds: z.array(orgIdSchema).max(50).optional(),
});

// ── migration:* payload schemas ───────────────────────────────────────────
// Mirror the shared request contracts (no current webview emitter). The
// handler re-validates the path against traversal after parsing.

export const migrationImportPayloadSchema = z.object({
  filePath: z.string().min(1).max(2_000),
  format: z.string().max(50).optional(),
});
export const migrationImportSfdmuPayloadSchema = z.object({
  filePath: z.string().min(1).max(2_000),
});

// ── execution:* payload schemas ───────────────────────────────────────────
// `execution:abort` is posted with `{ operationId }` by the Seed page, and was
// also posted as `{ executionId, objectName }` by the retry surface the
// webview no longer carries — both shapes stay accepted.

export const executionAbortPayloadSchema = z
  .object({
    operationId: opaqueIdSchema.optional(),
    executionId: opaqueIdSchema.optional(),
    objectName: z.string().min(1).max(200).optional(),
  })
  .passthrough();

// ── governance:* payload schemas ──────────────────────────────────────────
// Mirror what GovernancePanel posts. `policy` is deep-validated by
// GovernancePolicySchema inside the handler (VALIDATION_ERROR path) — here we
// only require an object.

export const governancePolicyIdPayloadSchema = z.object({ policyId: opaqueIdSchema });
export const governancePolicySavePayloadSchema = z.object({
  policy: z.record(z.unknown()),
});
export const governanceEvaluatePayloadSchema = z.object({
  policyId: opaqueIdSchema,
  orgId: orgIdSchema,
});

// ── reports:* payload schemas ─────────────────────────────────────────────
// Mirror what ReportsContainer posts. Both payloads are optional: a request
// with none asks for the newest page, or for the latest lineage.

export const reportsAuditPayloadSchema = z
  .object({
    module: z.string().min(1).max(50).optional(),
    orgId: orgIdSchema.optional(),
    // Nothing past what the trail keeps is worth asking for.
    offset: z.number().int().min(0).max(AUDIT_TRAIL_LIMIT).optional(),
    limit: z.number().int().min(1).max(AUDIT_TRAIL_LIMIT).optional(),
  })
  .optional();
export const reportsLineagePayloadSchema = z
  .object({ operationId: opaqueIdSchema.optional() })
  .optional();

// ── config:* payload schemas ──────────────────────────────────────────────
// Mirror what ConfigProfilePanel posts.

/** Config profile categories (mirrors ConfigCategory in ConfigProfileManager). */
export const configCategorySchema = z.enum([
  'syncMappings',
  'forgePlans',
  'pipelines',
  'anonymizationTemplates',
]);

export const configExportPayloadSchema = z.object({
  categories: z.array(configCategorySchema).min(1).max(50),
});
export const configImportPayloadSchema = z.object({
  json: z.string().min(1).max(5_000_000),
  overwrite: z.boolean(),
});
export const configValidatePayloadSchema = z.object({
  json: z.string().min(1).max(5_000_000),
});

// ── org:* payload schemas ─────────────────────────────────────────────────
// Mirror what OrgManagerPage posts. `authMethod` stays a bounded string (not
// an enum): the handler has an explicit default branch that warns on
// not-yet-supported methods — rejecting them here would lose that UX.

export const orgConnectPayloadSchema = z
  .object({
    // The webview sends '' for fresh connections (no org id yet).
    orgId: z.string().max(128),
    authMethod: z.string().min(1).max(50),
    alias: z.string().max(100).optional(),
    loginUrl: z.string().max(500).optional(),
    username: z.string().max(300).optional(),
    password: z.string().max(500).optional(),
    securityToken: z.string().max(100).optional(),
    clientId: z.string().max(256).optional(),
    jwtKeyFile: z.string().max(4096).optional(),
  })
  .passthrough();

/**
 * An alias the CLI is given: letters, digits, dots, dashes and underscores, as
 * `SfdxBridge.loginWeb` already requires. Empty means none.
 */
const cliAliasSchema = z
  .string()
  .trim()
  .max(100)
  .regex(/^[\w.-]*$/, 'an alias is letters, digits, dots, dashes and underscores')
  .optional();

/**
 * A Salesforce username, in the character set `refreshTokenViaCli` accepts:
 * an org signed in under any other could never have its session refreshed.
 */
const sfUsernameSchema = z
  .string()
  .trim()
  .min(1, 'the username is required')
  .max(80)
  .regex(/^[\w.@+-]+$/, 'a username is written like an email address');

/**
 * A consumer key (client id), in the character set the CLI accepts for one in
 * an SFDX authorization URL.
 */
const consumerKeySchema = z
  .string()
  .trim()
  .min(1, 'the consumer key is required')
  .max(256)
  .regex(
    /^[A-Za-z0-9._-]+={0,2}$/,
    'a consumer key is letters, digits, dots, dashes and underscores',
  );

/**
 * The private key's location, as a path: absolute, since the CLI would resolve
 * a relative one against the extension host's working directory, which the
 * user never chose.
 */
const keyFilePathSchema = z
  .string()
  .trim()
  .min(1, 'the private key file is required')
  .max(4096)
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'the private key file path holds a control character')
  .refine((keyFile) => isAbsolute(keyFile), 'give the private key file as an absolute path');

/**
 * What a JWT bearer sign-in reads from `org:connect`. The key file is a path
 * for `sf org login jwt`; SandForge never opens it.
 */
export const orgJwtConnectPayloadSchema = z
  .object({
    alias: cliAliasSchema,
    loginUrl: z.string().max(500).optional(),
    username: sfUsernameSchema,
    clientId: consumerKeySchema,
    jwtKeyFile: keyFilePathSchema,
  })
  .passthrough();

/** What a device-flow sign-in reads from `org:connect`: the app and the login host. */
export const orgDeviceConnectPayloadSchema = z
  .object({
    alias: cliAliasSchema,
    loginUrl: z.string().max(500).optional(),
    clientId: consumerKeySchema,
  })
  .passthrough();

/** Stop the sign-in the `org:connect` request `requestId` is waiting on. */
export const orgConnectCancelPayloadSchema = z.object({ requestId: opaqueIdSchema });
export const orgDisconnectPayloadSchema = z.object({ orgId: orgIdSchema });
export const orgSelectPayloadSchema = z.object({ orgId: orgIdSchema });
/**
 * What the org edit dialog saves. The colour is one of the dialog's hex
 * swatches and each tag a trimmed word; the bounds keep a crafted payload from
 * bloating the registry every activation loads. Any other key — a safety tier
 * included — is dropped, not stored.
 */
export const orgUpdatePayloadSchema = z.object({
  orgId: orgIdSchema,
  alias: z.string().trim().min(1).max(100),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
});

// ── settings:* / onboarding / plugins / telemetry payload schemas ──────────
// Mirror what useSettingsPageData posts; plugins/telemetry/hint follow the
// shared request contracts (no current webview emitter).

export const settingsUpdatePayloadSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
});
export const telemetryTogglePayloadSchema = z.object({ enabled: z.boolean() });

// ── i18n:* payload schemas ────────────────────────────────────────────────

/**
 * Locale bundle request (lazy i18n loading). The enum is the strict locale
 * whitelist — the handler joins `<lng>.json` onto the packaged locales
 * directory, so arbitrary/path-traversal codes must never parse.
 */
export const i18nLocalePayloadSchema = z.object({
  lng: z.enum(['en', 'fr', 'de', 'es', 'ja', 'pt-BR']),
});

// ── smart-action:* payload schemas ──────────────────────────────────────────
// Mirror what useSmartAction posts.

export const smartActionAnalyzePayloadSchema = z.object({
  targetOrgId: orgIdSchema,
  sourceOrgId: orgIdSchema.optional(),
});

// ── automation:* (pipeline / operation / marketplace) payload schemas ──────
// Mirror what useAutomationPageData / MonitorPage post.

export const pipelineRunPayloadSchema = z.object({
  pipeline: z
    .object({
      name: z.string().min(1).max(200),
      // A step saved without a config has none to read; it is read as empty.
      steps: z
        .array(z.object({ config: z.record(z.unknown()).default({}) }).passthrough())
        .max(200),
      // A definition that carries no variables or no triggers — one written
      // by hand, drafted elsewhere, or saved before they existed — declares
      // none. Both were iterated as they came, so their absence failed the
      // run on `pipeline:error` with "pipeline.variables is not iterable".
      variables: z.array(z.record(z.unknown())).max(200).default([]),
      triggers: z.array(z.record(z.unknown())).max(50).default([]),
    })
    .passthrough(),
  variables: z.record(z.string().max(2_000)).optional(),
});
/**
 * A pipeline `pipeline:save` stored, read back to be started by a trigger: the
 * definition a run from the page is read as, and the id it was saved under.
 * The save keeps whatever the page sent, so what comes back is read again.
 */
export const savedPipelineSchema = pipelineRunPayloadSchema.shape.pipeline.extend({
  id: z.string().min(1).max(200),
});
export const pipelineSavePayloadSchema = z.object({
  // Empty id stays legal: the handler falls back to crypto.randomUUID().
  id: z.string().max(200),
  config: z.record(z.unknown()),
});
export const marketplaceListPayloadSchema = z
  .object({
    category: z.string().max(100).optional(),
    query: z.string().max(500).optional(),
  })
  .passthrough()
  .optional();
export const marketplaceInstallPayloadSchema = z.object({ templateId: opaqueIdSchema });

/**
 * Validate a webview message payload against a zod schema. Returns parsed
 * data on success; on failure, posts a handler error and returns null so
 * the caller can early-return. Defense-in-depth against compromised webview.
 *
 * @param schema - Zod schema describing the expected payload.
 * @param msg - The request whose payload is validated (its origin, if it fails).
 * @param responseType - Error message type to post back on failure.
 * @param deps - Handler dependencies (log, broker, nextId).
 */
export function validatePayload<T>(
  schema: z.ZodSchema<T>,
  msg: InboundRequest & { readonly payload?: unknown },
  responseType: string,
  deps: Pick<HandlerDeps, 'log' | 'broker' | 'nextId'>,
): T | null {
  const result = schema.safeParse(msg.payload);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    sendHandlerError(deps, msg.type, responseType, msg, new Error(`Invalid payload — ${summary}`), {
      code: 'INVALID_PAYLOAD',
    });
    return null;
  }
  return result.data;
}
