import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TriggerType } from '@sandforge/shared';

/** The run a pipeline's marker says is going. */
export interface RunHolder {
  /** When the run started, as an ISO date. */
  startedAt: string;
  /** What started it. */
  triggeredBy: TriggerType;
}

/** A pipeline held for a run, or the run that holds it already. */
export type HoldOutcome = { release(): void } | { busy: RunHolder };

/**
 * What the VS Code windows open on one machine share about pipeline runs.
 *
 * SandForge activates in every window, and each window runs its own extension
 * host with its own trigger scheduler: with two windows open, a schedule that
 * falls due is seen twice, and a sandbox refresh can be noticed by both. Without
 * something the windows share, each would start its own run of the pipeline.
 */
export interface TriggerClaims {
  /**
   * Take `key` for good: true for the one caller that takes it first, in this
   * window or another. A schedule claims each time it falls due, so that one
   * window starts the run, or reports it missed, and the others let it be.
   */
  claim(key: string): boolean;
  /**
   * Mark `pipelineId` as running until the returned `release` is called, or
   * say which run already holds it — in this window or in another.
   */
  hold(pipelineId: string, holder: RunHolder): HoldOutcome;
  /** Forget the claims taken more than `ageMs` ago. */
  prune(ageMs: number): void;
}

/** The claims of one window, kept in memory: a host with no shared storage, and the tests. */
export function memoryTriggerClaims(): TriggerClaims {
  const claimed = new Map<string, number>();
  const held = new Map<string, RunHolder>();
  return {
    claim(key) {
      if (claimed.has(key)) return false;
      claimed.set(key, Date.now());
      return true;
    },
    hold(pipelineId, holder) {
      const running = held.get(pipelineId);
      if (running) return { busy: running };
      held.set(pipelineId, holder);
      return { release: () => void held.delete(pipelineId) };
    },
    prune(ageMs) {
      const oldest = Date.now() - ageMs;
      for (const [key, at] of claimed) if (at < oldest) claimed.delete(key);
    },
  };
}

/**
 * The longest a run marker is believed. `sandforge.pipeline.timeout` stops
 * any run within an hour; a marker older than that and a margin was left by
 * a host that ended mid-run, even if its process id has since been reused.
 */
const MARKER_LIFETIME_MS = 65 * 60_000;

/** What a run marker holds. */
interface RunMarker extends RunHolder {
  pid: number;
  writtenAt: number;
}

/** What {@link fileTriggerClaims} needs besides its directory. */
export interface FileTriggerClaimsDeps {
  /** This extension host's process id. */
  pid?: number;
  /** Whether a process is still running; the marker of a host that is gone is stale. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  log?: (message: string) => void;
}

/** Whether a process exists: `kill(pid, 0)` sends nothing and fails only for a missing one. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a file operation failed because the file was already there. */
function alreadyThere(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * A file name for a key. Keys carry pipeline ids, which are whatever a saved
 * pipeline holds, so a key is never used as a path: its digest is.
 */
function fileNameOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Claims kept as files in a directory every window of the machine reaches —
 * the extension's global storage. A file created with `wx` exists once: the
 * one window whose create succeeds holds the claim.
 *
 * A file operation that fails for another reason than the file being there
 * (a read-only disk, a directory removed under it) falls back to this
 * window's memory, logged: the window still keeps its own runs apart, and
 * triggers keep firing.
 *
 * @param dir - The directory the claims live in; created when missing.
 */
export function fileTriggerClaims(dir: string, deps: FileTriggerClaimsDeps = {}): TriggerClaims {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? processIsAlive;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const claimsDir = path.join(dir, 'claims');
  const runningDir = path.join(dir, 'running');
  const fallback = memoryTriggerClaims();
  // This window's own runs: a marker it wrote is authoritative only while
  // listed here, which a marker left by a crashed run of this process is not.
  const held = new Map<string, RunHolder>();

  const ensureDirs = (): void => {
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.mkdirSync(runningDir, { recursive: true });
  };

  const readMarker = (file: string): RunMarker | undefined => {
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunMarker>;
      if (
        typeof marker.pid !== 'number' ||
        typeof marker.writtenAt !== 'number' ||
        typeof marker.startedAt !== 'string' ||
        typeof marker.triggeredBy !== 'string'
      ) {
        return undefined;
      }
      return marker as RunMarker;
    } catch {
      // Gone since it was seen, or half written: not a run anyone can prove.
      return undefined;
    }
  };

  const isLive = (marker: RunMarker): boolean =>
    marker.pid !== pid && isAlive(marker.pid) && now() - marker.writtenAt < MARKER_LIFETIME_MS;

  const removeQuietly = (file: string): void => {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already removed, by its owner or by another window.
    }
  };

  return {
    claim(key) {
      try {
        ensureDirs();
        fs.closeSync(fs.openSync(path.join(claimsDir, fileNameOf(key)), 'wx'));
        return true;
      } catch (err: unknown) {
        if (alreadyThere(err)) return false;
        log(`[pipeline-triggers] claims kept in memory: ${(err as Error).message}`);
        return fallback.claim(key);
      }
    },

    hold(pipelineId, holder) {
      const own = held.get(pipelineId);
      if (own) return { busy: own };
      const file = path.join(runningDir, `${fileNameOf(pipelineId)}.json`);
      const marker: RunMarker = { ...holder, pid, writtenAt: now() };
      // Twice at most: the second attempt follows the removal of a stale marker.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          ensureDirs();
          const fd = fs.openSync(file, 'wx');
          try {
            fs.writeSync(fd, JSON.stringify(marker));
          } finally {
            fs.closeSync(fd);
          }
          held.set(pipelineId, holder);
          return {
            release: () => {
              held.delete(pipelineId);
              removeQuietly(file);
            },
          };
        } catch (err: unknown) {
          if (!alreadyThere(err)) {
            log(`[pipeline-triggers] run markers kept in memory: ${(err as Error).message}`);
            const kept = fallback.hold(pipelineId, holder);
            if ('busy' in kept) return kept;
            held.set(pipelineId, holder);
            return {
              release: () => {
                held.delete(pipelineId);
                kept.release();
              },
            };
          }
          const other = readMarker(file);
          if (other && isLive(other)) {
            return { busy: { startedAt: other.startedAt, triggeredBy: other.triggeredBy } };
          }
          removeQuietly(file);
        }
      }
      // Another window took the marker between the removal and the retry.
      const other = readMarker(file);
      return {
        busy: other
          ? { startedAt: other.startedAt, triggeredBy: other.triggeredBy }
          : { startedAt: new Date(now()).toISOString(), triggeredBy: holder.triggeredBy },
      };
    },

    prune(ageMs) {
      fallback.prune(ageMs);
      let names: string[];
      try {
        names = fs.readdirSync(claimsDir);
      } catch {
        return;
      }
      const oldest = now() - ageMs;
      for (const name of names) {
        const file = path.join(claimsDir, name);
        try {
          if (fs.statSync(file).mtimeMs < oldest) fs.unlinkSync(file);
        } catch {
          // Pruned by another window meanwhile.
        }
      }
    },
  };
}
