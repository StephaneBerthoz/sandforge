/**
 * Each resource kind's lines for the script that runs it, and the reading of
 * what that script answers with `--json`: how an environment applies,
 * refreshes and destroys a resource without wiring a module of its own. The
 * script writes, gates and keeps its run file; the environment decides the
 * line and reads the answer.
 *
 * A `seed` resource runs `sandforge-seed`: a dry run and a run of the
 * template the environment converted from its file (`--template-file`),
 * under the run id it chose (`--run-id`); the removal of that run from the
 * summary it printed, and the preview of that removal (`--remove … --preview`).
 *
 * The answers are read with zod, off the shapes the script prints — its run
 * and dry-run summary (`main`), its preview (`removalPreviewJson`) — and an
 * answer that does not read as one is an error naming the script, never a
 * default: a plan that took a refusal it could not read for "nothing to do"
 * would apply over it.
 */

import { z } from 'zod';
import type { RunnableScript } from '../scriptRunner.js';

/** The script a `seed` resource runs. */
export const SEED_SCRIPT = 'sandforge-seed' satisfies RunnableScript;

/** The characters of an answer an error quotes, the first of it. */
export const ANSWER_EXCERPT_CHARS = 200;

/**
 * A value of a line: never one a script would take for a flag, the rule the
 * MCP server keeps for every value it puts on a line.
 */
function valueOf(flag: string, value: string): string {
  if (value === '' || value.startsWith('-')) {
    throw new Error(`${flag} cannot be "${value}": a value that starts with "-" reads as a flag.`);
  }
  return value;
}

/**
 * What a seed resource's run, or its dry run, is given. Nothing of it
 * accepts automation: a seed's run refuses past the emails its records send,
 * which no acceptance lifts, and reads no `--accept-automation` — given one,
 * it refused the whole line. Its removal takes one.
 */
export interface SeedRunLine {
  /** sf CLI alias of the org the environment is applied to. */
  target: string;
  /** The `SeedTemplate` the resource converts into, written to a file. */
  templateFile: string;
  /** The run's id, of the environment's making (`env-…`). */
  runId: string;
  /** What the run's draws are seeded with: the same records, run after run. */
  seed?: number;
  /** The locale the faker draws in; the org's own when absent. */
  locale?: string;
  /** Record types by object, by DeveloperName: `EnvSeedRun.recordTypes`. */
  recordTypes?: Readonly<Record<string, readonly string[]>>;
}

/** What a run and its dry run are given alike: the same records, planned then written. */
function seedRunSwitches(input: SeedRunLine): string[] {
  return [
    '--target',
    valueOf('--target', input.target),
    '--template-file',
    valueOf('--template-file', input.templateFile),
    '--run-id',
    valueOf('--run-id', input.runId),
    ...(input.seed !== undefined ? ['--seed', String(input.seed)] : []),
    ...(input.locale !== undefined ? ['--locale', valueOf('--locale', input.locale)] : []),
    ...Object.entries(input.recordTypes ?? {}).flatMap(([object, names]) => [
      '--record-type',
      valueOf('--record-type', `${object}=${names.join(',')}`),
    ]),
  ];
}

/** The line of a seed resource's run, its summary alone on stdout. */
export function seedApplyLine(input: SeedRunLine): string[] {
  return [
    ...seedRunSwitches(input),
    '--json',
    // A run that wrote some records and had others refused is partial: the
    // environment holds it to every record it planned.
    '--fail-on-partial',
  ];
}

/** The line of a seed resource's dry run: the same template, read and planned, nothing written. */
export function seedDryRunLine(input: SeedRunLine): string[] {
  return [...seedRunSwitches(input), '--dry-run', '--json'];
}

/** What the removal of a seed resource's run, or its preview, is given. */
export interface SeedRemovalLine {
  /** sf CLI alias of the org the run wrote to. */
  target: string;
  /** The summary the run printed with `--json`, saved by the environment. */
  summary: string;
  /** Take the records changed since the run too. */
  includeChanged?: boolean;
  /** Delete although the target runs automation as the records go. */
  acceptAutomation?: boolean;
  /** Remove the rest when the user may not delete some objects' records. */
  leaveUndeletable?: boolean;
}

/** The switches a removal and its preview share. */
function removalSwitches(input: SeedRemovalLine): string[] {
  return [
    ...(input.includeChanged === true ? ['--include-changed'] : []),
    ...(input.acceptAutomation === true ? ['--accept-automation'] : []),
    ...(input.leaveUndeletable === true ? ['--leave-undeletable'] : []),
  ];
}

/** The line of the removal of a seed resource's run, its outcome alone on stdout. */
export function seedRemoveLine(input: SeedRemovalLine & { sweep?: boolean }): string[] {
  return [
    '--remove',
    valueOf('--remove', input.summary),
    '--target',
    valueOf('--target', input.target),
    ...removalSwitches(input),
    ...(input.sweep === true ? ['--sweep'] : []),
    '--json',
  ];
}

/** The line of the preview of that removal: what it would do, nothing written. */
export function seedPreviewLine(input: SeedRemovalLine): string[] {
  return [
    '--remove',
    valueOf('--remove', input.summary),
    '--target',
    valueOf('--target', input.target),
    '--preview',
    ...removalSwitches(input),
    '--json',
  ];
}

// ─── The answers ─────────────────────────────────────────────────────────────

/** A Salesforce id, as every id an answer names is: a run's records, an org, a user. */
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/);

const countSchema = z.number().int().nonnegative();

/** One daily email limit the records send against, as the seed's gate counted it. */
const emailCheckSchema = z.object({
  limit: z.enum(['SingleEmail', 'DailyWorkflowEmails']),
  emails: countSchema,
  verdict: z.enum(['fits', 'exceeds', 'unread']),
  remaining: z.number().int().optional(),
  max: z.number().int().optional(),
  unread: z.string().optional(),
});

/** What the records make the target send, against what it has left today. */
const emailsSchema = z.object({
  checks: z.array(emailCheckSchema),
  refusal: z.string().optional(),
  unknown: z.array(z.string()).optional(),
});

/** One object of a seed's result. */
const seedObjectResultSchema = (ids: z.ZodType<string>) =>
  z.object({
    objectApiName: z.string().min(1),
    recordsCreated: countSchema,
    recordsFailed: countSchema,
    createdIds: z.array(ids),
    errors: z.array(z.string()),
    truncated: z.boolean().optional(),
  });

/** A seed's result: the orchestrator's, as the summary carries it. */
const seedResultSchema = (ids: z.ZodType<string>) =>
  z.object({
    templateId: z.string().optional(),
    operationId: z.string().min(1),
    status: z.enum(['success', 'partial', 'failure']),
    cancelled: z.boolean().optional(),
    objectResults: z.array(seedObjectResultSchema(ids)),
    totalRecordsCreated: countSchema,
    totalRecordsFailed: countSchema,
  });

/** What every seed summary says, run or dry run. */
const seedSummaryBase = {
  tool: z.literal(SEED_SCRIPT),
  target: z.string().min(1),
  seed: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  notes: z.array(z.string()).optional(),
  emails: emailsSchema,
  elapsedMs: countSchema,
  interrupted: z.literal(true).optional(),
};

/**
 * What `sandforge-seed --json` prints for a run that wrote: the records it
 * created by their ids, the org it wrote to, the file that keeps them.
 */
export const seedRunAnswerSchema = z.object({
  ...seedSummaryBase,
  dryRun: z.literal(false),
  /** Absent when the run created nothing, or the org did not say its id. */
  targetOrgId: idSchema.optional(),
  result: seedResultSchema(idSchema),
  /** Absent when the file could not be written: the summary is then what takes the run back. */
  runFile: z.string().min(1).optional(),
});

/** The data storage a dry run's records take, against what the target has left. */
const dryRunStorageSchema = z.object({
  bytes: countSchema,
  verdict: z.enum(['fits', 'near', 'exceeds', 'unread']),
  estimateMB: z.number().nonnegative(),
  maxMB: z.number().optional(),
  remainingMB: z.number().optional(),
  unread: z.string().optional(),
  /** What a real run would be refused for. */
  refusal: z.string().optional(),
});

/** The API requests a dry run's writes would make, against what the target has left today. */
const dryRunApiRequestsSchema = z.object({
  estimate: countSchema,
  verdict: z.enum(['fits', 'near', 'exceeds', 'unread']),
  max: z.number().int().optional(),
  remaining: z.number().int().optional(),
  unread: z.string().optional(),
  /** What a real run would be refused for. */
  refusal: z.string().optional(),
});

/**
 * What `sandforge-seed --dry-run --json` prints: the records a run would
 * create, per object — counted, with stand-ins for ids (`dry-0`, …) — the
 * emails they would make the target send, and the data storage and API
 * requests they would take, as the gates counted them. Nothing it names is
 * in the org.
 */
export const seedDryRunAnswerSchema = z.object({
  ...seedSummaryBase,
  dryRun: z.literal(true),
  storage: dryRunStorageSchema,
  apiRequests: dryRunApiRequestsSchema,
  result: seedResultSchema(z.string()),
});

/** One object of a removal, as the removal brick answers it: `ForgeUndoObjectResult`. */
const removalObjectSchema = z.object({
  objectApiName: z.string().min(1),
  planned: countSchema,
  deleted: countSchema,
  alreadyGone: countSchema,
  keptChanged: countSchema,
  keptDependents: countSchema,
  refused: countSchema,
  notVisible: countSchema.optional(),
  notReached: countSchema.optional(),
  heldBy: z.array(z.string()),
  reasons: z.array(z.string()),
});

/**
 * What `sandforge-seed --remove … --json` prints once a removal ran: how it
 * ended, and per object what it deleted, found gone, kept and was refused.
 * A removal refused before its first delete prints nothing on stdout.
 */
export const seedRemovalAnswerSchema = z.object({
  tool: z.literal(SEED_SCRIPT),
  action: z.literal('remove'),
  summary: z.string().min(1),
  target: z.string().min(1),
  includeChanged: z.boolean(),
  result: z.object({
    status: z.enum(['success', 'partial', 'failure', 'cancelled']),
    planned: countSchema,
    objects: z.array(removalObjectSchema),
    sweep: z.object({ status: z.string() }).loose().optional(),
  }),
  elapsedMs: countSchema,
});

/** One object of a removal preview: `RemovalPreviewObject`. */
const previewObjectSchema = z.object({
  objectApiName: z.string().min(1),
  planned: countSchema,
  toDelete: countSchema,
  alreadyGone: countSchema,
  changedSince: countSchema,
  keptChanged: countSchema,
  changedBy: z.record(idSchema, countSchema),
  undeletable: countSchema,
  notVisible: countSchema,
  unread: countSchema,
  reasons: z.array(z.string()),
});

/**
 * What `sandforge-seed --remove … --preview --json` prints: per object, what
 * a removal would delete, keep, leave and not find, and what it would be
 * refused for now. It wrote nothing.
 */
export const seedPreviewAnswerSchema = z.object({
  tool: z.literal(SEED_SCRIPT),
  action: z.literal('remove-preview'),
  summary: z.string().min(1),
  target: z.string().min(1),
  includeChanged: z.boolean(),
  preview: z.object({
    planned: countSchema,
    objects: z.array(previewObjectSchema),
    undeletable: z
      .array(z.object({ objectApiName: z.string().min(1), records: countSchema }))
      .optional(),
    userNames: z.record(idSchema, z.string()),
  }),
  refusals: z.array(z.string()),
  notes: z.array(z.string()),
  elapsedMs: countSchema,
});

export type SeedRunAnswer = z.infer<typeof seedRunAnswerSchema>;
export type SeedDryRunAnswer = z.infer<typeof seedDryRunAnswerSchema>;
export type SeedPreviewAnswer = z.infer<typeof seedPreviewAnswerSchema>;
export type SeedRemovalAnswer = z.infer<typeof seedRemovalAnswerSchema>;

/** An answer a step's script printed that does not read as the one asked for. */
export class StepAnswerError extends Error {
  constructor(
    /** The script that answered. */
    readonly script: RunnableScript,
    /** What its answer was read as. */
    readonly expected: string,
    /** Why it does not read as that. */
    readonly reason: string,
    /** The first {@link ANSWER_EXCERPT_CHARS} characters of what it printed. */
    readonly excerpt: string,
  ) {
    super(
      `${script} did not answer ${expected} (${reason}): ` +
        (excerpt === '' ? 'it printed nothing on stdout' : `it printed ${JSON.stringify(excerpt)}`),
    );
    this.name = 'StepAnswerError';
  }
}

/** `stdout` read with `schema`, or a {@link StepAnswerError} that names the script and quotes it. */
function readAnswer<T>(
  script: RunnableScript,
  expected: string,
  schema: z.ZodType<T>,
  stdout: string,
): T {
  const excerpt = stdout.trim().slice(0, ANSWER_EXCERPT_CHARS);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new StepAnswerError(script, expected, 'not JSON', excerpt);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'the answer';
    throw new StepAnswerError(
      script,
      expected,
      `${where}: ${issue?.message ?? 'refused'}`,
      excerpt,
    );
  }
  return parsed.data;
}

/** What a seed resource's run printed, read: see {@link seedRunAnswerSchema}. */
export function readSeedRun(stdout: string): SeedRunAnswer {
  return readAnswer(SEED_SCRIPT, 'the summary of a run', seedRunAnswerSchema, stdout);
}

/** What a seed resource's dry run printed, read: see {@link seedDryRunAnswerSchema}. */
export function readSeedDryRun(stdout: string): SeedDryRunAnswer {
  return readAnswer(SEED_SCRIPT, 'the summary of a dry run', seedDryRunAnswerSchema, stdout);
}

/** What the preview of a seed run's removal printed, read: see {@link seedPreviewAnswerSchema}. */
export function readSeedPreview(stdout: string): SeedPreviewAnswer {
  return readAnswer(SEED_SCRIPT, 'the preview of a removal', seedPreviewAnswerSchema, stdout);
}

/** What the removal of a seed run printed, read: see {@link seedRemovalAnswerSchema}. */
export function readSeedRemoval(stdout: string): SeedRemovalAnswer {
  return readAnswer(SEED_SCRIPT, 'the outcome of a removal', seedRemovalAnswerSchema, stdout);
}
