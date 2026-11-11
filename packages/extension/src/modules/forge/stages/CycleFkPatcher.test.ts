import { describe, it, expect, vi } from 'vitest';
import {
  CycleFkPass,
  RecordsOwingAcrossParts,
  patchCycleFkUpdates,
  type CycleFkPatchInput,
} from './CycleFkPatcher.js';
import { IdRemapper } from '../IdRemapper.js';
import type { PendingFkUpdate } from './BatchWriter.js';
import type { ForgeExecutorDeps, ForgeProgressEvent } from '../ForgeExecutor.js';
import { BulkJobLostError, type BulkRowState, type BulkWriteAnswer } from '../forgeBulkWrite.js';
import {
  CallSizes,
  GOVERNOR_LIMIT_ALONE,
  SplitAllowance,
} from '../../../core/common/governorLimit.js';

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

  it('splits pass 2 at the REST limit instead of posting one oversized UPDATE', async () => {
    // deps.updateRecords is `conn.sobject(name).update(records)`, and jsforce
    // only chunks an oversized array when `options.allowRecursive` is passed,
    // which that call site does not. Pass 1 was bounded and pass 2, which it
    // feeds, was not: a cyclic clone above 200 records failed one stage later.
    const remapper = new IdRemapper();
    const pending: PendingFkUpdate[] = [];
    for (let i = 0; i < 450; i++) {
      remapper.add(`003OLD${i}`, `003NEW${i}`);
      pending.push(
        makePending({
          objectApiName: 'Contact',
          newId: `003NEW${i}`,
          sourceId: `003OLD${i}`,
          fieldName: 'ReportsToId',
          sourceRefId: `003OLD${i}`,
        }),
      );
    }
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation((_org, _obj, records) =>
        Promise.resolve(records.map((r) => ({ id: String(r['Id']), success: true, errors: [] }))),
      );

    const error = await patchCycleFkUpdates(
      makeInput({ pendingFkUpdates: pending, remapper, updateRecords }),
    );

    expect(error).toBeFalsy();
    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([200, 200, 50]);
    // Every record still travels exactly once, and only once.
    const sent = updateRecords.mock.calls.flatMap((c) => c[2].map((r) => r['Id']));
    expect(new Set(sent).size).toBe(450);
  });

  it('tells what each call filled in, and that the call was answered, before it sends the next', async () => {
    const remapper = new IdRemapper();
    const pending: PendingFkUpdate[] = [];
    for (let i = 0; i < 450; i++) {
      remapper.add(`003OLD${i}`, `003NEW${i}`);
      pending.push(
        makePending({
          objectApiName: 'Contact',
          newId: `003NEW${i}`,
          sourceId: `003OLD${i}`,
          fieldName: 'ReportsToId',
          sourceRefId: `003OLD${i}`,
        }),
      );
    }
    const told: string[] = [];
    const updateRecords = vi.fn<UpdateRecordsFn>().mockImplementation((_org, _obj, records) => {
      told.push(`call of ${records.length}`);
      return Promise.resolve(
        records.map((r, i) => ({ id: String(r['Id']), success: i !== 0, errors: [] })),
      );
    });
    let patched = 0;
    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        onPatched: () => patched++,
        onAnswered: () => {
          told.push(`answered, ${patched} filled in so far`);
        },
      }),
    );
    // What a journal marks of a call is on disk before the next call goes:
    // the first record of each call is refused, and not counted filled in.
    expect(told).toEqual([
      'call of 200',
      'answered, 199 filled in so far',
      'call of 200',
      'answered, 398 filled in so far',
      'call of 50',
      'answered, 447 filled in so far',
    ]);
  });

  it('keeps patching the remaining batches when one rejected batch throws', async () => {
    const remapper = new IdRemapper();
    const pending: PendingFkUpdate[] = [];
    for (let i = 0; i < 250; i++) {
      remapper.add(`003OLD${i}`, `003NEW${i}`);
      pending.push(
        makePending({
          objectApiName: 'Contact',
          newId: `003NEW${i}`,
          sourceId: `003OLD${i}`,
          fieldName: 'ReportsToId',
          sourceRefId: `003OLD${i}`,
        }),
      );
    }
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockRejectedValueOnce(new Error('REQUEST_LIMIT_EXCEEDED'))
      .mockImplementation((_org, _obj, records) =>
        Promise.resolve(records.map((r) => ({ id: String(r['Id']), success: true, errors: [] }))),
      );

    const error = await patchCycleFkUpdates(
      makeInput({ pendingFkUpdates: pending, remapper, updateRecords }),
    );

    expect(updateRecords).toHaveBeenCalledTimes(2);
    expect(error?.failedCount).toBe(200);
    expect(error?.attemptedCount).toBe(250);
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

  it('counts every lookup it could not fill in, past the three it names', async () => {
    // A real clone left twelve lookups empty — nine orders whose quote was
    // held back, two whose opportunity was not cloned, the opportunity's
    // synced quote — and the pass reported "0/3 resolved": the count stopped
    // where the samples did.
    const pending = Array.from({ length: 12 }, (_, i) =>
      makePending({ newId: `801NEW${i}`, sourceId: `801OLD${i}`, fieldName: 'QuoteId' }),
    );
    const input = makeInput({ pendingFkUpdates: pending });

    const error = await patchCycleFkUpdates(input);

    expect(error).toMatchObject({ failedCount: 12, attemptedCount: 12 });
    expect(error?.samples).toHaveLength(3);
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress[0].message).toBe('Pass 2 (cycle FK update): 0/12 resolved');
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

  it('counts every lookup of a refused update as left empty, not the one record that carried them', async () => {
    // Both lookups of the account go in one update. Counted by the record,
    // its refusal read as one lookup of two resolved, when neither was written.
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockResolvedValue([
        { id: '001NEW1', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'] },
      ]);
    const input = makeInput({
      remapper,
      updateRecords,
      pendingFkUpdates: [
        makePending({ fieldName: 'PrimaryContactId' }),
        makePending({ fieldName: 'Backup_Contact__c' }),
      ],
    });

    const error = await patchCycleFkUpdates(input);

    expect(updateRecords).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ failedCount: 2, attemptedCount: 2 });
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress[0].message).toBe('Pass 2 (cycle FK update): 0/2 resolved');
  });

  it('tells which lookups of a refused update a lookup filter named, by record, and none another refusal names', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    remapper.add('02iOLD1', '02iNEW1');
    const filter = 'FIELD_FILTER_VALIDATION_EXCEPTION';
    const updateRecords = vi.fn<UpdateRecordsFn>().mockResolvedValue([
      {
        id: '500NEW1',
        success: false,
        errors: [`${filter}: Value does not exist or does not match filter criteria. [AssetId]`],
        errorDetails: [
          { statusCode: filter, message: 'Value does not exist', fields: ['AssetId'] },
        ],
      },
      {
        id: '500NEW2',
        success: false,
        errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused [ContactId]'],
        errorDetails: [
          {
            statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
            message: 'refused',
            fields: ['ContactId'],
          },
        ],
      },
    ]);
    const onRefusedByFilter = vi.fn();
    const onCase = (newId: string, fieldName: string, sourceRefId: string) =>
      makePending({ objectApiName: 'Case', newId, fieldName, sourceRefId });

    await patchCycleFkUpdates(
      makeInput({
        remapper,
        updateRecords,
        onRefusedByFilter,
        pendingFkUpdates: [
          onCase('500NEW1', 'AssetId', '02iOLD1'),
          onCase('500NEW1', 'ContactId', '003OLD1'),
          onCase('500NEW2', 'ContactId', '003OLD1'),
        ],
      }),
    );

    expect(onRefusedByFilter.mock.calls).toEqual([['Case', 'AssetId', '500NEW1']]);
  });

  it('counts every lookup of a batch that threw as left empty', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi.fn<UpdateRecordsFn>().mockRejectedValue(new Error('ECONNRESET'));
    const input = makeInput({
      remapper,
      updateRecords,
      pendingFkUpdates: [
        makePending({ fieldName: 'PrimaryContactId' }),
        makePending({ fieldName: 'Backup_Contact__c' }),
        makePending({ newId: '001NEW2', fieldName: 'PrimaryContactId' }),
      ],
    });

    const error = await patchCycleFkUpdates(input);

    expect(error).toMatchObject({ failedCount: 3, attemptedCount: 3 });
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress[0].message).toBe('Pass 2 (cycle FK update): 0/3 resolved');
  });

  it('counts the updates an answer leaves out as left empty, not as resolved', async () => {
    // One result for two records: the second was read as patched.
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockResolvedValue([{ id: '001NEW1', success: true, errors: [] }]);
    const input = makeInput({
      remapper,
      updateRecords,
      pendingFkUpdates: [makePending(), makePending({ newId: '001NEW2', sourceId: '001OLD2' })],
    });

    const error = await patchCycleFkUpdates(input);

    expect(error).toEqual({
      objectApiName: '__pass2__',
      stage: 'insert',
      failedCount: 1,
      attemptedCount: 2,
      samples: [
        {
          recordSummary: 'Id=001NEW2 PrimaryContactId=003NEW1',
          messages: ['No result returned for record (API truncated batch: 1/2)'],
        },
      ],
    });
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress[0].message).toBe('Pass 2 (cycle FK update): 1/2 resolved');
  });

  /** 450 contacts, each owing its ReportsToId, every one resolvable: three calls of the pass. */
  function fourHundredFiftyOwed(): { pending: PendingFkUpdate[]; remapper: IdRemapper } {
    const remapper = new IdRemapper();
    const pending: PendingFkUpdate[] = [];
    for (let i = 0; i < 450; i++) {
      remapper.add(`003OLD${i}`, `003NEW${i}`);
      pending.push(
        makePending({
          objectApiName: 'Contact',
          newId: `003NEW${i}`,
          sourceId: `003OLD${i}`,
          fieldName: 'ReportsToId',
          sourceRefId: `003OLD${i}`,
        }),
      );
    }
    return { pending, remapper };
  }

  it('stops between two calls once the run is cancelled, and says what it filled and what it left', async () => {
    // The pass went on sending every call after a cancel: a clone stopped
    // during it still wrote to the target until the last lookup.
    const { pending, remapper } = fourHundredFiftyOwed();
    let cancelled = false;
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _obj, records) => {
        cancelled = true;
        return records.map((r) => ({ id: String(r['Id']), success: true, errors: [] }));
      });
    const input = makeInput({
      pendingFkUpdates: pending,
      remapper,
      updateRecords,
      stopped: () => cancelled,
    });

    const error = await patchCycleFkUpdates(input);

    expect(updateRecords).toHaveBeenCalledTimes(1);
    expect(error).toEqual({
      objectApiName: '__pass2__',
      stage: 'insert',
      failedCount: 250,
      attemptedCount: 450,
      samples: [
        {
          recordSummary: 'Contact: 250 lookups not sent',
          messages: ['The run was cancelled before they were filled in: they stay empty.'],
        },
      ],
    });
    const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
    expect(progress).toEqual([
      {
        objectName: '__pass2__',
        status: 'error',
        progress: 100,
        message: 'Pass 2 (cycle FK update): 200/450 resolved; cancelled with 250 not sent',
      },
    ]);
  });

  it('sends nothing once the run is cancelled before its first call', async () => {
    const { pending, remapper } = fourHundredFiftyOwed();
    const input = makeInput({ pendingFkUpdates: pending, remapper, stopped: () => true });

    const error = await patchCycleFkUpdates(input);

    expect(input.updateRecords).not.toHaveBeenCalled();
    expect(error).toMatchObject({ failedCount: 450, attemptedCount: 450 });
    expect(error?.samples[0].recordSummary).toBe('Contact: 450 lookups not sent');
  });

  it('settling after a node, counts what a cancel left unsent and still hands back what it cannot resolve yet', async () => {
    // What the cancel stopped is said with this settle: the run ends before
    // the pass that would have said it. What no record written can fill yet
    // goes back, as it always did.
    const { pending, remapper } = fourHundredFiftyOwed();
    const notYet = makePending({ sourceRefId: '003NOTYET' });
    let cancelled = false;
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _obj, records) => {
        cancelled = true;
        return records.map((r) => ({ id: String(r['Id']), success: true, errors: [] }));
      });
    const stillPending: PendingFkUpdate[] = [];

    const error = await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: [...pending, notYet],
        remapper,
        updateRecords,
        stopped: () => cancelled,
        deferUnresolved: true,
        stillPending,
      }),
    );

    expect(updateRecords).toHaveBeenCalledTimes(1);
    expect(stillPending).toEqual([notYet]);
    expect(error).toMatchObject({ failedCount: 250, attemptedCount: 450 });
  });

  it('counts a thrown batch as failed for every record in it', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    const updateRecords = vi.fn<UpdateRecordsFn>().mockRejectedValue(new Error('ECONNRESET'));
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

  describe('a lookup only an insert sets', () => {
    it('sends no update for it, says it is left empty, and still fills in the record’s other lookups', async () => {
      // Sent with the record's other lookup, the update was refused — "Unable
      // to create/update fields" — and took that one down with it.
      const remapper = new IdRemapper();
      remapper.add('003OLD1', '003NEW1');
      remapper.add('500OLD1', '500NEW1');
      const updateRecords = vi
        .fn<UpdateRecordsFn>()
        .mockResolvedValue([{ id: '001NEW1', success: true, errors: [] }]);
      const input = makeInput({
        remapper,
        updateRecords,
        pendingFkUpdates: [
          makePending(),
          makePending({ fieldName: 'Case__c', sourceRefId: '500OLD1', insertOnly: true }),
        ],
      });

      const error = await patchCycleFkUpdates(input);

      expect(updateRecords.mock.calls.map(([, , rows]) => rows)).toEqual([
        [{ Id: '001NEW1', PrimaryContactId: '003NEW1' }],
      ]);
      expect(error).toEqual({
        objectApiName: '__pass2__',
        stage: 'insert',
        failedCount: 1,
        attemptedCount: 2,
        samples: [
          {
            recordSummary: 'Account source=001OLD1 target=001NEW1 Case__c',
            messages: [
              "Lookup 'Case__c' left empty: only an insert sets it, and the record it names " +
                '(source 500OLD1) was written after this one',
            ],
          },
        ],
      });
      const progress = vi.mocked(input.onProgress).mock.calls.map((c) => c[0]);
      expect(progress[0].message).toBe('Pass 2 (cycle FK update): 1/2 resolved');
    });

    it('settling after a node, says it once its record is written and hands it back no more', async () => {
      const remapper = new IdRemapper();
      remapper.add('500OLD1', '500NEW1');
      const updateRecords = vi.fn<UpdateRecordsFn>();
      const stillPending: PendingFkUpdate[] = [];
      const later = makePending({ fieldName: 'Parent__c', sourceRefId: '001LATER' });
      const input = makeInput({
        remapper,
        updateRecords,
        deferUnresolved: true,
        stillPending,
        pendingFkUpdates: [
          later,
          makePending({ fieldName: 'Case__c', sourceRefId: '500OLD1', insertOnly: true }),
        ],
      });

      const error = await patchCycleFkUpdates(input);

      expect(updateRecords).not.toHaveBeenCalled();
      expect(stillPending).toEqual([later]);
      expect(error?.failedCount).toBe(1);
      expect(error?.samples[0].messages[0]).toContain("Lookup 'Case__c' left empty");
    });

    it('reports one whose record was never written as any lookup left unresolved', async () => {
      const input = makeInput({
        pendingFkUpdates: [makePending({ fieldName: 'Case__c', insertOnly: true })],
      });

      const error = await patchCycleFkUpdates(input);

      expect(error?.samples[0].messages[0]).toBe(
        "Cycle FK 'Case__c' could not be resolved — referenced parent (source 003OLD1) was not cloned",
      );
    });
  });
});

describe('the second pass handed in parts', () => {
  /** Parts of two lookups each, as the pass reads what a journal owes. */
  function inParts(updates: PendingFkUpdate[], size = 2): PendingFkUpdate[][] {
    const parts: PendingFkUpdate[][] = [];
    for (let at = 0; at < updates.length; at += size) parts.push(updates.slice(at, at + size));
    return parts;
  }

  /** Patch `parts` as the pass of a journal does: which records owe in several told first, held back, sent at the end. */
  async function patchInParts(input: CycleFkPatchInput, parts: PendingFkUpdate[][]) {
    const across = new RecordsOwingAcrossParts();
    parts.forEach((part, n) => {
      for (const update of part) across.note(n, update.newId);
    });
    const pass = new CycleFkPass(input);
    for (const part of parts) await pass.patch(part, (update) => across.spans(update.newId));
    await pass.sendHeld();
    return pass.finish();
  }

  it('sends one update for a record whose lookups fall in two parts', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    remapper.add('001OLD9', '001NEW9');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((record) => ({ id: String(record['Id']), success: true, errors: [] })),
      );
    // The first record's second lookup is the first of the second part.
    const parts = inParts([
      makePending({ newId: '001NEW2', fieldName: 'ParentId', sourceRefId: '001OLD9' }),
      makePending({ newId: '001NEW1', fieldName: 'PrimaryContactId' }),
      makePending({ newId: '001NEW1', fieldName: 'ParentId', sourceRefId: '001OLD9' }),
    ]);

    const error = await patchInParts(makeInput({ remapper, updateRecords }), parts);

    expect(error).toBeNull();
    const sent = updateRecords.mock.calls.flatMap(([, , records]) => records);
    expect(sent).toEqual([
      { Id: '001NEW2', ParentId: '001NEW9' },
      { Id: '001NEW1', PrimaryContactId: '003NEW1', ParentId: '001NEW9' },
    ]);
  });

  it('says two values of one lookup of a record owed in two parts, and sends the first alone', async () => {
    const remapper = new IdRemapper();
    remapper.add('003OLD1', '003NEW1');
    remapper.add('003OLD2', '003NEW2');
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((record) => ({ id: String(record['Id']), success: true, errors: [] })),
      );
    const parts = inParts([
      makePending({ newId: '001NEW1', sourceRefId: '003OLD1' }),
      makePending({ newId: '001NEW2', sourceRefId: '003OLD1' }),
      makePending({ newId: '001NEW1', sourceRefId: '003OLD2' }),
    ]);

    const error = await patchInParts(makeInput({ remapper, updateRecords }), parts);

    const sent = updateRecords.mock.calls.flatMap(([, , records]) => records);
    expect(sent).toEqual([
      { Id: '001NEW2', PrimaryContactId: '003NEW1' },
      { Id: '001NEW1', PrimaryContactId: '003NEW1' },
    ]);
    expect(error?.failedCount).toBe(1);
    expect(error?.samples[0].messages[0]).toBe(
      'Conflicting cycle FK update for PrimaryContactId: 003NEW1 vs 003NEW2',
    );
  });

  it('tells a record owing in two parts from one owing in a single part, however many records it holds', () => {
    const across = new RecordsOwingAcrossParts();
    for (let n = 0; n < 5000; n++) across.note(n % 7, `001NEW${String(n).padStart(9, '0')}`);
    // Each was first seen in part n % 7: once more there is not another part.
    across.note(4, '001NEW000000004');
    across.note(2, '001NEW000000009');
    across.note(5, '001NEW000000011');
    expect(across.spans('001NEW000000004')).toBe(false);
    expect(across.spans('001NEW000000009')).toBe(false);
    expect(across.spans('001NEW000000011')).toBe(true);
    expect(across.spans('001NEW000000010')).toBe(false);
    expect(across.spans('001NEW999999999')).toBe(false);
  });
});

describe('patchCycleFkUpdates — updates sent as Bulk API jobs', () => {
  type BulkUpdateFn = NonNullable<CycleFkPatchInput['bulkUpdate']>;

  /** `n` accounts owing their parent, the parents cloned: every lookup resolvable. */
  function owing(n: number): { pending: PendingFkUpdate[]; remapper: IdRemapper } {
    const remapper = new IdRemapper();
    const pending: PendingFkUpdate[] = [];
    for (let i = 0; i < n; i++) {
      const parent = `001PAR${String(i % 3).padStart(9, '0')}`;
      remapper.add(parent, `001TGT${String(i % 3).padStart(9, '0')}`);
      pending.push(
        makePending({
          newId: `001NEW${String(i).padStart(9, '0')}`,
          sourceId: `001OLD${String(i).padStart(9, '0')}`,
          fieldName: 'ParentId',
          sourceRefId: parent,
        }),
      );
    }
    return { pending, remapper };
  }

  /** The answer of a job that took every update it was sent. */
  function allTaken(records: readonly Record<string, unknown>[]): BulkWriteAnswer {
    return {
      answers: records.map((r) => ({ id: String(r['Id']), success: true, errors: [] })),
      rows: records.map((): BulkRowState => 'answered'),
      unmatchedIds: [],
      requests: 12,
    };
  }

  const LOCK = {
    id: '',
    success: false,
    errors: ['UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record'],
    errorDetails: [
      {
        statusCode: 'UNABLE_TO_LOCK_ROW',
        message: 'unable to obtain exclusive access',
        fields: [],
      },
    ],
  };

  it('sends an object owing 2 000 updates or more as jobs, sorted by the value each sets, and marks what they took', async () => {
    const { pending, remapper } = owing(2_100);
    const bulkUpdate = vi
      .fn<BulkUpdateFn>()
      .mockImplementation(async (_object, records) => allTaken(records));
    const onPatched = vi.fn();
    const onAnswered = vi.fn();
    const input = makeInput({
      pendingFkUpdates: pending,
      remapper,
      bulkUpdate,
      onPatched,
      onAnswered,
    });

    const error = await patchCycleFkUpdates(input);

    expect(error).toBeNull();
    expect(input.updateRecords).not.toHaveBeenCalled();
    expect(bulkUpdate).toHaveBeenCalledTimes(1);
    const [object, sent] = bulkUpdate.mock.calls[0];
    expect(object).toBe('Account');
    expect(sent).toHaveLength(2_100);
    const values = sent.map((r) => String(r['ParentId']));
    expect(values).toEqual([...values].sort());
    expect(onPatched).toHaveBeenCalledTimes(2_100);
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it('updates by REST under 2 000 updates, and an object a duplicate rule watches whatever their number', async () => {
    const few = owing(1_999);
    const bulkUpdate = vi
      .fn<BulkUpdateFn>()
      .mockImplementation(async (_object, records) => allTaken(records));
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((r) => ({ id: String(r['Id']), success: true, errors: [] })),
      );

    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: few.pending,
        remapper: few.remapper,
        updateRecords,
        bulkUpdate,
      }),
    );
    const many = owing(2_000);
    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: many.pending,
        remapper: many.remapper,
        updateRecords,
        bulkUpdate,
        restOnly: new Set(['Account']),
      }),
    );

    expect(bulkUpdate).not.toHaveBeenCalled();
    expect(updateRecords).toHaveBeenCalledTimes(20);
  });

  it('sends again by REST, three times at most, the updates a job refused for a lock', async () => {
    const { pending, remapper } = owing(2_000);
    const bulkUpdate = vi.fn<BulkUpdateFn>().mockImplementation(async (_object, records) => {
      const answer = allTaken(records);
      answer.answers[0] = LOCK;
      answer.answers[1] = LOCK;
      answer.rows[2] = 'unprocessed';
      return answer;
    });
    // The first record stays locked; the second goes on its second send.
    let sends = 0;
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) => {
        sends++;
        return records.map((r, i) =>
          i === 0 || (i === 1 && sends === 1)
            ? LOCK
            : { id: String(r['Id']), success: true, errors: [] },
        );
      });
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const error = await patchCycleFkUpdates(
      makeInput({ pendingFkUpdates: pending, remapper, updateRecords, bulkUpdate, wait }),
    );

    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([3, 2, 1]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ objectApiName: '__pass2__', failedCount: 1 });
  });

  it('updates by REST what a job wrote nothing of, and counts as left empty what a lost job may have written', async () => {
    const { pending, remapper } = owing(2_000);
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((r) => ({ id: String(r['Id']), success: true, errors: [] })),
      );

    await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        bulkUpdate: vi.fn<BulkUpdateFn>().mockResolvedValue({
          answers: [],
          rows: [],
          unmatchedIds: [],
          untouched: { reason: 'InvalidEntity', unsupported: true },
          requests: 1,
        }),
      }),
    );
    expect(updateRecords).toHaveBeenCalledTimes(10);

    const lost = await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        bulkUpdate: vi
          .fn<BulkUpdateFn>()
          .mockRejectedValue(new BulkJobLostError('750JOB', 'socket hang up')),
      }),
    );
    expect(lost).toMatchObject({ failedCount: 2_000 });
    expect(lost?.samples[0].messages).toContainEqual(expect.stringContaining('socket hang up'));
  });

  it('updates by REST what a job that threw before the org held anything of it was to update', async () => {
    const { pending, remapper } = owing(2_000);
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((r) => ({ id: String(r['Id']), success: true, errors: [] })),
      );
    const onPatched = vi.fn();

    const error = await patchCycleFkUpdates(
      makeInput({
        pendingFkUpdates: pending,
        remapper,
        updateRecords,
        onPatched,
        bulkUpdate: vi.fn<BulkUpdateFn>().mockRejectedValue(new Error('no connection')),
      }),
    );

    expect(error).toBeNull();
    expect(updateRecords).toHaveBeenCalledTimes(10);
    expect(onPatched).toHaveBeenCalledTimes(2_000);
  });

  it('sends no job of an object the run heard the Bulk API does not update, and tells the run of one it hears so', async () => {
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((r) => ({ id: String(r['Id']), success: true, errors: [] })),
      );
    const bulkUpdate = vi.fn<BulkUpdateFn>().mockResolvedValue({
      answers: [],
      rows: [],
      unmatchedIds: [],
      untouched: { reason: 'InvalidEntity', unsupported: true },
      requests: 1,
    });
    const bulkUnsupported = new Set<string>();

    // Two nodes' passes of one run: the second sends no job of the object.
    for (let node = 0; node < 2; node++) {
      const { pending, remapper } = owing(2_000);
      await patchCycleFkUpdates(
        makeInput({
          pendingFkUpdates: pending,
          remapper,
          updateRecords,
          bulkUpdate,
          bulkUnsupported,
        }),
      );
    }

    expect(bulkUpdate).toHaveBeenCalledTimes(1);
    expect(bulkUnsupported.has('Account')).toBe(true);
    expect(updateRecords).toHaveBeenCalledTimes(20);
  });
});

describe('patchCycleFkUpdates — updates the target’s automation refuses for a Salesforce limit', () => {
  type BulkUpdateFn = NonNullable<CycleFkPatchInput['bulkUpdate']>;

  /** What a trigger that runs a query per record answers a call too large for it. */
  const LIMIT_MESSAGE =
    'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: SSC_TRG_Provenance: execution of BeforeUpdate\n\n' +
    'caused by: System.LimitException: Too many SOQL queries: 101\n\n' +
    'Trigger.SSC_TRG_Provenance: line 12, column 1';

  const refusedForALimit = (id: string) => ({
    id,
    success: false,
    errors: [LIMIT_MESSAGE],
    errorDetails: [
      { statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', message: LIMIT_MESSAGE, fields: [] },
    ],
  });

  /** `n` provenances owing their parent, every parent cloned. */
  function owing(n: number): { pendingFkUpdates: PendingFkUpdate[]; remapper: IdRemapper } {
    const remapper = new IdRemapper();
    const pendingFkUpdates: PendingFkUpdate[] = [];
    for (let i = 0; i < n; i++) {
      const id = String(i).padStart(9, '0');
      remapper.add(`a01OLD${id}`, `a01TGT${id}`);
      pendingFkUpdates.push(
        makePending({
          objectApiName: 'Provenance__c',
          newId: `a02NEW${id}`,
          sourceId: `a02OLD${id}`,
          fieldName: 'Parent__c',
          sourceRefId: `a01OLD${id}`,
        }),
      );
    }
    return { pendingFkUpdates, remapper };
  }

  /** A target whose trigger refuses, for a limit, every update of a call past `most`. */
  function targetTaking(most: number) {
    return vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((r) =>
          records.length > most
            ? refusedForALimit(String(r['Id']))
            : { id: String(r['Id']), success: true, errors: [] },
        ),
      );
  }

  /** A Bulk API job that answers every update refused for a limit. */
  function jobsRefusingAll() {
    return vi.fn<BulkUpdateFn>().mockImplementation(async (_object, records) => ({
      answers: records.map((r) => refusedForALimit(String(r['Id']))),
      rows: records.map((): BulkRowState => 'answered'),
      unmatchedIds: [],
      requests: 12,
    }));
  }

  it('sends again in calls half as large the updates a call was refused for, and tells each one filled in', async () => {
    const updateRecords = targetTaking(100);
    const onPatched = vi.fn();
    const onAnswered = vi.fn();
    const callSizes = new CallSizes();

    const error = await patchCycleFkUpdates(
      makeInput({ ...owing(116), updateRecords, onPatched, onAnswered, callSizes }),
    );

    expect(error).toBeNull();
    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([116, 58, 58]);
    expect(onPatched).toHaveBeenCalledTimes(116);
    expect(new Set(onPatched.mock.calls.map((c) => c[1]['Id'])).size).toBe(116);
    expect(onAnswered).toHaveBeenCalledTimes(3);
    expect(callSizes.report({ objectApiName: 'Provenance__c', op: 'update' })).toMatchObject({
      from: 116,
      to: 58,
      rows: 116,
      extraCalls: 2,
      limit: 'Too many SOQL queries',
      automation: 'SSC_TRG_Provenance',
      event: 'before update',
    });
  });

  it('starts the next pass of the run at the size that went through', async () => {
    const callSizes = new CallSizes();
    const splitAllowance = new SplitAllowance(2_000);
    const updateRecords = targetTaking(100);
    await patchCycleFkUpdates(
      makeInput({ ...owing(116), updateRecords, callSizes, splitAllowance }),
    );
    updateRecords.mockClear();

    await patchCycleFkUpdates(
      makeInput({ ...owing(116), updateRecords, callSizes, splitAllowance }),
    );

    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([58, 58]);
  });

  it('fails an update refused so on its own, saying what to fix after the words of the org', async () => {
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) =>
        records.map((r) => refusedForALimit(String(r['Id']))),
      );

    const error = await patchCycleFkUpdates(
      makeInput({ ...owing(1), updateRecords, splitAllowance: new SplitAllowance() }),
    );

    expect(updateRecords).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ objectApiName: '__pass2__', failedCount: 1 });
    expect(error?.samples[0].messages).toEqual([LIMIT_MESSAGE, GOVERNOR_LIMIT_ALONE]);
  });

  it('splits nothing for a pass handed neither the run sizes nor its allowance, as Seed hands none', async () => {
    const updateRecords = targetTaking(100);

    const error = await patchCycleFkUpdates(makeInput({ ...owing(116), updateRecords }));

    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual([116]);
    expect(error).toMatchObject({ failedCount: 116, attemptedCount: 116 });
    expect(error?.samples[0].messages).toEqual([LIMIT_MESSAGE]);
  });

  it('sends nothing smaller past the smaller calls the run allows itself, and says so', async () => {
    const updateRecords = targetTaking(100);

    const error = await patchCycleFkUpdates(
      makeInput({ ...owing(116), updateRecords, splitAllowance: new SplitAllowance(0) }),
    );

    expect(updateRecords).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ failedCount: 116, attemptedCount: 116 });
    expect(error?.samples[0].messages).toEqual([
      LIMIT_MESSAGE,
      'Not sent in smaller calls: what the org has left today allowed the run none.',
    ]);
  });

  it('counts as not sent the smaller calls a cancel came before', async () => {
    let cancelled = false;
    const updateRecords = vi
      .fn<UpdateRecordsFn>()
      .mockImplementation(async (_org, _object, records) => {
        cancelled = true;
        return records.map((r) => refusedForALimit(String(r['Id'])));
      });
    const onPatched = vi.fn();

    const error = await patchCycleFkUpdates(
      makeInput({
        ...owing(116),
        updateRecords,
        onPatched,
        stopped: () => cancelled,
        callSizes: new CallSizes(),
      }),
    );

    expect(updateRecords).toHaveBeenCalledTimes(1);
    expect(onPatched).not.toHaveBeenCalled();
    expect(error).toMatchObject({ failedCount: 116, attemptedCount: 116 });
    expect(error?.samples[0].recordSummary).toBe('Provenance__c: 116 lookups not sent');
  });

  it('sends again by REST, 100 at a time, the updates a job was refused for, and no job of the object after', async () => {
    const bulkUpdate = jobsRefusingAll();
    const updateRecords = targetTaking(100);
    const onPatched = vi.fn();
    const callSizes = new CallSizes();
    const splitAllowance = new SplitAllowance(2_000);

    const error = await patchCycleFkUpdates(
      makeInput({
        ...owing(2_000),
        updateRecords,
        bulkUpdate,
        onPatched,
        callSizes,
        splitAllowance,
      }),
    );

    expect(error).toBeNull();
    expect(bulkUpdate).toHaveBeenCalledTimes(1);
    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual(Array(20).fill(100));
    expect(onPatched).toHaveBeenCalledTimes(2_000);
    // Twenty calls of 100 where one job went: each is one more.
    expect(splitAllowance.spent).toBe(20);

    // The next node's pass of the run sends the object by REST, at 100.
    bulkUpdate.mockClear();
    updateRecords.mockClear();
    await patchCycleFkUpdates(
      makeInput({ ...owing(2_000), updateRecords, bulkUpdate, callSizes, splitAllowance }),
    );
    expect(bulkUpdate).not.toHaveBeenCalled();
    expect(updateRecords.mock.calls.map((c) => c[2].length)).toEqual(Array(20).fill(100));
  });

  it('sends by REST, at 100, the jobs of the object still planned after one was refused', async () => {
    const bulkUpdate = jobsRefusingAll();
    const updateRecords = targetTaking(100);
    const splitAllowance = new SplitAllowance(2_000);

    const error = await patchCycleFkUpdates(
      makeInput({ ...owing(20_000), updateRecords, bulkUpdate, splitAllowance }),
    );

    expect(error).toBeNull();
    expect(bulkUpdate).toHaveBeenCalledTimes(1);
    expect(updateRecords).toHaveBeenCalledTimes(200);
    expect(updateRecords.mock.calls.every((c) => c[2].length === 100)).toBe(true);
    // Two hundred calls of 100 where two jobs went: each is one more.
    expect(splitAllowance.spent).toBe(200);
  });

  it('sends by REST what the allowance pays every call for of a job still planned, and the rest as a job', async () => {
    const bulkUpdate = jobsRefusingAll();
    const updateRecords = targetTaking(100);
    const callSizes = new CallSizes();
    const splitAllowance = new SplitAllowance(150);

    await patchCycleFkUpdates(
      makeInput({ ...owing(30_000), updateRecords, bulkUpdate, callSizes, splitAllowance }),
    );

    // The first job's 10 000 by REST, 100 calls; 50 calls of the second
    // job's, the 5 000 updates left a job, as the third, the object spent.
    expect(bulkUpdate.mock.calls.map((c) => c[1].length)).toEqual([10_000, 5_000, 10_000]);
    expect(updateRecords).toHaveBeenCalledTimes(150);
    expect(updateRecords.mock.calls.every((c) => c[2].length === 100)).toBe(true);
    expect(splitAllowance.spent).toBe(150);
    expect(callSizes.report({ objectApiName: 'Provenance__c', op: 'update' })).toMatchObject({
      notSplit: 15_000,
      spent: true,
    });
  });

  it('keeps a job planned a job once the smaller calls are spent', async () => {
    // Thirty thousand updates: three jobs. The first is refused for a limit;
    // its updates go again at 100 until the allowance of 3 runs out, and the
    // rest stay refused, never sent at 200 to be refused again. The object
    // spent, the two jobs still planned stay jobs, and what they refuse for a
    // limit stays refused, sent by REST no more.
    const bulkUpdate = jobsRefusingAll();
    const updateRecords = targetTaking(100);
    const callSizes = new CallSizes();

    const error = await patchCycleFkUpdates(
      makeInput({
        ...owing(30_000),
        updateRecords,
        bulkUpdate,
        callSizes,
        splitAllowance: new SplitAllowance(3),
      }),
    );

    expect(callSizes.isSpent({ objectApiName: 'Provenance__c', op: 'update' })).toBe(true);
    expect(bulkUpdate).toHaveBeenCalledTimes(3);
    // Three calls of 100, each paid, and none of 200.
    expect(updateRecords).toHaveBeenCalledTimes(3);
    expect(updateRecords.mock.calls.every((c) => c[2].length === 100)).toBe(true);
    expect(error).toMatchObject({ failedCount: 29_700, attemptedCount: 30_000 });
    expect(callSizes.report({ objectApiName: 'Provenance__c', op: 'update' })).toMatchObject({
      notSplit: 29_700,
      spent: true,
    });
  });
});
