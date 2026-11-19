/**
 * The handoff note of the Back into service page: what each step did, the
 * testers' starting point, what is left to do in the order a refresh's
 * checklist takes it, and what SandForge leaves to others — in Markdown, for
 * whoever takes the sandbox from there.
 *
 * It is made from the page's status and the audits the page read, and reads
 * nothing of the org. It names steps, checkpoints by their names, runs by
 * their numbers, jobs by their names and endpoints by their hosts — never a
 * value of a record, never an address. The sections no environment is needed
 * for are those `sandforge env apply` writes (`audit/handoffSections.ts`).
 *
 * It is kept where the command line keeps its notes, in a folder of its own
 * that no environment can be named, so that the two never write over each
 * other:
 *
 * ```
 * <journal>/handoff/                          0700
 *   _recovery/<instant>-<organizationId>.md   0600
 * ```
 *
 * The note of the org the sandbox is now is what tells the page its last
 * step is done, and what its Open opens again, unwritten.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RecoveryStatus, RecoveryStep, RecoveryStepId } from '@sandforge/shared';
import {
  code,
  handoffTitleOf,
  notTouchedLines,
  orgLineOf,
  secondOf,
  stillToDoLines,
  type HandoffAudits,
} from '../audit/handoffSections.js';
import type { AuditOrgInput } from '../audit/readAudits.js';
import { organizationKey } from '../checkpoint/OrgCheckpointStore.js';

/** What a folder of the notes is made with: its owner alone lists them. */
export const RECOVERY_HANDOFF_DIR_MODE = 0o700;

/** What a note is written with: its owner alone reads it. */
export const RECOVERY_HANDOFF_FILE_MODE = 0o600;

/** The page's folder among the notes: a name no environment can take (`^[a-z][a-z0-9-]*$`). */
export const RECOVERY_HANDOFF_FOLDER = '_recovery';

/** What the note is titled by, and what it names the page by. */
const SUBJECT = 'Back into service';

/** A note's file: when it was written, and of which org. */
const NOTE_FILE = /^(\d{8}T\d{9}Z)-(00D[A-Za-z0-9]{15})\.md$/;

/**
 * The folder the command lines keep their files in: the one
 * `SANDFORGE_JOURNAL_DIR` names, or `.sandforge` in the home directory.
 */
export function journalDirOf(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  return dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
}

/** The folder of the page's notes. */
export function recoveryHandoffFolderOf(journalDir: string): string {
  return join(resolve(journalDir), 'handoff', RECOVERY_HANDOFF_FOLDER);
}

/** Where a note of the org written at `at` is kept. */
export function recoveryHandoffPathOf(
  journalDir: string,
  input: { organizationId: string; at: string },
): string {
  const stamp = new Date(input.at).toISOString().replace(/[-:.]/g, '');
  return join(
    recoveryHandoffFolderOf(journalDir),
    `${stamp}-${organizationKey(input.organizationId)}.md`,
  );
}

/** The instant a note's stamp names, as ISO 8601. */
function instantOf(stamp: string): string {
  return (
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
    `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`
  );
}

/**
 * The newest note of the org: when it was written, and where it is — what
 * Open opens again, as it was left. None when no note of it is kept, or the
 * folder is not there.
 */
export async function newestHandoffOf(
  journalDir: string,
  organizationId: string,
): Promise<{ at: string; path: string } | undefined> {
  const key = organizationKey(organizationId);
  const folder = recoveryHandoffFolderOf(journalDir);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw err;
  }
  const notes = names.flatMap((name) => {
    const match = NOTE_FILE.exec(name);
    return match?.[1] !== undefined && match[2] === key ? [{ stamp: match[1], name }] : [];
  });
  const newest = notes.sort((a, b) => (a.stamp < b.stamp ? -1 : 1)).at(-1);
  return newest !== undefined
    ? { at: instantOf(newest.stamp), path: join(folder, newest.name) }
    : undefined;
}

/**
 * When the newest note of the org was written: none when no note of it is
 * kept, or the folder is not there.
 */
export async function lastHandoffOf(
  journalDir: string,
  organizationId: string,
): Promise<string | undefined> {
  return (await newestHandoffOf(journalDir, organizationId))?.at;
}

/** A step, as the note names it. */
const STEP_WORDS: Readonly<Record<RecoveryStepId, string>> = {
  refresh: 'Refresh noticed',
  users: 'Users',
  masking: 'Masking of the data copied from production',
  replay: 'Replay of the checkpoint of before',
  frozen: 'Frozen dataset loaded',
  testersCheckpoint: "Testers' starting checkpoint",
  deliverability: 'Email deliverability',
  scheduledJobs: 'Scheduled jobs',
  endpoints: 'Endpoints that still name production',
  handoff: 'Handoff note',
};

/** Why a step stands where it does, after its status. */
const REASON_WORDS: Readonly<Record<RecoveryStep['reason'], string>> = {
  refreshDetected: 'noticed',
  ranAfterRefresh: 'ran on the sandbox since its refresh',
  markedDone: 'checked and marked done',
  ready: 'kept',
  toDo: 'to do',
  skipped: 'skipped',
  noRefreshDetected: 'no refresh was noticed',
  nothingCopied: 'nothing of production was copied into this sandbox',
  noCheckpointBefore: 'no checkpoint of the sandbox was taken before its refresh',
  noManifest: 'no frozen dataset is kept on this machine',
  noInventoryBefore: 'no inventory of its jobs was kept before the refresh',
  noUserToBringBack: 'no user is under .invalid, frozen or inactive',
  stagingSandbox: 'the sandbox is marked Staging',
};

/** A status, as the note says it. */
const STATUS_WORDS: Readonly<Record<RecoveryStep['status'], string>> = {
  todo: 'to do',
  done: 'done',
  skipped: 'skipped',
  notApplicable: 'not applicable',
  refused: 'refused',
};

/** One step's line: its status, why, when, and what the status says of it beside. */
function stepLine(step: RecoveryStep, index: number, status: RecoveryStatus): string {
  const parts = [STATUS_WORDS[step.status]];
  if (step.status !== 'todo' && step.status !== 'skipped') parts.push(REASON_WORDS[step.reason]);
  if (step.at !== undefined) parts.push(secondOf(step.at));
  if (step.id === 'users' && status.lastUsersRun !== undefined) {
    parts.push(
      `last run ${status.lastUsersRun.run}, ${status.lastUsersRun.status}` +
        (status.lastUsersRun.takenBack === true ? ', taken back by its removal' : ''),
    );
  }
  if (step.id === 'replay' && status.checkpointBefore !== undefined) {
    parts.push(
      `checkpoint ${code(status.checkpointBefore.name)} of ${secondOf(status.checkpointBefore.takenAt)}`,
    );
  }
  return `${index + 1}. ${STEP_WORDS[step.id]}: ${parts.join(', ')}.`;
}

/** What the note is made of. */
export interface RecoveryHandoffInput {
  status: RecoveryStatus;
  /** The org, as the audits' sections name it. */
  org: AuditOrgInput;
  /** The audits the page read of the org now, when it read any. */
  audits?: HandoffAudits;
  /** When it is written. */
  at: string;
  sandforgeVersion?: string;
}

/** The note, in Markdown: see the module's comment. */
export function recoveryHandoffNoteOf(input: RecoveryHandoffInput): string {
  const { status, org } = input;
  const refresh = status.refresh;
  const refreshLine =
    refresh !== undefined
      ? `- Refresh: noticed ${secondOf(refresh.detectedAt)}` +
        (refresh.previousOrganizationId !== undefined
          ? `; the sandbox was ${code(refresh.previousOrganizationId)} before.`
          : '.')
      : '- Refresh: none was noticed; the steps are of the org the sandbox is.';
  const start = status.steps.find((step) => step.id === 'testersCheckpoint');
  const lines: string[] = [
    handoffTitleOf(SUBJECT, org),
    '',
    '## Sandbox',
    '',
    orgLineOf(org),
    refreshLine,
    `- Written: ${secondOf(input.at)}` +
      (input.sandforgeVersion !== undefined ? `, by SandForge ${input.sandforgeVersion}` : '') +
      `; ${status.done} of ${status.total} steps done.`,
    '',
    '## Steps',
    '',
    ...status.steps.map((step, index) => stepLine(step, index, status)),
    '',
    "## Testers' starting point",
    '',
    start?.status === 'done' && start.at !== undefined
      ? `- A checkpoint of the sandbox taken ${secondOf(start.at)}: what the testers start from, and what a rewind takes it back to.`
      : '- No checkpoint of the sandbox was taken since its refresh: take one before the testers start, to rewind to.',
    '',
    ...stillToDoLines(input.audits, {
      endpoints: 'step 9 of Back into service lists those that still name production.',
      schedules: 'step 8 of Back into service compares them with their inventory.',
    }),
    '',
    ...notTouchedLines(),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Write a note whole: into a file of its own beside it, its owner's alone,
 * flushed to the disk, then renamed into place. Its folder is made its
 * owner's alone when new.
 */
export async function writeRecoveryHandoff(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: RECOVERY_HANDOFF_DIR_MODE });
  const temp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', RECOVERY_HANDOFF_FILE_MODE);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
}
