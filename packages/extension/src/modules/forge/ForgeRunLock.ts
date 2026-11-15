/**
 * The lock a Forge run holds on its journal while it writes, so that nothing
 * removes the run under it: `<journal>.lock`, beside the journal in
 * `forge-runs/`.
 *
 * A clone writes its journal as it goes, and its summary with `--summary`
 * says where. Nothing kept a removal off a journal still being written: a
 * `--remove` of the summary, or of the journal itself, given while the run
 * went on, deleted what the run had created so far, and the run went on
 * creating records under parents that were gone, and names that no summary
 * would take back. Only the MCP server held its own runs apart.
 *
 * A run takes the lock as it begins its journal, or takes up an earlier part
 * of it (`--resume`), and lets it go once its part has ended. A removal takes
 * it too before it reaches any org, and holds it until it ends (`removes`):
 * it is refused while a run holds it, naming that run, and a run that would
 * take the journal up while the removal deletes what it wrote is refused,
 * naming the removal; so is a second run that would take up the same
 * journal. A removal read the lock and took none: a `--resume` given while
 * it deleted went on writing under it. The command line and the editor read
 * the same file: the panel's run and its removal take and read it as the
 * command line's do.
 *
 * Made on the checkpoint store's link-file mechanism (`linkedLock.ts`): the
 * file names the process that holds it, and a lock whose process is gone —
 * killed, or ended without letting it go — is no lock: a run killed part way
 * is removed as it always was. A lock taken more than a day before is taken
 * for one whose process is gone, as a run's writer is (`WRITER_QUIET_MS`).
 */

import * as z from 'zod';
import {
  linkedLockKind,
  lockHolderShape,
  type LinkedLock,
  type LinkedLockOptions,
} from '../checkpoint/linkedLock.js';

/** Where a run that writes a journal was started: the command line, or a window of the editor. */
export type ForgeRunPlace = 'commandLine' | 'editor';

/** A journal's lock file, as it is written and read back. */
const runLockFileSchema = z.object({
  ...lockHolderShape,
  /** The run's journal id, as its journal's head names it. */
  journalId: z.string().min(1).max(200),
  ranFrom: z.enum(['commandLine', 'editor']),
  /** The org it writes to, as the run names it: an alias, or the panel's name of the org. */
  target: z.string().min(1).max(255).optional(),
  /** Whether the run takes up an earlier part of the journal. */
  resumes: z.boolean().optional(),
  /** Whether the lock is a removal's, taking back what the run wrote, rather than a run's. */
  removes: z.boolean().optional(),
});

type RunLockFile = z.infer<typeof runLockFileSchema>;

/** Who holds a journal's lock, as a refusal names them. */
export type ForgeRunLockHolder = Omit<RunLockFile, 'version' | 'token'>;

/** What a run takes its journal's lock for. */
export interface ForgeRunLockRequest {
  journalId: string;
  ranFrom: ForgeRunPlace;
  target?: string;
  resumes?: boolean;
  /** Taken by a removal of what the run wrote, for as long as it deletes: see {@link ForgeRunLockHolder}. */
  removes?: boolean;
}

const RUN_LOCKS = linkedLockKind((content) => {
  const parsed = runLockFileSchema.safeParse(content);
  return parsed.success ? parsed.data : undefined;
});

/** The lock file of the journal at `journalPath`: beside it, its name with `.lock`. */
export function forgeRunLockFileOf(journalPath: string): string {
  return `${journalPath.replace(/\.ndjson$/, '')}.lock`;
}

function holderOf({
  version: _version,
  token: _token,
  ...holder
}: RunLockFile): ForgeRunLockHolder {
  return holder;
}

/**
 * Take the lock of the journal at `journalPath` for a run about to write it.
 * One whose holder is alive is said, and nothing is taken.
 */
export function lockForgeRun(
  journalPath: string,
  request: ForgeRunLockRequest,
  options: LinkedLockOptions = {},
): { lock: LinkedLock } | { busy: ForgeRunLockHolder } {
  const outcome = RUN_LOCKS.acquire(
    forgeRunLockFileOf(journalPath),
    (head) => ({
      ...head,
      journalId: request.journalId.slice(0, 200),
      ranFrom: request.ranFrom,
      ...(request.target !== undefined && request.target !== ''
        ? { target: request.target.slice(0, 255) }
        : {}),
      ...(request.resumes ? { resumes: true } : {}),
      ...(request.removes ? { removes: true } : {}),
    }),
    options,
  );
  return 'busy' in outcome ? { busy: holderOf(outcome.busy) } : outcome;
}

/**
 * The run that still writes the journal at `journalPath`, alive; undefined
 * when none does — never begun, ended, or its process gone.
 */
export function forgeRunWriting(
  journalPath: string,
  options: LinkedLockOptions = {},
): ForgeRunLockHolder | undefined {
  const holder = RUN_LOCKS.holder(forgeRunLockFileOf(journalPath), options);
  return holder !== undefined ? holderOf(holder) : undefined;
}

/**
 * Which run still writes a journal, as a refusal says it: the run, where it
 * was started and since when, by which process, to which org — or the
 * removal that takes back what it wrote, from which org.
 */
export function forgeRunWritingWords(holder: ForgeRunLockHolder): string {
  const where = holder.ranFrom === 'commandLine' ? 'from the command line' : 'in VS Code';
  if (holder.removes) {
    const from = holder.target !== undefined ? ` from ${holder.target}` : '';
    return (
      `a removal of the run ${holder.journalId} deletes what it wrote${from}: started ${where} ` +
      `at ${holder.acquiredAt} (process ${holder.pid} on ${holder.host})`
    );
  }
  const to = holder.target !== undefined ? ` to ${holder.target}` : '';
  const resumes = holder.resumes ? ', taking up an earlier part of it' : '';
  return (
    `the run ${holder.journalId} still writes this journal: started ${where}${to} at ` +
    `${holder.acquiredAt} (process ${holder.pid} on ${holder.host})${resumes}`
  );
}

/** How the run that holds a journal is stopped, where it runs: what comes before its removal. */
export function forgeRunStopWords(holder: ForgeRunLockHolder): string {
  if (holder.removes && holder.ranFrom === 'editor') {
    return 'let it end on the Forge page that removes it';
  }
  return holder.ranFrom === 'commandLine'
    ? 'stop it with Ctrl-C in the terminal it runs in, or let it end'
    : 'stop it on the Forge page that runs it, or let it end';
}
