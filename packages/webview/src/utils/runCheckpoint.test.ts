import { describe, expect, it } from 'vitest';
import type { RunCheckpointEstimate, RunCheckpointTaken } from '@sandforge/shared';
import { runCheckpointEstimateOf, runCheckpointOf, takenOrDeleted } from './runCheckpoint';

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101540-a1b2',
  name: 'Before Forge run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:40.000Z',
  expiresAt: '2026-11-08T10:15:40.000Z',
  objects: ['Account', 'Contact'],
  records: 38,
  bytes: 2_100_000,
  requests: 66,
  added: [],
  notHeld: [{ objectApiName: 'FeedItem', reason: 'Chatter posts are never held.' }],
};

const PLANNED: RunCheckpointEstimate = {
  state: 'planned',
  estimate: {
    records: 38,
    apiRequests: 68,
    apiRequestsLeft: 14_000,
    seconds: 44,
    bytes: 2_200_000,
  },
  objects: ['Account'],
  added: [],
  notHeld: [],
  keepDays: 7,
};

describe('runCheckpointOf', () => {
  it('reads a checkpoint taken, and one deleted as the run wrote nothing', () => {
    expect(runCheckpointOf(TAKEN)).toEqual(TAKEN);
    expect(runCheckpointOf({ state: 'deleted', deleted: 'nothingWritten' })).toEqual({
      state: 'deleted',
      deleted: 'nothingWritten',
    });
    // A checkpoint kept until it is deleted has no date to be deleted on.
    expect(runCheckpointOf({ ...TAKEN, expiresAt: null })).toEqual({ ...TAKEN, expiresAt: null });
  });

  it('reads nothing from a field that is not one: an estimate, a checkpoint missing what a page shows', () => {
    expect(runCheckpointOf(undefined)).toBeUndefined();
    expect(runCheckpointOf('deleted')).toBeUndefined();
    expect(runCheckpointOf(PLANNED)).toBeUndefined();
    expect(runCheckpointOf({ ...TAKEN, checkpointId: '' })).toBeUndefined();
    expect(runCheckpointOf({ ...TAKEN, objects: [1] })).toBeUndefined();
    expect(runCheckpointOf({ ...TAKEN, notHeld: ['FeedItem'] })).toBeUndefined();
    expect(runCheckpointOf({ ...TAKEN, records: '38' })).toBeUndefined();
  });
});

describe('takenOrDeleted and runCheckpointEstimateOf', () => {
  it('tell a run’s checkpoint from a simulation’s estimate of one', () => {
    expect(takenOrDeleted(TAKEN)).toBe(TAKEN);
    expect(takenOrDeleted(PLANNED)).toBeUndefined();
    expect(takenOrDeleted(undefined)).toBeUndefined();
    expect(runCheckpointEstimateOf(PLANNED)).toBe(PLANNED);
    expect(runCheckpointEstimateOf(TAKEN)).toBeUndefined();
  });
});
