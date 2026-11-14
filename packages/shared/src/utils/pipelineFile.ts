import * as z from 'zod';

import type { PipelineStepType } from '../types/automation.types.js';
import type {
  PipelineFileDraft,
  PipelineFileIssue,
  PipelineFileNoteCode,
  PipelineFileOrgKind,
  PipelineFileOrgRef,
  PipelineFileRead,
  PipelineFileRefusal,
  PipelineFileSettingKey,
  PipelineFileWritten,
  SandforgePipelineFile,
} from '../types/pipelineFile.types.js';
import { isOwnAlias } from './org-name.js';
import { sha256Hex } from './sha256.js';

/**
 * The pipeline file: its version, its schema, its digest, and how it is
 * written and read (see `types/pipelineFile.types.ts` for what it holds).
 *
 * The file is read in two passes, and every issue of both is reported: the
 * schema checks each field's shape, and the checks the shape cannot carry —
 * an org a step names that the file does not hold, a username where an alias
 * goes, the value of a secret — are made on the file as it came, so a file
 * with a wrong Organization Id and a username in it is refused once, for
 * both, rather than once for each.
 *
 * The configurations and templates the file carries are not read here past
 * their id: the command line hands them to the stores the editor reads, and
 * the step that names one checks it as the editor does, naming the step.
 */

/** The version of the pipeline file this release writes, and the highest it reads. */
export const PIPELINE_FILE_VERSION = 1;

/** What a pipeline file's name ends with. */
export const PIPELINE_FILE_SUFFIX = '.sandforge-pipeline.json';

/** The longest a pipeline file's name runs before its suffix. */
const FILE_NAME_MAX_LENGTH = 80;

/** How a setting of a pipeline file reads: its type, and its bounds, as the extension's manifest gives them. */
export interface PipelineFileSettingRule {
  type: 'number' | 'integer' | 'boolean';
  minimum?: number;
  maximum?: number;
}

/**
 * The settings a pipeline file carries: those the steps of a pipeline read
 * where it runs, with the bounds VS Code holds each to. Beside the seven the
 * Automation page's runs were known to read, the code of the steps reads
 * four more: the volume past which a Sync asks before it writes, the age past
 * which a Backup's retention drops a snapshot, and the three settings that
 * partition a large Seed or Sync. A setting the file leaves out is read at
 * its default; one it holds past its bounds does not read.
 */
export const PIPELINE_FILE_SETTINGS: Readonly<
  Record<PipelineFileSettingKey, PipelineFileSettingRule>
> = {
  'pipeline.timeout': { type: 'number', minimum: 30_000, maximum: 3_600_000 },
  'sync.maxRecordsPerObject': { type: 'integer', minimum: 1, maximum: 50_000 },
  'sync.defaultBatchSize': { type: 'number', minimum: 1, maximum: 10_000 },
  'seed.defaultBatchSize': { type: 'number', minimum: 1, maximum: 10_000 },
  'backup.maxRecordsPerObject': { type: 'integer', minimum: 100, maximum: 1_000_000 },
  'backup.maxCount': { type: 'number', minimum: 1, maximum: 100 },
  'backup.maxAgeDays': { type: 'integer', minimum: 0, maximum: 3650 },
  'safety.auditLogging': { type: 'boolean' },
  'safety.confirmAboveRecords': { type: 'number', minimum: 0 },
  'grappe.enabled': { type: 'boolean' },
  'grappe.autoActivateThreshold': { type: 'number', minimum: 1 },
  'grappe.grappeSize': { type: 'number', minimum: 1 },
};

/** Each note code an export writes (see {@link PipelineFileNoteCode}). */
export const PIPELINE_FILE_NOTE_CODES = [
  'APPROVAL_NEEDS_PERSON',
  'STAGING_NEEDS_PERSON',
  'REWIND_NEEDS_CONFIRMATION',
  'REWIND_CHECKPOINT_ELSEWHERE',
  'ORG_NO_ALIAS',
  'ORG_NOT_SIGNED_IN',
  'SECRET_NOT_EXPORTED',
  'NOTIFICATION_PRINTED',
  'STEP_REFUSED',
  'TRIGGER_NOT_EXPORTED',
] as const satisfies readonly PipelineFileNoteCode[];

/**
 * The fields of a step's configuration that name an org, by step type: the
 * org a step reads or writes, by the id the editor's registry gave it. A Sync
 * step names its orgs through its configuration's `sourceOrgId` and
 * `targetOrgId`; Delay, Condition, Approval and Notification name none.
 */
export const PIPELINE_STEP_ORG_FIELDS: Readonly<
  Partial<Record<PipelineStepType, readonly string[]>>
> = {
  backup: ['orgId'],
  compare: ['sourceOrgId', 'targetOrgId'],
  precheck: ['orgId'],
  seed: ['orgId'],
  anonymize: ['orgId'],
  checkpoint: ['orgId'],
  rewind: ['orgId'],
};

/** The fields of a Sync configuration that name an org. */
const SYNC_CONFIG_ORG_FIELDS = ['sourceOrgId', 'targetOrgId'] as const;

/** The field of a Sync step's configuration that names the Sync configuration it runs. */
const SYNC_STEP_CONFIG_FIELD = 'configId';

/** `SandForge 1.81.0`, `SandForge 1.82.0-beta.1`: the release a file names as its writer. */
const EXPORTED_BY = /^SandForge (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** An Organization Id: `00D`, then twelve letters or digits, then three more for the long form. */
const ORGANIZATION_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** An org's key: what `--org <key>=<alias>` names, so neither a space nor `=`. */
const ORG_KEY = /^[^\s=]+$/;

/** A note's code: capitals, digits and underscores. */
const NOTE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A digest: `sha256:` and 64 lowercase hex digits. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The words a refusal names a kind of org by. */
const KIND_WORDS: Readonly<Record<PipelineFileOrgKind, string>> = {
  sandbox: 'a sandbox',
  scratch: 'a scratch org',
  developer: 'a Developer Edition org',
  production: 'a production org',
};

/** What a key a version-1 file does not have is refused with. */
function unknownKeysMessage(keys: readonly string[]): string {
  const named = keys.map((key) => `"${key}"`).join(', ');
  return (
    `${named} ${keys.length === 1 ? 'is' : 'are'} not part of a version-${PIPELINE_FILE_VERSION} ` +
    'pipeline file: remove it, or run the file with the release that exported it.'
  );
}

/** A strict object whose unknown keys are refused with {@link unknownKeysMessage}. */
function fileObject<Shape extends z.core.$ZodLooseShape>(shape: Shape) {
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys' ? unknownKeysMessage(issue.keys) : undefined,
  });
}

/** A number setting, held to the bounds {@link PIPELINE_FILE_SETTINGS} gives it. */
function numberSetting(key: PipelineFileSettingKey) {
  const rule = PIPELINE_FILE_SETTINGS[key];
  let schema = rule.type === 'integer' ? z.number().int() : z.number();
  if (rule.minimum !== undefined) schema = schema.min(rule.minimum);
  if (rule.maximum !== undefined) schema = schema.max(rule.maximum);
  return schema.optional();
}

const settingsSchema = z.strictObject(
  {
    'pipeline.timeout': numberSetting('pipeline.timeout'),
    'sync.maxRecordsPerObject': numberSetting('sync.maxRecordsPerObject'),
    'sync.defaultBatchSize': numberSetting('sync.defaultBatchSize'),
    'seed.defaultBatchSize': numberSetting('seed.defaultBatchSize'),
    'backup.maxRecordsPerObject': numberSetting('backup.maxRecordsPerObject'),
    'backup.maxCount': numberSetting('backup.maxCount'),
    'backup.maxAgeDays': numberSetting('backup.maxAgeDays'),
    'safety.auditLogging': z.boolean().optional(),
    'safety.confirmAboveRecords': numberSetting('safety.confirmAboveRecords'),
    'grappe.enabled': z.boolean().optional(),
    'grappe.autoActivateThreshold': numberSetting('grappe.autoActivateThreshold'),
    'grappe.grappeSize': numberSetting('grappe.grappeSize'),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `${issue.keys.map((key) => `"${key}"`).join(', ')} ${
            issue.keys.length === 1 ? 'is not a setting' : 'are not settings'
          } a pipeline file takes. It takes ${Object.keys(PIPELINE_FILE_SETTINGS).join(', ')}.`
        : undefined,
  },
);

/** A step as the editor saved it: what names it and what it runs; the rest travels as written. */
const stepSchema = z.looseObject({
  id: z.string().min(1, 'A step needs an id: the routes between steps name it.').max(200),
  name: z.string().min(1, 'A step needs a name: --approve and every refusal name it.').max(200),
  // Any text: a type this release does not have still reads, and the run
  // refuses it before its first step, naming the step, as the editor does.
  type: z.string().min(1).max(80),
  config: z.record(z.string(), z.unknown()).default({}),
});

const variableSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(['string', 'number', 'boolean', 'secret']),
  defaultValue: z.string().max(2_000).optional(),
  required: z.boolean().default(false),
  description: z.string().max(2_000).default(''),
});

const pipelineSchema = fileObject({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  description: z.string().max(5_000).default(''),
  steps: z.array(stepSchema).max(200),
  variables: z.array(variableSchema).max(200).default([]),
  tags: z.array(z.string().max(100)).max(50).default([]),
});

const scheduleSchema = fileObject({
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(100),
});

const orgSchema = fileObject({
  alias: z.string().trim().min(1).max(255).optional(),
  organizationId: z
    .string()
    .regex(ORGANIZATION_ID, 'Not an Organization Id: 00D and 12 or 15 letters and digits.'),
  kind: z.enum(['sandbox', 'scratch', 'developer', 'production']),
  staging: z.boolean().default(false),
  name: z.string().trim().min(1).max(255).optional(),
});

const orgKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(ORG_KEY, 'An org\'s key is what --org <key>=<alias> names: neither a space nor "=".');

const storedSchema = z.looseObject({ id: z.string().min(1).max(200) });

const syncConfigSchema = z.looseObject({
  id: z.string().min(1).max(200),
  sourceOrgId: z.string().optional(),
  targetOrgId: z.string().optional(),
});

const noteSchema = fileObject({
  code: z.string().regex(NOTE_CODE, 'A note code is written in capitals: APPROVAL_NEEDS_PERSON.'),
  text: z.string().min(1).max(2_000),
  step: z.string().max(200).optional(),
  org: z.string().max(200).optional(),
});

/** The shape of a version-1 file, field by field; {@link fileIssues} adds what the shape cannot say. */
const fileShapeSchema = fileObject({
  sandforgePipeline: z.literal(PIPELINE_FILE_VERSION, {
    error: `The version of a pipeline file this release reads is ${PIPELINE_FILE_VERSION}.`,
  }),
  exportedAt: z.iso.datetime({ offset: true, error: 'Not a date and time (ISO 8601).' }),
  exportedBy: z.string().min(1).max(100),
  digest: z.string().regex(DIGEST, 'Not a digest: sha256: and 64 hex digits.'),
  pipeline: pipelineSchema,
  schedule: scheduleSchema.nullable().default(null),
  orgs: z.record(orgKeySchema, orgSchema),
  syncConfigs: z.record(z.string().min(1).max(200), syncConfigSchema).default({}),
  seedTemplates: z.record(z.string().min(1).max(200), storedSchema).default({}),
  maskingTemplates: z.record(z.string().min(1).max(200), storedSchema).default({}),
  settings: settingsSchema.default({}),
  notes: z.array(noteSchema).max(500).default([]),
});

/** The value of `value` as an object of named fields, or nothing. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A text that names something: a string with more than blanks in it. */
function named(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Whether `object` has `key` of its own: a key from a file is data, and `constructor` is no step type. */
function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** An org named somewhere in a file, with where, as a path. */
interface OrgRefAt extends PipelineFileOrgRef {
  at: Array<string | number>;
  /** Who names it, as a refusal says it. */
  who: string;
}

/**
 * Each org a file names, read defensively: from a file that does not read
 * as a whole, the places that do are still found.
 */
function orgRefsAt(value: unknown): OrgRefAt[] {
  const file = fieldsOf(value);
  const refs: OrgRefAt[] = [];
  const steps = fieldsOf(file?.['pipeline'])?.['steps'];
  (Array.isArray(steps) ? steps : []).forEach((raw, index) => {
    const step = fieldsOf(raw);
    const type = step?.['type'];
    const stepId = named(step?.['id']);
    if (typeof type !== 'string' || stepId === undefined) return;
    if (!hasOwn(PIPELINE_STEP_ORG_FIELDS, type)) return;
    const fields = PIPELINE_STEP_ORG_FIELDS[type as PipelineStepType] ?? [];
    const config = fieldsOf(step?.['config']);
    for (const field of fields) {
      const key = named(config?.[field]);
      if (key === undefined) continue;
      refs.push({
        key,
        field,
        stepId,
        at: ['pipeline', 'steps', index, 'config', field],
        who: `Step "${String(step?.['name'] ?? stepId)}"`,
      });
    }
  });
  for (const [configKey, raw] of Object.entries(fieldsOf(file?.['syncConfigs']) ?? {})) {
    const config = fieldsOf(raw);
    for (const field of SYNC_CONFIG_ORG_FIELDS) {
      const key = named(config?.[field]);
      if (key === undefined) continue;
      refs.push({
        key,
        field,
        syncConfigId: configKey,
        at: ['syncConfigs', configKey, field],
        who: `Sync configuration "${configKey}"`,
      });
    }
  }
  return refs;
}

/** An issue found on the file as it came, where it is as the path's keys: a key may hold a dot. */
interface FoundIssue {
  at: Array<string | number>;
  message: string;
}

/**
 * What the shape of a file cannot say: a secret's value, a username, a
 * Staging mark nothing reads, a configuration filed under another id, and
 * an org or a configuration named and not held. Read on the file as it came.
 */
function fileIssues(value: unknown): FoundIssue[] {
  const issues: FoundIssue[] = [];
  const file = fieldsOf(value);
  const pipeline = fieldsOf(file?.['pipeline']);

  const variables = pipeline?.['variables'];
  (Array.isArray(variables) ? variables : []).forEach((raw, index) => {
    const variable = fieldsOf(raw);
    const name = typeof variable?.['name'] === 'string' ? variable['name'] : '';
    if (name.includes('=')) {
      issues.push({
        at: ['pipeline', 'variables', index, 'name'],
        message: `Variable "${name}" has "=" in its name, which --var <name>=<value> cannot give.`,
      });
    }
    if (variable?.['type'] === 'secret' && variable['defaultValue'] !== undefined) {
      issues.push({
        at: ['pipeline', 'variables', index, 'defaultValue'],
        message:
          `Variable "${name}" is a secret: a pipeline file never holds its value. Remove ` +
          `"defaultValue", and give it as the run starts with --var-env ${name}=<environment variable>.`,
      });
    }
  });

  const orgs = fieldsOf(file?.['orgs']) ?? {};
  const syncConfigs = fieldsOf(file?.['syncConfigs']) ?? {};

  const steps = pipeline?.['steps'];
  (Array.isArray(steps) ? steps : []).forEach((raw, index) => {
    const step = fieldsOf(raw);
    if (step?.['type'] !== 'sync') return;
    const configId = named(fieldsOf(step['config'])?.[SYNC_STEP_CONFIG_FIELD]);
    if (configId === undefined || hasOwn(syncConfigs, configId)) return;
    issues.push({
      at: ['pipeline', 'steps', index, 'config', SYNC_STEP_CONFIG_FIELD],
      message:
        `Sync step "${String(step['name'] ?? '')}" runs the configuration "${configId}", which ` +
        '"syncConfigs" does not hold: export the pipeline again.',
    });
  });

  const refs = orgRefsAt(value);
  for (const ref of refs.filter((candidate) => candidate.stepId !== undefined)) {
    if (hasOwn(orgs, ref.key)) continue;
    issues.push({
      at: ref.at,
      message:
        `${ref.who} names the org "${ref.key}" (${ref.field}), which "orgs" does not hold: ` +
        'export the pipeline again.',
    });
  }

  for (const [key, raw] of Object.entries(orgs)) {
    const org = fieldsOf(raw);
    if (!org) continue;
    // Never echoed: the issue lands in a terminal, a CI log, a ticket.
    if (typeof org['alias'] === 'string' && !isOwnAlias(org['alias'], undefined)) {
      issues.push({
        at: ['orgs', key, 'alias'],
        message:
          `The alias of org "${key}" is shaped as a username, which a pipeline file never holds. ` +
          'Give the org an alias of its own with the Salesforce CLI, remove "alias" here, and run ' +
          `with --org ${key}=<alias>.`,
      });
    }
    if (typeof org['name'] === 'string' && !isOwnAlias(org['name'], undefined)) {
      issues.push({
        at: ['orgs', key, 'name'],
        message: `The name of org "${key}" is shaped as a username, which a pipeline file never holds: remove it.`,
      });
    }
    const kind = org['kind'];
    if (org['staging'] === true && typeof kind === 'string' && kind !== 'sandbox') {
      const words = hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind as PipelineFileOrgKind] : kind;
      issues.push({
        at: ['orgs', key, 'staging'],
        message:
          `Org "${key}" is ${words}: the Staging mark is read of a sandbox alone, and a run ` +
          'would not ask what it asks of a Staging sandbox. Remove "staging".',
      });
    }
  }

  for (const map of ['syncConfigs', 'seedTemplates', 'maskingTemplates'] as const) {
    for (const [key, raw] of Object.entries(fieldsOf(file?.[map]) ?? {})) {
      const id = fieldsOf(raw)?.['id'];
      if (typeof id !== 'string' || id === key) continue;
      issues.push({
        at: [map, key, 'id'],
        message: `"${key}" holds the one whose id is "${id}": the steps name each by its own id.`,
      });
    }
  }

  for (const ref of refs.filter((candidate) => candidate.syncConfigId !== undefined)) {
    if (hasOwn(orgs, ref.key)) continue;
    issues.push({
      at: ref.at,
      message:
        `${ref.who} names the org "${ref.key}" (${ref.field}), which "orgs" does not hold: ` +
        'export the pipeline again.',
    });
  }
  return issues;
}

/** An issue of the schema, as a person reads it: the path, and the words of the check that failed. */
function issueOf(issue: z.core.$ZodIssue): PipelineFileIssue {
  const message =
    issue.code === 'invalid_key' && issue.issues.length > 0
      ? issue.issues.map((inner) => inner.message).join('; ')
      : issue.message;
  return { path: issue.path.map(String).join('.'), message };
}

/** The schema's issues and the file's own, the schema's first; the file is refused for any of them. */
function issuesOf(
  value: unknown,
): { ok: true; file: SandforgePipelineFile } | { ok: false; issues: PipelineFileIssue[] } {
  const shape = fileShapeSchema.safeParse(value);
  const issues = [
    ...(shape.success ? [] : shape.error.issues.map(issueOf)),
    ...fileIssues(value).map(({ at, message }) => ({ path: at.join('.'), message })),
  ];
  if (!shape.success || issues.length > 0) return { ok: false, issues };
  return { ok: true, file: shape.data };
}

/**
 * The schema of a version-1 pipeline file: its shape, then what the shape
 * cannot say. {@link parsePipelineFile} reads a file with both at once, and
 * reports every issue of both.
 */
export const sandforgePipelineFileSchema = fileShapeSchema.superRefine((file, ctx) => {
  for (const issue of fileIssues(file)) {
    ctx.addIssue({ code: 'custom', path: issue.at, message: issue.message });
  }
});

/** A value, written so that the same data always gives the same text: keys sorted, `undefined` left out. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const fields = fieldsOf(value);
  if (!fields) return JSON.stringify(value) ?? 'null';
  const keys = Object.keys(fields)
    .filter((key) => fields[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`).join(',')}}`;
}

/** What a file's digest covers: everything that says what a run does. */
type DigestedPart = Pick<
  SandforgePipelineFile,
  | 'sandforgePipeline'
  | 'pipeline'
  | 'schedule'
  | 'orgs'
  | 'syncConfigs'
  | 'seedTemplates'
  | 'maskingTemplates'
  | 'settings'
>;

/**
 * The digest of a pipeline file, as the schema reads it: `sha256:` and 64 hex
 * digits of its pipeline, schedule, orgs, configurations, templates and
 * settings, written with sorted keys. When it was exported, by which
 * release, and the notes do not count: an export of the same pipeline a day
 * later has the same digest, and the editor tells a saved change from it.
 */
export function pipelineFileDigest(file: DigestedPart): string {
  return `sha256:${sha256Hex(
    canonicalJson({
      sandforgePipeline: file.sandforgePipeline,
      pipeline: file.pipeline,
      schedule: file.schedule,
      orgs: file.orgs,
      syncConfigs: file.syncConfigs,
      seedTemplates: file.seedTemplates,
      maskingTemplates: file.maskingTemplates,
      settings: file.settings,
    }),
  )}`;
}

/** The release `exportedBy` names, `1.81.0`; nothing when it names none. */
export function exporterVersionOf(exportedBy: string): string | undefined {
  return EXPORTED_BY.exec(exportedBy)?.[1];
}

/** Where a pipeline file comes from. */
const EXPORT_ONE = 'Export the pipeline from the Automation page (Export…) to get a pipeline file.';

/** What is said of a file that is JSON, and no pipeline file. */
const NOT_A_PIPELINE = `This is not a SandForge pipeline file: it has no "sandforgePipeline" version. ${EXPORT_ONE}`;

/** A refusal, with no issue list: a file refused as a whole. */
function refusal(
  code: PipelineFileRefusal['code'],
  message: string,
  extra: Pick<PipelineFileRefusal, 'fileVersion' | 'exporterVersion'> = {},
): PipelineFileRead {
  return { ok: false, refusal: { code, message, issues: [], ...extra } };
}

/**
 * A pipeline file read from its JSON value: refused as no pipeline file, as
 * one a later release wrote, or for each issue found; or read, with whether
 * its digest is still that of what it holds. A digest that no longer matches
 * does not refuse the file — a person may edit it, as a test edits the
 * Organization Id — and the caller says it was edited.
 */
export function parsePipelineFile(value: unknown): PipelineFileRead {
  const fields = fieldsOf(value);
  if (!fields || !hasOwn(fields, 'sandforgePipeline')) {
    return refusal('PIPELINE_FILE_NOT_A_PIPELINE', NOT_A_PIPELINE);
  }
  const version = fields['sandforgePipeline'];
  if (typeof version === 'number' && Number.isInteger(version) && version > PIPELINE_FILE_VERSION) {
    const exportedBy = fields['exportedBy'];
    const exporterVersion =
      typeof exportedBy === 'string' ? exporterVersionOf(exportedBy) : undefined;
    const writer = exporterVersion
      ? `SandForge ${exporterVersion}`
      : 'a later release of SandForge';
    return refusal(
      'PIPELINE_FILE_NEWER',
      `This pipeline file is in version ${version} of the format, written by ${writer}; this ` +
        `release reads version ${PIPELINE_FILE_VERSION}. Run it with ${
          exporterVersion ? `SandForge ${exporterVersion}` : 'the release that exported it'
        } or a later one.`,
      { fileVersion: version, ...(exporterVersion ? { exporterVersion } : {}) },
    );
  }
  const read = issuesOf(value);
  if (!read.ok) {
    const count = read.issues.length;
    return {
      ok: false,
      refusal: {
        code: 'PIPELINE_FILE_INVALID',
        message:
          `This pipeline file does not read: ${count} ${count === 1 ? 'issue' : 'issues'}. ` +
          'Fix the file, or export the pipeline again.',
        issues: read.issues,
        ...(typeof version === 'number' ? { fileVersion: version } : {}),
      },
    };
  }
  return {
    ok: true,
    file: read.file,
    digestMatches: pipelineFileDigest(read.file) === read.file.digest,
  };
}

/** A pipeline file read from its text: {@link parsePipelineFile}, once the text is JSON. */
export function readPipelineFile(text: string): PipelineFileRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err: unknown) {
    // Where the parser stopped, and nothing of what it read there: its
    // message quotes the text, and a file given by mistake — an environment
    // file — would land in a terminal or a CI log.
    const reason = err instanceof Error ? err.message : '';
    const line = /line (\d+) column (\d+)/.exec(reason);
    const where = line ? ` at line ${line[1]}, column ${line[2]}` : '';
    return refusal('PIPELINE_FILE_NOT_JSON', `This file is not JSON${where}. ${EXPORT_ONE}`);
  }
  return parsePipelineFile(value);
}

/**
 * A pipeline file written from what an export gathered: read by the same
 * schema and checks as any file, so what an export writes always reads, and
 * refused with each issue when a reader would refuse it — a username kept as
 * an alias, a secret's value. Its digest is worked out on the file as read.
 */
export function writePipelineFile(draft: PipelineFileDraft): PipelineFileWritten {
  const exportedBy = `SandForge ${draft.sandforgeVersion}`;
  const candidate = {
    sandforgePipeline: PIPELINE_FILE_VERSION,
    exportedAt: draft.exportedAt,
    exportedBy,
    // Replaced below, once the file is read: the digest is of the file as read.
    digest: `sha256:${'0'.repeat(64)}`,
    pipeline: draft.pipeline,
    schedule: draft.schedule,
    orgs: draft.orgs,
    syncConfigs: draft.syncConfigs,
    seedTemplates: draft.seedTemplates,
    maskingTemplates: draft.maskingTemplates,
    settings: draft.settings,
    notes: draft.notes,
  };
  const read = issuesOf(candidate);
  const versionIssues: PipelineFileIssue[] =
    exporterVersionOf(exportedBy) === undefined
      ? [{ path: 'exportedBy', message: `"${draft.sandforgeVersion}" is no release of SandForge.` }]
      : [];
  if (!read.ok) return { ok: false, issues: [...versionIssues, ...read.issues] };
  if (versionIssues.length > 0) return { ok: false, issues: versionIssues };
  const file: SandforgePipelineFile = { ...read.file, digest: pipelineFileDigest(read.file) };
  return { ok: true, file, text: `${JSON.stringify(file, null, 2)}\n` };
}

/**
 * Each place a pipeline file names an org: the steps' configurations in
 * order, by the fields {@link PIPELINE_STEP_ORG_FIELDS} gives their type, then
 * the Sync configurations'. A field that names nothing is left out: the step
 * check refuses a step that names no org, as the editor does.
 */
export function pipelineFileOrgRefs(
  file: Pick<SandforgePipelineFile, 'pipeline' | 'syncConfigs'>,
): PipelineFileOrgRef[] {
  return orgRefsAt(file).map(({ key, field, stepId, syncConfigId }) => ({
    key,
    field,
    ...(stepId !== undefined ? { stepId } : {}),
    ...(syncConfigId !== undefined ? { syncConfigId } : {}),
  }));
}

/**
 * The name a pipeline file is saved under: its pipeline's name in lowercase
 * letters, digits and dashes, accents dropped, then the suffix; `pipeline`
 * when nothing of the name is left, as of a name in Japanese.
 */
export function pipelineFileNameOf(pipelineName: string): string {
  const slug = pipelineName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, FILE_NAME_MAX_LENGTH)
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'pipeline' : slug}${PIPELINE_FILE_SUFFIX}`;
}
