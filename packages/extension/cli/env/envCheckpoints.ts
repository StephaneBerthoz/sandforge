/**
 * The checkpoints of an environment's lifecycle, taken and rewound to by the
 * checkpoint script itself (`sandforge-checkpoint`), spawned with `--json` as
 * every step's script is: its guard — no production org, a user with View All
 * Data and Modify All Data, the org the checkpoint was taken of —, its lock,
 * its estimate and its preview hold as they hold on a terminal.
 *
 * - **`checkpoint.before: true`**: a checkpoint taken before the first write of
 *   the first apply that writes, never taken again while the state names it.
 *   `destroy --rewind` returns the org to it, whoever changed what since.
 * - **`checkpoint.after: <name>`**: a checkpoint taken once an apply ended 0,
 *   and taken again by the next apply that writes, the one before deleted:
 *   once an apply wrote, the org no longer holds the environment as that one
 *   holds it. `reset` rewinds the org to it between two test suites, and a
 *   plan compares the whole org with it, through its own preview.
 *
 * A plan says what each take would cost, by the checkpoint script's own
 * estimate (`take --estimate`), and what refuses it: a refusal refuses the
 * apply before its first write, since an apply that went ahead would leave the
 * environment without the checkpoint the file promises.
 *
 * The checkpoints are kept in `checkpoints/` of the journal directory, the
 * checkpoint script's own default for it, so they live where the state does,
 * outside the project's repository. A checkpoint holds the records' values in
 * clear: a cache that keeps the journal directory keeps them too.
 *
 * Once a destroy took every resource back, or a `destroy --rewind` returned
 * the org to before the first apply, the environment's checkpoints are
 * deleted: they hold the org's values, and nothing of the environment is left
 * to rewind. A `reset` keeps them, and the checkpoint script offers to undo
 * it, as it offers to undo any rewind; a `destroy --rewind` cannot be undone,
 * its rewind's journal deleted with its checkpoint.
 */

import { join } from 'node:path';
import { z } from 'zod';
import {
  checkpointIdSchema,
  type EnvCheckpointRefusal,
  type EnvCheckpointStep,
  type EnvCheckpointStepResult,
  type EnvFile,
  type EnvPlan,
  type EnvPlanCheckpoint,
  type EnvPlanDrift,
  type EnvRewindUndo,
  type EnvState,
  type EnvTargetKind,
} from '@sandforge/shared';
import { formatMB } from '../../src/modules/forge/ForgeRunGate.js';
import { DONE_EXIT, FAILED_EXIT } from '../exitCodes.js';
import type { CommandRun, CommandRunner, RunnableScript } from '../scriptRunner.js';
import { SCRATCH_STATE_KEEP_DAYS } from './envState.js';
import { StepAnswerError, countSchema, readAnswer, valueOf } from './kinds/common.js';

/** The script the checkpoints are taken, previewed, rewound to and deleted by. */
export const CHECKPOINT_SCRIPT = 'sandforge-checkpoint' satisfies RunnableScript;

/** Where an environment's checkpoints are kept: `checkpoints/` of its journal directory. */
export function envCheckpointStoreOf(journalDir: string): string {
  return join(journalDir, 'checkpoints');
}

/**
 * The days a checkpoint of the environment is kept: a scratch org's as long
 * as its state, which no scratch org outlives; any other's until the destroy
 * that deletes it.
 */
export function checkpointKeepDays(kind: EnvTargetKind): number {
  return kind === 'scratch' ? SCRATCH_STATE_KEEP_DAYS : 0;
}

/** The name a step's checkpoint is taken under: the file's own for `after`, `<env> before` for `before`. */
export function checkpointNameOf(
  file: Pick<EnvFile, 'name' | 'checkpoint'>,
  step: EnvCheckpointStep,
): string | undefined {
  if (step === 'before')
    return file.checkpoint?.before === true ? `${file.name} before` : undefined;
  const after = file.checkpoint?.after;
  return typeof after === 'string' ? after : undefined;
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** Where a line of the checkpoint script reaches, and keeps its checkpoints. */
export interface CheckpointLineBase {
  /** sf CLI alias of the org the environment is applied to. */
  org: string;
  /** The folder the checkpoints are kept in: {@link envCheckpointStoreOf}. */
  store: string;
}

function baseOf(input: CheckpointLineBase): string[] {
  return ['--org', valueOf('--org', input.org), '--store', valueOf('--store', input.store)];
}

/** The fields not compared, one `--ignore-field` each, as the file lists them. */
function ignoredOf(fields: readonly string[] | undefined): string[] {
  return (fields ?? []).flatMap((field) => ['--ignore-field', valueOf('--ignore-field', field)]);
}

/** The line of a take's estimate: what it would hold and cost, nothing read or kept. */
export function checkpointEstimateLine(
  input: CheckpointLineBase & { ignoreFields?: readonly string[] },
): string[] {
  return ['take', ...baseOf(input), ...ignoredOf(input.ignoreFields), '--estimate', '--json'];
}

/** The line of a take, under its name, kept as long as the environment needs it. */
export function checkpointTakeLine(
  input: CheckpointLineBase & { name: string; keepDays: number; ignoreFields?: readonly string[] },
): string[] {
  return [
    'take',
    ...baseOf(input),
    '--name',
    valueOf('--name', input.name),
    '--keep-days',
    String(input.keepDays),
    ...ignoredOf(input.ignoreFields),
    '--json',
  ];
}

/** The line of a preview: what a rewind to the checkpoint would do, nothing written. */
export function checkpointPreviewLine(
  input: CheckpointLineBase & { checkpoint: string },
): string[] {
  return [
    'preview',
    ...baseOf(input),
    '--checkpoint',
    checkpointIdSchema.parse(input.checkpoint),
    '--json',
  ];
}

/**
 * The line of a rewind, or of its preview with `dryRun`. It is named by its
 * id and asked nothing: the environment asked for the alias before. Its
 * acceptances are given only when the line that runs the environment gives
 * them; it never makes records again with new Ids, which the state would no
 * longer name.
 */
export function checkpointRewindLine(
  input: CheckpointLineBase & {
    checkpoint: string;
    dryRun: boolean;
    acceptAutomation: boolean;
    acceptNoUndo: boolean;
    /** Not given, not accepted. */
    acceptUnseen?: boolean;
  },
): string[] {
  return [
    'rewind',
    ...baseOf(input),
    '--checkpoint',
    checkpointIdSchema.parse(input.checkpoint),
    input.dryRun ? '--dry-run' : '--yes',
    ...(input.acceptAutomation ? ['--accept-automation'] : []),
    ...(input.acceptNoUndo ? ['--accept-no-undo'] : []),
    ...(input.acceptUnseen === true ? ['--accept-unseen'] : []),
    '--json',
  ];
}

/** The line of a checkpoint's deletion, from this machine: the org is not touched. */
export function checkpointDeleteLine(input: CheckpointLineBase & { checkpoint: string }): string[] {
  return [
    'delete',
    ...baseOf(input),
    '--checkpoint',
    checkpointIdSchema.parse(input.checkpoint),
    '--yes',
    '--json',
  ];
}

// ─── The answers ─────────────────────────────────────────────────────────────

/** A refusal, as the checkpoint script answers one with `--json`. */
const refusalSchema = z.object({ code: z.string().min(1), message: z.string().min(1) });

const refusedAnswerSchema = z.object({ refusal: refusalSchema });

/** What `take --estimate --json` prints: the take's cost, or what refuses it. */
const estimateAnswerSchema = z.union([
  z.object({
    mode: z.string(),
    estimate: z.object({
      records: countSchema,
      apiRequests: countSchema,
      apiRequestsLeft: z.number(),
      seconds: z.number().nonnegative(),
      bytes: countSchema,
    }),
    refusal: refusalSchema.optional(),
  }),
  refusedAnswerSchema,
]);

/** What `take --json` prints: the checkpoint as kept, or what refused it. */
const takeAnswerSchema = z.union([
  z.object({
    checkpoint: z.object({
      checkpointId: checkpointIdSchema,
      name: z.string().min(1),
      takenAt: z.string().min(1),
    }),
  }),
  refusedAnswerSchema,
]);

/** What `preview --json` and `rewind --dry-run --json` print: what a rewind would do now. */
const previewAnswerSchema = z.union([
  z.object({
    checkpoint: z.object({
      id: checkpointIdSchema,
      name: z.string().min(1),
      takenAt: z.string().min(1),
    }),
    toDelete: countSchema,
    toGiveBack: countSchema,
    toBringBack: countSchema,
    toRecreate: countSchema,
    differs: z.boolean(),
    diff: z.object({
      objects: z.array(
        z.object({
          objectApiName: z.string().min(1),
          lastChangedBy: z.record(z.string(), countSchema),
          touched: countSchema,
        }),
      ),
      userNames: z.record(z.string(), z.string()),
    }),
    refusal: refusalSchema.optional(),
  }),
  refusedAnswerSchema,
]);

/** Planned, done and left of one brick of a rewind, as its answer tallies them. */
const tallySchema = z.object({ planned: countSchema, done: countSchema, left: countSchema });

/** What `rewind --json` prints once a rewind ran: how it ended, and until when it can be undone. */
const rewindAnswerSchema = z.union([
  z.object({
    checkpoint: z.object({ id: checkpointIdSchema, name: z.string().min(1) }),
    rewindId: z.string().min(1),
    status: z.enum(['success', 'partial', 'unstable', 'failure', 'cancelled']),
    deleted: tallySchema,
    givenBack: tallySchema,
    broughtBack: tallySchema,
    undo: z.object({ until: z.string().min(1) }).optional(),
    residual: z.array(z.object({ object: z.string(), reason: z.string(), count: countSchema })),
  }),
  refusedAnswerSchema,
]);

/** What `delete --json` prints: the checkpoints deleted, and those a run of the org kept. */
const deleteAnswerSchema = z.union([
  z.object({ deleted: z.array(z.string()), kept: z.array(z.string()) }),
  refusedAnswerSchema,
]);

export type CheckpointEstimateAnswer = z.infer<typeof estimateAnswerSchema>;
export type CheckpointTakeAnswer = z.infer<typeof takeAnswerSchema>;
export type CheckpointPreviewAnswer = z.infer<typeof previewAnswerSchema>;
export type CheckpointRewindAnswer = z.infer<typeof rewindAnswerSchema>;
export type CheckpointDeleteAnswer = z.infer<typeof deleteAnswerSchema>;

export function readCheckpointEstimate(stdout: string): CheckpointEstimateAnswer {
  return readAnswer(CHECKPOINT_SCRIPT, 'the estimate of a take', estimateAnswerSchema, stdout);
}

export function readCheckpointTake(stdout: string): CheckpointTakeAnswer {
  return readAnswer(CHECKPOINT_SCRIPT, 'a take', takeAnswerSchema, stdout);
}

export function readCheckpointPreview(stdout: string): CheckpointPreviewAnswer {
  return readAnswer(CHECKPOINT_SCRIPT, 'a preview', previewAnswerSchema, stdout);
}

export function readCheckpointRewind(stdout: string): CheckpointRewindAnswer {
  return readAnswer(CHECKPOINT_SCRIPT, 'a rewind', rewindAnswerSchema, stdout);
}

export function readCheckpointDelete(stdout: string): CheckpointDeleteAnswer {
  return readAnswer(CHECKPOINT_SCRIPT, 'a deletion', deleteAnswerSchema, stdout);
}

/** The last line a script said on stderr: what a failure before its answer is. */
function lastLineOf(run: Pick<CommandRun, 'stderr'>): string {
  return (
    run.stderr
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? 'it said nothing'
  );
}

/**
 * A run's answer read with `read`, and as it printed it — what a result
 * carries, every key the reader does not read included — or why it gave none
 * that reads: its last line.
 */
function answerOf<T>(
  run: CommandRun,
  read: (stdout: string) => T,
): { answer: T; raw: unknown } | { unread: string } {
  try {
    const answer = read(run.stdout);
    return { answer, raw: JSON.parse(run.stdout) as unknown };
  } catch (err: unknown) {
    if (!(err instanceof StepAnswerError)) throw err;
    return { unread: `exit ${run.code}: ${lastLineOf(run)}` };
  }
}

// ─── The plan ────────────────────────────────────────────────────────────────

/**
 * The checkpoints an apply would take, by the file, the state and whether the
 * apply writes: `before` ahead of the first write of an environment no apply
 * wrote yet, `after` once it ended — again after an apply that writes, and
 * after one that writes nothing when the state names none.
 */
export function checkpointStepsOf(
  file: Pick<EnvFile, 'name' | 'checkpoint'>,
  state: Pick<EnvState, 'checkpoints' | 'resources'> | undefined,
  writes: boolean,
): Array<{ step: EnvCheckpointStep; name: string }> {
  const steps: Array<{ step: EnvCheckpointStep; name: string }> = [];
  const before = checkpointNameOf(file, 'before');
  if (before !== undefined && writes && beforeIsTakenNow(state)) {
    steps.push({ step: 'before', name: before });
  }
  const after = checkpointNameOf(file, 'after');
  if (after !== undefined && (writes || state?.checkpoints?.after === undefined)) {
    steps.push({ step: 'after', name: after });
  }
  return steps;
}

/** Whether the state holds what an earlier apply wrote: a resource not taken back. */
function holdsWrites(state: Pick<EnvState, 'resources'> | undefined): boolean {
  return Object.values(state?.resources ?? {}).some((r) => r.status !== 'destroyed');
}

/**
 * Whether a `before` checkpoint is taken by this apply: the state names none,
 * and holds nothing an earlier apply wrote. Taken once records of the
 * environment are in the org, a rewind to it would keep them, and a destroy
 * by rewind would leave them, the state saying them taken back.
 */
function beforeIsTakenNow(state: Pick<EnvState, 'checkpoints' | 'resources'> | undefined): boolean {
  return state?.checkpoints?.before === undefined && !holdsWrites(state);
}

/**
 * What the plan warns of the file's checkpoint settings: a `before` asked of
 * an environment an earlier apply wrote without one, which is never taken
 * now.
 */
export function checkpointWarningsOf(
  file: Pick<EnvFile, 'name' | 'checkpoint'>,
  state: Pick<EnvState, 'checkpoints' | 'resources'> | undefined,
): string[] {
  if (file.checkpoint?.before !== true || state?.checkpoints?.before !== undefined) return [];
  if (!holdsWrites(state)) return [];
  return [
    'checkpoint.before is taken before the first apply of an environment, and the org holds what ' +
      'an earlier apply wrote without one: it is not taken now, since a rewind to it would keep ' +
      'those records. Destroy the environment, then apply, to take it',
  ];
}

/** What a take's estimate read: its cost, its refusal, or why it said nothing. */
export type CheckpointEstimateRead =
  | { estimate: NonNullable<EnvPlanCheckpoint['estimate']>; refusal?: EnvCheckpointRefusal }
  | { refusal: EnvCheckpointRefusal }
  | { unread: string };

/** A take's estimate, read from its run. */
export function estimateReadOf(run: CommandRun): CheckpointEstimateRead {
  const read = answerOf(run, readCheckpointEstimate);
  if ('unread' in read) return read;
  const answer = read.answer;
  if (!('estimate' in answer)) return { refusal: answer.refusal };
  const { records, apiRequests, seconds, bytes } = answer.estimate;
  return {
    estimate: { records, apiRequests, seconds, bytes },
    ...(answer.refusal !== undefined ? { refusal: answer.refusal } : {}),
  };
}

/**
 * The checkpoints a plan lists, each with the estimate it was read with: one
 * estimate stands for both takes, which read the same objects of the org —
 * the one after holding, besides, the records the apply writes.
 *
 * @param written - The records the plan writes, at most: what the org holds more once applied.
 */
export function planCheckpointsOf(
  steps: ReadonlyArray<{ step: EnvCheckpointStep; name: string }>,
  read: CheckpointEstimateRead | undefined,
  written = 0,
): EnvPlanCheckpoint[] {
  return steps.map(({ step, name }) => {
    if (read === undefined) return { step, name, unread: 'not read: --quick' };
    if ('unread' in read) return { step, name, unread: read.unread };
    return {
      step,
      name,
      ...('estimate' in read
        ? {
            estimate:
              step === 'after'
                ? { ...read.estimate, records: read.estimate.records + written }
                : read.estimate,
          }
        : {}),
      ...(read.refusal !== undefined ? { refusal: read.refusal } : {}),
    };
  });
}

/** A step as a line names it. */
const STEP_WORDS: Readonly<Record<EnvCheckpointStep, string>> = {
  before: 'before the first write',
  after: 'once applied',
};

/**
 * What refuses an apply for its checkpoints, or nothing: a take the
 * checkpoint guard, the take's limit or the org's day refuses. Applied
 * without it, the environment would be left without the checkpoint the file
 * promises, and `reset` or `destroy --rewind` would have nothing to go back
 * to.
 */
export function checkpointRefusalOf(checkpoints: readonly EnvPlanCheckpoint[]): string | undefined {
  const refused = checkpoints.filter((c) => c.refusal !== undefined);
  if (refused.length === 0) return undefined;
  return (
    refused
      .map(
        (c) =>
          `The checkpoint the file asks ${STEP_WORDS[c.step]}, '${c.name}', would be refused: ` +
          `${c.refusal?.message ?? ''}`,
      )
      .join(' ') +
    ' Take checkpoint.before or checkpoint.after out of the file, or fix what refuses it.'
  );
}

/** The API requests the checkpoints of a plan take, and those not counted. */
export function checkpointRequestsOf(checkpoints: readonly EnvPlanCheckpoint[]): {
  estimate: number;
  notCounted: string[];
} {
  let estimate = 0;
  const notCounted: string[] = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.estimate !== undefined) estimate += checkpoint.estimate.apiRequests;
    else notCounted.push(`the checkpoint ${STEP_WORDS[checkpoint.step]}, not estimated`);
  }
  return { estimate, notCounted };
}

/** The drift of the whole org, read from the preview of the checkpoint taken after the last apply. */
export function driftOf(checkpoint: string, run: CommandRun): EnvPlanDrift {
  const read = answerOf(run, readCheckpointPreview);
  if ('unread' in read) return { checkpoint, differs: false, unread: read.unread };
  const answer = read.answer;
  if (!('differs' in answer)) {
    return { checkpoint, differs: false, unread: answer.refusal.message };
  }
  return {
    checkpoint,
    differs: answer.differs,
    toDelete: answer.toDelete,
    toGiveBack: answer.toGiveBack,
    toBringBack: answer.toBringBack,
  };
}

const count = (n: number): string => n.toLocaleString('en-US');

/** The lines a plan says of its checkpoints and of the whole org's drift. */
export function checkpointPlanLines(plan: Pick<EnvPlan, 'checkpoints' | 'drift'>): string[] {
  const lines: string[] = [];
  for (const checkpoint of plan.checkpoints ?? []) {
    const head = `checkpoint ${STEP_WORDS[checkpoint.step]}: '${checkpoint.name}'`;
    const { estimate } = checkpoint;
    if (estimate !== undefined) {
      lines.push(
        `${head}, about ${count(estimate.records)} records, ${count(estimate.apiRequests)} API ` +
          `requests, ${count(Math.ceil(estimate.seconds))} s, ` +
          `${formatMB(estimate.bytes / (1024 * 1024))} MB on this machine`,
      );
    } else {
      lines.push(`${head}, not estimated (${checkpoint.unread ?? 'no estimate'})`);
    }
    if (checkpoint.refusal !== undefined) {
      lines.push(`           refused: ${checkpoint.refusal.message}`);
    }
  }
  const drift = plan.drift;
  if (drift !== undefined) {
    const head = `the whole org against the checkpoint after the last apply (${drift.checkpoint})`;
    lines.push(
      drift.unread !== undefined
        ? `${head}: not compared, ${drift.unread}`
        : drift.differs
          ? `${head}: differs, ${count(drift.toDelete ?? 0)} to delete · ` +
            `${count(drift.toGiveBack ?? 0)} to give back · ` +
            `${count(drift.toBringBack ?? 0)} to bring back`
          : `${head}: nothing differs among the objects and fields it compares`,
    );
  }
  return lines;
}

// ─── The steps ───────────────────────────────────────────────────────────────

/** What a checkpoint step runs with. */
export interface CheckpointDeps {
  runner: CommandRunner;
  /** The journal directory, whose `checkpoints/` keeps them. */
  journalDir: string;
  say: (line: string) => void;
}

/** The org a step reaches, by its alias, and its kind, which says how long a checkpoint is kept. */
export interface CheckpointOrg {
  alias: string;
  kind: EnvTargetKind;
}

/** How a take ended: the step's result, and the checkpoint's id once it is kept. */
export interface CheckpointTaken {
  result: EnvCheckpointStepResult;
  checkpoint?: string;
}

/** Take one of the environment's checkpoints, under its name, through the checkpoint script. */
export async function takeEnvCheckpoint(
  deps: CheckpointDeps,
  input: {
    org: CheckpointOrg;
    step: EnvCheckpointStep;
    name: string;
    ignoreFields?: readonly string[];
  },
  signal: AbortSignal,
): Promise<CheckpointTaken> {
  deps.say(`checkpoint ${STEP_WORDS[input.step]}: taking '${input.name}'`);
  const ran = await deps.runner(
    CHECKPOINT_SCRIPT,
    checkpointTakeLine({
      org: input.org.alias,
      store: envCheckpointStoreOf(deps.journalDir),
      name: input.name,
      keepDays: checkpointKeepDays(input.org.kind),
      ...(input.ignoreFields !== undefined ? { ignoreFields: input.ignoreFields } : {}),
    }),
    signal,
  );
  const read = answerOf(ran, readCheckpointTake);
  const answer = 'answer' in read ? read.answer : undefined;
  const raw = 'raw' in read ? read.raw : undefined;
  if (ran.code === DONE_EXIT && answer !== undefined && 'checkpoint' in answer) {
    return {
      result: {
        step: input.step,
        checkpoint: answer.checkpoint.checkpointId,
        exitCode: ran.code,
        answer: raw,
      },
      checkpoint: answer.checkpoint.checkpointId,
    };
  }
  const refusal =
    answer !== undefined && 'refusal' in answer
      ? `${answer.refusal.code}: ${answer.refusal.message}`
      : 'unread' in read
        ? read.unread
        : `exit ${ran.code}`;
  return {
    result: {
      step: input.step,
      exitCode: ran.code === DONE_EXIT ? FAILED_EXIT : ran.code,
      refusal: refusal.slice(0, 4_000),
      ...(raw !== undefined ? { answer: raw } : {}),
    },
  };
}

/** Delete one of the environment's checkpoints from this machine, through the checkpoint script. */
export async function deleteEnvCheckpoint(
  deps: CheckpointDeps,
  input: { org: CheckpointOrg; checkpoint: string; why: string },
  signal: AbortSignal,
): Promise<EnvCheckpointStepResult> {
  deps.say(`checkpoint ${input.checkpoint}: deleted from this machine, ${input.why}`);
  const ran = await deps.runner(
    CHECKPOINT_SCRIPT,
    checkpointDeleteLine({
      org: input.org.alias,
      store: envCheckpointStoreOf(deps.journalDir),
      checkpoint: input.checkpoint,
    }),
    signal,
  );
  const read = answerOf(ran, readCheckpointDelete);
  const answer = 'answer' in read ? read.answer : undefined;
  const gone =
    answer !== undefined && 'deleted' in answer && answer.deleted.includes(input.checkpoint);
  // One no longer kept is as good as deleted: deleted by hand, or swept on its date.
  const notKept =
    answer !== undefined && 'refusal' in answer && answer.refusal.code === 'NOT_FOUND';
  if (gone || notKept) {
    return { step: 'delete', checkpoint: input.checkpoint, exitCode: DONE_EXIT };
  }
  const refusal =
    answer !== undefined && 'refusal' in answer
      ? `${answer.refusal.code}: ${answer.refusal.message}`
      : answer !== undefined && 'kept' in answer
        ? 'kept: a take, a rewind or an undo of the org is running'
        : 'unread' in read
          ? read.unread
          : `exit ${ran.code}`;
  deps.say(`  not deleted: ${refusal}`);
  return {
    step: 'delete',
    checkpoint: input.checkpoint,
    exitCode: ran.code === DONE_EXIT ? FAILED_EXIT : ran.code,
    refusal: refusal.slice(0, 4_000),
  };
}

/** The checkpoints a state names, each with its step, in the order a destroy deletes them. */
export function checkpointsOfState(
  state: Pick<EnvState, 'checkpoints'> | undefined,
): Array<{ step: EnvCheckpointStep; checkpoint: string }> {
  const out: Array<{ step: EnvCheckpointStep; checkpoint: string }> = [];
  if (state?.checkpoints?.after !== undefined) {
    out.push({ step: 'after', checkpoint: state.checkpoints.after });
  }
  if (state?.checkpoints?.before !== undefined) {
    out.push({ step: 'before', checkpoint: state.checkpoints.before });
  }
  return out;
}

/** The state with a step's checkpoint named, or forgotten. */
export function withCheckpoint(
  state: EnvState,
  step: EnvCheckpointStep,
  checkpoint: string | undefined,
): EnvState {
  const checkpoints: NonNullable<EnvState['checkpoints']> = { ...state.checkpoints };
  if (checkpoint !== undefined) checkpoints[step] = checkpoint;
  else delete checkpoints[step];
  const next: EnvState = { ...state, checkpoints };
  // A state that names none holds no `checkpoints` at all, as one never written with any.
  if (Object.keys(checkpoints).length === 0) delete next.checkpoints;
  return next;
}

// ─── Rewinds: reset, destroy --rewind ────────────────────────────────────────

/** What a rewind's preview said: what it would do, who last changed it, and what refuses it. */
export interface RewindPreview {
  checkpoint: { id: string; name: string; takenAt: string };
  toDelete: number;
  toGiveBack: number;
  toBringBack: number;
  /** By the name of each user, the records to delete or give back they last changed. */
  lastChangedBy: Record<string, number>;
  differs: boolean;
  refusal?: EnvCheckpointRefusal;
}

/** A rewind's preview, read from its dry run, or why it said nothing. */
export function rewindPreviewOf(run: CommandRun): RewindPreview | { refusal: string } {
  const read = answerOf(run, readCheckpointPreview);
  if ('unread' in read) return { refusal: read.unread };
  const answer = read.answer;
  if (!('differs' in answer)) return { refusal: answer.refusal.message };
  const by: Record<string, number> = {};
  for (const object of answer.diff.objects) {
    for (const [userId, n] of Object.entries(object.lastChangedBy)) {
      const name = answer.diff.userNames[userId] ?? userId;
      by[name] = (by[name] ?? 0) + n;
    }
  }
  return {
    checkpoint: answer.checkpoint,
    toDelete: answer.toDelete,
    toGiveBack: answer.toGiveBack,
    toBringBack: answer.toBringBack,
    lastChangedBy: by,
    differs: answer.differs,
    ...(answer.refusal !== undefined ? { refusal: answer.refusal } : {}),
  };
}

/** Who last changed what a rewind deletes or gives back, most first, as a line names them. */
export function changedByWords(lastChangedBy: Readonly<Record<string, number>>): string {
  return Object.entries(lastChangedBy)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${count(n)}`)
    .join(', ');
}

/** The lines a rewind's preview is said in, before its question. */
export function rewindPreviewLines(
  verb: 'reset' | 'destroy',
  alias: string,
  preview: RewindPreview,
): string[] {
  const to = `'${preview.checkpoint.name}' (${preview.checkpoint.id}), taken ${preview.checkpoint.takenAt}`;
  const lines = [
    verb === 'reset'
      ? `reset ${alias} to the checkpoint taken after the last apply, ${to}:`
      : `destroy by rewinding ${alias} to the checkpoint taken before the first apply, ${to}:`,
    `  ${count(preview.toDelete)} to delete · ${count(preview.toGiveBack)} to give back · ` +
      `${count(preview.toBringBack)} to bring back` +
      (preview.differs ? '' : ' — nothing differs: nothing to rewind'),
  ];
  const by = changedByWords(preview.lastChangedBy);
  if (by !== '') lines.push(`  last changed by: ${by}`);
  if (preview.refusal !== undefined) lines.push(`  refused: ${preview.refusal.message}`);
  return lines;
}

/** How a rewind ran, read from its answer. */
export interface RewindRan {
  exitCode: number;
  status: 'success' | 'partial' | 'unstable' | 'failure' | 'cancelled';
  answer?: unknown;
  /** What it deleted, gave back and brought back. */
  done?: { deleted: number; givenBack: number; broughtBack: number; differing: number };
  /** Until when the checkpoint script offers to undo it, when it does. */
  undoUntil?: string;
  refusal?: EnvCheckpointRefusal;
}

/** A rewind's run, read: its status from its answer, or from its exit code when it gave none. */
export function rewindRanOf(run: CommandRun): RewindRan {
  const read = answerOf(run, readCheckpointRewind);
  const answer = 'answer' in read ? read.answer : undefined;
  const raw = 'raw' in read ? read.raw : undefined;
  if (answer !== undefined && 'status' in answer) {
    return {
      exitCode: run.code,
      status: answer.status,
      answer: raw,
      done: {
        deleted: answer.deleted.done,
        givenBack: answer.givenBack.done,
        broughtBack: answer.broughtBack.done,
        differing: answer.residual.reduce((sum, r) => sum + r.count, 0),
      },
      ...(answer.undo !== undefined ? { undoUntil: answer.undo.until } : {}),
    };
  }
  const refusal: EnvCheckpointRefusal =
    answer !== undefined && 'refusal' in answer
      ? answer.refusal
      : { code: 'UNREAD', message: 'unread' in read ? read.unread : `exit ${run.code}` };
  return {
    exitCode: run.code === DONE_EXIT ? FAILED_EXIT : run.code,
    status: run.code >= 128 ? 'cancelled' : 'failure',
    ...(raw !== undefined ? { answer: raw } : {}),
    refusal,
  };
}

/**
 * Whether the checkpoint script offers to undo a rewind, and in its words:
 * until when, sooner if the recycle bin fills, and the line that does it. A
 * destroy's is never offered: its checkpoints, the rewind's journal among
 * them, are deleted once the org is back before the first apply.
 */
export function rewindUndoOf(
  input: {
    verb: 'reset' | 'destroy';
    alias: string;
    checkpoint: string;
    journalDir: string;
    /** The checkpoints were deleted once the rewind ended. */
    deleted: boolean;
  },
  ran: RewindRan,
): EnvRewindUndo {
  if (input.deleted) {
    return {
      offered: false,
      why:
        'the environment’s checkpoints are deleted with it, the journal of this rewind among ' +
        'them: a destroy is undone by applying again',
    };
  }
  if (ran.undoUntil === undefined) {
    return {
      offered: false,
      why:
        ran.status === 'failure' || ran.status === 'cancelled'
          ? 'the checkpoint script offers no undo of a rewind that wrote nothing it can take back'
          : 'the checkpoint script offers none: the rewind wrote nothing',
    };
  }
  return {
    offered: true,
    until: new Date(Date.parse(ran.undoUntil)).toISOString(),
    line:
      `sandforge-checkpoint undo --org ${input.alias} --checkpoint ${input.checkpoint} ` +
      `--store ${envCheckpointStoreOf(input.journalDir)}`,
  };
}

/** The line a rewind's undo is said in. */
export function undoLine(undo: EnvRewindUndo): string {
  return undo.offered
    ? `undo it until ${undo.until}, sooner if the recycle bin fills: ${undo.line}`
    : `no undo: ${undo.why}`;
}
