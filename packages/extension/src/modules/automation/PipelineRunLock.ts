/**
 * The lock that keeps two runs of one pipeline apart on this machine, the
 * editor's and the command line's (`sandforge pipeline run`).
 *
 * A pipeline exported and started by cron while VS Code is open could run
 * twice at once: the editor's own schedule falling due, or Run clicked on
 * the page, while the launcher's run goes on. The windows of the editor keep
 * their runs apart with markers in the extension's storage, which a command
 * line never reads. This lock is a file both read: `run.lock` in the
 * pipeline's folder, `<journal>/pipelines/<pipeline>/`, where the journal is
 * `SANDFORGE_JOURNAL_DIR` or `~/.sandforge`, the folder the checkpoints and
 * the runs' journals are kept in. A run under another `SANDFORGE_JOURNAL_DIR`
 * takes another lock, and its history is listed elsewhere: it is another
 * store, as the checkpoints of that folder are.
 *
 * Made on the checkpoint store's link-file mechanism (`linkedLock.ts`): the
 * file names the process that holds it, and a lock whose process is gone is
 * taken over, which the caller is told so it can say it. Only this machine is
 * kept apart: a CI job and an editor open elsewhere run the same pipeline at
 * once, which the export dialog says.
 *
 * The other locks of a run are not this one. Sync, Seed and Backup keep their
 * writes to an org apart in memory, per process: a pipeline run in the editor
 * and another pipeline's run from the command line can write to the same org
 * at once. Only the checkpoints' lock of an org is a file both read.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import type { TriggerType } from '@sandforge/shared';
import {
  linkedLockKind,
  lockHolderShape,
  type LinkedLockOptions,
} from '../checkpoint/linkedLock.js';

/** Where a run of a pipeline ran from: the editor, or the command line. */
export type PipelineRunPlace = 'editor' | 'commandLine';

/** A pipeline's run lock file, as it is written and read back. */
const runLockFileSchema = z.object({
  ...lockHolderShape,
  /** The pipeline's id, as its file or the editor names it. */
  pipelineId: z.string().min(1).max(200),
  /** Its name, for the line a refusal says; never more than the pipeline's own. */
  pipelineName: z.string().max(200).optional(),
  ranFrom: z.enum(['editor', 'commandLine']),
  triggeredBy: z.enum([
    'manual',
    'schedule',
    'event',
    'webhook',
    'sandbox_refresh',
    'deployment_complete',
  ]),
  /** A dry run, which writes nothing and holds the pipeline all the same. */
  dryRun: z.boolean().optional(),
});

type RunLockFile = z.infer<typeof runLockFileSchema>;

/** Who holds a pipeline's run lock, as a refusal names them. */
export type PipelineRunLockHolder = Omit<RunLockFile, 'version' | 'token'>;

/** A pipeline's run lock, held until it is released. */
export interface PipelineRunLock {
  readonly pipelineId: string;
  /** Let the lock go; once is enough, and again does nothing. */
  release(): void;
}

/** What a run takes the lock for. */
export interface PipelineRunLockRequest {
  pipelineName?: string;
  ranFrom: PipelineRunPlace;
  triggeredBy: TriggerType;
  dryRun?: boolean;
}

/**
 * The lock taken; `tookOver` names the run whose process had gone and whose
 * lock this one replaced, which the caller says in a line.
 */
export type PipelineRunLockOutcome =
  { lock: PipelineRunLock; tookOver?: PipelineRunLockHolder } | { busy: PipelineRunLockHolder };

const RUN_LOCKS = linkedLockKind((content) => {
  const parsed = runLockFileSchema.safeParse(content);
  return parsed.success ? parsed.data : undefined;
});

/** The name of a pipeline's run lock in its folder. */
const RUN_LOCK_FILE = 'run.lock';

/** A pipeline's id that names its folder as it is: letters, digits, dots, dashes and underscores. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Where the pipelines' folders are: `pipelines` in the folder
 * `SANDFORGE_JOURNAL_DIR` names, or in `~/.sandforge`.
 */
export function defaultPipelinesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  const home =
    dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
  return join(home, 'pipelines');
}

/**
 * The name of a pipeline's folder: its id, when it is plain — the editor
 * gives each pipeline a UUID — and otherwise `p-` and a digest of it. An id
 * comes from a file anybody can write, and is never used as a path as it is.
 */
export function pipelineFolderName(pipelineId: string): string {
  if (PLAIN_ID.test(pipelineId) && !pipelineId.includes('..')) return pipelineId;
  return `p-${createHash('sha256').update(pipelineId).digest('hex').slice(0, 32)}`;
}

/** A pipeline's folder: its lock, its command-line history, its launcher's log. */
export function pipelineFolderOf(root: string, pipelineId: string): string {
  return join(root, pipelineFolderName(pipelineId));
}

/** Where a pipeline's run lock is. */
export function pipelineRunLockFileOf(root: string, pipelineId: string): string {
  return join(pipelineFolderOf(root, pipelineId), RUN_LOCK_FILE);
}

/** The lock file as it is, read as a lock; undefined when there is none, or it does not read. */
function lockOnDisk(file: string): RunLockFile | undefined {
  try {
    const parsed = runLockFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function holderOf({
  version: _version,
  token: _token,
  ...holder
}: RunLockFile): PipelineRunLockHolder {
  return holder;
}

/**
 * Take the run lock of a pipeline. One whose holder is alive is said, and
 * nothing is taken; one whose holder is gone is taken over, and said too.
 */
export function acquirePipelineRunLock(
  root: string,
  pipelineId: string,
  request: PipelineRunLockRequest,
  options: LinkedLockOptions = {},
): PipelineRunLockOutcome {
  const file = pipelineRunLockFileOf(root, pipelineId);
  // A lock left by a run whose process is gone, which the take replaces: one
  // released between this read and the take is not said to be taken over.
  const left = lockOnDisk(file);
  const gone = left !== undefined && RUN_LOCKS.holder(file, options) === undefined;
  const outcome = RUN_LOCKS.acquire(
    file,
    (head) => ({
      ...head,
      pipelineId,
      ...(request.pipelineName !== undefined
        ? { pipelineName: request.pipelineName.slice(0, 200) }
        : {}),
      ranFrom: request.ranFrom,
      triggeredBy: request.triggeredBy,
      ...(request.dryRun ? { dryRun: true } : {}),
    }),
    options,
  );
  if ('busy' in outcome) return { busy: holderOf(outcome.busy) };
  return {
    lock: { pipelineId, release: outcome.lock.release },
    ...(gone && left !== undefined ? { tookOver: holderOf(left) } : {}),
  };
}

/** Who holds a pipeline's run lock, alive; undefined when nobody does. */
export function pipelineRunLockHolder(
  root: string,
  pipelineId: string,
  options: LinkedLockOptions = {},
): PipelineRunLockHolder | undefined {
  const holder = RUN_LOCKS.holder(pipelineRunLockFileOf(root, pipelineId), options);
  return holder !== undefined ? holderOf(holder) : undefined;
}

/** Where a run that holds the lock runs, as a line names it. */
function placeOf(holder: PipelineRunLockHolder): string {
  const what = holder.dryRun ? 'a dry run' : 'a run';
  return holder.ranFrom === 'commandLine'
    ? `${what} from the command line (sandforge pipeline run)`
    : `${what} in VS Code`;
}

/**
 * Why a run of a pipeline does not start: another run of it holds its lock on
 * this machine — who, since when, and to wait for it.
 */
export function pipelineRunningRefusal(
  holder: PipelineRunLockHolder,
  pipelineName: string,
): string {
  return (
    `Pipeline "${pipelineName}" is already running on this machine: ${placeOf(holder)} ` +
    `started at ${holder.acquiredAt} (process ${holder.pid} on ${holder.host}) has not ended. ` +
    'A pipeline runs once at a time: run it again once that run ends.'
  );
}

/** The line a run says when it took over the lock of a run whose process had gone. */
export function pipelineLockTakenOverLine(holder: PipelineRunLockHolder): string {
  return (
    `The run lock of pipeline "${holder.pipelineName ?? holder.pipelineId}" was left by ` +
    `${placeOf(holder)} started at ${holder.acquiredAt} (process ${holder.pid} on ${holder.host}), ` +
    'whose process has ended: taken over.'
  );
}
