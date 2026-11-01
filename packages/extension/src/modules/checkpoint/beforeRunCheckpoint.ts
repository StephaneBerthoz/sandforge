/**
 * A checkpoint of what a run writes, taken before its first write (Checkpoint
 * first), and the one order every run that writes keeps from its reads to its
 * result: the five ideas of this release meet on that path, and each one's
 * part is in its place in it.
 *
 * The order of a run's write path, the same for Forge, Sync, Seed, Autopilot
 * and Frozen:
 *
 * 1. `reads` — the run's reads and the read of the target's automation, as
 *    they were.
 * 2. `leasePlan` — the plan of the mute's lease, nothing assigned: which sets
 *    it is to hold, what they silence and what still runs.
 * 3. `stillRunning` — what is computed of what still runs, by one function
 *    (`stillRunningOf`, shared): the checkpoint's scope (the objects the
 *    flows that still run create), the fit's room, the senders of emails.
 * 4. `deliverabilityRead` — whether the target delivers its emails, read only
 *    when a sender is left. The Apex runs as the run's user, lease or not:
 *    read before the lease, it reads the same.
 * 5. `question` — one question, its blocks in this order: what leaves the org
 *    (deliverability, the day's emails); the automation that still runs; the
 *    checkpoint (its cost, what it adds, what it leaves out); the storage,
 *    the API requests and the fit. Forge puts its automation and its emails
 *    before it reads its rows, and its checkpoint at its write gate, once they
 *    are read: two questions, the take after the second.
 * 6. `checkpointTake` — the take, as close to the first write as the answer
 *    lets it: what others change between the take and the run's end is taken
 *    back by a rewind to it too, so the take never waits on a person.
 * 7. `leaseAcquire` — the lease, taken as late as it can be, just before the
 *    first write, and read back: the shortest window the bypass is held.
 *    Taken after the take, it never dates what the take holds (an assignment
 *    and its removal left the data's `SystemModstamp` as it was).
 * 8. `afterLeaseCheck` — the lease held against its plan: a set not held that
 *    leaves a sender of emails running unaccepted, or a flow creating outside
 *    the checkpoint, refuses the run before any write, the lease given back
 *    and the checkpoint deleted ("the run wrote nothing"). A lease that
 *    assigned anything has the describes of the objects written read again:
 *    an assignment may open record types, and a fresh describe says so.
 * 9. `write`, then `leaseRelease` in a `finally`.
 * 10. `recordTypeReadBack` — the read of the record types the target gave
 *     the records created without one, once the lease is given back.
 * 11. `result`.
 *
 * Each module's order test counts its writes, assignments, deliverability
 * reads and takes against {@link writePathOrderDefects}.
 *
 * The take itself — its scope, its estimate, the disk it needs, the run's
 * own mark left out of what refuses it, its deletion when the run wrote
 * nothing — is built on these types.
 */

import type {
  CheckpointBeforeRunModule,
  RunCheckpointRequest,
  StillRunning,
} from '@sandforge/shared';

/** The steps of a run's write path, in their order. */
export const WRITE_PATH_STEPS = [
  'reads',
  'leasePlan',
  'stillRunning',
  'deliverabilityRead',
  'question',
  'checkpointTake',
  'leaseAcquire',
  'afterLeaseCheck',
  'write',
  'leaseRelease',
  'recordTypeReadBack',
  'result',
] as const;

/** A step of a run's write path ({@link WRITE_PATH_STEPS}). */
export type WritePathStep = (typeof WRITE_PATH_STEPS)[number];

/**
 * The run a checkpoint is taken before, as the take's check of the runs
 * writing to the org knows it: its own mark — the operation the panel holds
 * for it, the run file it writes — is left out of what refuses the take,
 * and only its own. Another run of the window, a run file another live
 * process writes and the store's lock refuse it as ever.
 */
export interface BeforeRunOwn {
  operationId?: string;
  runId?: string;
}

/** What the scope of a checkpoint before a run is computed from, at the run's gate, reading no record. */
export interface BeforeRunScopeInput {
  module: CheckpointBeforeRunModule;
  /** The objects the run writes, every operation together: inserts, updates, upserts and deletes. */
  written: readonly string[];
  /** What still runs once the run's mute plan holds: the flows whose creations the checkpoint holds too. */
  running: Pick<StillRunning<unknown>, 'firing'>;
  request: RunCheckpointRequest;
}

/**
 * What a run's path did out of the order above, each in words; empty when it
 * kept it. `events` is what the run did, as a test of it counts it: a step it
 * did not make is absent, one it made more than once — Forge's two questions,
 * a write per call — is there each time.
 *
 * Reads may come between two questions (Forge reads its rows after its
 * automation question). Past the last question, the order is strict: the
 * take, the lease, its check, the writes, the release, the read-back.
 */
export function writePathOrderDefects(events: readonly WritePathStep[]): string[] {
  const defects: string[] = [];
  // The first and the last place of a step; -1 for one the run did not make.
  const first = (step: WritePathStep): number => events.indexOf(step);
  const last = (step: WritePathStep): number => events.lastIndexOf(step);
  const before = (
    a: WritePathStep,
    b: WritePathStep,
    said: string,
    aAt = last(a),
    bAt = first(b),
  ): void => {
    if (aAt >= 0 && bAt >= 0 && aAt > bAt) defects.push(said);
  };
  before('leasePlan', 'stillRunning', 'what still runs was computed before the lease was planned');
  before(
    'stillRunning',
    'deliverabilityRead',
    'the deliverability was read before what still runs was known',
  );
  before(
    'deliverabilityRead',
    'question',
    'the deliverability was read after the question it belongs to',
    first('deliverabilityRead'),
  );
  before('question', 'checkpointTake', 'the checkpoint was taken before the last question');
  before('question', 'leaseAcquire', 'the lease was taken before the last question');
  before('checkpointTake', 'leaseAcquire', 'the lease was taken before the checkpoint');
  before('leaseAcquire', 'afterLeaseCheck', 'the lease was checked before it was taken');
  before('checkpointTake', 'write', 'a record was written before the checkpoint was taken');
  before('leaseAcquire', 'write', 'a record was written before the lease was taken');
  before('afterLeaseCheck', 'write', 'a record was written before the lease was checked');
  before('write', 'leaseRelease', 'the lease was given back before the last write');
  before('write', 'recordTypeReadBack', 'the record types were read back before the last write');
  before(
    'leaseRelease',
    'recordTypeReadBack',
    'the record types were read back while the lease was held',
  );
  if (first('leaseAcquire') >= 0 && first('leaseRelease') < 0) {
    defects.push('the lease was never given back');
  }
  const resultAt = first('result');
  if (resultAt >= 0 && events.slice(resultAt + 1).some((step) => step !== 'result')) {
    defects.push('the run went on past its result');
  }
  return defects;
}
