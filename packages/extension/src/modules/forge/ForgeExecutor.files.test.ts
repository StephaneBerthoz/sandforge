import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { forgeRunCreatedRecords } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from './ForgeExecutor.js';
import { ForgeFilesRefusedError } from './stages/FileCopier.js';
import { finishedRunStatus } from './runResult.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const MB = 1_048_576;

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT = id('001', 1);
const KEY_CONTACT = id('003', 1);
const OTHER_CONTACT = id('003', 2);
const ELSEWHERE_ACCOUNT = id('001', 9);
const DOCUMENT = id('069', 1);
const ELSEWHERE_DOCUMENT = id('069', 9);
const ATTACHMENT = id('00P', 1);

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: false,
});
const lookup = (name: string, target: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  isReference: true,
  referenceTo: [target],
  nillable: true,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Account: [idField, text('Name')],
  Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
};

function node(objectApiName: string): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 2,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

const EDGE: ForgeGraphEdge = {
  sourceObject: 'Account',
  targetObject: 'Contact',
  relationshipName: 'Contacts',
  type: 'lookup',
};

const GRAPH: ForgeGraph = {
  nodes: [node('Account'), node('Contact')],
  edges: [EDGE],
  totalRecords: 4,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** An account with two contacts, a file on the account and the key contact, an attachment. */
function sourceTables(): Record<string, FakeRow[]> {
  return {
    Account: [
      { Id: ACCOUNT, Name: 'Root' },
      { Id: ELSEWHERE_ACCOUNT, Name: 'Elsewhere' },
    ],
    Contact: [
      { Id: KEY_CONTACT, LastName: 'Key', AccountId: ACCOUNT },
      { Id: OTHER_CONTACT, LastName: 'Other', AccountId: ACCOUNT },
    ],
    ContentDocumentLink: [
      {
        ContentDocumentId: DOCUMENT,
        LinkedEntityId: ACCOUNT,
        ShareType: 'I',
        Visibility: 'AllUsers',
      },
      {
        ContentDocumentId: DOCUMENT,
        LinkedEntityId: KEY_CONTACT,
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
      {
        ContentDocumentId: ELSEWHERE_DOCUMENT,
        LinkedEntityId: ELSEWHERE_ACCOUNT,
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
    ],
    ContentVersion: [
      {
        Id: id('068', 1),
        ContentDocumentId: DOCUMENT,
        IsLatest: true,
        Title: 'Contract',
        PathOnClient: 'contract.pdf',
        ContentSize: '4',
        ContentLocation: 'S',
        SharingPrivacy: 'N',
      },
      {
        Id: id('068', 9),
        ContentDocumentId: ELSEWHERE_DOCUMENT,
        IsLatest: true,
        Title: 'Elsewhere',
        PathOnClient: 'elsewhere.pdf',
        ContentSize: '4',
        ContentLocation: 'S',
        SharingPrivacy: 'N',
      },
    ],
    Attachment: [
      {
        Id: ATTACHMENT,
        ParentId: OTHER_CONTACT,
        Name: 'note.txt',
        ContentType: 'text/plain',
        BodyLength: '3',
        IsPrivate: false,
      },
    ],
  };
}

/** Rows as the API answers them: sizes are numbers there. */
function answered(rows: FakeRow[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) =>
        k === 'ContentSize' || k === 'BodyLength' ? [k, Number(v)] : [k, v],
      ),
    ),
  );
}

/** Key prefixes of what the target creates. */
const TARGET_PREFIX: Record<string, string> = {
  Account: '001',
  Contact: '003',
  ContentVersion: '068',
  ContentDocument: '069',
  Attachment: '00P',
  ContentDocumentLink: '06A',
};

/**
 * A source org holding the tables above, and a target that gives each record
 * it creates an id of its object and a name to read it by: the contact named
 * Key is `Contact:Key`, the first file written `ContentVersion:1` and its
 * document `ContentDocument:1`. Every write is logged in the order it reached
 * the target.
 */
function fakeOrgs(storageLeftMB = 100) {
  const tables = sourceTables();
  const writes: string[] = [];
  const sent: Array<{ object: string; record: Record<string, unknown> }> = [];
  const names = new Map<string, string>();
  const documents = new Map<string, string>();
  let next = 500;
  let files = 0;
  const create = (object: string, name: string): string => {
    const created = id(TARGET_PREFIX[object], ++next);
    names.set(created, `${object}:${name}`);
    return created;
  };
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') return answered(selectRows(tables, soql));
      const versionId = /FROM ContentVersion WHERE Id = '([^']+)'/.exec(soql)?.[1];
      if (!versionId) return [];
      const document =
        documents.get(versionId) ??
        create('ContentDocument', (names.get(versionId) ?? '').split(':')[1]);
      documents.set(versionId, document);
      return [{ ContentDocumentId: document }];
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      writes.push(`insert ${object}`);
      sent.push(...rows.map((record) => ({ object, record })));
      return rows.map((row) => ({
        id: create(object, String(row['Name'] ?? row['LastName'] ?? names.size)),
        success: true,
        errors: [],
      }));
    }),
    readFileBody: vi.fn(async (_org: string, object: string, recordId: string) => {
      const size = object === 'Attachment' ? 3 : 4;
      return Buffer.from(recordId.slice(0, size)).toString('base64');
    }),
    insertFile: vi.fn(
      async (
        _org: string,
        object: string,
        record: Record<string, unknown>,
      ): Promise<InsertResult> => {
        writes.push(`file ${object}`);
        sent.push({ object, record });
        return { id: create(object, String(++files)), success: true, errors: [] };
      },
    ),
    remainingFileStorageMB: vi.fn(async () => storageLeftMB),
  } satisfies ForgeExecutorDeps;
  /** A value the target was sent or answered, by the name of the record it is the id of. */
  const named = (value: unknown): unknown =>
    typeof value === 'string' ? (names.get(value) ?? value) : value;
  const readable = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, named(v)]));
  return { deps, writes, sent, named, readable };
}

const SCOPED: ExecuteOptions = { rootRecordId: ACCOUNT, rootObjectApiName: 'Account' };
const FILES = { maxFileBytes: 10 * MB };

describe('ForgeExecutor, copying the files of the records it clones', () => {
  it('writes the files after the records they hang on, published on the record the run created', async () => {
    const { deps, writes, sent, readable } = fakeOrgs();

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...SCOPED,
      files: FILES,
    });

    expect(writes).toEqual([
      'insert Account',
      'insert Contact',
      'file ContentVersion',
      'insert ContentDocumentLink',
      'file Attachment',
    ]);
    expect(
      sent
        .filter((s) => s.object !== 'Account' && s.object !== 'Contact')
        .map((s) => ({ object: s.object, record: readable(s.record) })),
    ).toEqual([
      {
        object: 'ContentVersion',
        record: {
          Title: 'Contract',
          PathOnClient: 'contract.pdf',
          VersionData: Buffer.from(id('068', 1).slice(0, 4)).toString('base64'),
          FirstPublishLocationId: 'Account:Root',
        },
      },
      {
        object: 'ContentDocumentLink',
        record: {
          ContentDocumentId: 'ContentDocument:1',
          LinkedEntityId: 'Contact:Key',
          ShareType: 'V',
          Visibility: 'AllUsers',
        },
      },
      {
        object: 'Attachment',
        record: {
          Name: 'note.txt',
          ContentType: 'text/plain',
          IsPrivate: false,
          Body: Buffer.from(ATTACHMENT.slice(0, 3)).toString('base64'),
          ParentId: 'Contact:Other',
        },
      },
    ]);
    expect(summary.files).toEqual({
      maxFileBytes: 10 * MB,
      objects: [
        { objectApiName: 'ContentDocument', planned: 1, plannedBytes: 4, copied: 1, failed: 0 },
        { objectApiName: 'Attachment', planned: 1, plannedBytes: 3, copied: 1, failed: 0 },
      ],
      links: 1,
      leftOut: [],
      remainingStorageBytes: 100 * MB,
    });
  });

  it('counts the files it created among the records removing the run takes, and takes them first', async () => {
    const { deps, named } = fakeOrgs();

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...SCOPED,
      files: FILES,
    });

    expect(summary.remapByObject).toEqual([
      { objectApiName: 'Account', created: 1, linked: 0 },
      { objectApiName: 'Contact', created: 2, linked: 0 },
      { objectApiName: 'ContentDocument', created: 1, linked: 0 },
      { objectApiName: 'Attachment', created: 1, linked: 0 },
    ]);
    const plan = forgeRunCreatedRecords({
      idRemapTable: summary.remapTable,
      idRemapExisting: summary.existingSourceIds,
      idRemapCreated: summary.createdByObject,
    });
    expect(plan.map((o) => [o.objectApiName, o.ids.map(named)])).toEqual([
      ['Attachment', ['Attachment:2']],
      ['ContentDocument', ['ContentDocument:1']],
      ['Contact', ['Contact:Other', 'Contact:Key']],
      ['Account', ['Account:Root']],
    ]);
  });

  it('reads no file when the run is not asked to copy them', async () => {
    const { deps, writes } = fakeOrgs();

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      SCOPED,
    );

    const soql = deps.queryRecords.mock.calls.map((c) => c[1]).join('\n');
    expect(soql).not.toContain('ContentDocumentLink');
    expect(soql).not.toContain('FROM Attachment');
    expect(writes).toEqual(['insert Account', 'insert Contact']);
    expect(summary.files).toBeUndefined();
  });

  describe('while the run anonymizes', () => {
    const anonymization = { fields: { Contact: ['LastName'] }, methods: {} };

    it('refuses the run before reading anything unless the files were accepted as they are', async () => {
      const { deps } = fakeOrgs();

      const run = new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...SCOPED,
        anonymization,
        files: FILES,
      });

      await expect(run).rejects.toBeInstanceOf(ForgeFilesRefusedError);
      await expect(run).rejects.toThrow('copied as they are');
      expect(deps.queryRecords).not.toHaveBeenCalled();
      expect(deps.insertRecords).not.toHaveBeenCalled();
    });

    it('copies the files as they are once they were accepted so', async () => {
      const { deps, writes } = fakeOrgs();

      const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...SCOPED,
        anonymization,
        files: { ...FILES, acceptedAsIs: true },
      });

      expect(writes).toContain('file ContentVersion');
      expect(summary.files?.objects.map((o) => o.copied)).toEqual([1, 1]);
    });
  });

  it('writes nothing at all when the files do not fit in what the target has left', async () => {
    const { deps } = fakeOrgs(0);

    const run = new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...SCOPED,
      files: FILES,
    });

    await expect(run).rejects.toBeInstanceOf(ForgeFilesRefusedError);
    await expect(run).rejects.toThrow(
      'The files to copy take 7 B and the target has 0 B of file storage left.',
    );
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(deps.insertFile).not.toHaveBeenCalled();
  });

  it('checks the files of a full-table run against the target before its first write', async () => {
    // A full-table run writes each object as soon as it has read it; asked
    // to copy files, it reads everything first so nothing is written before
    // the files are measured.
    const { deps } = fakeOrgs(0);
    const tables = sourceTables();
    deps.queryRecords.mockImplementation(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return /WHERE/.test(soql) ? answered(selectRows(tables, soql)) : answered(tables[object]);
    });

    const run = new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      files: FILES,
    });

    await expect(run).rejects.toBeInstanceOf(ForgeFilesRefusedError);
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('copies no file of a record it maps by name instead of cloning', async () => {
    // Business hours are matched to the target's own by name: the run clones
    // none, so it has no record to hang their files on, and reads none.
    const { deps } = fakeOrgs();
    const tables = sourceTables();
    const HOURS = id('01m', 1);
    tables.BusinessHours = [{ Id: HOURS, Name: 'Default' }];
    tables.ContentDocumentLink.push({
      ContentDocumentId: id('069', 5),
      LinkedEntityId: HOURS,
      ShareType: 'V',
      Visibility: 'AllUsers',
    });
    tables.ContentVersion.push({
      Id: id('068', 5),
      ContentDocumentId: id('069', 5),
      IsLatest: true,
      Title: 'Opening times',
      PathOnClient: 'hours.pdf',
      ContentSize: '4',
      ContentLocation: 'S',
      SharingPrivacy: 'N',
    });
    deps.queryRecords.mockImplementation(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return /WHERE/.test(soql) ? answered(selectRows(tables, soql)) : answered(tables[object]);
    });
    const graph: ForgeGraph = { ...GRAPH, nodes: [...GRAPH.nodes, node('BusinessHours')] };

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => undefined, {
      files: FILES,
    });

    const listed = [
      ...(summary.files?.leftOut ?? []).map((f) => f.sourceId),
      ...deps.readFileBody.mock.calls.map((c) => c[2]),
    ];
    expect(listed).not.toContain(id('069', 5));
    expect(listed).not.toContain(id('068', 5));
    expect(deps.readFileBody.mock.calls.map((c) => c[2])).toContain(id('068', 1));
  });

  it('lists on a dry run the files it would copy and their size, and writes nothing', async () => {
    const { deps, writes } = fakeOrgs();
    const events: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      (e) => events.push(e),
      { ...SCOPED, dryRun: true, files: FILES },
    );

    expect(writes).toEqual([]);
    expect(deps.readFileBody).not.toHaveBeenCalled();
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        '[dry-run] ContentDocument: 1 file would be copied (4 B)',
        '[dry-run] Attachment: 1 attachment would be copied (3 B)',
      ]),
    );
    expect(summary.files?.objects).toEqual([
      { objectApiName: 'ContentDocument', planned: 1, plannedBytes: 4, copied: 0, failed: 0 },
      { objectApiName: 'Attachment', planned: 1, plannedBytes: 3, copied: 0, failed: 0 },
    ]);
    expect(summary.files?.wouldCopy).toEqual([
      { objectApiName: 'ContentDocument', sourceId: DOCUMENT, name: 'Contract', bytes: 4 },
      { objectApiName: 'Attachment', sourceId: ATTACHMENT, name: 'note.txt', bytes: 3 },
    ]);
  });

  it('says on a dry run that the files would not fit, without stopping it', async () => {
    const { deps } = fakeOrgs(0);

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...SCOPED,
      dryRun: true,
      files: FILES,
    });

    expect(summary.errors).toContainEqual({
      objectApiName: '__files__',
      stage: 'scope',
      failedCount: 0,
      attemptedCount: 0,
      samples: [
        {
          recordSummary: '(files)',
          messages: [
            'The files to copy take 7 B and the target has 0 B of file storage left. ' +
              'Lower the largest file copied, or leave the files out.',
          ],
        },
      ],
    });
  });

  it('refuses a run asked to copy files that has no way to move one', async () => {
    const { deps } = fakeOrgs();
    const unwired: ForgeExecutorDeps = {
      describeFields: deps.describeFields,
      queryRecords: deps.queryRecords,
      insertRecords: deps.insertRecords,
    };

    await expect(
      new ForgeExecutor(unwired).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...SCOPED,
        files: FILES,
      }),
    ).rejects.toThrow('This session cannot copy files');
    expect(deps.queryRecords).not.toHaveBeenCalled();
  });

  it('counts a file the target refused as failed, so the run does not read as a success', async () => {
    const { deps } = fakeOrgs();
    deps.insertFile.mockResolvedValueOnce({
      id: '',
      success: false,
      errors: ['STORAGE_LIMIT_EXCEEDED: storage limit exceeded'],
    });

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...SCOPED,
      files: FILES,
    });

    expect(summary.failedCount).toBe(1);
    expect(finishedRunStatus(summary)).toBe('partial');
    expect(summary.errors.find((e) => e.objectApiName === 'ContentDocument')?.stage).toBe('insert');
  });
});
