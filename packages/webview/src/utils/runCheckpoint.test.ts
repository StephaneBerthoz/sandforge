import { describe, expect, it } from 'vitest';
import type { RunCheckpointEstimate, RunCheckpointTaken } from '@sandforge/shared';
import i18n from '../i18n';
import {
  checkpointRefusalWords,
  panelRefusalWords,
  runCheckpointEstimateOf,
  runCheckpointOf,
  takenOrDeleted,
} from './runCheckpoint';

const t = (key: string): string => i18n.t(key);

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

describe('checkpointRefusalWords', () => {
  it.each([
    ['DISK', "This machine's disk has too little room for it."],
    [
      'RUN_WRITING',
      'Another SandForge run, take, rewind or undo is writing to the org: start this run once it has ended.',
    ],
    [
      'NOTHING_HELD',
      'It would hold none of the objects the run writes: each is left out, or of a kind no checkpoint holds.',
    ],
    [
      'TOO_MANY_RECORDS',
      'The objects it would hold have more records than a checkpoint takes: run without it, or leave objects out of the run.',
    ],
    ['API_BUDGET', 'Its API requests are past what the org has left today.'],
    ['PRODUCTION', 'SandForge takes no checkpoint of a production org.'],
    ['SCRATCH_EXPIRED', 'The scratch org has expired.'],
  ])('words %s', (reason, words) => {
    expect(checkpointRefusalWords(reason, t)).toBe(words);
  });

  it('says the output has it for a code with no words of its own, and for a take that failed', () => {
    expect(checkpointRefusalWords('OTHER_ORG', t)).toBe(
      'Its guards refused it: the SandForge output says why.',
    );
    expect(checkpointRefusalWords(undefined, t)).toBe(
      'It was refused, or could not be taken: the SandForge output says why.',
    );
  });
});

describe('panelRefusalWords', () => {
  const explained = i18n.t('errors.checkpointRefused.explanation');
  const action = i18n.t('errors.checkpointRefused.action');

  it('says what refused the checkpoint, by the code its error carries, between what happened and what to do', () => {
    expect(panelRefusalWords('CHECKPOINT_REFUSED', { checkpointRefusal: 'DISK' }, t)).toBe(
      `${explained} This machine's disk has too little room for it. ${action}`,
    );
  });

  it('says the output has why for a take that failed, whose error names no refusal', () => {
    expect(panelRefusalWords('CHECKPOINT_REFUSED', {}, t)).toBe(
      `${explained} It was refused, or could not be taken: the SandForge output says why. ${action}`,
    );
    // Read as the untrusted field of a message it is.
    expect(panelRefusalWords('CHECKPOINT_REFUSED', { checkpointRefusal: 3 }, t)).toContain(
      'the SandForge output says why',
    );
  });

  it('says a seed nobody could answer for in the catalogue’s words', () => {
    expect(panelRefusalWords('SEED_CONFIRMATION_UNAVAILABLE', {}, t)).toBe(
      `${i18n.t('errors.seedConfirmationUnavailable.explanation')} ${i18n.t(
        'errors.seedConfirmationUnavailable.action',
      )}`,
    );
  });

  it('adds no reason to another code, and leaves to the host what the panel does not word', () => {
    expect(panelRefusalWords('SYNC_WRITE_DECLINED', { checkpointRefusal: 'DISK' }, t)).toBe(
      `${i18n.t('errors.syncWriteDeclined.explanation')} ${i18n.t('errors.syncWriteDeclined.action')}`,
    );
    expect(panelRefusalWords('API_BUDGET_EXCEEDED', {}, t)).toBeUndefined();
    expect(panelRefusalWords(null, {}, t)).toBeUndefined();
  });
});
