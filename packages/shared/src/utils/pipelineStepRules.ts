import * as z from 'zod';

import type { PipelineStepType, RetiredPipelineStepType } from '../types/automation.types.js';
import {
  checkpointIdSchema,
  checkpointIgnoredFieldsSchema,
  checkpointScopeModeSchema,
} from '../schemas/checkpoint.schema.js';
import { sha256Hex } from './sha256.js';

/**
 * Rules about pipeline steps that the extension, which runs them, and the
 * Automation page, which says before Run is pressed whether a step can run,
 * have to read alike: the step types there are, the ones SandForge no longer
 * has, how an Approval step's configuration is read, how the configurations
 * of the steps that take a checkpoint, rewind, seed and mask are read, and
 * what a Rewind step's confirmation is bound to.
 */

/** Every member of {@link PipelineStepType}, as data, for narrowing what a payload or a store holds. */
export const PIPELINE_STEP_TYPES: readonly PipelineStepType[] = [
  'seed',
  'sync',
  'backup',
  'restore',
  'anonymize',
  'delete',
  'checkpoint',
  'rewind',
  'compare',
  'precheck',
  'notification',
  'approval',
  'delay',
  'condition',
];

/** Every member of {@link RetiredPipelineStepType}, as data. */
export const RETIRED_PIPELINE_STEP_TYPES: readonly RetiredPipelineStepType[] = [
  'script',
  'loop',
  'parallel',
];

/** Whether `type` is a step type SandForge has. */
export function isPipelineStepType(type: unknown): type is PipelineStepType {
  return typeof type === 'string' && (PIPELINE_STEP_TYPES as readonly string[]).includes(type);
}

/** Whether `type` is a step type SandForge no longer has (see {@link RetiredPipelineStepType}). */
export function isRetiredPipelineStepType(type: unknown): type is RetiredPipelineStepType {
  return (
    typeof type === 'string' && (RETIRED_PIPELINE_STEP_TYPES as readonly string[]).includes(type)
  );
}

/** How long an Approval step waits for an answer when its configuration does not say. */
export const APPROVAL_DEFAULT_TIMEOUT_MINUTES = 60;

/**
 * The longest an Approval step may wait: a day. A step that waited longer
 * would hold its pipeline, and every trigger of it, for longer than anyone
 * comes back to a question.
 */
export const APPROVAL_MAX_TIMEOUT_MINUTES = 24 * 60;

/** The longest message an Approval step shows with its question. */
export const APPROVAL_MAX_MESSAGE_LENGTH = 500;

/** What keeps an Approval step's configuration from being used. */
export type ApprovalDefect = 'timeout' | 'message';

/**
 * How many minutes an Approval step waits, or undefined when its
 * configuration names no usable wait: a whole number of minutes from 1 to a
 * day. A step that names none waits {@link APPROVAL_DEFAULT_TIMEOUT_MINUTES}.
 * @param config - The step's configuration; a step read back from storage may have none
 */
export function approvalTimeoutMinutes(
  config: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const minutes = config?.['timeoutMinutes'];
  if (minutes === undefined) return APPROVAL_DEFAULT_TIMEOUT_MINUTES;
  return typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= 1 &&
    minutes <= APPROVAL_MAX_TIMEOUT_MINUTES
    ? minutes
    : undefined;
}

/**
 * What keeps an Approval step's configuration from being used, or undefined
 * when nothing does: a wait outside 1 minute to a day, or a message that is
 * not text or is longer than {@link APPROVAL_MAX_MESSAGE_LENGTH}. A step with
 * no message asks with the pipeline's and the step's names alone.
 * @param config - The step's configuration
 */
export function approvalDefect(
  config: Readonly<Record<string, unknown>> | undefined,
): ApprovalDefect | undefined {
  if (approvalTimeoutMinutes(config) === undefined) return 'timeout';
  const message = config?.['message'];
  if (message === undefined) return undefined;
  return typeof message === 'string' && message.trim().length <= APPROVAL_MAX_MESSAGE_LENGTH
    ? undefined
    : 'message';
}

// ─── The configurations of the steps that take a checkpoint, rewind, seed and mask ───

/** An org as a step names it: its id in SandForge's registry of orgs. */
const stepOrgIdSchema = z
  .string()
  .max(128)
  .refine((id) => id.trim() !== '', 'Name the org');

/** A template as a step names it: its id where the Seed or the DataOps page keeps it, or SandForge ships it. */
const stepTemplateIdSchema = z
  .string()
  .max(200)
  .refine((id) => id.trim() !== '', 'Name the template');

/** An object's API name, namespaced ones included. */
const stepObjectNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Not a Salesforce API name')
  .max(80);

/** The most objects a step names: as many as a take asked for by name may hold. */
const STEP_MAX_OBJECTS = 1000;

/** Objects a step names, each once. */
const stepObjectsSchema = z
  .array(stepObjectNameSchema)
  .min(1)
  .max(STEP_MAX_OBJECTS)
  .refine((objects) => new Set(objects).size === objects.length, 'An object is named twice');

/** Days a checkpoint a Checkpoint step takes is kept when its configuration does not say: as the Take page's. */
export const CHECKPOINT_STEP_DEFAULT_KEEP_DAYS = 30;

/** The longest a Checkpoint step keeps what it takes, in days, short of "until I delete it" (0). */
export const CHECKPOINT_STEP_MAX_KEEP_DAYS = 3650;

/** What a Checkpoint step's name puts the take's start (T0) in the place of. */
export const CHECKPOINT_STEP_DATE = '{date}';

/**
 * How long a take's start reads once put in a name, `2026-10-22 14:05 UTC`:
 * the name a take not given one is called by.
 */
const CHECKPOINT_STEP_DATE_LENGTH = 20;

/** The longest a checkpoint's name may be, as `checkpointNameSchema` holds it. */
const CHECKPOINT_NAME_MAX_LENGTH = 120;

/**
 * What a Checkpoint step calls each checkpoint it takes: one line of text,
 * `{date}` put in the place of the take's start, which keeps the names of a
 * nightly step's checkpoints apart. It must still be a checkpoint's name once
 * every `{date}` is replaced: refused before the run, never at the take.
 */
const checkpointStepNameSchema = z
  .string()
  .refine((name) => name.trim() !== '', 'Name the checkpoint, or leave the name out')
  .refine((name) => !/\p{Cc}/u.test(name), 'A checkpoint name is one line of text')
  .refine(
    (name) =>
      name.split(CHECKPOINT_STEP_DATE).join('x'.repeat(CHECKPOINT_STEP_DATE_LENGTH)).trim()
        .length <= CHECKPOINT_NAME_MAX_LENGTH,
    `A checkpoint name is at most ${CHECKPOINT_NAME_MAX_LENGTH} characters once ${CHECKPOINT_STEP_DATE} is replaced`,
  );

/**
 * A Checkpoint step's configuration: a take of `orgId`, as the Take page
 * asks one, every object people work in or the objects picked.
 * - `objects` come with `picked` alone; `excluded` with either mode;
 * - `name`, absent, is the take's start, as for a take on the page;
 * - `keepDays` is {@link CHECKPOINT_STEP_DEFAULT_KEEP_DAYS} when absent, 0
 *   keeping each checkpoint until it is deleted: a nightly step's
 *   checkpoints then pile up, one a night;
 * - `maxTotal`, absent, is the take's own default, 500,000 records.
 * The org's kind, the objects' existence and the take's limits are read at
 * the run, by the take.
 */
export const pipelineCheckpointStepConfigSchema = z
  .object({
    orgId: stepOrgIdSchema,
    mode: checkpointScopeModeSchema,
    objects: stepObjectsSchema.optional(),
    excluded: stepObjectsSchema.optional(),
    name: checkpointStepNameSchema.optional(),
    keepDays: z
      .number()
      .int()
      .min(0)
      .max(CHECKPOINT_STEP_MAX_KEEP_DAYS)
      .default(CHECKPOINT_STEP_DEFAULT_KEEP_DAYS),
    maxTotal: z.number().int().min(1).optional(),
    ignoredFields: checkpointIgnoredFieldsSchema.optional(),
  })
  .refine(
    (config) =>
      config.mode === 'picked' ? config.objects !== undefined : config.objects === undefined,
    {
      path: ['objects'],
      message: 'Name the objects with "picked", and none with "everything"',
    },
  );

/** A Checkpoint step's configuration, as read: {@link pipelineCheckpointStepConfigSchema}. */
export type PipelineCheckpointStepConfig = z.output<typeof pipelineCheckpointStepConfigSchema>;

/**
 * The checkpoint a Rewind step rewinds to, by its id. Never `latest`: a
 * confirmation given once for the latest checkpoint would hold for whichever
 * checkpoint is latest at the run, one nobody looked at, as the command
 * line's `--yes` refuses it.
 */
const namedCheckpointSchema = z
  .string()
  .refine(
    (id) => id.trim().toLowerCase() !== 'latest',
    'A Rewind step names its checkpoint by its id, never latest',
  )
  .pipe(checkpointIdSchema);

/**
 * A Rewind step's configuration: put `orgId` back to the checkpoint
 * `checkpointId` kept on this machine, whenever the pipeline runs, a schedule
 * too, once a person has confirmed it by typing the org's alias
 * ({@link rewindGrantDigest}).
 * - `objects`, absent, rewinds every object the checkpoint holds; given, the
 *   objects picked alone, a dependency named and never added;
 * - each acceptance is false unless the configuration says yes to it, as
 *   each flag of the command line is off unless given: the rewind is
 *   refused before writing where one it needs is missing;
 * - `maxRecords` is required: the most records the rewind may delete, give
 *   back, bring back and make again, all together, which stands in for the
 *   person who would read the preview (`RewindBounds`);
 * - `refuseWhenActive`, true unless the configuration says otherwise,
 *   refuses the rewind when someone else changed records of the
 *   checkpoint's objects in the hour before it.
 */
export const pipelineRewindStepConfigSchema = z.object({
  orgId: stepOrgIdSchema,
  checkpointId: namedCheckpointSchema,
  objects: stepObjectsSchema.optional(),
  acceptAutomation: z.boolean().default(false),
  acceptNoUndo: z.boolean().default(false),
  acceptRecreate: z.boolean().default(false),
  acceptOutside: z.boolean().default(false),
  acceptUnseen: z.boolean().default(false),
  maxRecords: z.number().int().min(1),
  refuseWhenActive: z.boolean().default(true),
});

/** A Rewind step's configuration, as read: {@link pipelineRewindStepConfigSchema}. */
export type PipelineRewindStepConfig = z.output<typeof pipelineRewindStepConfigSchema>;

/**
 * A Seed step's configuration: seed `orgId` with the template `templateId`,
 * one the Seed page saved or one SandForge ships (`prebuilt-*`). Whether the
 * template is there, reads, and holds no AI rule is the extension's to say,
 * from the templates it keeps.
 */
export const pipelineSeedStepConfigSchema = z.object({
  orgId: stepOrgIdSchema,
  templateId: stepTemplateIdSchema,
});

/** A Seed step's configuration, as read: {@link pipelineSeedStepConfigSchema}. */
export type PipelineSeedStepConfig = z.output<typeof pipelineSeedStepConfigSchema>;

/** The longest condition an Anonymize step filters rows by, as the DataOps request allows. */
const ANONYMIZE_STEP_MAX_WHERE_LENGTH = 2000;

/**
 * An Anonymize step's configuration: mask `orgId` with the template
 * `templateId`, one DataOps ships (`tpl-*`) or one the DataOps page saved,
 * every object its rules name or the one `object`, its rows held to `where`,
 * a SOQL condition without its `WHERE`.
 * - `where` comes with `object` alone, as on the DataOps page: a condition
 *   beside every object of a template would hold all of them to fields one of
 *   them has. An empty one filters nothing;
 * - what `where` may say — a filter and nothing past it — is the extension's
 *   SOQL rule to check, which the DataOps request applies.
 */
export const pipelineAnonymizeStepConfigSchema = z
  .object({
    orgId: stepOrgIdSchema,
    templateId: stepTemplateIdSchema,
    object: stepObjectNameSchema.optional(),
    where: z.string().max(ANONYMIZE_STEP_MAX_WHERE_LENGTH).optional(),
  })
  .refine(
    (config) =>
      config.where === undefined || config.where.trim() === '' || config.object !== undefined,
    { path: ['where'], message: 'A condition filters the rows of one object: name the object' },
  );

/** An Anonymize step's configuration, as read: {@link pipelineAnonymizeStepConfigSchema}. */
export type PipelineAnonymizeStepConfig = z.output<typeof pipelineAnonymizeStepConfigSchema>;

/**
 * What a Rewind step's confirmation is bound to, versioned: a change of what
 * it binds gives every confirmation a digest no configuration has, and asks
 * for each again rather than letting one stand for what it never covered.
 */
const REWIND_GRANT_BINDING = 'sandforge-rewind-grant/1';

/**
 * The digest a Rewind step's confirmation is kept with, `sha256:` and 64
 * hexadecimal digits: of what the step does to the org, every field of its
 * configuration — the org, the checkpoint, the objects, each acceptance, the
 * bound on records and the refusal when people are active — and nothing
 * else. A change of any of them gives another digest, which voids the
 * confirmation; the step's name, its description and a key the configuration
 * does not define change nothing, nor does the order its keys or its objects
 * are written in. The Automation page and the extension compute it alike.
 * @param config - The step's configuration, as {@link pipelineRewindStepConfigSchema} reads it
 */
export function rewindGrantDigest(config: PipelineRewindStepConfig): string {
  const bound = {
    binding: REWIND_GRANT_BINDING,
    orgId: config.orgId,
    checkpointId: config.checkpointId,
    // Absent: every object the checkpoint holds, which no list of them is.
    objects: config.objects === undefined ? null : [...config.objects].sort(),
    acceptAutomation: config.acceptAutomation,
    acceptNoUndo: config.acceptNoUndo,
    acceptRecreate: config.acceptRecreate,
    acceptOutside: config.acceptOutside,
    acceptUnseen: config.acceptUnseen,
    maxRecords: config.maxRecords,
    refuseWhenActive: config.refuseWhenActive,
  };
  return `sha256:${sha256Hex(JSON.stringify(bound))}`;
}
