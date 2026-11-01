import { describe, it, expect } from 'vitest';

import {
  WRITE_PATH_STEPS,
  writePathOrderDefects,
  type WritePathStep,
} from './beforeRunCheckpoint.js';

/** A Sync, Seed or Autopilot run that mutes, asks, takes a checkpoint first and writes in two calls. */
const ONE_QUESTION: WritePathStep[] = [
  'reads',
  'leasePlan',
  'stillRunning',
  'deliverabilityRead',
  'question',
  'checkpointTake',
  'leaseAcquire',
  'afterLeaseCheck',
  'write',
  'write',
  'leaseRelease',
  'recordTypeReadBack',
  'result',
];

/** A Forge run: its emails asked with its automation, its rows read, its checkpoint at its write gate. */
const FORGE: WritePathStep[] = [
  'reads',
  'leasePlan',
  'stillRunning',
  'deliverabilityRead',
  'question',
  'reads',
  'question',
  'checkpointTake',
  'leaseAcquire',
  'afterLeaseCheck',
  'write',
  'leaseRelease',
  'recordTypeReadBack',
  'result',
];

/** `steps` with `step` moved to just before `before`. */
function moved(
  steps: WritePathStep[],
  step: WritePathStep,
  before: WritePathStep,
): WritePathStep[] {
  const without = steps.filter((s) => s !== step);
  const at = without.indexOf(before);
  return [...without.slice(0, at), step, ...without.slice(at)];
}

describe('the order of a run’s write path', () => {
  it('lists its steps in the order every module keeps', () => {
    expect(WRITE_PATH_STEPS).toEqual([
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
    ]);
    expect(writePathOrderDefects([...WRITE_PATH_STEPS])).toEqual([]);
  });

  it('finds nothing amiss in a run of one question, of Forge’s two, or of one without a mute, a checkpoint or emails', () => {
    expect(writePathOrderDefects(ONE_QUESTION)).toEqual([]);
    expect(writePathOrderDefects(FORGE)).toEqual([]);
    expect(writePathOrderDefects(['reads', 'question', 'write', 'result'])).toEqual([]);
  });

  it('finds a lease taken before the question, as Forge took it before its rows and its write gate', () => {
    expect(writePathOrderDefects(moved(FORGE, 'leaseAcquire', 'reads'))).toContain(
      'the lease was taken before the last question',
    );
    const leasedBeforeRows: WritePathStep[] = [
      'reads',
      'leasePlan',
      'question',
      'leaseAcquire',
      'reads',
      'question',
      'checkpointTake',
      'write',
      'leaseRelease',
      'result',
    ];
    expect(writePathOrderDefects(leasedBeforeRows)).toEqual([
      'the lease was taken before the last question',
      'the lease was taken before the checkpoint',
    ]);
  });

  it('finds a checkpoint taken after the lease, or before the question it is asked in', () => {
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'checkpointTake', 'afterLeaseCheck'))).toEqual(
      ['the lease was taken before the checkpoint'],
    );
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'checkpointTake', 'question'))).toEqual([
      'the checkpoint was taken before the last question',
    ]);
  });

  it('finds the deliverability read after the question, or before what still runs was known', () => {
    expect(
      writePathOrderDefects(moved(ONE_QUESTION, 'deliverabilityRead', 'checkpointTake')),
    ).toEqual(['the deliverability was read after the question it belongs to']);
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'deliverabilityRead', 'leasePlan'))).toEqual([
      'the deliverability was read before what still runs was known',
    ]);
  });

  it('finds a write before the lease or its check, a release before the last write, and a lease never given back', () => {
    expect(writePathOrderDefects(moved(ONE_QUESTION, 'afterLeaseCheck', 'leaseRelease'))).toContain(
      'a record was written before the lease was checked',
    );
    const releasedEarly: WritePathStep[] = [
      'reads',
      'question',
      'leaseAcquire',
      'write',
      'leaseRelease',
      'write',
      'result',
    ];
    expect(writePathOrderDefects(releasedEarly)).toEqual([
      'the lease was given back before the last write',
    ]);
    expect(writePathOrderDefects(['reads', 'question', 'leaseAcquire', 'write', 'result'])).toEqual(
      ['the lease was never given back'],
    );
  });

  it('finds the record types read back while the lease is held, and a run going on past its result', () => {
    expect(
      writePathOrderDefects(moved(ONE_QUESTION, 'recordTypeReadBack', 'leaseRelease')),
    ).toEqual(['the record types were read back while the lease was held']);
    expect(writePathOrderDefects(['reads', 'question', 'write', 'result', 'write'])).toEqual([
      'the run went on past its result',
    ]);
  });
});
