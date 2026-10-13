/**
 * Runs that copy the files of their records, through the real orchestrator,
 * DataSync, Forge's file stage and config store, against two in-memory orgs
 * that hold records, Salesforce Files with their versions and links, and
 * legacy attachments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator, type SourceRead } from './SyncOrchestrator';
import { DataSync, type OperationOutcome } from './DataSync';
import { FieldMappingService } from './FieldMapping';
import { TransformPipeline } from './TransformPipeline';
import { ConflictResolver } from './ConflictResolver';
import { SyncConfigStore } from './SyncConfigStore';
import { SyncRunFailure } from './SyncRunFailure';
import type { SyncDeltaReads } from './SyncDelta';
import type { SyncFileDeps } from './SyncFiles';
import type { ConfigStore } from '../../core/storage/ConfigStore';
import type { FileCopyDeps } from '../forge/stages/FileCopier';

type Row = Record<string, unknown>;

const MB = 1_048_576;
const SOURCE = 'src-org';
const TARGET = 'tgt-org';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** A record as an org holds it. */
interface AccountRecord {
  Id: string;
  Name: string;
  Ext_Id__c: string;
  Type: string;
  SystemModstamp: string;
}

/** One version of a Salesforce File. */
interface Version {
  Id: string;
  ContentDocumentId: string;
  Title: string;
  PathOnClient: string;
  ContentSize: number;
  ContentLocation: string;
  SharingPrivacy: string;
  IsLatest: boolean;
  SystemModstamp: string;
  content: string;
}

/** A link from a document to a record. */
interface Link {
  ContentDocumentId: string;
  LinkedEntityId: string;
  ShareType: string;
  Visibility: string;
}

/** A legacy attachment. */
interface AttachmentRow {
  Id: string;
  ParentId: string;
  Name: string;
  ContentType: string;
  BodyLength: number;
  IsPrivate: boolean;
  content: string;
}

/** What one org holds of files. */
class FileTables {
  versions: Version[] = [];
  links: Link[] = [];
  attachments: AttachmentRow[] = [];

  documents(): Row[] {
    const ids = [...new Set(this.versions.map((v) => v.ContentDocumentId))];
    return ids.map((Id) => ({
      Id,
      LatestPublishedVersionId: this.versions.find((v) => v.ContentDocumentId === Id && v.IsLatest)
        ?.Id,
    }));
  }

  table(object: string): Row[] {
    switch (object) {
      case 'ContentVersion':
        return this.versions as unknown as Row[];
      case 'ContentDocumentLink':
        return this.links as unknown as Row[];
      case 'ContentDocument':
        return this.documents();
      case 'Attachment':
        return this.attachments as unknown as Row[];
      default:
        throw new Error(`the fake org holds no ${object}`);
    }
  }
}

/**
 * The rows a statement of the shapes the file stage sends selects:
 * `SELECT … FROM X WHERE` terms joined by AND, each `F IN ('a', …)`,
 * `F = 'a'`, `F = true` or `F > <datetime>`.
 */
function select(tables: FileTables, soql: string): Row[] {
  const statement = /^SELECT .+? FROM (\w+) WHERE (.+)$/.exec(soql);
  if (!statement) throw new Error(`not a statement the fake reads: ${soql}`);
  const [, object, where] = statement;
  const tests = where.split(/ AND /).map((term) => {
    const within = /^(\w+) IN \((.*)\)$/.exec(term);
    if (within) {
      const values = within[2].split(', ').map((v) => v.replace(/^'|'$/g, ''));
      return (row: Row) => values.includes(String(row[within[1]]));
    }
    const equals = /^(\w+) = (.+)$/.exec(term);
    if (equals) {
      const value = equals[2];
      return (row: Row) =>
        value.startsWith("'")
          ? row[equals[1]] === value.slice(1, -1)
          : String(row[equals[1]]) === value;
    }
    const after = /^(\w+) > (\S+)$/.exec(term);
    if (after) return (row: Row) => String(row[after[1]]) > new Date(after[2]).toISOString();
    throw new Error(`a term the fake does not read: ${term}`);
  });
  return tables.table(object).filter((row) => tests.every((test) => test(row)));
}

/** A file's content: `bytes` letters, base64-encoded. */
const contentOf = (bytes: number, letter = 'x'): string =>
  Buffer.from(letter.repeat(bytes)).toString('base64');

/** The two orgs, and what was asked of them. */
class OrgPair {
  source: AccountRecord[] = [];
  target = new Map<string, Row>();
  sourceFiles = new FileTables();
  targetFiles = new FileTables();
  storageMB = 20;
  refuseUpsert = new Set<string>();
  /** Every query the file stage sent, by org. */
  fileQueries: string[] = [];
  private next = 1;

  stampFor(id: string, at: string): void {
    const record = this.source.find((r) => r.Id === id);
    if (!record) throw new Error(`no source record ${id}`);
    record.SystemModstamp = at;
  }

  /** A new latest version of a source document, stamped `at`. */
  newVersion(documentId: string, bytes: number, at: string): string {
    for (const v of this.sourceFiles.versions) {
      if (v.ContentDocumentId === documentId) v.IsLatest = false;
    }
    const latest = this.sourceFiles.versions.filter((v) => v.ContentDocumentId === documentId);
    const id = fakeId('068', 100 + this.next++);
    this.sourceFiles.versions.push({
      ...latest[0],
      Id: id,
      ContentSize: bytes,
      IsLatest: true,
      SystemModstamp: at,
      content: contentOf(bytes, 'y'),
    });
    return id;
  }

  querySource = vi.fn(async (_org: string, oc: SyncObjectConfig, read?: SourceRead) =>
    this.inScope(oc, read?.changedSince).map((r) => ({ attributes: { type: 'Account' }, ...r })),
  );

  inScope(oc: SyncObjectConfig, changedSince?: string): AccountRecord[] {
    return this.source
      .filter((r) => (oc.where ? r.Type === /'(.*)'/.exec(oc.where)?.[1] : true))
      .filter((r) => !changedSince || r.SystemModstamp > new Date(changedSince).toISOString());
  }

  deltaReads: SyncDeltaReads = {
    latestModstamp: vi.fn(
      async () =>
        this.source
          .map((r) => r.SystemModstamp)
          .sort()
          .at(-1) ?? null,
    ),
    deletedRows: vi.fn(async () => ({ records: [], truncated: false })),
    heldInSource: vi.fn(async () => new Set<string>()),
    targetIdsByKey: vi.fn(async () => new Map<string, string[]>()),
  };

  dataSync(): DataSync {
    return new DataSync({
      insert: async () => {
        throw new Error('not used');
      },
      update: async () => {
        throw new Error('not used');
      },
      delete: async () => {
        throw new Error('not used');
      },
      upsert: async (_object, keyField, records) =>
        records.map((record): OperationOutcome => {
          const key = String(record[keyField]);
          if (this.refuseUpsert.has(key)) {
            return { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'] };
          }
          const held = [...this.target.values()].find((r) => r.Ext_Id__c === key);
          const fields = Object.fromEntries(
            Object.entries(record).filter(([f]) => f !== 'attributes' && f !== 'Id'),
          );
          if (held) {
            Object.assign(held, fields);
            return { id: String(held.Id), success: true, errors: [], created: false };
          }
          const id = fakeId('001', 500 + this.next++);
          this.target.set(id, { ...fields, Id: id });
          return { id, success: true, errors: [], created: true };
        }),
    });
  }

  copy: FileCopyDeps = {
    queryRecords: vi.fn(async (orgId: string, soql: string) => {
      this.fileQueries.push(`${orgId === SOURCE ? 'source' : 'target'}: ${soql}`);
      return select(orgId === SOURCE ? this.sourceFiles : this.targetFiles, soql).map((r) => ({
        ...r,
      }));
    }),
    readFileBody: vi.fn(async (_orgId: string, object: string, id: string) => {
      const row =
        object === 'ContentVersion'
          ? this.sourceFiles.versions.find((v) => v.Id === id)
          : this.sourceFiles.attachments.find((a) => a.Id === id);
      if (!row) throw new Error(`no ${object} ${id}`);
      return row.content;
    }),
    insertFile: vi.fn(async (_orgId: string, object: string, record: Row) => {
      const id = fakeId(object === 'Attachment' ? '00P' : '068', 900 + this.next++);
      const content = String(record.Body ?? record.VersionData);
      const bytes = Buffer.byteLength(content, 'base64');
      if (object === 'Attachment') {
        this.targetFiles.attachments.push({
          Id: id,
          ParentId: String(record.ParentId),
          Name: String(record.Name),
          ContentType: 'text/plain',
          BodyLength: bytes,
          IsPrivate: false,
          content,
        });
        return { id, success: true, errors: [] };
      }
      const documentId =
        typeof record.ContentDocumentId === 'string'
          ? record.ContentDocumentId
          : fakeId('069', 900 + this.next++);
      for (const v of this.targetFiles.versions) {
        if (v.ContentDocumentId === documentId) v.IsLatest = false;
      }
      this.targetFiles.versions.push({
        Id: id,
        ContentDocumentId: documentId,
        Title: String(record.Title),
        PathOnClient: String(record.PathOnClient),
        ContentSize: bytes,
        ContentLocation: 'S',
        SharingPrivacy: 'N',
        IsLatest: true,
        SystemModstamp: '2026-10-13T12:00:00.000Z',
        content,
      });
      if (typeof record.FirstPublishLocationId === 'string') {
        this.targetFiles.links.push({
          ContentDocumentId: documentId,
          LinkedEntityId: record.FirstPublishLocationId,
          ShareType: 'V',
          Visibility: 'AllUsers',
        });
      }
      return { id, success: true, errors: [] };
    }),
    insertRecords: vi.fn(async (_orgId: string, _object: string, records: Row[]) =>
      records.map((record) => {
        const link = record as unknown as Link;
        const duplicate = this.targetFiles.links.some(
          (l) =>
            l.ContentDocumentId === link.ContentDocumentId &&
            l.LinkedEntityId === link.LinkedEntityId,
        );
        if (duplicate) return { id: '', success: false, errors: ['DUPLICATE_VALUE: linked'] };
        this.targetFiles.links.push({ ...link });
        return { id: fakeId('06A', 900 + this.next++), success: true, errors: [] };
      }),
    ),
    remainingFileStorageMB: vi.fn(async () => this.storageMB),
  };

  sourceIds = vi.fn(async (oc: SyncObjectConfig, changedSince?: string) =>
    this.inScope(oc, changedSince).map((r) => r.Id),
  );

  /** The target's documents, each with its versions and the target records it is linked to. */
  targetDocuments(): Array<{ id: string; versions: number; linkedTo: string[] }> {
    return this.targetFiles.documents().map((d) => ({
      id: String(d.Id),
      versions: this.targetFiles.versions.filter((v) => v.ContentDocumentId === d.Id).length,
      linkedTo: this.targetFiles.links
        .filter((l) => l.ContentDocumentId === d.Id)
        .map((l) => l.LinkedEntityId)
        .sort(),
    }));
  }

  /** The target record copied from the source record with `key`. */
  targetIdOf(key: string): string {
    const held = [...this.target.values()].find((r) => r.Ext_Id__c === key);
    if (!held) throw new Error(`no target record for ${key}`);
    return String(held.Id);
  }
}

/** A ConfigStore holding JSON copies in memory, as the extension's does. */
function memoryConfigStore(): ConfigStore {
  const data = new Map<string, { value: string; category: string }>();
  return {
    get: (key: string) => {
      const entry = data.get(key);
      return entry ? JSON.parse(entry.value) : undefined;
    },
    set: (key: string, value: unknown, category = 'general') => {
      data.set(key, { value: JSON.stringify(value), category });
    },
    delete: (key: string) => data.delete(key),
    getByCategory: (category: string) =>
      Object.fromEntries(
        [...data]
          .filter(([, e]) => e.category === category)
          .map(([k, e]) => [k, JSON.parse(e.value)]),
      ),
  } as unknown as ConfigStore;
}

function accounts(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    externalIdField: 'Ext_Id__c',
    where: "Type = 'In'",
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...overrides,
  };
}

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'cfg-files',
    name: 'files',
    description: '',
    sourceOrgId: SOURCE,
    targetOrgId: TARGET,
    direction: 'source_to_target',
    mode: 'full',
    objects: [accounts()],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    files: { maxFileSizeMB: 10, maxRunMB: 100 },
    ...overrides,
  };
}

const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const A3 = fakeId('001', 3);
const DOC_1 = fakeId('069', 1);
const DOC_3 = fakeId('069', 3);
const ATT_2 = fakeId('00P', 2);

/**
 * Three accounts, two of them in the filter. A report hangs on the first and
 * is linked to the second as well, a note is attached to the second, and the
 * third — outside the filter — has a file of its own.
 */
function seed(orgs: OrgPair): void {
  orgs.source = [
    {
      Id: A1,
      Name: 'Acme',
      Ext_Id__c: 'K-1',
      Type: 'In',
      SystemModstamp: '2026-10-13T08:00:00.000Z',
    },
    {
      Id: A2,
      Name: 'Globex',
      Ext_Id__c: 'K-2',
      Type: 'In',
      SystemModstamp: '2026-10-13T08:30:00.000Z',
    },
    {
      Id: A3,
      Name: 'Initech',
      Ext_Id__c: 'K-3',
      Type: 'Out',
      SystemModstamp: '2026-10-13T09:00:00.000Z',
    },
  ];
  const version = (id: string, documentId: string, title: string, bytes: number): Version => ({
    Id: id,
    ContentDocumentId: documentId,
    Title: title,
    PathOnClient: `${title}.txt`,
    ContentSize: bytes,
    ContentLocation: 'S',
    SharingPrivacy: 'N',
    IsLatest: true,
    SystemModstamp: '2026-10-13T07:00:00.000Z',
    content: contentOf(bytes),
  });
  orgs.sourceFiles.versions = [
    version(fakeId('068', 1), DOC_1, 'Report', 40),
    version(fakeId('068', 3), DOC_3, 'Elsewhere', 30),
  ];
  orgs.sourceFiles.links = [
    { ContentDocumentId: DOC_1, LinkedEntityId: A1, ShareType: 'V', Visibility: 'AllUsers' },
    { ContentDocumentId: DOC_1, LinkedEntityId: A2, ShareType: 'I', Visibility: 'InternalUsers' },
    { ContentDocumentId: DOC_3, LinkedEntityId: A3, ShareType: 'V', Visibility: 'AllUsers' },
  ];
  orgs.sourceFiles.attachments = [
    {
      Id: ATT_2,
      ParentId: A2,
      Name: 'note.txt',
      ContentType: 'text/plain',
      BodyLength: 12,
      IsPrivate: false,
      content: contentOf(12),
    },
  ];
}

describe('SyncOrchestrator — the files of the records it writes', () => {
  let orgs: OrgPair;
  let store: SyncConfigStore;

  beforeEach(() => {
    orgs = new OrgPair();
    seed(orgs);
    store = new SyncConfigStore(memoryConfigStore());
    store.save(config());
  });

  function fileDeps(): SyncFileDeps {
    return {
      copy: orgs.copy,
      sourceIds: orgs.sourceIds,
      store: {
        load: (id) => (store.load(id) ? store.loadFiles(id) : null),
        record: (id, entry) => store.recordFile(id, entry),
      },
    };
  }

  function orchestrator(extra: Partial<ConstructorParameters<typeof SyncOrchestrator>[0]> = {}) {
    return new SyncOrchestrator({
      dataSync: orgs.dataSync(),
      conflictResolver: new ConflictResolver(),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: orgs.querySource,
      queryTarget: vi.fn().mockResolvedValue([]),
      deltaStore: {
        load: (id) => (store.load(id) ? store.loadDelta(id) : null),
        record: (id, watermark) => store.recordWatermark(id, watermark),
      },
      deltaReads: orgs.deltaReads,
      files: fileDeps(),
      findInTarget: vi.fn(async () => new Map<string, number>()),
      ...extra,
    });
  }

  it('copies the files of the records it writes, linked to their copies, and those only', async () => {
    const result = await orchestrator().execute(config());

    const t1 = orgs.targetIdOf('K-1');
    const t2 = orgs.targetIdOf('K-2');
    // One copy of the report, published on the first account and linked to
    // the second; the file of the account outside the filter is never read.
    expect(orgs.targetDocuments()).toEqual([
      { id: expect.any(String), versions: 1, linkedTo: [t1, t2].sort() },
    ]);
    expect(orgs.targetFiles.attachments).toEqual([
      expect.objectContaining({ ParentId: t2, Name: 'note.txt', BodyLength: 12 }),
    ]);
    expect(orgs.copy.readFileBody).not.toHaveBeenCalledWith(
      SOURCE,
      'ContentVersion',
      fakeId('068', 3),
    );
    expect(result.status).toBe('success');
    expect(result.objectResults[0].files).toEqual({
      copied: 2,
      versions: 0,
      bytes: 52,
      links: 1,
      unchanged: 0,
      tooLarge: 0,
      pastRunCap: 0,
      external: 0,
      recordNotWritten: 0,
      failed: 0,
    });
    expect(result.files).toEqual({ remainingBytes: 20 * MB, plannedBytes: 52 });
  });

  it('copies no file of a record the target refused, and counts it', async () => {
    orgs.refuseUpsert.add('K-2');

    const result = await orchestrator().execute(config());

    expect(orgs.targetFiles.attachments).toEqual([]);
    // The report is published on the first account, and not linked to a
    // record the target does not hold.
    expect(orgs.targetDocuments()).toEqual([
      { id: expect.any(String), versions: 1, linkedTo: [orgs.targetIdOf('K-1')] },
    ]);
    expect(result.objectResults[0].files).toMatchObject({ copied: 1, recordNotWritten: 1 });
  });

  it('runs a second time without copying any file twice', async () => {
    await orchestrator().execute(config());
    const second = await orchestrator().execute(config());

    expect(orgs.targetDocuments()).toHaveLength(1);
    expect(orgs.targetFiles.attachments).toHaveLength(1);
    expect(second.objectResults[0].files).toMatchObject({ copied: 0, versions: 0, unchanged: 2 });
  });

  it('copies once a file linked to records of two objects, and links it to both', async () => {
    // The report hangs on an account of each object as well.
    orgs.sourceFiles.links.push({
      ContentDocumentId: DOC_1,
      LinkedEntityId: A3,
      ShareType: 'V',
      Visibility: 'AllUsers',
    });
    const twoObjects = config({
      objects: [
        accounts(),
        accounts({ objectApiName: 'Partner__c', where: "Type = 'Out'", insertOrder: 1 }),
      ],
    });

    const result = await orchestrator().execute(twoObjects);

    const report = orgs.targetDocuments().find((d) => d.versions === 1 && d.linkedTo.length === 3);
    expect(orgs.targetDocuments()).toHaveLength(2);
    expect(report?.linkedTo).toEqual(
      [orgs.targetIdOf('K-1'), orgs.targetIdOf('K-2'), orgs.targetIdOf('K-3')].sort(),
    );
    expect(result.objectResults[1].files).toMatchObject({ copied: 1, unchanged: 1, links: 1 });
  });

  it('skips and counts a file over the largest size, never cutting one', async () => {
    orgs.sourceFiles.versions[0].ContentSize = 3 * MB;
    orgs.sourceFiles.versions[0].content = contentOf(3 * MB);

    const result = await orchestrator().execute(
      config({ files: { maxFileSizeMB: 2, maxRunMB: 100 } }),
    );

    expect(orgs.targetDocuments()).toEqual([]);
    expect(result.objectResults[0].files).toMatchObject({ copied: 1, tooLarge: 1 });
    expect(result.objectResults[0].errors).toContain('1 file(s) larger than 2 MB were not copied.');
  });

  describe('past the most a run copies', () => {
    beforeEach(() => {
      orgs.sourceFiles.versions[0].ContentSize = MB;
      orgs.sourceFiles.versions[0].content = contentOf(MB);
      orgs.sourceFiles.attachments[0].BodyLength = MB;
      orgs.sourceFiles.attachments[0].content = contentOf(MB);
    });

    it('skips and counts the files past it, and copies them on the next run', async () => {
      const capped = config({ files: { maxFileSizeMB: 10, maxRunMB: 1 } });

      const first = await orchestrator().execute(capped);

      expect(first.objectResults[0].files).toMatchObject({ copied: 1, pastRunCap: 1 });
      expect(first.objectResults[0].errors).toContain(
        '1 file(s) past the 1 MB a run copies were not copied: the next run copies them.',
      );

      const second = await orchestrator().execute(capped);

      expect(second.objectResults[0].files).toMatchObject({
        copied: 1,
        unchanged: 1,
        pastRunCap: 0,
      });
      expect(orgs.targetDocuments()).toHaveLength(1);
      expect(orgs.targetFiles.attachments).toHaveLength(1);
    });

    it('keeps the watermark of a delta run that left files past it', async () => {
      const capped = config({ mode: 'delta', files: { maxFileSizeMB: 10, maxRunMB: 1 } });
      store.save(capped);

      const first = await orchestrator().execute(capped);

      expect(first.objectResults[0].delta?.recorded).toBeUndefined();
      // So the next run reads the records again, and copies what was left.
      const second = await orchestrator().execute(capped);
      expect(second.objectResults[0].delta).toMatchObject({ read: 'full', reason: 'first_run' });
      expect(second.objectResults[0].files).toMatchObject({ copied: 1, unchanged: 1 });
    });
  });

  it('refuses, with the numbers and nothing written, a run whose files do not fit in the target', async () => {
    orgs.storageMB = 1;
    orgs.sourceFiles.versions[0].ContentSize = 2 * MB;
    orgs.sourceFiles.versions[0].content = contentOf(2 * MB);

    const run = orchestrator().execute(config());

    await expect(run).rejects.toBeInstanceOf(SyncRunFailure);
    await expect(run).rejects.toThrow(
      'The files to copy take 2 MB and the target has 1 MB of file storage left.',
    );
    expect(orgs.target.size).toBe(0);
    expect(orgs.copy.insertFile).not.toHaveBeenCalled();
  });

  it('copies no file for a configuration that is not saved', async () => {
    const run = orchestrator().execute(config({ id: 'never-saved' }));

    await expect(run).rejects.toThrow('Files are copied by a saved configuration only');
    expect(orgs.target.size).toBe(0);
  });

  it('reads nothing about files when the configuration does not copy them', async () => {
    const result = await orchestrator().execute(config({ files: undefined }));

    expect(result.status).toBe('success');
    expect(orgs.target.size).toBe(2);
    expect(orgs.copy.remainingFileStorageMB).not.toHaveBeenCalled();
    expect(orgs.sourceIds).not.toHaveBeenCalled();
    expect(orgs.fileQueries).toEqual([]);
    expect(result.objectResults[0].files).toBeUndefined();
    expect(result.files).toBeUndefined();
  });

  describe('a delta run', () => {
    const delta = (): SyncConfig => config({ mode: 'delta' });

    beforeEach(() => {
      store.save(delta());
    });

    it('adds a version the source added to a copied file, never a second document', async () => {
      await orchestrator().execute(delta());
      const [copy] = orgs.targetDocuments();
      orgs.newVersion(DOC_1, 55, '2026-10-13T10:00:00.000Z');

      // No record changed: only the file did.
      const result = await orchestrator().execute(delta());

      expect(result.objectResults[0].delta).toMatchObject({ read: 'delta', changed: 0 });
      expect(orgs.targetDocuments()).toEqual([{ ...copy, versions: 2 }]);
      expect(result.objectResults[0].files).toMatchObject({ copied: 0, versions: 1, bytes: 55 });
      // The new version carries the source's new content.
      const latest = orgs.targetFiles.versions.find((v) => v.IsLatest);
      expect(latest?.content).toBe(contentOf(55, 'y'));
    });

    it('copies nothing again when neither the records nor their files changed', async () => {
      await orchestrator().execute(delta());
      orgs.stampFor(A1, '2026-10-13T10:00:00.000Z');

      const result = await orchestrator().execute(delta());

      expect(result.objectResults[0].delta).toMatchObject({ read: 'delta', changed: 1 });
      expect(result.objectResults[0].files).toMatchObject({ copied: 0, versions: 0, unchanged: 1 });
      expect(orgs.targetDocuments()).toHaveLength(1);
      expect(orgs.targetDocuments()[0].versions).toBe(1);
    });

    it('copies the version of a file once, however many runs read it', async () => {
      await orchestrator().execute(delta());
      orgs.newVersion(DOC_1, 55, '2026-10-13T10:00:00.000Z');
      await orchestrator().execute(delta());
      // Within the overlap the next read reads the version again.
      orgs.stampFor(A1, '2026-10-13T10:01:00.000Z');

      const third = await orchestrator().execute(delta());

      expect(third.objectResults[0].files).toMatchObject({ versions: 0, unchanged: 1 });
      expect(orgs.targetDocuments()[0].versions).toBe(2);
    });
  });

  it('takes as copied a file the target holds under the same id, as a sandbox of the same production does', async () => {
    orgs.targetFiles.versions = [{ ...orgs.sourceFiles.versions[0] }];
    orgs.targetFiles.links = [
      {
        ContentDocumentId: DOC_1,
        LinkedEntityId: 'placeholder',
        ShareType: 'V',
        Visibility: 'AllUsers',
      },
    ];

    const result = await orchestrator().execute(config());

    expect(orgs.targetDocuments().map((d) => d.id)).toEqual([DOC_1]);
    expect(orgs.targetDocuments()[0].versions).toBe(1);
    expect(result.objectResults[0].files).toMatchObject({ copied: 1, unchanged: 1 });
  });

  describe('a simulation', () => {
    it('says how many files and how much a run would copy, and writes and records nothing', async () => {
      const simulation = await orchestrator().simulate(config());

      expect(simulation.objects[0].files).toMatchObject({ copied: 2, bytes: 52, unchanged: 0 });
      expect(simulation.files).toEqual({ remainingBytes: 20 * MB, plannedBytes: 52 });
      expect(orgs.copy.insertFile).not.toHaveBeenCalled();
      expect(orgs.copy.readFileBody).not.toHaveBeenCalled();
      expect(store.loadFiles('cfg-files')).toEqual({ kind: 'none' });
    });

    it('says what a run copied already would not be copied again', async () => {
      await orchestrator().execute(config());

      const simulation = await orchestrator().simulate(config());

      expect(simulation.objects[0].files).toMatchObject({ copied: 0, unchanged: 2, bytes: 0 });
    });

    it('says when the files would not fit, as the run would be refused', async () => {
      orgs.storageMB = 0;

      const simulation = await orchestrator().simulate(config());

      expect(simulation.files?.shortfall).toBe(
        'The files to copy take 52 B and the target has 0 B of file storage left. Lower the ' +
          'largest file or the most a run copies, or leave the files out.',
      );
    });
  });

  it('stops before the next file on a cancel, keeping a record of what it copied', async () => {
    const controller = new AbortController();
    const insertFile = orgs.copy.insertFile;
    orgs.copy.insertFile = vi.fn(async (...args: Parameters<FileCopyDeps['insertFile']>) => {
      const written = await insertFile(...args);
      controller.abort();
      return written;
    });

    const result = await orchestrator({ signal: controller.signal }).execute(config());

    expect(result.cancelled).toBe(true);
    expect(result.error).toMatch(/^Cancelled while the files of Account were copied/);
    expect(result.objectResults[0].files).toMatchObject({ copied: 1 });
    const kept = store.loadFiles('cfg-files');
    expect(kept.kind === 'stored' ? kept.map.entries.map((e) => e.sourceId) : []).toEqual([DOC_1]);
  });
});
