import { describe, expect, it } from 'vitest';

import { ConfigStore } from '../../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../../test/InMemoryConfigStoreBackend.js';
import {
  BackupSetStore,
  backupSetSummaryOf,
  lateRowsOf,
  nextSliceIndex,
  sliceDone,
  sliceSetOpenOf,
  sliceSetResultOf,
  sliceSnapshotId,
  slicesOf,
  type BackupSet,
  type BackupSlice,
} from './backupSet.js';

/** The `n`-th contact id. */
function contactId(n: number): string {
  return `003${String(n).padStart(12, '0')}AAA`;
}

/** A slice of a set, masked unless said. */
function slice(index: number, overrides: Partial<BackupSlice> = {}): BackupSlice {
  return {
    index,
    ...(index > 1 ? { afterId: contactId((index - 1) * 1000) } : {}),
    lastId: contactId(index * 1000),
    rows: 1000,
    snapshotId: sliceSnapshotId('set-1', index),
    state: 'masked',
    masked: 1000,
    refused: 0,
    deletedSince: 0,
    nothingToMask: 0,
    sizeUsed: 1000,
    ...overrides,
  };
}

/** A masking set of two masked slices and one in progress. */
function setOf(overrides: Partial<BackupSet> = {}): BackupSet {
  return {
    setId: 'set-1',
    kind: 'masking',
    orgId: 'org-1',
    templateId: 'tpl-gdpr-standard',
    size: 1000,
    state: 'open',
    startedAt: '2026-11-14T10:00:00.000Z',
    serverStartedAt: '2026-11-14T10:00:01.000Z',
    lastActivityAt: '2026-11-14T10:30:00.000Z',
    requestsSpent: 40,
    objects: [
      {
        objectApiName: 'Contact',
        done: false,
        slices: [slice(1), slice(2), slice(3, { state: 'masking', masked: 300 })],
      },
    ],
    ...overrides,
  };
}

function store(): { sets: BackupSetStore; config: ConfigStore } {
  const config = new ConfigStore(new InMemoryConfigStoreBackend());
  config.initialize();
  return { sets: new BackupSetStore(config), config };
}

describe('backupSet', () => {
  it('names a slice by its set and its number on four digits, with no colon', () => {
    expect(sliceSnapshotId('cli-dataops-anonymize-1', 7)).toBe('cli-dataops-anonymize-1-s0007');
    expect(sliceSnapshotId('set', 2000)).not.toContain(':');
  });

  it('numbers slices across the objects of a set, and tells the ones done with', () => {
    const set = setOf();
    set.objects.push({ objectApiName: 'Lead', done: true, slices: [slice(4)] });

    expect(slicesOf(set).map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(nextSliceIndex(set)).toBe(5);
    expect(slicesOf(set).map(sliceDone)).toEqual([true, true, false, true]);
    expect(sliceDone({ state: 'snapshotted' })).toBe(true);
    expect(sliceDone({ state: 'pending' })).toBe(false);
  });

  it('keeps a manifest and reads it back, and finds the open set of a template on an org', () => {
    const { sets } = store();
    sets.save(setOf());
    sets.save(setOf({ setId: 'set-2', state: 'done', objects: [] }));
    sets.save(setOf({ setId: 'set-3', orgId: 'org-2', objects: [] }));

    expect(sets.get('set-1')).toEqual(setOf());
    expect(
      sets
        .list('org-1')
        .map((s) => s.setId)
        .sort(),
    ).toEqual(['set-1', 'set-2']);
    expect(sets.openFor('org-1', 'tpl-gdpr-standard')?.setId).toBe('set-1');
    expect(sets.openFor('org-1', 'tpl-hipaa-health')).toBeUndefined();
    expect(sets.ofSnapshot('set-1-s0002')?.setId).toBe('set-1');

    sets.delete('set-1');
    expect(sets.get('set-1')).toBeUndefined();
  });

  it('reads no set from an entry edited by hand, and keeps none that does not read as one', () => {
    const { sets, config } = store();
    config.set('backupSet:set-x', { ...setOf({ setId: 'set-x' }), size: -1 });
    config.set('backupSet:set-y', { ...setOf({ setId: 'set-z' }) });

    expect(sets.get('set-x')).toBeUndefined();
    // Kept under another set's key: not that set.
    expect(sets.get('set-y')).toBeUndefined();
    expect(() =>
      sets.save({
        ...setOf(),
        objects: [
          {
            objectApiName: 'Contact',
            done: false,
            slices: [slice(1, { afterId: "x' OR Id != '" })],
          },
        ],
      }),
    ).toThrow();
  });

  it('says the rows created late that no slice holds: past the last slice, and in a range masked', () => {
    const set = setOf();
    set.objects[0].tailLeft = 2;
    set.objects[0].slices[0].lateLeft = 3;

    expect(lateRowsOf(set)).toBe(5);
  });

  it('says a set as a run ends, as the listing gives it, and as a coverage names it open', () => {
    const set = setOf();

    expect(sliceSetResultOf(set, { requestsSpent: 12, stoppedOnBudget: true })).toEqual({
      setId: 'set-1',
      size: 1000,
      state: 'open',
      objects: [
        {
          objectApiName: 'Contact',
          slices: [1, 2, 3].map((index) =>
            expect.objectContaining({ index, objectApiName: 'Contact' }),
          ),
        },
      ],
      lateRecords: 0,
      requestsSpent: 12,
      stoppedOnBudget: true,
      slicesLeft: true,
    });
    expect(
      backupSetSummaryOf({ ...set, objects: [{ ...set.objects[0], where: "LastName LIKE 'S%'" }] }),
    ).toMatchObject({
      setId: 'set-1',
      kind: 'masking',
      totalRecords: 3000,
      wheres: { Contact: "LastName LIKE 'S%'" },
    });
    expect(sliceSetOpenOf(set)).toEqual({
      setId: 'set-1',
      savedAt: '2026-11-14T10:30:00.000Z',
      done: 2,
      total: 3,
      state: 'open',
      size: 1000,
    });
  });
});
