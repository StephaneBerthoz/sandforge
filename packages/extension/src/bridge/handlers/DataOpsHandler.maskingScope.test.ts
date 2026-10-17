import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { BaseMessage } from '@sandforge/shared';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { SafetyTier } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  MaskingCheckpointStore,
  maskingFingerprint,
} from '../../modules/dataops/MaskingCheckpointStore.js';
import { ANONYMIZATION_TEMPLATES } from '../templates/anonymizationTemplates.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * A masking run held to a filter, the snapshot it takes before its first
 * write, and the tier a Developer Edition org is taken for. The command line
 * drives these: run for real, a test over a large org skipped masking
 * altogether, since nothing outside the editor could mask twenty records of it
 * and put them back.
 */

/** The fields of a contact the GDPR template masks, and the one it leaves. */
const CONTACT_FIELDS = [
  'Id',
  'FirstName',
  'LastName',
  'Email',
  'Phone',
  'MailingStreet',
  'MailingCity',
  'MailingPostalCode',
  'Department',
];

/** A Contact any field of which the running user may write. */
const contactDescribe = {
  name: 'Contact',
  label: 'Contact',
  createable: true,
  updateable: true,
  deletable: true,
  queryable: true,
  fields: CONTACT_FIELDS.map((name) => ({
    name,
    label: name,
    type: name === 'Id' ? 'id' : 'string',
    createable: name !== 'Id',
    updateable: name !== 'Id',
    permissionable: name !== 'Id',
  })),
  recordTypeInfos: [],
  childRelationships: [],
};

/** `count` contacts, the first `scoped` of them under the last name the filter picks. */
function contactsOf(count: number, scoped: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Id: `003${String(i + 1).padStart(12, '0')}`,
    FirstName: `First${i + 1}`,
    LastName: i < scoped ? `Scoped${i + 1}` : `Other${i + 1}`,
    Email: `person${i + 1}@example.com`,
    Phone: `+33 1 00 00 ${String(i + 1).padStart(2, '0')}`,
    MailingStreet: `${i + 1} rue Example`,
    MailingCity: 'Example City',
    MailingPostalCode: '75000',
    Department: 'Unmasked',
  }));
}

/** The filter the tests give a run: the contacts whose last name starts with `Scoped`. */
const WHERE = "LastName LIKE 'Scoped%'";

/**
 * An org of contacts, read and written the way Salesforce does: a filter of
 * the shape `(Field LIKE 'prefix%')`, the rows past an Id, a LIMIT, the fields
 * a statement names, an update and an upsert on Id that change the rows.
 */
function orgOf(rows: Array<Record<string, unknown>>) {
  const statements: string[] = [];
  /** The rows a statement's WHERE keeps. */
  const kept = (soql: string): Array<Record<string, unknown>> => {
    const like = /\((\w+) LIKE '([^']*)%'\)/.exec(soql);
    const after = /\bId > '(\w+)'/.exec(soql)?.[1];
    const inList = /\bId IN \(([^)]*)\)/.exec(soql)?.[1];
    const ids = inList?.split(',').map((id) => id.trim().replace(/'/g, ''));
    return rows.filter(
      (r) =>
        (!like || String(r[like[1]]).startsWith(like[2])) &&
        (after === undefined || String(r.Id) > after) &&
        (ids === undefined || ids.includes(String(r.Id))),
    );
  };
  const query = vi.fn(async (soql: string) => {
    statements.push(soql);
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00D000000000001AAA' }], done: true, totalSize: 1 };
    }
    if (soql.includes('IsDeleted = true')) return { records: [], done: true, totalSize: 0 };
    if (soql.startsWith('SELECT COUNT() ')) {
      return { records: [], done: true, totalSize: kept(soql).length };
    }
    const fields = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
    const limit = Number(/\bLIMIT (\d+)/.exec(soql)?.[1] ?? rows.length);
    const records = kept(soql)
      .slice(0, limit)
      .map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    return { records, done: true, totalSize: records.length };
  });
  const write = (batch: Array<Record<string, unknown>>) =>
    batch.map((sent) => {
      Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
      return { success: true, id: sent.Id };
    });
  const update = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const conn = {
    query,
    queryMore: vi.fn(),
    describe: vi.fn().mockResolvedValue(contactDescribe),
    sobject: vi.fn(() => ({ update, upsert })),
    soap: { undelete: vi.fn(async () => []) },
  };
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  return { statements, query, update, upsert };
}

/** Backup files kept in memory, behind the store the handler writes them through. */
function memoryBackups(): BackupRecordStore {
  const files = new Map<string, string>();
  return new BackupRecordStore({
    storagePath: '/storage',
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    appendFile: async (p, content) => {
      files.set(p, (files.get(p) ?? '') + content);
    },
    exists: async (p) => files.has(p),
    readLines: async function* (p) {
      yield* (files.get(p) ?? '').split('\n');
    },
    mkdir: async () => undefined,
    rm: async (p) => {
      files.delete(p);
    },
    listFiles: async (dir) =>
      [...files.keys()]
        .filter((p) => path.dirname(p) === dir)
        .map((p) => ({ name: path.basename(p), modifiedMs: Date.now() })),
  });
}

describe('DataOpsHandler — a masking run held to a filter, with a snapshot first', () => {
  let deps: HandlerDeps;
  let handler: DataOpsHandler;
  let store: ConfigStore;
  let requestConfirmation: ReturnType<
    typeof vi.fn<(impactSummary: string, orgTier: SafetyTier) => Promise<boolean>>
  >;
  let org: { orgType: string; metadata?: { edition?: string } };
  let cap: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    requestConfirmation = vi.fn(async (_impactSummary: string, _orgTier: SafetyTier) => false);
    org = { orgType: 'Sandbox' };
    cap = undefined;
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      stateSync: {},
      orgManager: { getOrg: vi.fn(() => ({ alias: 'ORG', ...org })) },
      orgRegistry: {},
      configStore: store,
      secretVault: {},
      authProvider: {},
      sfdxBridge: {},
      services: {
        getSandforgeSetting: (key: string, fallback: unknown) =>
          key === 'backup.maxRecordsPerObject' && cap !== undefined ? cap : fallback,
      },
      infraServices: {
        productionGuard: new ProductionGuard({ requestConfirmation }),
        backgroundRegistry: new BackgroundOperationRegistry(),
      },
      nextId: () => String(++ids),
    } as unknown as HandlerDeps;
    handler = new DataOpsHandler(deps);
    handler.setBackupRecordStore(memoryBackups());
  });

  /** Send what the page, or the command line, sends. */
  async function send(type: string, payload: Record<string, unknown>, id = `req-${type}`) {
    await handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  /** The last message of a type the handler posted. */
  function last(type: string): (BaseMessage & { payload: Record<string, unknown> }) | undefined {
    return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type)
      .at(-1);
  }

  /** The ids every update sent. */
  function idsSent(update: ReturnType<typeof vi.fn>): string[] {
    return update.mock.calls.flatMap(([batch]) =>
      (batch as Array<Record<string, unknown>>).map((r) => String(r.Id)),
    );
  }

  it('counts, reads and masks only the rows its filter holds it to, past the row it reached', async () => {
    const rows = contactsOf(30, 20);
    const { statements, update } = orgOf(rows);

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      where: WHERE,
    });

    expect(statements).toContain(`SELECT COUNT() FROM Contact WHERE (${WHERE})`);
    const page = statements.find((s) => s.startsWith('SELECT Id, '));
    expect(page).toMatch(new RegExp(`FROM Contact WHERE \\(${WHERE}\\) ORDER BY Id LIMIT 2000$`));
    expect(idsSent(update)).toEqual(rows.slice(0, 20).map((r) => r.Id));
    // The ten the filter leaves out keep their names.
    expect(rows.slice(20).every((r, i) => r.FirstName === `First${i + 21}`)).toBe(true);
    expect(last('dataops:anonymize:response')?.payload).toMatchObject({
      status: 'success',
      recordsProcessed: 20,
      objects: [{ objectApiName: 'Contact', total: 20, processed: 20, notMasked: 0 }],
    });
  });

  it('keeps the filter inside its parentheses next to the row a page starts after', async () => {
    // An OR in the filter, unbracketed, would read every row before the Id.
    const rows = contactsOf(5, 5);
    const { statements } = orgOf(rows);
    new MaskingCheckpointStore(store).save({
      id: 'cp-1',
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      fingerprint: maskingFingerprint(
        ANONYMIZATION_TEMPLATES[0].rules,
        ['Contact'],
        "LastName LIKE 'Scoped%' OR Department = 'Unmasked'",
      ),
      savedAt: '2026-10-01T10:00:00.000Z',
      objects: [
        { objectApiName: 'Contact', done: false, afterId: String(rows[1].Id), refused: [] },
      ],
    });

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      where: "LastName LIKE 'Scoped%' OR Department = 'Unmasked'",
      resumeFrom: 'cp-1',
    });

    expect(statements).toContain(
      "SELECT COUNT() FROM Contact WHERE (LastName LIKE 'Scoped%' OR Department = 'Unmasked') " +
        `AND Id > '${String(rows[1].Id)}'`,
    );
  });

  it.each([
    ['with no object', {}],
    ['with two objects', { objects: ['Contact', 'Lead'] }],
  ])('refuses a filter %s, and reads nothing', async (_label, scope) => {
    const { statements } = orgOf(contactsOf(3, 3));

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      where: WHERE,
      ...scope,
    });

    expect(last('dataops:error')?.payload).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(statements).toEqual([]);
  });

  it('refuses a filter that goes on past the condition', async () => {
    const { statements } = orgOf(contactsOf(3, 3));

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      where: "LastName LIKE 'Scoped%' LIMIT 1",
    });

    expect(last('dataops:error')?.payload).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(statements).toEqual([]);
  });

  it('takes a snapshot of the masked fields of the rows it masks before its first write, and a restore of it puts them back', async () => {
    const rows = contactsOf(30, 20);
    const before = rows.map((r) => ({ ...r }));
    const { statements, query, update, upsert } = orgOf(rows);

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      where: WHERE,
      snapshot: true,
    });

    // The snapshot is read under the filter, its fields those the run masks,
    // before the first update goes.
    const snapshotRead = statements.findIndex(
      (s) =>
        s ===
        'SELECT Id, FirstName, LastName, Email, Phone, MailingStreet, MailingCity, ' +
          `MailingPostalCode FROM Contact WHERE (${WHERE})`,
    );
    expect(snapshotRead).toBeGreaterThanOrEqual(0);
    expect(query.mock.invocationCallOrder[snapshotRead]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
    const response = last('dataops:anonymize:response')?.payload;
    const snapshot = response?.snapshot as { operationId: string; totalRecords: number };
    expect(snapshot).toEqual({
      operationId: expect.stringMatching(/-snapshot$/),
      totalRecords: 20,
    });
    expect(store.get(`backup:${snapshot.operationId}`)).toMatchObject({
      orgId: 'org-1',
      totalRecords: 20,
      partial: false,
      objects: [{ objectApiName: 'Contact', recordCount: 20, truncated: false }],
    });
    expect(rows.slice(0, 20).some((r, i) => r.Email === before[i].Email)).toBe(false);

    await send('dataops:rollback', { orgId: 'org-1', operationId: snapshot.operationId }, 'rb-1');

    // Only the masked fields go back, by Id, and every row is as it was.
    const sent = upsert.mock.calls.flatMap(([batch]) => batch as Array<Record<string, unknown>>);
    expect(sent).toHaveLength(20);
    expect(Object.keys(sent[0]).sort()).toEqual(CONTACT_FIELDS.slice(0, 8).sort());
    expect(rows).toEqual(before);
    expect(last('dataops:rollback:response')?.payload).toMatchObject({
      status: 'success',
      totalRestored: 20,
    });
  });

  it('writes nothing when the snapshot stops at the cap with rows of the run past it', async () => {
    cap = 100;
    const rows = contactsOf(150, 150);
    const { update } = orgOf(rows);

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      snapshot: true,
    });

    expect(update).not.toHaveBeenCalled();
    const error = last('dataops:error')?.payload;
    expect(error).toMatchObject({ code: 'SNAPSHOT_NOT_TAKEN' });
    expect(String(error?.message)).toContain('holds only part of the records the run would mask');
    expect(String(error?.message)).toContain('Contact 100 of 150 (stopped at the cap)');
    expect(new AuditTrailStore(store).list().entries[0]).toMatchObject({
      action: 'anonymize_execute',
      outcome: 'stopped',
      details: { code: 'SNAPSHOT_NOT_TAKEN' },
    });
  });

  it('refuses a snapshot asked with a resume, whose run already wrote over some of its rows', async () => {
    const { statements } = orgOf(contactsOf(3, 3));

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      resumeFrom: 'cp-1',
      snapshot: true,
    });

    expect(last('dataops:error')?.payload).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(statements).toEqual([]);
  });

  it('masks a Developer Edition org as the development org it is, without the question asked of production', async () => {
    org = { orgType: 'Production', metadata: { edition: 'Developer Edition' } };
    const rows = contactsOf(3, 3);
    const { update } = orgOf(rows);

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
    });

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still asks before masking a production org of any other edition, and writes nothing when declined', async () => {
    org = { orgType: 'Production', metadata: { edition: 'Enterprise Edition' } };
    const { update } = orgOf(contactsOf(3, 3));

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      snapshot: true,
    });

    expect(requestConfirmation).toHaveBeenCalledWith(expect.any(String), 'production');
    expect(update).not.toHaveBeenCalled();
    // Nor is anything read into a snapshot of an org the run may not write.
    expect(store.getKeysByPrefix('backup:')).toEqual([]);
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'GUARD_DECLINED' });
  });

  it('restores into a Developer Edition org without the question asked of production', async () => {
    org = { orgType: 'Production', metadata: { edition: 'Developer Edition' } };
    const rows = contactsOf(3, 3);
    const { upsert } = orgOf(rows);
    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      snapshot: true,
    });
    const snapshot = last('dataops:anonymize:response')?.payload.snapshot as {
      operationId: string;
    };

    await send('dataops:rollback', { orgId: 'org-1', operationId: snapshot.operationId }, 'rb-2');

    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('counts what a run of one object under a filter would mask, and finds the checkpoint that run would resume', async () => {
    orgOf(contactsOf(30, 20));
    const fingerprint = maskingFingerprint(ANONYMIZATION_TEMPLATES[0].rules, ['Contact'], WHERE);
    new MaskingCheckpointStore(store).save({
      id: 'cp-scoped',
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      fingerprint,
      savedAt: '2026-10-01T10:00:00.000Z',
      objects: [{ objectApiName: 'Contact', done: false, refused: [] }],
    });

    await send('dataops:anonymize:coverage', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      where: WHERE,
    });

    expect(last('dataops:anonymize:coverage:response')?.payload).toMatchObject({
      objects: [{ objectApiName: 'Contact', count: 20 }],
      checkpoint: { id: 'cp-scoped' },
    });

    // The same template over every contact is another run: no checkpoint of it.
    await send('dataops:anonymize:coverage', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
    });
    const unscoped = last('dataops:anonymize:coverage:response')?.payload;
    expect(unscoped?.objects).toEqual([expect.objectContaining({ count: 30 })]);
    expect(unscoped?.checkpoint).toBeUndefined();
  });

  it('lists no object the template has no rule for in what a run would mask', async () => {
    orgOf(contactsOf(3, 3));

    await send('dataops:anonymize:coverage', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact', 'Case'],
    });

    expect(last('dataops:anonymize:coverage:response')?.payload.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Contact' }),
    ]);
  });

  it('previews the first rows a run under a filter would mask, and only that object', async () => {
    orgOf(contactsOf(30, 20));

    await send('dataops:anonymize:preview', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Contact'],
      where: "LastName LIKE 'Other%'",
    });

    const objects = last('dataops:anonymize:preview:response')?.payload.objects as Array<{
      objectApiName: string;
      rows: Array<{ before: Record<string, unknown> }>;
    }>;
    expect(objects.map((o) => o.objectApiName)).toEqual(['Contact']);
    expect(objects[0].rows.map((r) => r.before.LastName)).toEqual([
      'Other21',
      'Other22',
      'Other23',
      'Other24',
      'Other25',
    ]);
  });
});
