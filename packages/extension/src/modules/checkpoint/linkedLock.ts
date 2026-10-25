/**
 * A lock one process of this machine holds at a time, in a file of its own:
 * made by linking a file written whole, so it exists once, for the one
 * process whose link succeeds, and is never read half written.
 *
 * The lock file names the process that holds it — its machine, its id, when
 * it started — and what it does, so a refusal can say who is at work. A lock
 * whose holder is gone is taken over: its process ended, or started before
 * the machine did, or the lock was taken longer ago than a run lasts.
 *
 * The checkpoint store keeps each org's takes, rewinds and undos apart with
 * it, and an environment keeps its applies and destroys of an org apart with
 * another file: the checkpoint an apply takes runs in a process of its own,
 * which its parent's lock would refuse were the two one file.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import * as z from 'zod';
import {
  THIS_HOST,
  WRITER_QUIET_MS,
  writtenElsewhere,
  type RunWriterChecks,
} from '../sync/runWriter.js';

/** What a folder of locks is made with: its owner alone lists it. */
const LOCKS_DIR_MODE = 0o700;

/** What a lock file is made with: its owner alone reads it. */
const LOCK_FILE_MODE = 0o600;

/** What every lock file says of the process that holds it, whatever it locks. */
export const lockHolderShape = {
  version: z.literal(1),
  /** The machine of the process that holds it. */
  host: z.string().min(1).max(255),
  pid: z.number().int().nonnegative(),
  /** When that process started, by its machine's clock. */
  hostStartedAt: z.iso.datetime({ offset: true }),
  acquiredAt: z.iso.datetime({ offset: true }),
  /** Tells this lock from any other taken by the same process. */
  token: z.string().min(1).max(64),
};

/** The part of a lock file {@link lockHolderShape} reads. */
export interface LockFileHead {
  version: 1;
  host: string;
  pid: number;
  hostStartedAt: string;
  acquiredAt: string;
  token: string;
}

/** A process that takes locks: its machine, its id, and when it started. */
export interface LockSelf {
  host: string;
  pid: number;
  startedAt: string;
}

/** This process. */
const THIS_PROCESS: LockSelf = {
  host: hostname(),
  pid: THIS_HOST.pid,
  startedAt: THIS_HOST.startedAt,
};

/** Who a lock is taken by, and how a holder is told alive from gone. */
export interface LinkedLockOptions {
  self?: LockSelf;
  checks?: RunWriterChecks;
}

/** A lock held until it is released. */
export interface LinkedLock {
  /** Let the lock go; once is enough, and again does nothing. */
  release(): void;
}

/** One kind of lock file: what it says besides its holder, read back by its own schema. */
export interface LinkedLockKind<L extends LockFileHead> {
  /**
   * Take the lock `file` names, saying what it is taken for. One whose holder
   * is alive is said, and nothing is taken.
   *
   * @param about - The lock file's content, from the part that names its holder.
   */
  acquire(
    file: string,
    about: (head: LockFileHead) => L,
    options?: LinkedLockOptions,
  ): { lock: LinkedLock } | { busy: L };
  /** Who holds the lock `file` names, alive; undefined when nobody does. */
  holder(file: string, options?: LinkedLockOptions): L | undefined;
}

/**
 * A kind of lock file. Each kind keeps the locks this process holds of it, by
 * process and file: a lock file naming this process is believed only while it
 * is listed there, since one left by an operation of this process that never
 * let it go names no work under way.
 *
 * @param read - A lock file's parsed content as this kind reads it, or
 *   undefined when it is not one: such a file is taken over.
 */
export function linkedLockKind<L extends LockFileHead>(
  read: (content: unknown) => L | undefined,
): LinkedLockKind<L> {
  const heldHere = new Map<string, L>();
  const lockIn = (raw: string): L | undefined => {
    try {
      return read(JSON.parse(raw));
    } catch {
      return undefined;
    }
  };
  /**
   * Whether the process a lock names is still at work. This very process holds
   * it while the lock is listed in `heldHere`. Another process of this machine
   * holds it while it runs, started after the machine did, within a run's
   * longest quiet ({@link writtenElsewhere}). A process of another machine
   * sharing this home folder cannot be asked, and holds it for that long.
   */
  const isAlive = (
    lock: L,
    file: string,
    self: LockSelf,
    checks: RunWriterChecks | undefined,
  ): boolean => {
    if (lock.host !== self.host) {
      const now = checks?.now?.() ?? Date.now();
      return now - Date.parse(lock.acquiredAt) < WRITER_QUIET_MS;
    }
    if (lock.pid === self.pid && lock.hostStartedAt === self.startedAt) {
      return heldHere.get(heldKey(self, file))?.token === lock.token;
    }
    return writtenElsewhere(
      {
        writer: { pid: lock.pid, hostStartedAt: lock.hostStartedAt },
        startedAt: lock.acquiredAt,
        lastWriteAt: lock.acquiredAt,
      },
      { pid: self.pid, startedAt: self.startedAt },
      checks,
    );
  };

  return {
    acquire(file, about, options = {}) {
      const self = options.self ?? THIS_PROCESS;
      const key = heldKey(self, file);
      const mine = heldHere.get(key);
      if (mine !== undefined) return { busy: mine };
      mkdirSync(dirname(file), { recursive: true, mode: LOCKS_DIR_MODE });
      const lock = about({
        version: 1,
        host: self.host,
        pid: self.pid,
        hostStartedAt: self.startedAt,
        acquiredAt: new Date(options.checks?.now?.() ?? Date.now()).toISOString(),
        token: randomUUID(),
      });
      const content = JSON.stringify(lock);
      // Three tries at most: each one that fails follows a lock taken over, or
      // one that went between two reads.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (linkedFresh(file, content)) {
          heldHere.set(key, lock);
          return {
            lock: {
              release: () => {
                if (heldHere.get(key)?.token !== lock.token) return;
                heldHere.delete(key);
                const raw = readQuietly(file);
                // Only this lock: another process may hold it by now, had this
                // one been taken over as gone.
                if (raw !== undefined && lockIn(raw)?.token === lock.token) unlinkQuietly(file);
              },
            },
          };
        }
        const raw = readQuietly(file);
        if (raw === undefined) continue;
        const holder = lockIn(raw);
        if (holder !== undefined && isAlive(holder, file, self, options.checks)) {
          return { busy: holder };
        }
        takeAway(file, raw);
      }
      const raw = readQuietly(file);
      return { busy: (raw !== undefined ? lockIn(raw) : undefined) ?? lock };
    },

    holder(file, options = {}) {
      const self = options.self ?? THIS_PROCESS;
      const mine = heldHere.get(heldKey(self, file));
      if (mine !== undefined) return mine;
      const raw = readQuietly(file);
      const holder = raw !== undefined ? lockIn(raw) : undefined;
      return holder !== undefined && isAlive(holder, file, self, options.checks)
        ? holder
        : undefined;
    },
  };
}

function heldKey(self: LockSelf, file: string): string {
  return `${self.host}\n${self.pid}\n${self.startedAt}\n${file}`;
}

/**
 * Make the lock file with `content`, if no lock file is there: a file of its
 * own written whole, then linked to the lock's name, which fails when the
 * name is taken. Both are its owner's alone.
 */
function linkedFresh(file: string, content: string): boolean {
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, content, { encoding: 'utf8', mode: LOCK_FILE_MODE, flag: 'wx' });
  try {
    linkSync(temp, file);
    return true;
  } catch (err: unknown) {
    if (codeOf(err) === 'EEXIST') return false;
    throw err;
  } finally {
    unlinkQuietly(temp);
  }
}

/**
 * Remove a lock judged gone, and that one only. It is moved aside first,
 * which one process alone can do; when what was moved is not the lock that
 * was judged — another process took it over between the read and the move —
 * it is put back where it was.
 */
function takeAway(file: string, judged: string): void {
  const aside = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.gone`;
  try {
    renameSync(file, aside);
  } catch {
    // Taken away by another process already.
    return;
  }
  if (readQuietly(aside) !== judged) {
    try {
      linkSync(aside, file);
    } catch {
      // A third process holds the name now: the lock it made stands.
    }
  }
  unlinkQuietly(aside);
}

function readQuietly(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if (codeOf(err) === 'ENOENT') return undefined;
    throw err;
  }
}

function unlinkQuietly(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}
