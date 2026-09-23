import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { forgeRunCreatedRecords } from '@sandforge/shared';
import { ForgeExecutor, type FieldInfo, type ForgeExecutorDeps } from './ForgeExecutor.js';
import { removeRunRecords, type RemovalOrg } from './ForgeRunRemoval.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const CASE = id('500', 1);
const DOCUMENT = id('069', 1);
const ATTACHMENT = id('00P', 1);

type Row = Record<string, unknown> & { Id: string };

/** What each object's describe lists as the records deleted along with one of its own. */
const CASCADES: Record<string, Array<{ childSObject: string; field: string }>> = {
  ContentDocument: [
    { childSObject: 'ContentVersion', field: 'ContentDocumentId' },
    { childSObject: 'ContentDocumentLink', field: 'ContentDocumentId' },
  ],
  Case: [
    { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId' },
    { childSObject: 'Attachment', field: 'ParentId' },
  ],
};

const PREFIX: Record<string, string> = {
  Case: '500',
  ContentVersion: '068',
  ContentDocument: '069',
  ContentDocumentLink: '06A',
  Attachment: '00P',
};

/** The user the target writes as: a file's owner, whose link the platform adds. */
const OWNER = id('005', 1);

/** The columns a file's link keeps: no created or modified date, a system stamp. */
const LINK_COLUMNS = new Set([
  'Id',
  'ContentDocumentId',
  'LinkedEntityId',
  'ShareType',
  'Visibility',
  'SystemModstamp',
]);

/**
 * The target sandbox in memory, as a clone writes into it and a removal reads
 * and deletes: a file written as a version brings its document, the owner's
 * link and a link to the record it is published on; deleting a document takes
 * its versions and links, and a version cannot be deleted on its own.
 *
 * Stamped as a real one: a record with the dates it is written at, and a link
 * with only a system stamp, set a few seconds later — the run copies its
 * files last, so its last links are stamped after it ended.
 */
class TargetOrg implements RemovalOrg {
  readonly rows = new Map<string, Row[]>();
  private next = 100;

  private insert(object: string, fields: Record<string, unknown>): Row {
    const now = Date.now();
    const dates =
      object === 'ContentDocumentLink'
        ? { SystemModstamp: new Date(now + 5_000).toISOString() }
        : {
            CreatedDate: new Date(now).toISOString(),
            LastModifiedDate: new Date(now).toISOString(),
          };
    const row: Row = { ...fields, Id: id(PREFIX[object], ++this.next), ...dates };
    this.rows.set(object, [...(this.rows.get(object) ?? []), row]);
    return row;
  }

  all(object: string): Row[] {
    return this.rows.get(object) ?? [];
  }

  writeRecords(object: string, records: Record<string, unknown>[]) {
    return records.map((record) => ({
      id: this.insert(object, record).Id,
      success: true,
      errors: [],
    }));
  }

  writeFile(object: string, record: Record<string, unknown>) {
    if (object === 'Attachment') {
      return { id: this.insert('Attachment', record).Id, success: true, errors: [] };
    }
    const document = this.insert('ContentDocument', { Title: record['Title'] });
    const version = this.insert('ContentVersion', { ...record, ContentDocumentId: document.Id });
    for (const linked of [OWNER, record['FirstPublishLocationId']]) {
      this.insert('ContentDocumentLink', {
        ContentDocumentId: document.Id,
        LinkedEntityId: linked,
      });
    }
    return { id: version.Id, success: true, errors: [] };
  }

  /** Link a file to a record, as someone does after the run. */
  share(documentId: string, linkedEntityId: string): void {
    this.insert('ContentDocumentLink', {
      ContentDocumentId: documentId,
      LinkedEntityId: linkedEntityId,
    });
  }

  async describe(objectApiName: string): Promise<unknown> {
    return {
      name: objectApiName,
      label: objectApiName,
      fields: [],
      childRelationships: (CASCADES[objectApiName] ?? []).map((r) => ({
        ...r,
        cascadeDelete: true,
      })),
    };
  }

  async describeGlobal(): Promise<unknown> {
    // Every one of them has a page layout, a file's links included.
    return {
      sobjects: Object.keys(PREFIX).map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    };
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    const match =
      /^SELECT (.+) FROM (\w+) WHERE (\w+) (?:IN \((.*)\)|= '(\w+)')(?: LIMIT \d+)?$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, columns, object, field, list, single] = match;
    const missing =
      object === 'ContentDocumentLink' &&
      columns.split(', ').find((column) => !LINK_COLUMNS.has(column));
    if (missing)
      throw new Error(`INVALID_FIELD: No such column '${missing}' on entity '${object}'`);
    const wanted = new Set(
      single !== undefined ? [single] : list.split(', ').map((quoted) => quoted.slice(1, -1)),
    );
    const records = this.all(object)
      .filter((row) => wanted.has(String(row[field])))
      .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])));
    return { totalSize: records.length, records };
  }

  /** No record of a file-copying run is put back to Draft: nothing to change. */
  async update(): Promise<unknown> {
    return [];
  }

  /** The clock it stamps records by. */
  async serverTime(): Promise<string> {
    return new Date().toISOString();
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    return ids.map((recordId) => {
      if (objectApiName === 'ContentVersion') {
        return {
          success: false,
          errors: [{ statusCode: 'INVALID_OPERATION', message: 'delete not allowed' }],
        };
      }
      if (!this.all(objectApiName).some((r) => r.Id === recordId)) {
        return { success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }] };
      }
      this.remove(objectApiName, recordId);
      return { id: recordId, success: true, errors: [] };
    });
  }

  private remove(object: string, recordId: string): void {
    this.rows.set(
      object,
      this.all(object).filter((r) => r.Id !== recordId),
    );
    for (const { childSObject, field } of CASCADES[object] ?? []) {
      for (const child of this.all(childSObject).filter((r) => r[field] === recordId)) {
        this.remove(childSObject, child.Id);
      }
    }
  }
}

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };

const GRAPH: ForgeGraph = {
  nodes: [
    {
      objectApiName: 'Case',
      recordCount: 1,
      fieldCount: 2,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 1,
      estimatedSizeMB: 0,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    } satisfies ForgeGraphNode,
  ],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** The source: a case with a file and an attachment. */
const SOURCE: Record<string, FakeRow[]> = {
  Case: [{ Id: CASE, Subject: 'Broken' }],
  ContentDocumentLink: [
    { ContentDocumentId: DOCUMENT, LinkedEntityId: CASE, ShareType: 'V', Visibility: 'AllUsers' },
  ],
  ContentVersion: [
    {
      Id: id('068', 1),
      ContentDocumentId: DOCUMENT,
      IsLatest: true,
      Title: 'Photo',
      PathOnClient: 'photo.png',
      ContentSize: '4',
      ContentLocation: 'S',
      SharingPrivacy: 'N',
    },
  ],
  Attachment: [
    {
      Id: ATTACHMENT,
      ParentId: CASE,
      Name: 'log.txt',
      ContentType: 'text/plain',
      BodyLength: '4',
      IsPrivate: false,
    },
  ],
};

/** Clone the case with its files into `target`, and hand back the run's summary. */
async function cloneInto(target: TargetOrg) {
  return { summary: await clone(target) };
}

/** Remove what the run created, over the span the target dated it by, as the extension does. */
async function removeRun(target: TargetOrg, run: Awaited<ReturnType<typeof cloneInto>>) {
  const plan = forgeRunCreatedRecords({
    idRemapTable: run.summary.remapTable,
    idRemapExisting: run.summary.existingSourceIds,
    idRemapCreated: run.summary.createdByObject,
  });
  const span = run.summary.writtenBetween;
  if (!span) throw new Error('The run was not dated by the target.');
  return removeRunRecords(target, plan, {
    runStartedAt: new Date(span.first),
    runEndedAt: new Date(span.last),
    includeChanged: false,
  });
}

async function clone(target: TargetOrg) {
  const deps: ForgeExecutorDeps = {
    describeFields: async (_org, object) =>
      object === 'Case'
        ? [idField, { name: 'Subject', queryable: true, createable: true, isReference: false }]
        : [idField],
    queryRecords: async (org, soql) => {
      if (org === 'tgt') return (await target.query(soql)).records as Record<string, unknown>[];
      return selectRows(SOURCE, soql).map((row) => ({
        ...row,
        ...(row['ContentSize'] ? { ContentSize: Number(row['ContentSize']) } : {}),
        ...(row['BodyLength'] ? { BodyLength: Number(row['BodyLength']) } : {}),
      }));
    },
    insertRecords: async (_org, object, records) => target.writeRecords(object, records),
    readFileBody: async () => Buffer.from('file').toString('base64'),
    insertFile: async (_org, object, record) => target.writeFile(object, record),
    remainingFileStorageMB: async () => 100,
  };
  return new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
    rootRecordId: CASE,
    rootObjectApiName: 'Case',
    files: { maxFileBytes: 1_048_576 },
  });
}

describe('removing the records a run created, when the run copied files', () => {
  it('removes the files it created with them: each document, which takes its versions and links', async () => {
    // The file's links are stamped after the run ended, as a real target
    // stamps the last file of a run: read by their date, they held the file
    // and the case it was published on in the org. The removal comes a
    // minute later, long after the links were stamped.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const target = new TargetOrg();
      const run = await cloneInto(target);
      expect(target.all('ContentVersion')).toHaveLength(1);
      expect(target.all('ContentDocumentLink')).toHaveLength(2);
      expect(target.all('Attachment')).toHaveLength(1);
      vi.setSystemTime(Date.now() + 60_000);

      const outcome = await removeRun(target, run);

      expect(
        outcome.objects.map((o) => [o.objectApiName, o.deleted, o.keptDependents, o.refused]),
      ).toEqual([
        ['Attachment', 1, 0, 0],
        ['ContentDocument', 1, 0, 0],
        ['Case', 1, 0, 0],
      ]);
      for (const object of Object.keys(PREFIX)) {
        expect({ object, left: target.all(object) }).toEqual({ object, left: [] });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a file someone linked since the run to a record the run did not create', async () => {
    // Someone shares the file a minute after the run, and the removal comes a
    // minute after that: a link made during the removal would be its own doing.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const target = new TargetOrg();
      const run = await cloneInto(target);
      const [document] = target.all('ContentDocument');
      vi.setSystemTime(Date.now() + 60_000);
      target.share(document.Id, id('001', 777));
      vi.setSystemTime(Date.now() + 60_000);

      const outcome = await removeRun(target, run);

      const files = outcome.objects.find((o) => o.objectApiName === 'ContentDocument');
      expect(files).toMatchObject({
        deleted: 0,
        keptDependents: 1,
        heldBy: ['ContentDocumentLink'],
      });
      expect(target.all('ContentDocument')).toHaveLength(1);
      // The case goes all the same: its link to the run's own file came with the run.
      expect(target.all('Case')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
