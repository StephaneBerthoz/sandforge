import type {
  CheckpointRewindEnded,
  CheckpointRewindListed,
  CheckpointRewindUndone,
} from '../types/checkpoint.types.js';

/**
 * Whether a run of Seed, Sync or Forge was taken back by a rewind, told by
 * dates alone: the run's, on this machine's clock, against those the rewind
 * ledger keeps of each rewind (`CheckpointRewindRecord`). No record id is
 * compared — a rewind of the command line never sees the runs the panel
 * keeps, and the other way round —, so the mark is the same whichever tool
 * rewound, and the exact count of a run's records a rewind took stays the
 * run's removal preview to give.
 *
 * A rewind to a checkpoint deletes what was created after the take began
 * (T0) and gives back what was changed after it, as the org stood when the
 * rewind began its reads (Tr). A run that wrote between the end of the take
 * (T1) and Tr was taken back whole; one that wrote while the checkpoint was
 * taken, or while the rewind ran, in part — what the take read of it, the
 * checkpoint holds and the rewind keeps; what it wrote after Tr, the rewind
 * may not have read; and one that had ended before T0 not at all: the
 * checkpoint holds its records, which is why it is never marked.
 */

/**
 * The margin around every bound, both ways: the run is dated by one machine,
 * the rewind by the org, through a reading of the org's clock by possibly
 * another machine, and clocks kept by NTP drift apart by seconds. A run this
 * close to a bound reads as rewound in part, never as rewound whole or not
 * at all.
 */
export const REWOUND_MARGIN_MS = 2 * 60_000;

/** A run of Seed, Sync or Forge, as its history dates it, on this machine's clock. */
export interface RewoundRun {
  /** The org it wrote to, by its id in this machine's registry. */
  orgId: string;
  startedAt: string;
  /** Absent while it writes: it is then dated to now. */
  endedAt?: string;
  /**
   * The objects it wrote, as its history names them. Absent, or empty, when
   * the history does not say: the run is then read as within the checkpoint.
   */
  objects?: readonly string[];
}

/**
 * How a rewind took a run back: whole, in part — the run wrote while the
 * checkpoint was taken or while the rewind ran —, or by a rewind stopped
 * part way, which took back what it reached.
 */
export type RewoundMarkKind = 'rewound' | 'partly' | 'stopped';

/** What a run's line says of the rewind that took it back. */
export interface RewoundMark {
  kind: RewoundMarkKind;
  rewindId: string;
  checkpointId: string;
  checkpointName: string;
  /** When the rewind ended, on this machine's clock. */
  at: string;
  /** The rewind left records that still differ: partial, unstable, or ended before it was through. */
  leftSome: boolean;
  /** When an undo took the rewind back, on this machine's clock: the run's records came back. */
  undoneAt?: string;
  /** The objects the run wrote that the checkpoint did not hold, as the run names them: not rewound. */
  outside: string[];
}

/** A rewind's bounds on this machine's clock, in milliseconds. */
interface Bounds {
  t0: number;
  t1: number;
  tr: number;
  end: number;
}

function boundsOf(rewind: CheckpointRewindEnded): Bounds | undefined {
  const ahead = rewind.orgAheadMs ?? 0;
  const bounds = {
    t0: Date.parse(rewind.readFrom) - ahead,
    t1: Date.parse(rewind.takenAt) - ahead,
    tr: Date.parse(rewind.startedAt) - ahead,
    end: Date.parse(rewind.endedAt) - ahead,
  };
  return Object.values(bounds).every(Number.isFinite) ? bounds : undefined;
}

/** A rewind that covers the run, and how. */
interface Covering {
  rewind: CheckpointRewindEnded;
  bounds: Bounds;
  kind: RewoundMarkKind;
  outside: string[];
  undo?: CheckpointRewindUndone;
}

/**
 * How `rewind` took back a run of `start` to `end`, and what of its objects
 * the checkpoint did not hold; undefined when it took back nothing of it: the
 * run ended before the take began, began after the rewind ended, or wrote
 * only objects the checkpoint did not hold.
 */
function coveringOf(
  rewind: CheckpointRewindEnded,
  start: number,
  end: number,
  objects: readonly string[],
): Omit<Covering, 'undo'> | undefined {
  const bounds = boundsOf(rewind);
  if (bounds === undefined) return undefined;
  const m = REWOUND_MARGIN_MS;
  if (end < bounds.t0 - m || start > bounds.end + m) return undefined;
  const held = new Set(rewind.objects.map((name) => name.toLowerCase()));
  const outside = objects.filter((name) => !held.has(name.toLowerCase()));
  if (objects.length > 0 && outside.length === objects.length) return undefined;
  const kind: RewoundMarkKind =
    rewind.status === 'cancelled'
      ? 'stopped'
      : start > bounds.t1 + m && end < bounds.tr - m
        ? 'rewound'
        : 'partly';
  return { rewind, bounds, kind, outside };
}

/** The run's objects, each named once, whatever its case. */
function namesOf(objects: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of objects ?? []) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * The mark a run's line carries, or undefined when no rewind of its org took
 * any of it back.
 *
 * Of several rewinds that cover the run, the one that took its writes back
 * is the oldest that went through and was not undone: a later one found
 * them gone. Failing that, the latest stopped part way that was not undone;
 * failing that, the latest undone, whose undo brought the run's records back.
 * A rewind stopped and taken up again ends under the same id: its last line
 * stands.
 *
 * @param run - The run, on this machine's clock.
 * @param records - The ledger's lines, as `checkpoint:rewinds` answers them,
 *   in the order they were written.
 * @param now - This machine's clock: the end of a run that has none yet.
 */
export function rewoundMarkOf(
  run: RewoundRun,
  records: readonly CheckpointRewindListed[],
  now: number,
): RewoundMark | undefined {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt === undefined ? now : Date.parse(run.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const objects = namesOf(run.objects);

  const rewinds = new Map<string, CheckpointRewindEnded>();
  const undos = new Map<string, CheckpointRewindUndone>();
  for (const record of records) {
    if (!record.orgIds.includes(run.orgId)) continue;
    if (record.kind === 'rewind') {
      // Taken up after a stop, a rewind ends under its id: the later line stands.
      rewinds.delete(record.rewindId);
      rewinds.set(record.rewindId, record);
    } else {
      undos.set(record.rewindId, record);
    }
  }

  const covering: Covering[] = [];
  for (const rewind of rewinds.values()) {
    const found = coveringOf(rewind, start, end, objects);
    if (found === undefined) continue;
    const undo = undos.get(rewind.rewindId);
    covering.push(undo ? { ...found, undo } : found);
  }
  if (covering.length === 0) return undefined;
  covering.sort((a, b) => a.bounds.tr - b.bounds.tr || a.bounds.end - b.bounds.end);

  const kept = covering.filter((each) => each.undo === undefined);
  const chosen =
    kept.find((each) => each.kind !== 'stopped') ??
    kept[kept.length - 1] ??
    covering[covering.length - 1];
  if (chosen === undefined) return undefined;
  const { rewind, bounds, kind, outside, undo } = chosen;
  return {
    kind,
    rewindId: rewind.rewindId,
    checkpointId: rewind.checkpointId,
    checkpointName: rewind.checkpointName,
    at: new Date(bounds.end).toISOString(),
    leftSome:
      rewind.status === 'partial' || rewind.status === 'unstable' || rewind.status === 'failure',
    ...(undo ? { undoneAt: undo.undoneAt } : {}),
    outside,
  };
}
