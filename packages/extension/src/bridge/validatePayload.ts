import {
  syncConfigSchema,
  syncObjectConfigSchema,
  seedConfigSchema,
  seedObjectConfigSchema,
  complianceFrameworkTypeSchema,
  anonymizationMethodSchema,
  QuickSyncConfigSchema,
} from '@sandforge/shared';
import { z } from 'zod';
import type { HandlerDeps, InboundRequest } from './handlers/HandlerTypes.js';
import { sendHandlerError } from './handlers/HandlerTypes.js';

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
 * extra keys the webview legitimately sends (config `id`, `createdAt`, …).
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
 * Free-text SOQL WHERE fragment. Subqueries and DML keywords are rejected at
 * validation time — the same filter is re-applied at query build time in
 * `SyncOpsHandler` (defense-in-depth, both layers stay).
 */
export const whereClauseSchema = z
  .string()
  .max(2000)
  .refine(
    (where) => {
      const upper = where.toUpperCase();
      return !(
        /\bSELECT\b/.test(upper) ||
        /\bINSERT\b/.test(upper) ||
        /\bUPDATE\b/.test(upper) ||
        /\bDELETE\b/.test(upper)
      );
    },
    {
      message:
        'WHERE clause contains forbidden keyword (SELECT/INSERT/UPDATE/DELETE). Subqueries are not allowed.',
    },
  );

/** Max objects accepted per data operation (bounds API-call fan-out per request). */
const MAX_OBJECTS_PER_REQUEST = 100;

/** Max records a single seed object may generate (bounds memory + API usage). */
const MAX_SEED_RECORDS_PER_OBJECT = 1_000_000;

/** Max batch size accepted from the webview (matches manifest caps). */
const MAX_BATCH_SIZE = 10_000;

// ── sync:* payload schemas ────────────────────────────────────────────────

/**
 * Per-object sync config as sent by the webview. `batchSize` is made optional
 * so the handler can fall back to the `sandforge.sync.defaultBatchSize`
 * setting (the shared schema hard-codes 200 otherwise).
 */
export const syncObjectPayloadSchema = syncObjectConfigSchema
  .extend({
    objectApiName: sfApiNameSchema,
    where: whereClauseSchema.optional(),
    batchSize: z.number().int().positive().max(MAX_BATCH_SIZE).optional(),
  })
  .passthrough();

/** Sync config accepted by `sync:execute` / `sync:config:save`. */
export const syncConfigPayloadSchema = syncConfigSchema
  .extend({
    sourceOrgId: orgIdSchema,
    targetOrgId: orgIdSchema,
    objects: z.array(syncObjectPayloadSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
  })
  .passthrough();

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

/** Schedule entry as sent by the webview (Omit<SyncScheduleEntry, runtime fields>). */
export const syncScheduleEntryPayloadSchema = z
  .object({
    id: opaqueIdSchema,
    name: z.string().min(1).max(200),
    configId: opaqueIdSchema,
    // 5-field cron expression; syntax is validated by cron-parser at upsert
    // time (SyncScheduleExecutor logs and yields an empty nextRunAt on error).
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
  .passthrough();

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

/** Seed template accepted by `seed:execute`. */
export const seedTemplatePayloadSchema = seedConfigSchema
  .extend({
    objects: z.array(seedObjectPayloadSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
  })
  .passthrough();

export const seedExecutePayloadSchema = z.object({
  orgId: orgIdSchema,
  template: seedTemplatePayloadSchema,
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
export const dataOpsMaskingTemplatesPayloadSchema = z.object({
  objectApiName: sfApiNameSchema,
});
export const piiScanPayloadSchema = z.object({
  orgId: orgIdSchema,
  objectNames: z.array(sfApiNameSchema).min(1).max(MAX_OBJECTS_PER_REQUEST),
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
});

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
export const aiResolveErrorPayloadSchema = z.object({
  errorMessage: z.string().min(1).max(10_000),
  errorCode: z.string().max(100).optional(),
  module: z.string().min(1).max(50),
  context: z.record(z.unknown()).optional(),
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
// Mirror what useRetryManager / ErrorRecoveryPanel post. NOTE: useRetryManager
// sends `{ executionId, objectName }` for execution:abort where the handler
// reads `operationId` (pre-existing mismatch) — both stay accepted.

export const executionAbortPayloadSchema = z
  .object({
    operationId: opaqueIdSchema.optional(),
    executionId: opaqueIdSchema.optional(),
    objectName: z.string().min(1).max(200).optional(),
  })
  .passthrough();
export const executionStatusPayloadSchema = z.object({ operationId: opaqueIdSchema });
export const executionManualRetryPayloadSchema = z.object({
  executionId: opaqueIdSchema,
  objectName: z.string().min(1).max(200),
});

// ── governance:* payload schemas ──────────────────────────────────────────
// Mirror what GovernancePanel posts. `policy` is deep-validated by
// GovernancePolicySchema inside the handler (VALIDATION_ERROR path) — here we
// only require an object.

export const governancePolicyIdPayloadSchema = z.object({ policyId: opaqueIdSchema });
export const governancePolicySavePayloadSchema = z.object({
  policy: z.record(z.unknown()),
});
export const governancePoliciesImportPayloadSchema = z.object({
  json: z.string().min(1).max(5_000_000),
});
export const governanceEvaluatePayloadSchema = z.object({
  policyId: opaqueIdSchema,
  orgId: orgIdSchema,
});

// ── config:* payload schemas ──────────────────────────────────────────────
// Mirror what ConfigProfilePanel posts.

/** Config profile categories (mirrors ConfigCategory in ConfigProfileManager). */
export const configCategorySchema = z.enum([
  'syncMappings',
  'forgePlans',
  'pipelines',
  'anonymizationTemplates',
  'settings',
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
  })
  .passthrough();
export const orgDisconnectPayloadSchema = z.object({ orgId: orgIdSchema });
export const orgSelectPayloadSchema = z.object({ orgId: orgIdSchema });

// ── settings:* / onboarding / plugins / telemetry payload schemas ──────────
// Mirror what useSettingsPageData posts; plugins/telemetry/hint follow the
// shared request contracts (no current webview emitter).

export const settingsUpdatePayloadSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.unknown(),
});
export const hintDismissPayloadSchema = z.object({ hintId: opaqueIdSchema });
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
      steps: z.array(z.record(z.unknown())).max(200),
    })
    .passthrough(),
  variables: z.record(z.string().max(2_000)).optional(),
});
export const pipelineSavePayloadSchema = z.object({
  // Empty id stays legal: the handler falls back to crypto.randomUUID().
  id: z.string().max(200),
  config: z.record(z.unknown()),
});
export const operationIdPayloadSchema = z.object({ operationId: opaqueIdSchema });
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
