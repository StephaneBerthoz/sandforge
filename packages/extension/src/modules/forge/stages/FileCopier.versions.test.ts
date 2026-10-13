import { describe, it, expect, vi } from 'vitest';
import type { ForgeFilesReport } from '@sandforge/shared';
import {
  copyFiles,
  plannedFilesReport,
  type CopiedFile,
  type FileCopyDeps,
  type FileToCopy,
} from './FileCopier.js';
import { IdRemapper } from '../IdRemapper.js';
import type { InsertResult } from '../ForgeExecutor.js';

/**
 * The file stage as Sync uses it: a Salesforce File an earlier run copied is
 * written as a new version of that copy, or only linked to the records it
 * lacks — never a second document.
 */

const MB = 1_048_576;

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const CASE_1 = id('500', 1);
const CASE_2 = id('500', 2);
const DOC_A = id('069', 1);
const COPY_OF_A = id('069', 7);

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
    fields: { Title: 'Report', PathOnClient: 'report.pdf', SharingPrivacy: 'P' },
    ...overrides,
  };
}

function targetDeps(overrides: Partial<FileCopyDeps> = {}) {
  return {
    queryRecords: vi.fn(async () => [{ ContentDocumentId: id('069', 8) }]),
    readFileBody: vi.fn(async () => contentOf(4)),
    insertFile: vi.fn(async (): Promise<InsertResult> => ({
      id: id('068', 9),
      success: true,
      errors: [],
    })),
    insertRecords: vi.fn(async (_orgId: string, _object: string, records: unknown[]) =>
      records.map((_, i) => ({ id: `06ANEW${i}`, success: true, errors: [] })),
    ),
    remainingFileStorageMB: vi.fn(async () => 100),
    ...overrides,
  };
}

/** The two cases the run wrote. */
function writtenCases(): IdRemapper {
  const remapper = new IdRemapper();
  remapper.add(CASE_1, '500NEW1', 'Case');
  remapper.add(CASE_2, '500NEW2', 'Case');
  return remapper;
}

async function run(
  files: FileToCopy[],
  deps: ReturnType<typeof targetDeps>,
  remapper = writtenCases(),
) {
  const report: ForgeFilesReport = plannedFilesReport({ files, leftOut: [], errors: [] }, MB);
  const copied: Array<{ file: FileToCopy; copy: CopiedFile }> = [];
  await copyFiles({
    files,
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    remapper,
    deps,
    report,
    errors: [],
    waitIfPaused: async () => undefined,
    onProgress: () => undefined,
    onCopied: (copiedFile, copy) => copied.push({ file: copiedFile, copy }),
  });
  return { report, copied };
}

describe('copyFiles — a Salesforce File an earlier run copied', () => {
  it('writes the new version into the copy instead of publishing a second document', async () => {
    const deps = targetDeps();

    const { copied, report } = await run(
      [file({ into: { documentId: COPY_OF_A, linked: ['500NEW1', '500NEW2'] } })],
      deps,
    );

    // Who sees the document stays as the copy has it: a version cannot set it.
    expect(deps.insertFile).toHaveBeenCalledWith('tgt', 'ContentVersion', {
      Title: 'Report',
      PathOnClient: 'report.pdf',
      VersionData: contentOf(4),
      ContentDocumentId: COPY_OF_A,
    });
    // Its document is known: nothing is read back, and no record is linked twice.
    expect(deps.queryRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(copied).toEqual([
      {
        file: expect.objectContaining({ sourceId: DOC_A }),
        copy: { targetId: COPY_OF_A, linked: [], asVersion: true },
      },
    ]);
    expect(report.objects[0]).toMatchObject({ copied: 1, failed: 0 });
  });

  it('writes the new version whether or not the run wrote a record it hangs on', async () => {
    const deps = targetDeps();

    const { copied } = await run(
      [file({ into: { documentId: COPY_OF_A, linked: ['500OLD1'] } })],
      deps,
      new IdRemapper(),
    );

    expect(deps.insertFile).toHaveBeenCalledTimes(1);
    expect(copied[0].copy).toEqual({ targetId: COPY_OF_A, linked: [], asVersion: true });
  });

  it('links the new version to the records the copy lacks', async () => {
    const deps = targetDeps();

    const { copied } = await run(
      [file({ into: { documentId: COPY_OF_A, linked: ['500NEW1'] } })],
      deps,
    );

    expect(deps.insertRecords).toHaveBeenCalledWith('tgt', 'ContentDocumentLink', [
      {
        ContentDocumentId: COPY_OF_A,
        LinkedEntityId: '500NEW2',
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
    ]);
    expect(copied[0].copy.linked).toEqual(['500NEW2']);
  });

  it('only links a copy whose source has not changed, reading and writing no content', async () => {
    const deps = targetDeps();

    const { copied, report } = await run(
      [file({ into: { documentId: COPY_OF_A, linked: ['500NEW1'], unchanged: true } })],
      deps,
    );

    expect(deps.readFileBody).not.toHaveBeenCalled();
    expect(deps.insertFile).not.toHaveBeenCalled();
    expect(deps.insertRecords).toHaveBeenCalledWith('tgt', 'ContentDocumentLink', [
      expect.objectContaining({ ContentDocumentId: COPY_OF_A, LinkedEntityId: '500NEW2' }),
    ]);
    expect(copied[0].copy).toEqual({ targetId: COPY_OF_A, linked: ['500NEW2'], asVersion: false });
    expect(report.objects[0]).toMatchObject({ copied: 0, failed: 0 });
  });

  it('says nothing of an unchanged copy already linked to every record', async () => {
    const deps = targetDeps();

    const { copied } = await run(
      [file({ into: { documentId: COPY_OF_A, linked: ['500NEW1', '500NEW2'], unchanged: true } })],
      deps,
    );

    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(copied).toEqual([]);
  });

  it('counts in its progress the files it copies, not the copies it only links', async () => {
    const deps = targetDeps();
    const messages: string[] = [];
    const files = [
      file({ into: { documentId: COPY_OF_A, linked: ['500NEW1'], unchanged: true } }),
      file({ sourceId: id('069', 2), into: { documentId: id('069', 6), linked: [] } }),
    ];

    await copyFiles({
      files,
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      remapper: writtenCases(),
      deps,
      report: plannedFilesReport({ files, leftOut: [], errors: [] }, MB),
      errors: [],
      waitIfPaused: async () => undefined,
      onProgress: (event) => {
        if (event.status === 'running') messages.push(event.message);
      },
    });

    // It said "file 1 of 2" of the one file a run copied, with a copy it only linked.
    expect(messages).toEqual(['Copying file 1 of 1 (4 B)']);
  });

  it('tells which records a new document was published on and linked to', async () => {
    const deps = targetDeps();

    const { copied } = await run([file()], deps);

    expect(copied[0].copy).toEqual({
      targetId: id('069', 8),
      linked: ['500NEW1', '500NEW2'],
      asVersion: false,
    });
  });

  it('leaves out of what it tells a link the target refused', async () => {
    const deps = targetDeps({
      insertRecords: vi.fn(async () => [
        { id: '', success: false, errors: ['INSUFFICIENT_ACCESS'] },
      ]),
    });

    const { copied } = await run([file()], deps);

    expect(copied[0].copy.linked).toEqual(['500NEW1']);
  });
});
