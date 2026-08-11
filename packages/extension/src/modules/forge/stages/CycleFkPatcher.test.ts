import { describe, it, expect, vi } from 'vitest';
import { patchCycleFkUpdates, type CycleFkPatchInput } from './CycleFkPatcher.js';
import { IdRemapper } from '../IdRemapper.js';
import type { PendingFkUpdate } from './BatchWriter.js';
import type { ForgeExecutorDeps, ForgeProgressEvent } from '../ForgeExecutor.js';

type UpdateRecordsFn = NonNullable<ForgeExecutorDeps['updateRecords']>;

function makePending(overrides?: Partial<PendingFkUpdate>): PendingFkUpdate {
  return {
    objectApiName: 'Account',
    newId: '001NEW1',
    sourceId: '001OLD1',
    fieldName: 'PrimaryContactId',
    sourceRefId: '003OLD1',
    ...overrides,
  };
}

function makeInput(overrides?: Partial<CycleFkPatchInput>): CycleFkPatchInput {
  return {
    pendingFkUpdates: [],
    remapper: new IdRemapper(),
    updateRecords: vi
      .fn<UpdateRecordsFn>()
      .mockResolvedValue([{ id: '001NEW1', success: true, errors: [] }]),
    targetOrgId: 'tgt',
    enabled: true,
    onProgress: vi.fn<(e: ForgeProgressEvent) => void>(),
    ...overrides,
  };
}

describe('patchCycleFkUpdates', () => {
  it('does nothing when disabled, when updateRecords is missing, or when no FK is pending', async () => {
    const onProgress = vi.fn<(e: ForgeProgressEvent) => void>();
    const pending = [makePending()];

    expect(
      await patchCycleFkUpdates(makeInput({ enabled: false, pendingFkUpdates: pending })),
    ).toBeNull();
    expect(
      await patchCycleFkUpdates(makeInput({ updateRecords: undefined, pendingFkUpdates: pending })),
    ).toBeNull();
    expect(await patchCycleFkUpdates(makeInput({ onProgress }))).toBeNull();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('coalesces multiple FKs of the same record into one UPDATE payload', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockResolvedValue([{ id: '001NEW1', success: true, errors: [] }]);
    const input = makeInput({
      remapper,
      updateRecords,
      pendingFkUpdates: [
        makePending({ fieldName: 'PrimaryContactId' }),
        makePending({ fieldName: 'Backup_Contact__c' }),
      ],
    });

    const error = await patchCycleFkUpdates(input);

    expect(error).toBeNull();
    expect(updateRecords).toHaveBeenCalledTimes(1);
    const [, objectName, payload] = updateRecords.mock.calls[0];
    expect(objectName).toBe('Account');
    expect(payload).toEqual([
      { Id: '001NEW1', PrimaryContactId: '003NEW1', Backup_Contact__c: '003NEW1' },
    ]);
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress[0]).toMatchObject({ objectName: '__pass2__', status: 'done', progress: 100 });
    expect(progress[0].message).toContain('2/2 resolved');
  });

  it('groups updates per object into separate batches', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockResolvedValue([{ id: 'x', success: true, errors: [] }]);
    const input = makeInput({
      remapper,
      updateRecords,
      pendingFkUpdates: [
        makePending({ objectApiName: 'Account', newId: '001NEW1' }),
        makePending({ objectApiName: 'Contact', newId: '003NEW9' }),
      ],
    });

    await patchCycleFkUpdates(input);

    expect(updateRecords).toHaveBeenCalledTimes(2);
    const objects = updateRecords.mock.calls.map((c) => c[1]).sort();
    expect(objects).toEqual(['Account', 'Contact']);
  });

  it('reports unresolved FKs when the parent was never cloned', async () => {
    const input = makeInput({ pendingFkUpdates: [makePending()] });

    const error = await patchCycleFkUpdates(input);

    expect(input.updateRecords).not.toHaveBeenCalled();
    expect(error).not.toBeNull();
    expect(error?.objectApiName).toBe('__pass2__');
    expect(error?.failedCount).toBe(1);
    expect(error?.samples[0].messages[0]).toContain('could not be resolved');
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress[0].status).toBe('error');
  });

  it('surfaces conflicting targets for the same record+field', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    remapper.add('003OLD2', '003NEW2');
    const input = makeInput({
      remapper,
      pendingFkUpdates: [
        makePending({ sourceRefId: '003OLD1' }),
        makePending({ sourceRefId: '003OLD2' }),
      ],
    });

    const error = await patchCycleFkUpdates(input);

    expect(error?.samples[0].messages[0]).toContain('Conflicting cycle FK update');
    // First (non-conflicting) update still goes through.
    expect(input.updateRecords).toHaveBeenCalledTimes(1);
  });

  it('reports per-record UPDATE failures', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockResolvedValue([{ id: '', success: false, errors: ['INVALID_FIELD'] }]);
    const input = makeInput({
      remapper,
      updateRecords,
      pendingFkUpdates: [makePending()],
    });

    const error = await patchCycleFkUpdates(input);

    expect(error?.failedCount).toBe(1);
    expect(error?.samples[0].messages).toEqual(['INVALID_FIELD']);
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress[0].status).toBe('error');
  });

  it('counts a thrown batch as failed for every record in it', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockRejectedValue(new Error('ECONNRESET'));
    const input = makeInput({
      remapper,
      updateRecords,
      // Two distinct target records — a thrown batch must count both.
      pendingFkUpdates: [makePending(), makePending({ newId: '001NEW2', fieldName: 'Other__c' })],
    });

    const error = await patchCycleFkUpdates(input);

    expect(error?.failedCount).toBe(2);
    expect(error?.samples[0].messages[0]).toBe('ECONNRESET');
  });
});
