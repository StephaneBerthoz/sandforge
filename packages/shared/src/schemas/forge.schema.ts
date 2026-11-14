import * as z from 'zod';
import { anonymizationMethodSchema } from './autopilot.schema.js';
import { FILE_COPY_CEILING_MB } from '../constants/file-copy.js';
import { forgeGapParts } from '../utils/forge-gaps.js';
import { FORGE_ROOTS_MAX } from '../utils/forge-run-gate.js';
import {
  soqlRootIssueWords,
  soqlRootQueryIssue,
  soqlWhereFragmentSchema,
} from '../utils/soqlRoot.js';
import type {
  ForgeConfig,
  ForgeFileCopyOption,
  ForgeLeftOutReason,
  ForgeQueryScope,
  ForgeSampleOptions,
  ForgeSampleWindow,
} from '../types/forge.types.js';

// ─── Enum Schemas ────────────────────────────────────────────────────────────

/** Zod schema for ForgeInputMode enum */
export const forgeInputModeSchema = z.enum(['record', 'soql', 'template', 'ai', 'org']);

/**
 * Zod schema for ForgeTraversalDepth: how far discovery walks from a root,
 * never `all`, which walks from none: what a template and the panel's walks
 * hold. A forge resource of `sandforge.yaml` takes `all` too, by
 * {@link forgeRunDepthSchema}, the clone of the whole org going there with no
 * record, no table and no template.
 */
export const forgeDepthSchema = z.enum(['direct', 'full', 'custom']);

/** Zod schema for ForgeDepth: a run's depth, the walks above or `all`, the whole org. */
export const forgeRunDepthSchema = z.enum(['direct', 'full', 'custom', 'all']);

/** Zod schema for ForgeNodeStatus enum */
export const forgeNodeStatusSchema = z.enum([
  'idle',
  'scanning',
  'running',
  'done',
  'error',
  'skipped',
  'stopped',
]);

/** Zod schema for ForgeGraphView, the `sandforge.forge.graphView` setting */
export const forgeGraphViewSchema = z.enum(['auto', 'graph', 'table']);

/** Zod schema for ForgeGraphEdge relationship type */
export const forgeEdgeTypeSchema = z.enum(['master-detail', 'lookup']);

/** Zod schema for ForgeBatchStrategy */
export const forgeBatchStrategySchema = z.enum(['rest', 'bulk', 'auto']);

/** Zod schema for ForgeAnonymizationCategory */
export const forgeAnonymizationCategorySchema = z.enum([
  'email',
  'phone',
  'name',
  'address',
  'ssn_id',
  'financial',
  'other',
]);

/** Zod schema for ForgeCycleStrategy */
export const forgeCycleStrategySchema = z.enum([
  'two_pass',
  'upsert_external_id',
  'nullable_lookup',
  'unbreakable',
]);

// ─── Config Schema ──────────────────────────────────────────────────────────

/** Strict Salesforce record/object ID — 15 or 18 alphanum chars. */
const SF_RECORD_ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;
/**
 * Salesforce SObject API name — letter-prefixed, alphanumeric + underscore,
 * length ≤ 80 (Salesforce hard cap is 40 for standard / 254 with namespace,
 * 80 is a safe practical ceiling). Anchored to block injection via the
 * graph payload (defense-in-depth — assertSoqlIdentifier still runs).
 */
const SF_OBJECT_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** A field's API name, as Salesforce allows them. */
const SF_FIELD_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/**
 * A record type's name: its DeveloperName (80 characters at most), after its
 * package's namespace (15) and `__` for a package's — `ns__Retail`.
 */
const SF_RECORD_TYPE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{0,96}$/;

/** Zod schema for ForgeSampleDraw */
export const forgeSampleDrawSchema = z.enum(['uniform', 'recent', 'oldest']);

/** Zod schema for ForgeQueryScope */
export const forgeQueryScopeSchema = z.enum([
  'records',
  'tables',
] as const satisfies readonly ForgeQueryScope[]);

/** The most days back a window of a sample reaches (`lastDays`): a hundred years. */
export const FORGE_SAMPLE_MAX_LAST_DAYS = 36_500;

/** The most fields a sample's roots are stratified by (`strata`). */
export const FORGE_SAMPLE_MAX_STRATA = 20;

/** The most objects whose roots a sample filters (`rootWhere`), as many as a run's object filters. */
export const FORGE_SAMPLE_MAX_ROOT_WHERE = 50;

/**
 * A field the roots are stratified by: `Field`, of every object drawn that
 * has it, or `Object.Field`, of that object.
 */
export const FORGE_SAMPLE_STRATUM_PATTERN =
  /^(?:[A-Za-z][A-Za-z0-9_]{0,79}\.)?[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** An instant of a window, in UTC to the second: `2025-07-01T00:00:00Z`. */
const WINDOW_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Whether `text` is an instant of a window, and one the calendar has. */
function isWindowInstant(text: string): boolean {
  if (!WINDOW_INSTANT.test(text)) return false;
  const time = Date.parse(text);
  return Number.isFinite(time) && new Date(time).toISOString() === text.replace('Z', '.000Z');
}

/**
 * A bound of a window as a person writes it — a date, `2025-06-30`, or an
 * instant in UTC to the second, `2025-06-30T12:00:00Z` — as the window holds
 * it: an instant. A date alone starts at 00:00Z; as the end, it takes the
 * whole day, and becomes the next day at 00:00Z, which the window leaves out.
 * Undefined for anything else, or a day the calendar does not have.
 */
export function forgeSampleWindowBound(text: string, end: boolean): string | undefined {
  if (isWindowInstant(text)) return text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const midnight = `${text}T00:00:00Z`;
  if (!isWindowInstant(midnight)) return undefined;
  if (!end) return midnight;
  const next = new Date(Date.parse(midnight) + 24 * 60 * 60 * 1000);
  return `${next.toISOString().slice(0, 19)}Z`;
}

/**
 * Zod schema for ForgeSampleWindow. Strict, as the options are: a misspelt
 * bound read as none would draw among more roots than asked. A window gives
 * a bound or `lastDays`, never both, and its `from` is before its `to`.
 */
export const forgeSampleWindowSchema = z
  .strictObject({
    field: z.enum([
      'CreatedDate',
      'LastModifiedDate',
    ] as const satisfies readonly ForgeSampleWindow['field'][]),
    from: z
      .string()
      .refine(isWindowInstant, { message: 'A bound is an instant in UTC, as 2025-07-01T00:00:00Z' })
      .optional(),
    to: z
      .string()
      .refine(isWindowInstant, { message: 'A bound is an instant in UTC, as 2025-07-01T00:00:00Z' })
      .optional(),
    lastDays: z.number().int().min(1).max(FORGE_SAMPLE_MAX_LAST_DAYS).optional(),
  })
  .superRefine((window, ctx) => {
    const bounded = window.from !== undefined || window.to !== undefined;
    if (!bounded && window.lastDays === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'A window gives from, to or both, or lastDays',
      });
    }
    if (bounded && window.lastDays !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastDays'],
        message:
          'lastDays counts back from when the sample is drawn, and takes no from or to: give one or the other',
      });
    }
    if (window.from !== undefined && window.to !== undefined && window.from >= window.to) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'A window’s from is before its to',
      });
    }
  });

/**
 * Zod schema for the fields a sample's roots are stratified by: one field of
 * each object at most — `Object.Field` before `Field`, which every object
 * that has it takes, so two of them would give each object two —, none twice.
 */
export const forgeSampleStrataSchema = z
  .array(
    z
      .string()
      .regex(
        FORGE_SAMPLE_STRATUM_PATTERN,
        'A stratum is a field, as RecordTypeId, or an object and its field, as Account.RecordTypeId',
      ),
  )
  .max(FORGE_SAMPLE_MAX_STRATA)
  .superRefine((strata, ctx) => {
    const seen = new Set<string>();
    strata.forEach((stratum, index) => {
      const dot = stratum.indexOf('.');
      const of = dot < 0 ? '' : stratum.slice(0, dot).toLowerCase();
      if (seen.has(of)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message:
            dot < 0
              ? `${stratum}: the roots are stratified by one field of every object at most`
              : `${stratum}: the roots of ${stratum.slice(0, dot)} are stratified by one field at most`,
        });
      }
      seen.add(of);
    });
  });

/** Zod schema for ForgeSampleParents */
export const forgeSampleParentsSchema = z.enum(['all', 'required']);

/**
 * What an option of a sample left out comes to: the roots drawn by seed 1,
 * spread over each object; the records an optional lookup names copied; a
 * hundred children of a record per relation; one root of each object kept
 * whatever the share, as Autopilot keeps one.
 */
export const FORGE_SAMPLE_DEFAULTS = {
  seed: 1,
  draw: 'uniform',
  parents: 'all',
  children: 100,
  floor: 1,
} as const satisfies Required<
  Pick<ForgeSampleOptions, 'seed' | 'draw' | 'parents' | 'children' | 'floor'>
>;

/**
 * Zod schema for ForgeSampleOptions. Strict: an option it does not name is
 * refused rather than dropped, as a mistyped bound read as none would let
 * the sample take more than was asked. Bounded as the rest of a config is,
 * so that a forged payload asks no list or number past what any org holds;
 * the records a plan holds at once are bounded where it is drawn.
 */
export const forgeSampleOptionsSchema = z.strictObject({
  withinMB: z.number().positive().max(1_000_000).optional(),
  maxTotal: z.number().int().min(1).optional(),
  seed: z.number().int().min(0).optional(),
  draw: forgeSampleDrawSchema.optional(),
  parents: forgeSampleParentsSchema.optional(),
  children: z.union([z.literal('all'), z.number().int().min(1).max(1_000_000)]).optional(),
  whole: z
    .array(z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'))
    .max(500)
    .optional(),
  floor: z.number().int().min(0).max(10_000).optional(),
  plan: z.string().min(1).max(4_096).optional(),
  window: forgeSampleWindowSchema.optional(),
  rootWhere: z
    .record(
      z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
      soqlWhereFragmentSchema,
    )
    .refine((m) => Object.keys(m).length <= FORGE_SAMPLE_MAX_ROOT_WHERE, {
      message: `The roots of ${FORGE_SAMPLE_MAX_ROOT_WHERE} objects at most are filtered`,
    })
    .optional(),
  strata: forgeSampleStrataSchema.optional(),
});

/** Why a config walked from a root is refused with a sample. */
const SAMPLE_OF_THE_WHOLE_ORG_ALONE =
  "A sample is drawn from a clone of the whole org alone (inputMode 'org', depth 'all'): sample must be left out";

/**
 * Base ForgeConfig schema (no cross-field refine). Kept as a plain ZodObject
 * so consumers like `forgeTemplateSchema` can still call `.omit()` on it.
 * For handler validation that requires the `inputMode → matching field`
 * contract, prefer `forgeConfigSchemaStrict` below.
 */
export const forgeConfigSchema = z.object({
  inputMode: forgeInputModeSchema,
  recordId: z.string().regex(SF_RECORD_ID_REGEX, 'Invalid Salesforce record ID').optional(),
  soqlQuery: z.string().min(1).max(20_000).optional(),
  // Parsing drops what the schema does not name: without them, a query sent
  // to clone the records it chooses would reach the run as one that reads
  // whole tables.
  queryScope: forgeQueryScopeSchema.optional(),
  maxRoots: z.number().int().min(1).max(FORGE_ROOTS_MAX).optional(),
  templateId: z.string().min(1).max(200).optional(),
  aiPrompt: z.string().min(1).max(4_000).optional(),
  depth: forgeRunDepthSchema,
  customDepth: z.number().int().positive().max(10).optional(),
  // Bounded well below what an org holds: discovery describes and counts each
  // object it reaches, and a cap in the thousands spends an API budget rather
  // than producing a usable graph.
  maxNodes: z.number().int().min(10).max(500).optional(),
  sourceOrgId: z.string().min(1).max(128),
  targetOrgId: z.string().min(1).max(128),
  anonymizePII: z.boolean(),
  skipEmpty: z.boolean(),
  batchSize: z.union([z.literal('auto'), z.number().int().positive().max(10_000)]),
  expandOrphanParents: z.boolean().optional(),
  // Parsing drops what the schema does not name: without it, the choice to
  // keep emails and phone numbers as they are never reached the run, nor a
  // template saved with it.
  keepContactPoints: z.boolean().optional(),
  // Parsing drops what the schema does not name: without it, a run asked to
  // apply the target's assignment rules reached the executor as one that
  // keeps them off.
  applyAssignmentRules: z.boolean().optional(),
  maxRecordsPerObject: z.number().int().positive().max(1_000_000).optional(),
  // Per-object field exclusions. Outer key = SObject API name (regex'd),
  // inner array = field API names to skip (each ≤ 80 chars, ≤ 200 per
  // object). Defense-in-depth: bounded to keep payloads sane.
  fieldExclusions: z
    .record(
      z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
      z
        .array(
          z
            .string()
            .regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/)
            .max(80),
        )
        .max(200),
    )
    .optional(),
  // Source-org → target-org User Id remap for OwnerId. Both sides are
  // Salesforce IDs; arbitrary keys would let a webview-compromised
  // payload swap arbitrary FK values, hence the strict ID regex on
  // both ends. Bounded to 200 entries (very large by realistic use).
  ownerMappings: z
    .record(
      z.string().regex(SF_RECORD_ID_REGEX, 'Invalid Salesforce record ID'),
      z.string().regex(SF_RECORD_ID_REGEX, 'Invalid Salesforce record ID'),
    )
    .refine((m) => Object.keys(m).length <= 200, {
      message: 'Too many owner mappings (max 200)',
    })
    .optional(),
  // Per-object SOQL WHERE filter. Outer key = SObject API name (regex'd),
  // value = arbitrary SOQL fragment (length-bounded to 512 chars). Two
  // defenses: object-name regex blocks injection via the key, length cap
  // blocks DoS via huge filters. Newlines and the SOQL comment markers
  // (-- and /* */) are rejected so the filter can't append a second
  // statement. Trust boundary at the schema — the filter itself is
  // intentionally arbitrary (BA writes their own WHERE clause).
  objectSoqlFilters: z
    .record(
      z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
      soqlWhereFragmentSchema,
    )
    .refine((m) => Object.keys(m).length <= 50, {
      message: 'Too many SOQL filters (max 50)',
    })
    .optional(),
  // Per-object field rename map for schema drift between source and target.
  // Outer key = SObject API name; inner record keys/values = field API names.
  // All three regexes match the SF field-name pattern. Bounded to 200 fields
  // per object × 50 objects × 80 chars per field name.
  fieldMappings: z
    .record(
      z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
      z
        .record(
          z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'Invalid source field name'),
          z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'Invalid target field name'),
        )
        .refine((m) => Object.keys(m).length <= 200, {
          message: 'Too many field mappings (max 200 per object)',
        }),
    )
    .refine((m) => Object.keys(m).length <= 50, {
      message: 'Too many objects with field mappings (max 50)',
    })
    .optional(),
  dryRun: z.boolean().optional(),
  // The decisions taken on Review's Gaps tab. Bounded like the maps above:
  // a payload from a compromised webview cannot grow them without end, and
  // every name is held to the SF pattern before it reaches a query or a row.
  picklistValueMappings: z
    .array(
      z.object({
        object: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
        field: z.string().regex(SF_FIELD_NAME_REGEX, 'Invalid field name'),
        recordType: z.string().regex(SF_RECORD_TYPE_NAME_REGEX).optional(),
        from: z.string().min(1).max(255),
        to: z.string().min(1).max(255).nullable(),
      }),
    )
    .max(500)
    .optional(),
  recordTypeMappings: z
    .array(
      z.object({
        object: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
        from: z.string().regex(SF_RECORD_TYPE_NAME_REGEX),
        to: z.string().regex(SF_RECORD_TYPE_NAME_REGEX).nullable(),
      }),
    )
    .max(200)
    .optional(),
  defaultValues: z
    .array(
      z.object({
        object: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
        field: z.string().regex(SF_FIELD_NAME_REGEX, 'Invalid field name'),
        value: z.union([z.string().max(1_000), z.number(), z.boolean()]),
      }),
    )
    .max(200)
    .optional(),
  truncateFields: z
    .array(
      z.object({
        object: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
        field: z.string().regex(SF_FIELD_NAME_REGEX, 'Invalid field name'),
      }),
    )
    .max(200)
    .optional(),
  excludedObjects: z
    .array(z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'))
    .max(500)
    .optional(),
  ignoredGaps: z.array(z.string().min(1).max(600)).max(1_000).optional(),
  // The gaps whose rows the run holds back, each under the object its id
  // names: an entry naming one object and the gap of another would hold back
  // nothing anyone chose.
  skippedRows: z
    .array(
      z
        .object({
          object: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
          gapId: z.string().min(1).max(600),
        })
        .refine((entry) => forgeGapParts(entry.gapId)?.objectApiName === entry.object, {
          message: 'The gap id must name the object',
          path: ['gapId'],
        }),
    )
    .max(500)
    .optional(),
  // Parsing drops what the schema does not name: without it, a resumed run
  // read its journal's config as one that copies every record.
  sample: forgeSampleOptionsSchema.optional(),
});

/**
 * A run's config walked from a root — a record, a query, a template or an AI
 * draft — never the clone of a whole org: what a template holds, and what
 * the Forge panel's messages carry. A config of the `org` mode or the `all`
 * depth is refused at its parse, as any mode or depth they never held, and
 * so is a sample, drawn from the whole org alone.
 */
export const forgeWalkConfigSchema = forgeConfigSchema.extend({
  inputMode: forgeInputModeSchema.exclude(['org']),
  depth: forgeDepthSchema,
  sample: z.never({ error: SAMPLE_OF_THE_WHOLE_ORG_ALONE }).optional(),
});

/**
 * Why a config is not a clone of the whole org as one must be, or nothing
 * when it is one, or is no clone of the whole org at all.
 *
 * The `org` input mode and the `all` depth go together and with nothing
 * else: a run that walks from a root reads what it reaches from it, and one
 * that takes the whole org reaches nothing from anything, so a record, a
 * query, a template, an AI draft or a custom depth given with it would be
 * read as a narrowing the run does not make. Exported beside the strict
 * schema because the messages the extension receives are parsed by the
 * plain one, whose `.omit()` the template schema needs, and the extension
 * asks this of them itself.
 *
 * A sample (`sample`) is drawn from the whole org alone: a walk reads all it
 * reaches, and its config would say a sample its run never draws. Nor can a
 * sample copy whole an object the run leaves out: one of the two choices
 * would be dropped unsaid. Nor filter the roots of an object it copies whole
 * or the run leaves out: such an object has no root to draw, and the filter
 * would choose nothing.
 */
export function wholeOrgConfigIssue(
  c: Pick<
    ForgeConfig,
    | 'inputMode'
    | 'depth'
    | 'recordId'
    | 'soqlQuery'
    | 'templateId'
    | 'aiPrompt'
    | 'customDepth'
    | 'sample'
    | 'excludedObjects'
  >,
): string | undefined {
  const org = c.inputMode === 'org';
  const all = c.depth === 'all';
  if (!org && !all) return c.sample === undefined ? undefined : SAMPLE_OF_THE_WHOLE_ORG_ALONE;
  if (!all) return "A clone of the whole org (inputMode 'org') takes the depth 'all' and no other";
  if (!org) {
    return `The depth 'all' clones the whole org and goes with inputMode 'org' only, not '${c.inputMode}'`;
  }
  const given = (
    ['recordId', 'soqlQuery', 'templateId', 'aiPrompt', 'customDepth'] as const
  ).filter((field) => c[field] !== undefined);
  if (given.length > 0) {
    return `A clone of the whole org starts from no record, query, template or AI draft and walks no depth: ${given.join(', ')} must be left out`;
  }
  const excluded = new Set(c.excludedObjects ?? []);
  const both = (c.sample?.whole ?? []).filter((name) => excluded.has(name));
  if (both.length > 0) {
    return `The sample copies whole an object the run leaves out: ${both.join(', ')}. Take each out of one list or the other`;
  }
  const filtered = Object.keys(c.sample?.rootWhere ?? {});
  const whole = new Set(c.sample?.whole ?? []);
  const copiedWhole = filtered.filter((name) => whole.has(name));
  if (copiedWhole.length > 0) {
    return `The sample filters the roots of an object it copies whole, every record of which comes: ${copiedWhole.join(', ')}. Take each out of whole, or filter the object itself (objectSoqlFilters), which leaves records out of the copy`;
  }
  const leftOut = filtered.filter((name) => excluded.has(name));
  if (leftOut.length === 0) return undefined;
  return `The sample filters the roots of an object the run leaves out: ${leftOut.join(', ')}. Take each out of one list or the other`;
}

/**
 * Why a config's query scope is not one a run can take, or nothing when it
 * is, by the field that is wrong: `queryScope` goes with a query alone, and
 * `maxRoots` with a query that clones the records it chooses
 * (`queryScope: 'records'`), whose query must then choose them as its own
 * statement reads them (`soqlRootQueryIssue`). Exported beside the strict
 * schema, as {@link wholeOrgConfigIssue} is, for the messages the extension
 * parses with the plain one.
 */
export function queryScopeConfigIssue(
  c: Pick<ForgeConfig, 'inputMode' | 'soqlQuery' | 'queryScope' | 'maxRoots'>,
): { field: 'queryScope' | 'maxRoots' | 'soqlQuery'; message: string } | undefined {
  if (c.queryScope !== undefined && c.inputMode !== 'soql') {
    return {
      field: 'queryScope',
      message: `queryScope says what a query clones, and goes with inputMode 'soql' alone, not '${c.inputMode}'`,
    };
  }
  if (c.maxRoots !== undefined && c.queryScope !== 'records') {
    return {
      field: 'maxRoots',
      message:
        "maxRoots bounds the records a query chooses to clone, and goes with queryScope 'records' alone",
    };
  }
  if (c.queryScope === 'records' && c.soqlQuery !== undefined) {
    const issue = soqlRootQueryIssue(c.soqlQuery);
    if (issue !== undefined) return { field: 'soqlQuery', message: soqlRootIssueWords(issue) };
  }
  return undefined;
}

/**
 * Why a sample of the whole org is refused with the files of its records:
 * which files a sample would copy, and what they would take of the target's
 * file storage, is not drawn yet. Asked on the run's options, not its config,
 * which never holds the files: the panel sends them beside it, the command
 * line reads `--files`.
 */
export function wholeOrgSampleFilesIssue(
  c: Pick<ForgeConfig, 'sample'>,
  files: ForgeFileCopyOption | undefined,
): string | undefined {
  if (c.sample === undefined || files === undefined) return undefined;
  return 'A sample of the whole org copies no files yet: copy every record to take them, or leave the files out';
}

/**
 * Strict ForgeConfig validation: enforces the inputMode→required-field
 * contract via `.superRefine`. Without this, a payload like
 * `{inputMode:'soql', recordId:'…'}` passes validation, then crashes
 * downstream in `resolveRootObject` with a generic message. A clone of the
 * whole org, and any config with a sample, is held to
 * {@link wholeOrgConfigIssue}, and refused in its words; a query's scope to
 * {@link queryScopeConfigIssue}.
 */
export const forgeConfigSchemaStrict = forgeConfigSchema.superRefine((c, ctx) => {
  const scope = queryScopeConfigIssue(c);
  if (scope !== undefined) {
    ctx.addIssue({ code: 'custom', message: scope.message, path: [scope.field] });
  }
  if (c.inputMode === 'org' || c.depth === 'all' || c.sample !== undefined) {
    const issue = wholeOrgConfigIssue(c);
    if (issue !== undefined) ctx.addIssue({ code: 'custom', message: issue, path: ['inputMode'] });
    return;
  }
  const matched =
    (c.inputMode === 'record' && c.recordId !== undefined) ||
    (c.inputMode === 'soql' && c.soqlQuery !== undefined) ||
    (c.inputMode === 'template' && c.templateId !== undefined) ||
    (c.inputMode === 'ai' && c.aiPrompt !== undefined);
  if (!matched) {
    ctx.addIssue({
      code: 'custom',
      message:
        'inputMode requires the matching field (record→recordId, soql→soqlQuery, template→templateId, ai→aiPrompt, org→none, with the depth all)',
      path: ['inputMode'],
    });
  }
});

// ─── Graph Schemas ──────────────────────────────────────────────────────────

/** Zod schema for ForgeGraphNode */
export const forgeGraphNodeSchema = z.object({
  objectApiName: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
  // Kept through a parse, as the counts below are: a graph Reuse last graph
  // brings back still names its records by their object's label.
  label: z.string().max(255).optional(),
  recordCount: z.number().int().nonnegative(),
  // Parsing drops what the schema does not name: without it, the graph a run
  // keeps in its history, which Reuse last graph brings back to Review,
  // would count a starter template's tables empty.
  recordCountUnknown: z.boolean().optional(),
  // Parsing drops what the schema does not name: without it, an object of a
  // clone of the whole org whose count was the org's approximation would
  // come back from the history read as counted.
  recordCountApproximate: z.boolean().optional(),
  fieldCount: z.number().int().nonnegative(),
  status: forgeNodeStatusSchema,
  progress: z.number().min(0).max(100),
  included: z.boolean(),
  // Parsing drops what the schema does not name: without it, a node the user
  // left out reached the run as one discovery left out.
  leftOutByUser: z.boolean().optional(),
  piiFields: z.array(z.string().max(80)).max(500),
  anonymizeFields: z.array(z.string().max(80)).max(500),
  level: z.number().int().nonnegative().max(20),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  errors: z.array(z.string().max(2_000)).max(50),
  createableFieldCount: z.number().int().nonnegative(),
  estimatedSizeMB: z.number().nonnegative(),
  estimatedApiCalls: z.number().int().nonnegative(),
  batchStrategy: forgeBatchStrategySchema,
});

/** Zod schema for ForgeGraphEdge */
export const forgeGraphEdgeSchema = z.object({
  sourceObject: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
  targetObject: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
  relationshipName: z.string().min(1).max(80),
  type: forgeEdgeTypeSchema,
  required: z.boolean().optional(),
  settable: z.boolean().optional(),
  insertOnly: z.boolean().optional(),
});

/** Zod schema for ForgeLeftOutReason */
export const forgeLeftOutReasonSchema = z.enum([
  'missingInTarget',
  'notQueryable',
  'empty',
  'unreadable',
  'notWritable',
  'createOnly',
  'setup',
  'platformCreated',
  'metadata',
  'chatter',
  'history',
  'sharing',
  'changeEvent',
  'unsupportedKind',
  'customSetting',
  'files',
  'excludedByUser',
  'notDescribed',
] as const satisfies readonly ForgeLeftOutReason[]);

/** Zod schema for ForgeLeftOutObject */
export const forgeLeftOutObjectSchema = z.object({
  objectApiName: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
  reason: forgeLeftOutReasonSchema,
  // The org's own words can be long: a refusal is said as the org said it.
  detail: z.string().max(2_000).optional(),
});

/**
 * The most objects a graph lists as left out of a clone of the whole org.
 *
 * Every object of the source's global describe that is not a node is one:
 * the sharing, history, feed and change event objects the org keeps beside
 * each object of its own, the empty tables, those the target lacks. An org
 * may hold three thousand custom objects, each with up to four such objects
 * beside it, over the fifteen hundred or so of the platform and theirs: some
 * sixteen thousand names at most. The bound leaves room past that, so that
 * no real org is refused for what it does not copy, and still bounds a
 * forged payload; nothing walks the list, it is only shown and counted.
 */
export const FORGE_LEFT_OUT_MAX = 50_000;

/**
 * Zod schema for ForgeGraph — bounded by .max() on nodes/edges to block
 * a forged payload from triggering O(n²) or recursive algorithms (Tarjan
 * SCC, in-degree map, etc.) into stack overflow / DoS.
 */
export const forgeGraphSchema = z.object({
  nodes: z.array(forgeGraphNodeSchema).max(2_000),
  edges: z.array(forgeGraphEdgeSchema).max(20_000),
  totalRecords: z.number().int().nonnegative(),
  estimatedSizeMB: z.number().nonnegative(),
  estimatedDurationSeconds: z.number().nonnegative(),
  truncated: z.boolean().optional(),
  // Every object of the source org a clone of the whole org leaves out.
  leftOut: z.array(forgeLeftOutObjectSchema).max(FORGE_LEFT_OUT_MAX).optional(),
  // The graph a history entry keeps of a clone of the whole org, without its
  // relations: kept through the parse so that its run is refused, not run.
  withoutEdges: z.literal(true).optional(),
});

// A run's result has no schema, on purpose. Nothing parses one: the extension
// builds it (`forgeRunResult`), posts it to the webview and keeps it in its own
// history, which it reads back itself, and no message from the webview carries
// one — a removal names the run's history entry, never records. The schema
// that stood here was parsed by its own tests alone and had fallen sixteen
// fields behind the type; parsing drops what it does not name, so a history
// entry read through it would have lost `idRemapCreated`, and with it the
// removal of the run's records.

// ─── Template Schema ────────────────────────────────────────────────────────

/**
 * The method for some PII categories, as Review holds them. Built here rather
 * than by each caller: zod 3's `z.record` told its two forms apart with
 * `instanceof` on its second argument, and a package whose zod was another copy
 * of it (the extension's tests load the ES build, this package the CommonJS
 * one) read the method schema as options and checked every method against the
 * categories.
 *
 * Partial: zod 4 reads a record keyed by an enum as holding every key, and a
 * Review that sets a method for two categories out of five is the common case.
 */
export const forgeAnonymizationRulesSchema = z.partialRecord(
  forgeAnonymizationCategorySchema,
  anonymizationMethodSchema,
);

/**
 * Zod schema for ForgeFileCopyOption: a whole number of megabytes, from one to
 * what a single call carries, and the acceptance the run needs while it
 * anonymizes.
 */
export const forgeFileCopyOptionSchema = z.object({
  maxFileSizeMB: z.number().int().min(1).max(FILE_COPY_CEILING_MB),
  acceptedAsIs: z.boolean(),
});

/** Zod schema for ForgeTemplateAnonymization */
export const forgeTemplateAnonymizationSchema = z.object({
  presetId: z.string().min(1).max(100).optional(),
  rules: forgeAnonymizationRulesSchema,
  // Bounded as a graph's nodes and their personal fields are: a template is a
  // file someone else may hand over, and it is read before anything checks it.
  fields: z
    .array(
      z.object({
        objectApiName: z.string().regex(SF_OBJECT_NAME_REGEX, 'Invalid SObject API name'),
        fieldNames: z.array(z.string().regex(SF_FIELD_NAME_REGEX, 'Invalid field name')).max(500),
      }),
    )
    .max(2_000)
    .optional(),
});

/** Zod schema for ForgeTemplate */
export const forgeTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  config: forgeWalkConfigSchema.omit({ sourceOrgId: true, targetOrgId: true }),
  targetOrgId: z.string().min(1).max(128).optional(),
  anonymization: forgeTemplateAnonymizationSchema.optional(),
  // Parsing drops what the schema does not name: without it, the file choice
  // a template was saved with never reached the workspace's file.
  files: z.object({ maxFileSizeMB: z.number().int().min(1).max(FILE_COPY_CEILING_MB) }).optional(),
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
  remapperState: z.record(z.string(), z.string()),
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
