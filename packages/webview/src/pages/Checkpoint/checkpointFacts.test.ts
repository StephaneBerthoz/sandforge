import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_NAME_MAX,
  isCheckpointName,
  objectsWithRecords,
  recordsHeld,
  roughSeconds,
  usableCheckpoints,
} from './checkpointFacts';
import { listEntry, readyCheckpoint } from './testing/checkpointFixtures';

describe('checkpointFacts', () => {
  it('counts the records of every object a checkpoint holds, and the objects holding some', () => {
    const checkpoint = readyCheckpoint();
    // Account 400, Contact 2,012 and an empty Campaign.
    expect(recordsHeld(checkpoint)).toBe(2412);
    expect(objectsWithRecords(checkpoint)).toBe(2);
  });

  it('offers only the checkpoints that can be rewound to, in the order listed', () => {
    const newest = listEntry(readyCheckpoint({ checkpointId: 'ck-20261022-090000-0001' }));
    const failed = listEntry(readyCheckpoint({ checkpointId: 'ck-20261021-090000-0002' }), {
      valid: false,
      why: 'failed',
    });
    const damaged = listEntry(null, { valid: false, why: 'damaged' });
    const older = listEntry(readyCheckpoint({ checkpointId: 'ck-20261020-090000-0003' }));
    expect(
      usableCheckpoints([newest, failed, damaged, older]).map((entry) => entry.checkpointId),
    ).toEqual(['ck-20261022-090000-0001', 'ck-20261020-090000-0003']);
  });

  it('says an estimate of time to ten seconds under a minute and to the minute above', () => {
    expect(roughSeconds(3)).toBe(10);
    expect(roughSeconds(38)).toBe(40);
    expect(roughSeconds(64)).toBe(60);
    expect(roughSeconds(95)).toBe(120);
  });

  it('holds a name to the store’s rule: one line, not blank, at most 120 characters', () => {
    expect(isCheckpointName('Before UAT')).toBe(true);
    expect(isCheckpointName('  Before UAT  ')).toBe(true);
    expect(isCheckpointName('x'.repeat(CHECKPOINT_NAME_MAX))).toBe(true);
    expect(isCheckpointName(` ${'x'.repeat(CHECKPOINT_NAME_MAX)} `)).toBe(true);
    expect(isCheckpointName('x'.repeat(CHECKPOINT_NAME_MAX + 1))).toBe(false);
    expect(isCheckpointName('   ')).toBe(false);
    // A line break would split the line the command line lists it on.
    expect(isCheckpointName('Before\nUAT')).toBe(false);
    expect(isCheckpointName('Before\u0085UAT')).toBe(false);
  });
});
