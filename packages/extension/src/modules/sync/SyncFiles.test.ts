import { describe, it, expect, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import {
  emptyFilesOutcome,
  filesSummaryLine,
  orgFileCopyDeps,
  planRunFiles,
  readFileMap,
  SYNC_FILE_MAP_MAX,
  SyncFilesRefusedError,
  type FileCopyOrg,
  type SyncCopiedFile,
  type SyncFileDeps,
  type SyncFileMapLoad,
} from './SyncFiles';
import type { FileCopyDeps } from '../forge/stages/FileCopier';

const MB = 1_048_576;

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function copied(overrides: Partial<SyncCopiedFile> = {}): SyncCopiedFile {
  return {
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    objectApiName: 'Account',
    kind: 'document',
    sourceId: fakeId('069', 1),
    targetId: fakeId('069', 9),
    sourceVersionId: fakeId('068', 1),
    linked: [],
    copiedAt: '2026-10-13T09:00:00.000Z',
    ...overrides,
  };
}

describe('readFileMap', () => {
  it('reads nothing stored as no file copied yet', () => {
    expect(readFileMap(undefined)).toEqual({ kind: 'none' });
  });

  it('reads a stored record of copied files', () => {
    expect(readFileMap({ version: 1, entries: [copied()] })).toEqual({
      kind: 'stored',
      map: { version: 1, entries: [copied()] },
    });
  });

  it('reads an id that is not a record id as unreadable, never half used', () => {
    expect(
      readFileMap({ version: 1, entries: [copied({ targetId: "x' OR Id != '" })] }),
    ).toMatchObject({ kind: 'unreadable', issue: expect.stringContaining('entries.0.targetId') });
  });
});

describe('planRunFiles — refusals before anything is written', () => {
  const account: SyncObjectConfig = {
    objectApiName: 'Account',
    operation: 'upsert',
    externalIdField: 'Ext_Id__c',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
  };
  const config = { id: 'cfg', sourceOrgId: 'src', targetOrgId: 'tgt' } as SyncConfig;
  const option = { maxFileSizeMB: 10, maxRunMB: 100 };

  function deps(load: SyncFileMapLoad | null, copy: Partial<FileCopyDeps> = {}): SyncFileDeps {
    return {
      copy: {
        queryRecords: vi.fn(async () => []),
        readFileBody: vi.fn(),
        insertFile: vi.fn(),
        insertRecords: vi.fn(),
        remainingFileStorageMB: vi.fn(async () => 20),
        ...copy,
      },
      sourceIds: vi.fn(async () => [fakeId('001', 1)]),
      store: { load: () => load, record: vi.fn() },
    };
  }

  it('refuses a configuration that is not saved, reading nothing', async () => {
    const d = deps(null);

    await expect(
      planRunFiles({ config, option, objects: [{ objectConfig: account }], deps: d }),
    ).rejects.toThrow('Files are copied by a saved configuration only');
    expect(d.copy.remainingFileStorageMB).not.toHaveBeenCalled();
  });

  it('refuses when the record of copied files does not read, since it could copy them twice', async () => {
    await expect(
      planRunFiles({
        config,
        option,
        objects: [{ objectConfig: account }],
        deps: deps({ kind: 'unreadable', issue: 'entries.0: bad' }),
      }),
    ).rejects.toThrow('The record of the files this configuration copied could not be read');
  });

  it("refuses when the target's file storage cannot be read", async () => {
    const d = deps(
      { kind: 'none' },
      {
        remainingFileStorageMB: vi.fn(async () => {
          throw new Error('REQUEST_LIMIT_EXCEEDED');
        }),
      },
    );

    await expect(
      planRunFiles({ config, option, objects: [{ objectConfig: account }], deps: d }),
    ).rejects.toThrow(/could not be read \(REQUEST_LIMIT_EXCEEDED\).*Nothing was written\.$/);
    expect(d.sourceIds).not.toHaveBeenCalled();
  });

  it('refuses when the files of the records could not all be looked up', async () => {
    const d = deps(
      { kind: 'none' },
      {
        queryRecords: vi.fn(async () => {
          throw new Error('QUERY_TIMEOUT');
        }),
      },
    );

    const planned = planRunFiles({ config, option, objects: [{ objectConfig: account }], deps: d });

    await expect(planned).rejects.toBeInstanceOf(SyncFilesRefusedError);
    await expect(planned).rejects.toThrow(
      /^Account: the files of its records could not all be looked up in the source \(QUERY_TIMEOUT\)/,
    );
  });

  it('copies no new file past the record a configuration keeps, and says why', async () => {
    const full: SyncCopiedFile[] = Array.from({ length: SYNC_FILE_MAP_MAX }, (_, n) =>
      copied({ sourceId: fakeId('069', 1000 + n) }),
    );
    const d = deps(
      { kind: 'stored', map: { version: 1, entries: full } },
      {
        queryRecords: vi.fn(async (_org: string, soql: string) => {
          if (soql.includes('FROM ContentDocumentLink')) {
            return [{ ContentDocumentId: fakeId('069', 1), LinkedEntityId: fakeId('001', 1) }];
          }
          if (soql.includes('FROM ContentVersion')) {
            return [
              {
                Id: fakeId('068', 1),
                ContentDocumentId: fakeId('069', 1),
                Title: 'Report',
                ContentSize: 10,
                ContentLocation: 'S',
              },
            ];
          }
          return [];
        }),
      },
    );

    const plan = await planRunFiles({
      config,
      option,
      objects: [{ objectConfig: account }],
      deps: d,
    });

    const files = plan.objects.get('Account');
    expect(files?.files).toEqual([]);
    expect(files?.outcome.pastRunCap).toBe(1);
    expect(files?.notes).toEqual([
      `1 file(s) were not copied: this configuration keeps the record of ${SYNC_FILE_MAP_MAX} copied files at most, which it holds already.`,
    ]);
  });

  it('reads no file of an object the run deletes', async () => {
    const d = deps({ kind: 'none' });

    const plan = await planRunFiles({
      config,
      option,
      objects: [{ objectConfig: { ...account, operation: 'delete' } }],
      deps: d,
    });

    expect(plan.objects.size).toBe(0);
    expect(d.sourceIds).not.toHaveBeenCalled();
  });
});

describe('orgFileCopyDeps', () => {
  function org(overrides: Partial<FileCopyOrg> = {}): FileCopyOrg {
    return {
      pages: {
        query: vi.fn(async () => ({
          records: [{ Id: 'a' }],
          done: false,
          nextRecordsUrl: '/next',
        })),
        queryMore: vi.fn(async () => ({ records: [{ Id: 'b' }], done: true })),
      },
      transport: {
        request: vi.fn(async () => ({ FileStorageMB: { Max: 20, Remaining: 7 } })),
      },
      create: vi.fn(async () => [
        { id: fakeId('06A', 1), success: true, errors: [] },
        { success: false, errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'linked' }] },
      ]),
      ...overrides,
    };
  }

  it('reads every page of a query from the org it names', async () => {
    const source = org();
    const deps = orgFileCopyDeps({ src: source, tgt: org() });

    expect(await deps.queryRecords('src', 'SELECT Id FROM Attachment WHERE Id IN (...)')).toEqual([
      { Id: 'a' },
      { Id: 'b' },
    ]);
    expect(source.pages.queryMore).toHaveBeenCalledWith('/next');
  });

  it('writes links in one call and says which the org took', async () => {
    const target = org();
    const deps = orgFileCopyDeps({ src: org(), tgt: target });

    const results = await deps.insertRecords('tgt', 'ContentDocumentLink', [{}, {}]);

    expect(target.create).toHaveBeenCalledWith('ContentDocumentLink', [{}, {}]);
    expect(results[0]).toEqual({ id: fakeId('06A', 1), success: true, errors: [] });
    expect(results[1]).toMatchObject({ success: false });
    expect(results[1].errors.join(' ')).toContain('DUPLICATE_VALUE');
  });

  it('reads the file storage an org has left from its /limits', async () => {
    expect(await orgFileCopyDeps({ tgt: org() }).remainingFileStorageMB('tgt')).toBe(7);
  });

  it('names an org it has no connection for', async () => {
    await expect(
      orgFileCopyDeps({}).queryRecords('nowhere', 'SELECT Id FROM X WHERE Id = 1'),
    ).rejects.toThrow('No connection for the org nowhere.');
  });
});

describe('filesSummaryLine', () => {
  it('says the files and versions copied, what they took, and what the caps skipped', () => {
    const outcomes = [
      { ...emptyFilesOutcome(), copied: 2, versions: 1, bytes: 3 * MB, tooLarge: 1 },
      { ...emptyFilesOutcome(), pastRunCap: 2 },
    ];

    expect(filesSummaryLine(outcomes)).toBe('3 file(s), 3 MB copied, 3 skipped past the caps');
  });
});
