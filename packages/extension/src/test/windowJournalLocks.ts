/**
 * The locks of Forge's run journals as the windows of the editor hold them:
 * each window a process of its own, and a window opened after another one
 * opened once that one closed — its process gone, and every lock it held
 * with it. The lock files are the product's own (`ForgeRunLock.ts`), kept in
 * a folder of their own, each window taking them as its own process.
 *
 * The tests that close a window under a run keep its journal in memory, at
 * a storage path given as `/storage`. Left to the handler's own locks, the
 * lock files went beside that path: a Linux or macOS runner could not create
 * it, and the runs went without a lock; a Windows runner created it at the
 * root of its drive, and there the one process that ran every window held
 * the lock of the run a closed window left, which then read as still
 * written, neither listed nor taken up.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ForgeJournalLocks } from '../bridge/handlers/ForgeHandler.js';
import { forgeRunWriting, lockForgeRun } from '../modules/forge/ForgeRunLock.js';
import type { LinkedLockOptions } from '../modules/checkpoint/linkedLock.js';

/** The windows of a test, one open at a time. */
export interface WindowJournalLocks {
  /** The locks of a window opened now: the window opened before it has closed. */
  opened(): ForgeJournalLocks;
  /** Remove the lock files. */
  dispose(): void;
}

/** A process id no process of the machine is told apart by: a window's own, from the first. */
const FIRST_WINDOW_PID = 990_000;

export function windowJournalLocks(): WindowJournalLocks {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-window-locks-'));
  const startedAt = new Date().toISOString();
  let open: number | undefined;
  let windows = 0;
  /** The lock file of a journal in memory, in the folder of the locks. */
  const fileOf = (journalPath: string): string => join(dir, basename(journalPath));
  return {
    opened() {
      const pid = FIRST_WINDOW_PID + windows;
      windows += 1;
      open = pid;
      const options: LinkedLockOptions = {
        self: { host: hostname(), pid, startedAt },
        // The window open alone runs; the machine started long before any of them.
        checks: { isAlive: (other) => other === open, bootedAt: () => 0 },
      };
      return {
        holder: (path) => forgeRunWriting(fileOf(path), options),
        take: (path, run) => {
          const taken = lockForgeRun(fileOf(path), { ...run, ranFrom: 'editor' }, options);
          return 'busy' in taken ? taken : { release: () => taken.lock.release() };
        },
      };
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
