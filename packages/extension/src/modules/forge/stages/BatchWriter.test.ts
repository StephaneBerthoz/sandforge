import { describe, it, expect, vi } from 'vitest';
import { BatchWriter, summarizeRecordForError, type WriteNodeInput } from './BatchWriter.js';
import { IdRemapper } from '../IdRemapper.js';
import { logger } from '../../../logger.js';
import type { CleanedRecord } from './RecordCleaner.js';
import type { FieldInfo, ForgeExecutorDeps, ForgeProgressEvent } from '../ForgeExecutor.js';
import type { ForgeGraphNode } from '@sandforge/shared';

type WriterDeps = Pick<ForgeExecutorDeps, 'insertRecords' | 'upsertRecords'>;

function makeNode(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'rest',
  };
}

const FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  { name: 'Name', queryable: true, createable: true, isReference: false },
];

function toCleaned(records: Record<string, unknown>[]): CleanedRecord[] {
  return records.map((r) => ({
    source: r,
    cleaned: { ...r },
    nullifiedFks: [],
  }));
}

function makeInput(
  records: Record<string, unknown>[],
  overrides?: Partial<WriteNodeInput>,
): WriteNodeInput {
  return {
    node: makeNode('Account', records.length),
    records: records.map((r) => ({ ...r })),
    cleanedRecords: toCleaned(records),
    fieldInfos: FIELDS,
    creatableFields: new Set(['Name']),
    upsertMode: 'off',
    targetOrgId: 'tgt',
    remapper: new IdRemapper(),
    waitIfPaused: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    onProgress: vi.fn<[e: ForgeProgressEvent], void>(),
    ...overrides,
  };
}

function makeDeps(insertImpl?: InsertImpl): WriterDeps {
  return {
    insertRecords: vi
      .fn<Parameters<InsertImpl>, ReturnType<InsertImpl>>()
      .mockImplementation(
        insertImpl ??
          (async (_orgId, _obj, recs) =>
            recs.map((_, i) => ({ id: `001NEW${i}`, success: true, errors: [] }))),
      ),
  };
}

type InsertImpl = WriterDeps['insertRecords'];
type UpsertFn = NonNullable<WriterDeps['upsertRecords']>;

describe('BatchWriter', () => {
  it('splits records into REST batches of 200 and checkpoints between batches', async () => {
    const records = Array.from({ length: 500 }, (_, i) => ({ Id: `001OLD${i}`, Name: `R${i}` }));
    const deps = makeDeps();
    const input = makeInput(records);
    const result = await new BatchWriter(deps).writeNode(input);

    expect(vi.mocked(deps.insertRecords).mock.calls.map((c) => c[2].length)).toEqual([
      200, 200, 100,
    ]);
    expect(input.waitIfPaused).toHaveBeenCalledTimes(3);
    expect(result.successCount).toBe(500);
    expect(result.failureCount).toBe(0);

    const running = vi
      .mocked(input.onProgress)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.status === 'running');
    expect(running[0].message).toContain('Inserting 500 Account records in 3 batch(es)');
    expect(running[running.length - 1].progress).toBe(100);
  });

  it('registers source→target mappings and queues nullified FKs for pass 2', async () => {
    const deps = makeDeps();
    const cleanedRecords: CleanedRecord[] = [
      {
        source: { Id: '001OLD1', Name: 'A' },
        cleaned: { Name: 'A' },
        nullifiedFks: [{ field: 'ContactId', sourceRefId: '003OLD', targetObjects: ['Contact'] }],
      },
    ];
    const input = makeInput([{ Id: '001OLD1', Name: 'A' }], {
      records: [{ Name: 'A' }],
      cleanedRecords,
    });
    const result = await new BatchWriter(deps).writeNode(input);

    expect(input.remapper.get('001OLD1')).toBe('001NEW0');
    expect(result.pendingFkUpdates).toEqual([
      {
        objectApiName: 'Account',
        newId: '001NEW0',
        sourceId: '001OLD1',
        fieldName: 'ContactId',
        sourceRefId: '003OLD',
      },
    ]);
  });

  it('counts API-truncated results as failures with an explicit sample', async () => {
    const deps = makeDeps(async () => [{ id: '001NEW0', success: true, errors: [] }]);
    const input = makeInput([
      { Id: '001A', Name: 'A' },
      { Id: '001B', Name: 'B' },
    ]);
    const result = await new BatchWriter(deps).writeNode(input);

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.errorSamples[0].messages[0]).toContain('API truncated batch: 1/2');
  });

  it('caps error samples at 3 per node', async () => {
    const deps = makeDeps(async (_orgId, _obj, recs) =>
      recs.map(() => ({ id: '', success: false, errors: ['FAIL'] })),
    );
    const records = Array.from({ length: 10 }, (_, i) => ({ Id: `001${i}`, Name: `R${i}` }));
    const result = await new BatchWriter(deps).writeNode(makeInput(records));

    expect(result.failureCount).toBe(10);
    expect(result.errorSamples).toHaveLength(3);
  });

  it('upserts on a unique external Id field when upsertMode=auto', async () => {
    const upsertRecords = vi
      .fn<Parameters<UpsertFn>, ReturnType<UpsertFn>>()
      .mockResolvedValue([{ id: '001UP1', success: true, errors: [] }]);
    const deps: WriterDeps = { ...makeDeps(), upsertRecords };
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const fields: FieldInfo[] = [
      ...FIELDS,
      {
        name: 'ExternalKey__c',
        queryable: true,
        createable: true,
        isReference: false,
        externalId: true,
      },
    ];
    const input = makeInput([{ Id: '001OLD', ExternalKey__c: 'KEY-1' }], {
      records: [{ ExternalKey__c: 'KEY-1' }],
      cleanedRecords: [
        {
          source: { Id: '001OLD', ExternalKey__c: 'KEY-1' },
          cleaned: { ExternalKey__c: 'KEY-1' },
          nullifiedFks: [],
        },
      ],
      fieldInfos: fields,
      creatableFields: new Set(['ExternalKey__c']),
      upsertMode: 'auto',
    });
    await new BatchWriter(deps).writeNode(input);

    expect(upsertRecords).toHaveBeenCalledWith('tgt', 'Account', 'ExternalKey__c', [
      { ExternalKey__c: 'KEY-1' },
    ]);
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('ExternalKey__c'));
    infoSpy.mockRestore();
  });

  it('falls back to insert when no external Id candidate is unique across the batch', async () => {
    const upsertRecords = vi.fn<Parameters<UpsertFn>, ReturnType<UpsertFn>>().mockResolvedValue([]);
    const deps: WriterDeps = { ...makeDeps(), upsertRecords };
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const fields: FieldInfo[] = [
      ...FIELDS,
      {
        name: 'ExternalKey__c',
        queryable: true,
        createable: true,
        isReference: false,
        externalId: true,
      },
    ];
    const dupes = [
      { Id: '001A', ExternalKey__c: 'SAME' },
      { Id: '001B', ExternalKey__c: 'SAME' },
    ];
    const input = makeInput(dupes, {
      records: dupes.map((d) => ({ ExternalKey__c: d.ExternalKey__c })),
      fieldInfos: fields,
      creatableFields: new Set(['ExternalKey__c']),
      upsertMode: 'auto',
    });
    await new BatchWriter(deps).writeNode(input);

    expect(upsertRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('falling back to insert'));
    warnSpy.mockRestore();
  });
});

describe('summarizeRecordForError', () => {
  it('summarizes up to 4 fields with truncation and type handling', () => {
    const summary = summarizeRecordForError({
      a: null,
      b: undefined,
      c: 'x'.repeat(40),
      d: { nested: 'y'.repeat(40) },
      e: 'ignored',
    });
    const parts = summary.split(' ');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('a=null');
    expect(parts[1]).toBe('b=undefined');
    expect(parts[2]).toBe(`c=${'x'.repeat(30)}…`);
    expect(parts[3]).toContain('d=');
    expect(parts[3].length).toBeLessThanOrEqual(33); // 'd=' + 30 chars + ellipsis
  });

  it('returns (empty) for empty records', () => {
    expect(summarizeRecordForError({})).toBe('(empty)');
  });
});
