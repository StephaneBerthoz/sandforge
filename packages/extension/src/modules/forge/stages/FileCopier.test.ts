import { describe, it, expect, vi } from 'vitest';
import type { ForgeFilesReport } from '@sandforge/shared';
import {
  copyFiles,
  lookupFailure,
  plannedFilesReport,
  selectFiles,
  storageShortfall,
  remainingStorageBytes,
  type FileCopyDeps,
  type FileToCopy,
} from './FileCopier.js';
import { IdRemapper } from '../IdRemapper.js';
import type { ExecutionObjectError, InsertResult } from '../ForgeExecutor.js';
import { selectRows, type FakeRow } from '../../../test/fakeSoql.js';

const MB = 1_048_576;

/** A fake source id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const CASE_1 = id('500', 1);
const CASE_2 = id('500', 2);
const OUTSIDE = id('500', 9);
const LIBRARY = id('058', 1);
const DOC_A = id('069', 1);
const DOC_B = id('069', 2);
const DOC_OUTSIDE = id('069', 9);

/** The source's files: two documents on the cases, one outside, and an attachment. */
function sourceFiles(): Record<string, FakeRow[]> {
  return {
    ContentDocumentLink: [
      { ContentDocumentId: DOC_A, LinkedEntityId: CASE_2, ShareType: 'V', Visibility: 'AllUsers' },
      {
        ContentDocumentId: DOC_A,
        LinkedEntityId: CASE_1,
        ShareType: 'I',
        Visibility: 'InternalUsers',
      },
      { ContentDocumentId: DOC_A, LinkedEntityId: LIBRARY, ShareType: 'I', Visibility: 'AllUsers' },
      { ContentDocumentId: DOC_B, LinkedEntityId: CASE_1, ShareType: 'V', Visibility: 'AllUsers' },
      {
        ContentDocumentId: DOC_OUTSIDE,
        LinkedEntityId: OUTSIDE,
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
    ],
    ContentVersion: [
      {
        Id: id('068', 1),
        ContentDocumentId: DOC_A,
        IsLatest: false,
        Title: 'Report (draft)',
        PathOnClient: 'report.pdf',
        ContentSize: '3',
        ContentLocation: 'S',
        SharingPrivacy: 'N',
      },
      {
        Id: id('068', 2),
        ContentDocumentId: DOC_A,
        IsLatest: true,
        Title: 'Report',
        PathOnClient: 'report.pdf',
        ContentSize: '4',
        ContentLocation: 'S',
        SharingPrivacy: 'P',
      },
      {
        Id: id('068', 3),
        ContentDocumentId: DOC_B,
        IsLatest: true,
        Title: 'Scan',
        PathOnClient: 'scan.png',
        ContentSize: '5',
        ContentLocation: 'S',
        SharingPrivacy: 'N',
      },
      {
        Id: id('068', 9),
        ContentDocumentId: DOC_OUTSIDE,
        IsLatest: true,
        Title: 'Elsewhere',
        PathOnClient: 'elsewhere.txt',
        ContentSize: '6',
        ContentLocation: 'S',
        SharingPrivacy: 'N',
      },
    ],
    Attachment: [
      {
        Id: id('00P', 1),
        ParentId: CASE_2,
        Name: 'note.txt',
        ContentType: 'text/plain',
        BodyLength: '3',
        IsPrivate: true,
      },
    ],
  };
}

/** Rows as the API answers them: sizes are numbers there. */
function asAnswered(rows: FakeRow[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) =>
        k === 'ContentSize' || k === 'BodyLength' ? [k, Number(v)] : [k, v],
      ),
    ),
  );
}

/** The source as `queryRecords` reads it. */
function readerOf(tables: Record<string, FakeRow[]>) {
  return vi.fn(async (_orgId: string, soql: string) => asAnswered(selectRows(tables, soql)));
}

const SCOPE = new Map([['Case', [CASE_1, CASE_2]]]);

describe('selectFiles', () => {
  it('takes the latest version of each document linked to a record in scope, and the attachments under them', async () => {
    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords: readerOf(sourceFiles()),
    });

    expect(selection.files.map((f) => [f.objectApiName, f.sourceId, f.body.id, f.bytes])).toEqual([
      ['ContentDocument', DOC_A, id('068', 2), 4],
      ['ContentDocument', DOC_B, id('068', 3), 5],
      ['Attachment', id('00P', 1), id('00P', 1), 3],
    ]);
    expect(selection.leftOut).toEqual([]);
    expect(selection.errors).toEqual([]);
  });

  it('leaves out a file linked only to records outside the scope, and the library a file sits in', async () => {
    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords: readerOf(sourceFiles()),
    });

    expect(selection.files.some((f) => f.sourceId === DOC_OUTSIDE)).toBe(false);
    const report = selection.files.find((f) => f.sourceId === DOC_A);
    // Hung on the two cases, in the order the run read them, never on the library.
    expect(report?.hosts).toEqual([
      { id: CASE_1, shareType: 'I', visibility: 'InternalUsers' },
      { id: CASE_2, shareType: 'V', visibility: 'AllUsers' },
    ]);
  });

  it('writes a file private to its owner as private, and names it as the source does', async () => {
    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords: readerOf(sourceFiles()),
    });

    expect(selection.files.map((f) => f.fields)).toEqual([
      { Title: 'Report', PathOnClient: 'report.pdf', SharingPrivacy: 'P' },
      { Title: 'Scan', PathOnClient: 'scan.png' },
      { Name: 'note.txt', ContentType: 'text/plain', IsPrivate: true },
    ]);
  });

  it('leaves out and lists a file over the cap and one kept outside Salesforce, never cutting one', async () => {
    const tables = sourceFiles();
    tables.ContentVersion[2] = { ...tables.ContentVersion[2], ContentSize: String(2 * MB) };
    tables.ContentVersion[1] = { ...tables.ContentVersion[1], ContentLocation: 'E' };

    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords: readerOf(tables),
    });

    expect(selection.files.map((f) => f.sourceId)).toEqual([id('00P', 1)]);
    expect(selection.leftOut).toEqual([
      {
        objectApiName: 'ContentDocument',
        sourceId: DOC_A,
        name: 'Report',
        bytes: 4,
        reason: 'external',
      },
      {
        objectApiName: 'ContentDocument',
        sourceId: DOC_B,
        name: 'Scan',
        bytes: 2 * MB,
        reason: 'too-large',
      },
    ]);
  });

  it('reads nothing when the run read no record', async () => {
    const queryRecords = readerOf(sourceFiles());

    const selection = await selectFiles({
      scope: new Map(),
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords,
    });

    expect(selection.files).toEqual([]);
    expect(queryRecords).not.toHaveBeenCalled();
  });

  it('reports a read the source refused, beside what the other reads found', async () => {
    const tables = sourceFiles();
    const queryRecords = vi.fn(async (_orgId: string, soql: string) => {
      if (soql.includes('FROM Attachment')) throw new Error('INVALID_TYPE: sObject type');
      return asAnswered(selectRows(tables, soql));
    });

    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords,
    });

    expect(selection.files.map((f) => f.objectApiName)).toEqual([
      'ContentDocument',
      'ContentDocument',
    ]);
    expect(selection.errors).toEqual([
      expect.objectContaining({
        objectApiName: 'Attachment',
        stage: 'query',
        samples: [expect.objectContaining({ messages: ['INVALID_TYPE: sObject type'] })],
      }),
    ]);
  });
});

describe('lookupFailure', () => {
  it('says nothing when every lookup answered', async () => {
    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords: readerOf(sourceFiles()),
    });

    expect(lookupFailure(selection)).toBeNull();
  });

  it('says what each lookup that failed answered', async () => {
    const queryRecords = vi.fn(async (_orgId: string, soql: string) => {
      if (soql.includes('FROM Attachment')) throw new Error('INVALID_TYPE: sObject type');
      throw new Error('QUERY_TIMEOUT: Your query request was running for too long.');
    });

    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords,
    });

    expect(lookupFailure(selection)).toBe(
      'The files of the records to clone could not all be looked up in the source ' +
        '(QUERY_TIMEOUT: Your query request was running for too long.; ' +
        'INVALID_TYPE: sObject type). Run it again, or leave the files out.',
    );
  });

  it('says an answer two lookups gave once', async () => {
    const tables = sourceFiles();
    const queryRecords = vi.fn(async (_orgId: string, soql: string) => {
      if (soql.includes('FROM ContentDocumentLink')) return asAnswered(selectRows(tables, soql));
      throw new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.');
    });

    const selection = await selectFiles({
      scope: SCOPE,
      sourceOrgId: 'src',
      maxFileBytes: MB,
      queryRecords,
    });

    expect(selection.errors).toHaveLength(2);
    expect(lookupFailure(selection)).toBe(
      'The files of the records to clone could not all be looked up in the source ' +
        '(REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.). ' +
        'Run it again, or leave the files out.',
    );
  });
});

describe('storageShortfall', () => {
  it('lets files through that fit in what the target has left', () => {
    expect(storageShortfall(10 * MB, 10 * MB)).toBeNull();
  });

  it('says what the files take and what the target has left when they do not fit', () => {
    expect(storageShortfall(12 * MB, 10 * MB)).toBe(
      'The files to copy take 12 MB and the target has 10 MB of file storage left. ' +
        'Lower the largest file copied, or leave the files out.',
    );
  });

  it('reads the storage left in MB, as /limits gives it', async () => {
    await expect(
      remainingStorageBytes({ remainingFileStorageMB: async () => 3 }, 'tgt'),
    ).resolves.toBe(3 * MB);
    await expect(
      remainingStorageBytes({ remainingFileStorageMB: async () => Number.NaN }, 'tgt'),
    ).rejects.toThrow('did not say how much file storage');
  });
});

describe('copyFiles', () => {
  /** A file's content as the source holds it: `bytes` letters, base64-encoded. */
  const contentOf = (bytes: number): string => Buffer.from('x'.repeat(bytes)).toString('base64');

  function file(overrides: Partial<FileToCopy> = {}): FileToCopy {
    return {
      objectApiName: 'ContentDocument',
      sourceId: DOC_A,
      body: { objectApiName: 'ContentVersion', id: id('068', 2) },
      name: 'Report',
      bytes: 4,
      hosts: [
        { id: CASE_1, shareType: 'I', visibility: 'InternalUsers' },
        { id: CASE_2, shareType: 'V', visibility: 'AllUsers' },
      ],
      fields: { Title: 'Report', PathOnClient: 'report.pdf' },
      ...overrides,
    };
  }

  /** The target: every file written is a new version of a new document. */
  function targetDeps(overrides: Partial<FileCopyDeps> = {}) {
    let written = 0;
    const deps = {
      queryRecords: vi.fn(async (_orgId: string, soql: string) => {
        const versionId = /Id = '(\w+)'/.exec(soql)?.[1] ?? '';
        return [{ ContentDocumentId: `069NEW${versionId.slice(-3)}` }];
      }),
      readFileBody: vi.fn(async (_orgId: string, _object: string, _id: string) => contentOf(4)),
      insertFile: vi.fn(
        async (): Promise<InsertResult> => ({
          id: `068NEW${String(++written).padStart(3, '0')}`,
          success: true,
          errors: [],
        }),
      ),
      insertRecords: vi.fn(async (_orgId: string, _object: string, records: unknown[]) =>
        records.map((_, i) => ({ id: `06ANEW${i}`, success: true, errors: [] })),
      ),
      remainingFileStorageMB: vi.fn(async () => 100),
      ...overrides,
    };
    return deps;
  }

  function emptyReport(): ForgeFilesReport {
    return plannedFilesReport({ files: [file()], leftOut: [], errors: [] }, MB);
  }

  /** The two cases created by the run. */
  function createdCases(): IdRemapper {
    const remapper = new IdRemapper();
    remapper.add(CASE_1, '500NEW1', 'Case');
    remapper.add(CASE_2, '500NEW2', 'Case');
    return remapper;
  }

  async function run(
    files: FileToCopy[],
    deps: ReturnType<typeof targetDeps>,
    remapper = createdCases(),
    report = emptyReport(),
    errors: ExecutionObjectError[] = [],
  ) {
    const failures = await copyFiles({
      files,
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      remapper,
      deps,
      report,
      errors,
      waitIfPaused: async () => undefined,
      onProgress: () => undefined,
    });
    return { failures, remapper, report, errors };
  }

  it('publishes a file on the record the run created and links it to the other records in scope', async () => {
    const deps = targetDeps();

    const { report } = await run([file()], deps);

    expect(deps.readFileBody).toHaveBeenCalledWith('src', 'ContentVersion', id('068', 2));
    expect(deps.insertFile).toHaveBeenCalledWith('tgt', 'ContentVersion', {
      Title: 'Report',
      PathOnClient: 'report.pdf',
      VersionData: contentOf(4),
      FirstPublishLocationId: '500NEW1',
    });
    expect(deps.insertRecords).toHaveBeenCalledWith('tgt', 'ContentDocumentLink', [
      {
        ContentDocumentId: '069NEW001',
        LinkedEntityId: '500NEW2',
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
    ]);
    expect(report.objects).toEqual([
      { objectApiName: 'ContentDocument', planned: 1, plannedBytes: 4, copied: 1, failed: 0 },
    ]);
    expect(report.links).toBe(1);
  });

  it('counts a copied file under the object whose removal takes it whole', async () => {
    // Its document: deleting a document deletes its versions and its links,
    // and a version cannot be deleted on its own.
    const deps = targetDeps();

    const { remapper } = await run([file()], deps);

    expect(remapper.createdByObject()).toContainEqual({
      objectApiName: 'ContentDocument',
      sourceIds: [DOC_A],
    });
    expect(remapper.get(DOC_A)).toBe('069NEW001');
  });

  it('writes an attachment under its remapped parent', async () => {
    const deps = targetDeps({ readFileBody: vi.fn(async () => contentOf(3)) });
    const attachment = file({
      objectApiName: 'Attachment',
      sourceId: id('00P', 1),
      body: { objectApiName: 'Attachment', id: id('00P', 1) },
      name: 'note.txt',
      bytes: 3,
      hosts: [{ id: CASE_2 }],
      fields: { Name: 'note.txt', ContentType: 'text/plain', IsPrivate: true },
    });

    const { remapper } = await run([attachment], deps);

    expect(deps.insertFile).toHaveBeenCalledWith('tgt', 'Attachment', {
      Name: 'note.txt',
      ContentType: 'text/plain',
      IsPrivate: true,
      Body: contentOf(3),
      ParentId: '500NEW2',
    });
    expect(remapper.createdByObject()).toContainEqual({
      objectApiName: 'Attachment',
      sourceIds: [id('00P', 1)],
    });
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('leaves out a file whose records the run did not create', async () => {
    const deps = targetDeps();
    const remapper = new IdRemapper();
    // The target already held both cases: linked to, never created.
    remapper.addExisting(CASE_1, '500OLD1', 'Case');
    remapper.addExisting(CASE_2, '500OLD2', 'Case');

    const { report } = await run([file()], deps, remapper);

    expect(deps.readFileBody).not.toHaveBeenCalled();
    expect(deps.insertFile).not.toHaveBeenCalled();
    expect(report.leftOut).toEqual([
      {
        objectApiName: 'ContentDocument',
        sourceId: DOC_A,
        name: 'Report',
        bytes: 4,
        reason: 'record-not-created',
      },
    ]);
  });

  it('publishes a file on the next record the run created when the first was only linked', async () => {
    const deps = targetDeps();
    const remapper = new IdRemapper();
    remapper.addExisting(CASE_1, '500OLD1', 'Case');
    remapper.add(CASE_2, '500NEW2', 'Case');

    await run([file()], deps, remapper);

    expect(deps.insertFile).toHaveBeenCalledWith(
      'tgt',
      'ContentVersion',
      expect.objectContaining({ FirstPublishLocationId: '500NEW2' }),
    );
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('writes nothing of a file that did not come back whole', async () => {
    const deps = targetDeps({ readFileBody: vi.fn(async () => contentOf(3)) });

    const { failures, report, errors } = await run([file()], deps);

    expect(deps.insertFile).not.toHaveBeenCalled();
    expect(failures).toBe(1);
    expect(report.objects[0]).toMatchObject({ copied: 0, failed: 1 });
    expect(errors[0].samples[0].messages[0]).toBe(
      'Read 3 bytes of the 4 the source reports: the file was not written.',
    );
  });

  it('reports a file the target refused and goes on with the next', async () => {
    const insertFile = vi
      .fn<FileCopyDeps['insertFile']>()
      .mockResolvedValueOnce({
        id: '',
        success: false,
        errors: ['STORAGE_LIMIT_EXCEEDED: storage limit exceeded'],
      })
      .mockResolvedValueOnce({ id: '068NEW002', success: true, errors: [] });
    const deps = targetDeps({ insertFile });
    const second = file({
      sourceId: DOC_B,
      body: { objectApiName: 'ContentVersion', id: id('068', 3) },
    });

    const { failures, errors, remapper } = await run([file(), second], deps);

    expect(failures).toBe(1);
    expect(errors).toEqual([
      {
        objectApiName: 'ContentDocument',
        stage: 'insert',
        failedCount: 1,
        attemptedCount: 2,
        samples: [
          {
            recordSummary: 'Report (4 B)',
            messages: ['STORAGE_LIMIT_EXCEEDED: storage limit exceeded'],
          },
        ],
      },
    ]);
    expect(remapper.get(DOC_B)).toBe('069NEW002');
    expect(remapper.get(DOC_A)).toBeUndefined();
  });

  it('counts what each stage lost out of everything it tried, not out of its failures alone', async () => {
    // Four files on the two cases: the second is not read, the third is
    // refused, and the fourth is copied with its link refused.
    const files = [1, 2, 3, 4].map((n) =>
      file({
        sourceId: id('069', n),
        body: { objectApiName: 'ContentVersion', id: id('068', n) },
        name: `Report ${n}`,
        fields: { Title: `Report ${n}`, PathOnClient: 'report.pdf' },
      }),
    );
    const readFileBody = vi.fn(async (_orgId: string, _object: string, versionId: string) => {
      if (versionId === id('068', 2)) throw new Error('UNKNOWN_EXCEPTION: read failed');
      return contentOf(4);
    });
    const insertFile = vi.fn(
      async (
        _orgId: string,
        _object: string,
        record: Record<string, unknown>,
      ): Promise<InsertResult> =>
        record['Title'] === 'Report 3'
          ? { id: '', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'] }
          : { id: `068NEW${String(record['Title']).slice(-1)}`, success: true, errors: [] },
    );
    let linkCalls = 0;
    const insertRecords = vi.fn(
      async (_orgId: string, _object: string, records: unknown[]): Promise<InsertResult[]> =>
        records.map((_, i) =>
          ++linkCalls === 2
            ? { id: '', success: false, errors: ['INSUFFICIENT_ACCESS: link refused'] }
            : { id: `06ANEW${i}`, success: true, errors: [] },
        ),
    );
    const deps = targetDeps({ readFileBody, insertFile, insertRecords });
    const report = plannedFilesReport({ files, leftOut: [], errors: [] }, MB);

    const { failures, errors } = await run(files, deps, createdCases(), report);

    expect(failures).toBe(3);
    expect(
      errors.map((e) => `[${e.stage}] ${e.objectApiName} ${e.failedCount}/${e.attemptedCount}`),
    ).toEqual([
      '[query] ContentDocument 1/4',
      '[insert] ContentDocument 1/3',
      '[insert] ContentDocumentLink 1/2',
    ]);
    expect(report.objects).toEqual([
      { objectApiName: 'ContentDocument', planned: 4, plannedBytes: 16, copied: 2, failed: 2 },
    ]);
    expect(report.links).toBe(1);
  });

  it('stops before the next file once the run is stopped, keeping what it copied', async () => {
    const deps = targetDeps();
    let calls = 0;
    const waitIfPaused = async (): Promise<void> => {
      if (++calls > 1) throw new Error('aborted');
    };
    const second = file({
      sourceId: DOC_B,
      body: { objectApiName: 'ContentVersion', id: id('068', 3) },
    });
    const remapper = createdCases();
    const report = emptyReport();

    await expect(
      copyFiles({
        files: [file(), second],
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        remapper,
        deps,
        report,
        errors: [],
        waitIfPaused,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow('aborted');

    expect(deps.insertFile).toHaveBeenCalledTimes(1);
    expect(remapper.get(DOC_A)).toBe('069NEW001');
    expect(report.objects[0].copied).toBe(1);
  });
});
