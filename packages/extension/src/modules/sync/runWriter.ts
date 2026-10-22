/**
 * Which process writes a Sync or a Seed run, as the run's file names it: the
 * extension host of a window, or a command line, by its process id and when
 * that process started.
 *
 * Whether a run is still writing was known to the window writing it alone.
 * Every other window read a run with no end as one a closed window left: a
 * second window listing its earlier seeds while the first one uploaded a Bulk
 * API job read the job back by its id, found it open, and aborted it — the
 * first window's records were never written — and its Sync page listed the
 * run under the runs a closed window left, removable. Its removal kept what
 * it took, and what the first window created after it was never offered for
 * removal again. A Frozen load's journal already named its process
 * (`SasReferenceIdMappingStore`); a run's file now does too, and a run with no
 * end whose process is alive is read as running in another window, in every
 * window but its own.
 */

import { uptime } from 'node:os';

/** A process that writes runs: its id, and when it started, by this machine's clock. */
export interface RunWriterHost {
  pid: number;
  /** ISO 8601. */
  startedAt: string;
}

/** This process, as the runs it writes name it. */
export const THIS_HOST: RunWriterHost = {
  pid: process.pid,
  startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
};

/**
 * How long a run whose file says nothing new is still taken for one being
 * written, whatever process holds its id by then: a day. A run writes a line
 * before each call and as each answers; a process id the system gave another
 * process since the run's own ended would otherwise keep the run unremovable
 * for as long as that process lives.
 */
export const WRITER_QUIET_MS = 24 * 60 * 60_000;

/** How far two readings of when a process started may differ: the clocks they are read from. */
const STARTED_LEEWAY_MS = 60_000;

/** What {@link writtenElsewhere} reads of the machine, injected so it can be tested. */
export interface RunWriterChecks {
  /** Whether a process of this id is running. */
  isAlive?: (pid: number) => boolean;
  /** When the machine started, in epoch milliseconds. */
  bootedAt?: () => number;
  /** Now, in epoch milliseconds. */
  now?: () => number;
}

/**
 * Whether the process `pid` is running: `kill(pid, 0)` sends nothing and
 * fails only for a process that is not there, or one of another user's.
 */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // Running, owned by another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A run as {@link writtenElsewhere} reads it. */
export interface RunWriterRead {
  /** How the run ended: one that ended is written by nobody. */
  end?: unknown;
  /** The process its file names as writing it; absent from a file written before files named one. */
  writer?: { pid: number; hostStartedAt: string };
  /** When its file last dated a write, by this machine's clock. */
  lastWriteAt?: string;
  startedAt: string;
}

/**
 * Whether a run with no end is being written by another process than
 * `self`, alive: one whose file names a process that is running, started
 * since the machine last started, and that dated a write within
 * {@link WRITER_QUIET_MS}. A run of this process is its own to tell
 * (`isRunning`), and one whose file names no process, written before files
 * named one, is read as before: stopped.
 */
export function writtenElsewhere(
  run: RunWriterRead,
  self: RunWriterHost = THIS_HOST,
  checks: RunWriterChecks = {},
): boolean {
  if (run.end !== undefined || run.writer === undefined) return false;
  // This process, or one of the same id before it: either way not another one alive.
  if (run.writer.pid === self.pid) return false;
  const now = checks.now?.() ?? Date.now();
  const booted = checks.bootedAt?.() ?? Date.now() - uptime() * 1000;
  const hostStarted = Date.parse(run.writer.hostStartedAt);
  // A process from before the machine started is gone: the id is another's now.
  if (Number.isFinite(hostStarted) && hostStarted < booted - STARTED_LEEWAY_MS) return false;
  const last = Date.parse(run.lastWriteAt ?? run.startedAt);
  if (Number.isFinite(last) && now - last > WRITER_QUIET_MS) return false;
  return (checks.isAlive ?? processRunning)(run.writer.pid);
}
