import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { BaseMessage, ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg, type MemoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * What a masking and a restore of the DataOps page and its command line read
 * of the org's automation before their first write, and what refuses them: a
 * masking of every contact ran the org's "on update" flows, emails among
 * them, with no question asked, where Forge, Sync, Seed and Frozen list what
 * fires and are refused without its acceptance.
 */

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

function contactsOf(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Id: `003${String(i + 1).padStart(12, '0')}`,
    FirstName: `First${i + 1}`,
    LastName: `Last${i + 1}`,
    Email: `person${i + 1}@example.com`,
    Phone: `+33 1 00 00 ${String(i + 1).padStart(2, '0')}`,
    MailingStreet: `${i + 1} rue Example`,
    MailingCity: 'Example City',
    MailingPostalCode: '75000',
    Department: 'Unmasked',
  }));
}

/** What a mute reads and writes, which the org's permission sets answer: never its contacts. */
const PERMISSION_TABLES =
  /FROM (Organization|UserPermissionAccess|PermissionSetAssignment|PermissionSet|SetupEntityAccess|ObjectPermissions|CustomPermission)\b/;

/** The org's clock as a masking starts writing. */
const ORG_CLOCK = '2026-11-04T12:31:20.000Z';

/** A duplicate record set or item, as the org keeps it. */
interface DuplicateRow {
  Id: string;
  CreatedDate: string;
  DuplicateRecordSetId?: string;
  RecordId?: string;
}

/** The duplicate record sets and items an org holds. */
interface DuplicateTables {
  sets: DuplicateRow[];
  items: DuplicateRow[];
}

/** The columns each object has, as its describe lists them: another one is refused. */
const DUPLICATE_COLUMNS: Record<string, readonly string[]> = {
  DuplicateRecordItem: ['Id', 'Name', 'DuplicateRecordSetId', 'RecordId', 'CreatedDate'],
  DuplicateRecordSet: ['Id', 'Name', 'DuplicateRuleId', 'RecordCount', 'CreatedDate'],
};

/** What the org answers a read of its duplicate record sets or items: the columns, the date, the ids. */
function duplicatesAnswer(tables: DuplicateTables, soql: string) {
  const [, select = '', object = ''] = /^SELECT (.+?) FROM (\w+)/.exec(soql) ?? [];
  const fields = select.split(', ');
  for (const field of fields) {
    if (!DUPLICATE_COLUMNS[object]?.includes(field)) {
      throw new Error(`INVALID_FIELD: No such column '${field}' on entity '${object}'.`);
    }
  }
  const since = /CreatedDate >= (\S+)/.exec(soql)?.[1];
  const ids = /\bId IN \(([^)]*)\)/
    .exec(soql)?.[1]
    ?.split(', ')
    .map((id) => id.slice(1, -1));
  const records = (object === 'DuplicateRecordSet' ? tables.sets : tables.items)
    .filter(
      (row) =>
        (since === undefined || Date.parse(row.CreatedDate) >= Date.parse(since)) &&
        (ids === undefined || ids.includes(row.Id)),
    )
    .map((row) =>
      Object.fromEntries(fields.map((f) => [f, (row as unknown as Record<string, unknown>)[f]])),
    );
  return { records, done: true, totalSize: records.length };
}

/** A rule's report of records written alike: a new set, and an item for each. */
function reportAlike(tables: DuplicateTables, ids: readonly string[]): void {
  const at = new Date(Date.parse(ORG_CLOCK) + 3_000).toISOString();
  const set = `0GLxx${String(tables.sets.length + 1).padStart(10, '0')}AAA`;
  tables.sets.push({ Id: set, CreatedDate: at });
  for (const id of ids) {
    tables.items.push({
      Id: `0GMxx${String(tables.items.length + 1).padStart(10, '0')}AAA`,
      CreatedDate: at,
      DuplicateRecordSetId: set,
      RecordId: id,
    });
  }
}

/**
 * An org of contacts, read and written as Salesforce does, whose requests
 * answer `/limits` and the line of Apex the deliverability is read with as an
 * org on All email does; and, when given, the permission sets a mute assigns
 * and takes back through the same connection.
 */
function orgOf(
  rows: Array<Record<string, unknown>>,
  permissions?: MemoryPermissionOrg,
  duplicates?: DuplicateTables,
) {
  const requests: string[] = [];
  const query = vi.fn(async (soql: string) => {
    if (permissions && PERMISSION_TABLES.test(soql)) return permissions.connection.query(soql);
    if (duplicates && /FROM DuplicateRecord(Item|Set)\b/.test(soql)) {
      return duplicatesAnswer(duplicates, soql);
    }
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00Dxx0000000001AAA' }], done: true, totalSize: 1 };
    }
    if (soql.includes('IsDeleted = true')) return { records: [], done: true, totalSize: 0 };
    if (soql.startsWith('SELECT COUNT() '))
      return { records: [], done: true, totalSize: rows.length };
    const fields = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
    const after = /\bId > '(\w+)'/.exec(soql)?.[1];
    const inList = /\bId IN \(([^)]*)\)/.exec(soql)?.[1];
    const ids = inList?.split(',').map((id) => id.trim().replace(/'/g, ''));
    const records = rows
      .filter(
        (r) =>
          (after === undefined || String(r.Id) > after) &&
          (ids === undefined || ids.includes(String(r.Id))),
      )
      .map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    return { records, done: true, totalSize: records.length };
  });
  const write = (batch: Array<Record<string, unknown>>) =>
    batch.map((sent) => {
      Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
      return { success: true, id: sent.Id };
    });
  const update = vi.fn(async (batch: Array<Record<string, unknown>>) => {
    // A rule that reports: the records written alike, in a set of their own,
    // written by the org a few seconds after the save.
    if (duplicates)
      reportAlike(
        duplicates,
        batch.map((sent) => String(sent.Id)),
      );
    return write(batch);
  });
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) => {
    // A rule that reports runs on an edit, a restore's upsert by Id included.
    if (duplicates)
      reportAlike(
        duplicates,
        batch.map((sent) => String(sent.Id)),
      );
    return write(batch);
  });
  const conn = {
    query,
    queryMore: vi.fn(),
    describe: vi.fn().mockResolvedValue(contactDescribe),
    ...(permissions ? { identity: permissions.connection.identity } : {}),
    sobject: vi.fn((name: string) =>
      permissions && name === 'PermissionSetAssignment'
        ? permissions.connection.sobject(name)
        : { update, upsert },
    ),
    soap: {
      undelete: vi.fn(async () => []),
      getServerTimestamp: vi.fn(async () => ({ timestamp: ORG_CLOCK })),
    },
    request: vi.fn(async ({ url }: { url: string }) => {
      requests.push(url);
      if (url === '/limits') {
        return {
          SingleEmail: { Max: 5_000, Remaining: 5_000 },
          DailyWorkflowEmails: { Max: 1_000_000, Remaining: 1_000_000 },
        };
      }
      return { compiled: true, success: true };
    }),
  };
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  return { update, upsert, requests };
}

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

/** A flow of Contact after the save, on update, sending `emails` single emails. */
function onUpdate(label: string, emails = 0): ForgeTargetFlow {
  return {
    apiName: label.replaceAll(' ', '_'),
    label,
    timing: 'afterSave',
    startsOn: 'update',
    condition: 'read',
    permissions: [],
    messages: Array.from({ length: emails }, (_, at) => ({
      kind: 'email' as const,
      name: `Send ${at}`,
      limit: 'SingleEmail' as const,
    })),
  };
}

/** What the org runs on Contact: `flows`. */
function runs(flows: ForgeTargetFlow[]): ForgeTargetAutomation {
  return {
    objectsRead: ['Contact'],
    objects: [{ objectApiName: 'Contact', flows, triggers: [] }],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 1,
  };
}

describe('DataOpsHandler — the automation a masking and a restore fire, asked before they write', () => {
  let deps: HandlerDeps;
  let handler: DataOpsHandler;
  let store: ConfigStore;
  let read: ReturnType<
    typeof vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      stateSync: {},
      orgManager: { getOrg: vi.fn(() => ({ alias: 'ORG', orgType: 'Sandbox' })) },
      orgRegistry: {},
      configStore: store,
      secretVault: {},
      authProvider: {},
      sfdxBridge: {},
      services: { getSandforgeSetting: (_key: string, fallback: unknown) => fallback },
      infraServices: {
        productionGuard: new ProductionGuard({ requestConfirmation: async () => false }),
        backgroundRegistry: new BackgroundOperationRegistry(),
      },
      nextId: () => String(++ids),
    } as unknown as HandlerDeps;
    handler = new DataOpsHandler(deps);
    handler.setBackupRecordStore(memoryBackups());
    read = vi.fn(async () => runs([onUpdate('Notify Owner')]));
    handler.setTargetAutomation({ read });
  });

  async function send(type: string, payload: Record<string, unknown>, id = `req-${type}`) {
    await handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  function last(type: string): (BaseMessage & { payload: Record<string, unknown> }) | undefined {
    return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type)
      .at(-1);
  }

  const masking = { orgId: 'org-1', templateId: 'tpl-gdpr-standard', objects: ['Contact'] };

  it('refuses a masking whose update flow fires, writing nothing, until the automation is accepted', async () => {
    const rows = contactsOf(3);
    const { update } = orgOf(rows);

    await send('dataops:anonymize', masking, 'run-refused');

    expect(read).toHaveBeenCalledWith('org-1', ['Contact']);
    expect(last('dataops:error')?.payload).toMatchObject({ code: 'AUTOMATION_NOT_ACCEPTED' });
    expect(String(last('dataops:error')?.payload.message)).toContain(
      'ORG runs automation as this masking writes over its records: Contact: flow "Notify Owner"',
    );
    expect(update).not.toHaveBeenCalled();
    expect(rows[0]?.FirstName).toBe('First1');
    expect(new AuditTrailStore(store).list().entries[0]).toMatchObject({
      action: 'anonymize_execute',
      outcome: 'stopped',
      details: expect.objectContaining({ code: 'AUTOMATION_NOT_ACCEPTED' }),
    });

    await send('dataops:anonymize', { ...masking, acceptAutomation: true }, 'run-accepted');

    expect(update).toHaveBeenCalled();
    expect(last('dataops:anonymize:response')?.payload).toMatchObject({
      status: 'success',
      recordsProcessed: 3,
    });
  });

  it('refuses a masking whose flow emails what it updates on an org that delivers them, until its emails are accepted too', async () => {
    read.mockResolvedValue(runs([onUpdate('Notify Owner', 1)]));
    const { update, requests } = orgOf(contactsOf(3));

    await send('dataops:anonymize', { ...masking, acceptAutomation: true }, 'run-emails');

    expect(last('dataops:error')?.payload).toMatchObject({ code: 'EMAILS_NOT_ACCEPTED' });
    expect(String(last('dataops:error')?.payload.message)).toContain(
      'ORG delivers every email its automation sends (Setup > Deliverability: All email)',
    );
    expect(requests.some((url) => url.includes('executeAnonymous'))).toBe(true);
    expect(update).not.toHaveBeenCalled();

    await send(
      'dataops:anonymize',
      { ...masking, acceptAutomation: true, acceptEmails: true },
      'run-emails-accepted',
    );
    expect(update).toHaveBeenCalled();
  });

  it('refuses a masking and a restore under the first refusal, each other one under its code, nothing written said once', async () => {
    read.mockResolvedValue(runs([onUpdate('Notify Owner', 1)]));
    const { update, upsert } = orgOf(contactsOf(2));

    await send('dataops:anonymize', masking, 'run-twice-refused');
    const masked = last('dataops:error')?.payload;
    await send(
      'dataops:anonymize',
      { ...masking, snapshot: true, acceptAutomation: true, acceptEmails: true },
      'snap-twice',
    );
    const snapshot = last('dataops:anonymize:response')?.payload.snapshot as {
      operationId: string;
    };
    upsert.mockClear();
    await send(
      'dataops:rollback',
      { orgId: 'org-1', operationId: snapshot.operationId },
      'restore-twice-refused',
    );
    const restored = last('dataops:error')?.payload;

    for (const refused of [masked, restored]) {
      expect(refused).toMatchObject({
        code: 'AUTOMATION_NOT_ACCEPTED',
        alsoRefused: [expect.objectContaining({ code: 'EMAILS_NOT_ACCEPTED' })],
      });
      // The banner said "Nothing was written." twice, the emails' code nowhere.
      expect(String(refused?.message).match(/Nothing was written\./g)).toHaveLength(1);
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a restore whose update flow fires as it puts the values back, until it is accepted', async () => {
    const rows = contactsOf(2);
    const { upsert } = orgOf(rows);
    await send('dataops:anonymize', { ...masking, snapshot: true, acceptAutomation: true }, 'snap');
    const snapshot = last('dataops:anonymize:response')?.payload.snapshot as {
      operationId: string;
    };

    await send(
      'dataops:rollback',
      { orgId: 'org-1', operationId: snapshot.operationId },
      'restore-refused',
    );

    expect(last('dataops:error')?.payload).toMatchObject({ code: 'AUTOMATION_NOT_ACCEPTED' });
    expect(String(last('dataops:error')?.payload.message)).toContain(
      'ORG runs automation as this restore puts back its records: Contact: flow "Notify Owner" ' +
        '(as its values are put back, after save)',
    );
    expect(upsert).not.toHaveBeenCalled();

    await send(
      'dataops:rollback',
      { orgId: 'org-1', operationId: snapshot.operationId, acceptAutomation: true },
      'restore-accepted',
    );
    expect(last('dataops:rollback:response')?.payload).toMatchObject({ totalRestored: 2 });
    expect(rows[0]?.FirstName).toBe('First1');
  });

  it('answers what a masking would fire, its emails and why it would be refused, and writes nothing', async () => {
    read.mockResolvedValue(runs([onUpdate('Notify Owner', 1)]));
    const { update } = orgOf(contactsOf(3));

    await send('dataops:automation', {
      orgId: 'org-1',
      act: 'masking',
      objects: [{ objectApiName: 'Contact', records: 3 }],
    });

    const answer = last('dataops:automation:response')?.payload;
    expect(answer).toMatchObject({
      act: 'masking',
      steps: { giveBack: ['Contact'] },
      emailsAsk: true,
      emails: [expect.objectContaining({ limit: 'SingleEmail', emails: 3 })],
    });
    expect(answer?.lines).toContain('  Contact: as it is masked, after save: flow "Notify Owner"');
    expect((answer?.refusals as Array<{ code: string }>).map((r) => r.code)).toEqual([
      'AUTOMATION_NOT_ACCEPTED',
      'EMAILS_NOT_ACCEPTED',
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('offers the mute in none of its refusals on an org the registry types as production, where it is refused', async () => {
    // A flow on update sending one email, which Skip_Flows keeps quiet, and the set holding it.
    const bypassed: ForgeTargetFlow = {
      ...onUpdate('Notify Owner', 1),
      permissions: [{ name: 'Skip_Flows', bypass: true }],
    };
    read.mockResolvedValue({
      ...runs([bypassed]),
      bypassGrants: [
        {
          permission: 'Skip_Flows',
          permissionSets: [{ name: 'Flow_Bypass', label: 'Flow Bypass', grants: 1 }],
        },
      ],
    });
    const { requests } = orgOf(contactsOf(3));
    const asked = {
      orgId: 'org-1',
      act: 'masking',
      objects: [{ objectApiName: 'Contact', records: 3 }],
    };
    const refusals = (): string =>
      (last('dataops:automation:response')?.payload.refusals as Array<{ message: string }>)
        .map((r) => r.message)
        .join(' ');

    await send('dataops:automation', asked, 'sandbox-read');
    expect(refusals()).toContain('With --mute-automation, the masking assigns Flow_Bypass');
    expect(requests.filter((url) => url !== '/limits')).toHaveLength(1);

    vi.mocked(deps.orgManager.getOrg).mockReturnValue({
      alias: 'ORG',
      orgType: 'Production',
    } as never);
    const before = requests.length;
    await send('dataops:automation', asked, 'production-read');

    const said = refusals();
    expect(said).toContain('ORG runs automation as this masking writes over its records');
    expect(said).toContain('Add --accept-emails to mask all the same');
    expect(said).not.toContain('--mute-automation');
    // No Apex in a production org: whether it delivers was not read, and is asked.
    expect(requests.slice(before).filter((url) => url !== '/limits')).toEqual([]);
  });

  it('offers the mute in none of its refusals to the reader of a command that mutes nothing', async () => {
    // A mask resource of sandforge-env, whose runs never mute, relayed
    // "With --mute-automation, the masking assigns …": a flag the
    // environment does not take.
    const bypassed: ForgeTargetFlow = {
      ...onUpdate('Notify Owner', 1),
      permissions: [{ name: 'Skip_Flows', bypass: true }],
    };
    read.mockResolvedValue({
      ...runs([bypassed]),
      bypassGrants: [
        {
          permission: 'Skip_Flows',
          permissionSets: [{ name: 'Flow_Bypass', label: 'Flow Bypass', grants: 1 }],
        },
      ],
    });
    orgOf(contactsOf(3));
    handler.setMuteOffered(false);

    await send('dataops:automation', {
      orgId: 'org-1',
      act: 'masking',
      objects: [{ objectApiName: 'Contact', records: 3 }],
    });

    const said = (
      last('dataops:automation:response')?.payload.refusals as Array<{ message: string }>
    )
      .map((r) => r.message)
      .join(' ');
    expect(said).toContain('ORG runs automation as this masking writes over its records');
    expect(said).toContain('Add --accept-automation');
    expect(said).not.toContain('--mute-automation');
  });

  describe('the duplicate rules of what a masking writes over', () => {
    /** What the trap org runs on Contact: nothing fires, its standard duplicate rule is active. */
    const ruled: ForgeTargetAutomation = {
      ...runs([]),
      objects: [
        {
          objectApiName: 'Contact',
          flows: [],
          triggers: [],
          duplicateRules: [
            {
              name: 'Standard Contact Duplicate Rule',
              developerName: 'Standard_Rule_for_Contacts',
            },
          ],
        },
      ],
    };

    beforeEach(() => {
      read.mockResolvedValue(ruled);
      handler.setDuplicatesSettle(0);
    });

    it('names them before its question', async () => {
      orgOf(contactsOf(2), undefined, { sets: [], items: [] });

      await send('dataops:automation', {
        orgId: 'org-1',
        act: 'masking',
        objects: [{ objectApiName: 'Contact', records: 2 }],
      });

      expect(last('dataops:automation:response')?.payload.lines).toContain(
        '  Contact: duplicate rules "Standard Contact Duplicate Rule": the masking saves a record ' +
          'a rule only alerts on, a rule that blocks still refuses it, and what a rule that ' +
          'reports writes (a duplicate record set and its items) stays',
      );
    });

    it('says what they wrote during it for the records it masked, and removes none of it', async () => {
      const rows = contactsOf(2);
      // A set from before the run, holding an item of the first contact.
      const tables: DuplicateTables = {
        sets: [{ Id: '0GLxx0000000900AAA', CreatedDate: '2026-10-01T08:00:00.000Z' }],
        items: [
          {
            Id: '0GMxx0000000900AAA',
            CreatedDate: '2026-10-01T08:00:00.000Z',
            DuplicateRecordSetId: '0GLxx0000000900AAA',
            RecordId: String(rows[0]?.Id),
          },
        ],
      };
      const { update } = orgOf(rows, undefined, tables);

      await send('dataops:anonymize', { ...masking, acceptAutomation: true }, 'run-duplicates');

      expect(update).toHaveBeenCalled();
      const answer = last('dataops:anonymize:response')?.payload;
      expect(answer?.duplicates).toEqual({
        rules: [{ objectApiName: 'Contact', rules: ['Standard Contact Duplicate Rule'] }],
        sets: 1,
        items: 2,
        requests: 3,
        waitedMs: 0,
      });
      expect(String(answer?.message)).toContain(
        'The duplicate rules of ORG on Contact ("Standard Contact Duplicate Rule") wrote 1 ' +
          'duplicate record set(s) and 2 item(s) during the masking, for records it masked: ' +
          'kept, as they name records that stay.',
      );
      // Kept: the org still holds the set and its items, and the page is told.
      expect(tables.sets).toHaveLength(2);
      expect(tables.items).toHaveLength(3);
      expect(last('notification')?.payload).toMatchObject({
        level: 'warning',
        message: expect.stringContaining('wrote 1 duplicate record set(s) and 2 item(s)'),
      });
    });

    it('says what they wrote for the records it masked before it failed half way, as a finished masking does', async () => {
      // Two updates of 200 and 1: the first is masked, and the org's rule
      // reports its records alike; the answer to the second never comes.
      const rows = contactsOf(201);
      const tables: DuplicateTables = { sets: [], items: [] };
      const { update } = orgOf(rows, undefined, tables);
      const answered = update.getMockImplementation();
      if (!answered) throw new Error('the org answers no update');
      update.mockImplementationOnce(answered).mockImplementationOnce(async () => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      });

      await send('dataops:anonymize', { ...masking, acceptAutomation: true }, 'run-fails');

      expect(update).toHaveBeenCalledTimes(2);
      const failed = last('dataops:error')?.payload;
      expect(failed?.duplicates).toEqual({
        rules: [{ objectApiName: 'Contact', rules: ['Standard Contact Duplicate Rule'] }],
        sets: 1,
        items: 200,
        requests: 3,
        waitedMs: 0,
      });
      expect(String(failed?.message)).toContain(
        'socket hang up — 200 masked before it stopped; 1 still hold their original values',
      );
      expect(String(failed?.message)).toContain(
        'The duplicate rules of ORG on Contact ("Standard Contact Duplicate Rule") wrote 1 ' +
          'duplicate record set(s) and 200 item(s) during the masking, for records it masked: ' +
          'kept, as they name records that stay.',
      );
      // Kept, as a finished masking keeps them.
      expect(tables.sets).toHaveLength(1);
      expect(tables.items).toHaveLength(200);
      expect(last('operation:failed')?.payload).toMatchObject({
        error: expect.stringContaining('socket hang up'),
      });
    });

    it('reads what they wrote for an update whose answer never came, which the org may have saved', async () => {
      // One update of 2: the org saves it and its rule reports the two alike,
      // and the answer is lost on the way back.
      const rows = contactsOf(2);
      const tables: DuplicateTables = { sets: [], items: [] };
      const { update } = orgOf(rows, undefined, tables);
      const answered = update.getMockImplementation();
      if (!answered) throw new Error('the org answers no update');
      update.mockImplementationOnce(async (batch) => {
        await answered(batch);
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      });

      await send('dataops:anonymize', { ...masking, acceptAutomation: true }, 'run-unanswered');

      const failed = last('dataops:error')?.payload;
      expect(failed?.duplicates).toMatchObject({ sets: 1, items: 2 });
      expect(String(failed?.message)).toContain(
        'wrote 1 duplicate record set(s) and 2 item(s) during the masking',
      );
    });

    it('reads nothing, asks the org nothing and waits for nothing when no record of the object was masked', async () => {
      // The org refuses every record: none was saved, so no rule reported one.
      const rows = contactsOf(2);
      const tables: DuplicateTables = { sets: [], items: [] };
      const { update } = orgOf(rows, undefined, tables);
      update.mockImplementationOnce(async (batch: Array<Record<string, unknown>>) =>
        batch.map((sent) => ({
          id: sent.Id,
          success: false,
          errors: [{ message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Email is locked' }],
        })),
      );
      const conn = (await getJsforceConnection('org-1', {} as never, {} as never)) as unknown as {
        soap: { getServerTimestamp: ReturnType<typeof vi.fn> };
        query: ReturnType<typeof vi.fn>;
      };

      await send('dataops:anonymize', { ...masking, acceptAutomation: true }, 'run-all-refused');

      expect(last('dataops:anonymize:response')?.payload).toMatchObject({ recordsFailed: 2 });
      expect(last('dataops:anonymize:response')?.payload.duplicates).toBeUndefined();
      expect(conn.soap.getServerTimestamp).not.toHaveBeenCalled();
      expect(
        conn.query.mock.calls.filter(([soql]) => /FROM DuplicateRecord/.test(String(soql))),
      ).toEqual([]);
    });

    it('says how long it waited for their reports and how many requests reading them took', async () => {
      const rows = contactsOf(2);
      orgOf(rows, undefined, { sets: [], items: [] });
      handler.setDuplicatesSettle(40);

      await send('dataops:anonymize', { ...masking, acceptAutomation: true }, 'run-measured');

      const answer = last('dataops:anonymize:response')?.payload;
      // The org's clock before the first write, the items, then their one set.
      expect(answer?.duplicates).toMatchObject({ sets: 1, items: 2, requests: 3 });
      const waited = (answer?.duplicates as { waitedMs?: number }).waitedMs ?? -1;
      expect(waited).toBeGreaterThan(0);
      expect(waited).toBeLessThanOrEqual(40);
      expect(String(answer?.message)).toContain(
        'kept, as they name records that stay. Read in 3 request(s), after waiting less than 1 s.',
      );
    });
  });

  describe('the duplicate rules of what a restore writes over', () => {
    /** What the org runs on Contact: nothing fires, its standard duplicate rule is active. */
    const ruled: ForgeTargetAutomation = {
      ...runs([]),
      objects: [
        {
          objectApiName: 'Contact',
          flows: [],
          triggers: [],
          duplicateRules: [
            {
              name: 'Standard Contact Duplicate Rule',
              developerName: 'Standard_Rule_for_Contacts',
            },
          ],
        },
      ],
    };

    beforeEach(() => {
      handler.setDuplicatesSettle(0);
    });

    it('says what they wrote during it for the records it put back, and removes none of it', async () => {
      // A masking with its snapshot, on an org without a rule, then the restore
      // on one whose rule reports what it puts back alike.
      read.mockResolvedValue(runs([]));
      const rows = contactsOf(2);
      orgOf(rows);
      await send(
        'dataops:anonymize',
        { ...masking, snapshot: true, acceptAutomation: true },
        'snap',
      );
      const snapshot = last('dataops:anonymize:response')?.payload.snapshot as {
        operationId: string;
      };
      read.mockResolvedValue(ruled);
      const tables: DuplicateTables = { sets: [], items: [] };
      const { upsert } = orgOf(rows, undefined, tables);

      await send(
        'dataops:rollback',
        { orgId: 'org-1', operationId: snapshot.operationId, acceptAutomation: true },
        'restore-duplicates',
      );

      expect(upsert).toHaveBeenCalled();
      const answer = last('dataops:rollback:response')?.payload;
      expect(answer).toMatchObject({ totalRestored: 2 });
      expect(answer?.duplicates).toMatchObject({
        rules: [{ objectApiName: 'Contact', rules: ['Standard Contact Duplicate Rule'] }],
        sets: 1,
        items: 2,
      });
      expect(String(answer?.message)).toContain(
        'The duplicate rules of ORG on Contact ("Standard Contact Duplicate Rule") wrote 1 ' +
          'duplicate record set(s) and 2 item(s) during the restore, for records it put back: ' +
          'kept, as they name records that stay.',
      );
      expect(tables.sets).toHaveLength(1);
      expect(last('notification')?.payload).toMatchObject({
        level: 'warning',
        message: expect.stringContaining('during the restore, for records it put back'),
      });
    });
  });

  describe('asked from the DataOps page, which has a confirmation and boxes, not flags', () => {
    it('refuses a masking in the words of its confirmation', async () => {
      const { update } = orgOf(contactsOf(3));

      await send('dataops:anonymize', { ...masking, fromPage: true }, 'page-refused');

      const refused = last('dataops:error')?.payload;
      expect(refused).toMatchObject({ code: 'AUTOMATION_NOT_ACCEPTED' });
      expect(String(refused?.message)).toContain(
        'Nothing was written. Confirm the masking from its confirmation, which lists what ' +
          'fires, to mask all the same, or turn that automation off in ORG first.',
      );
      expect(String(refused?.message)).not.toMatch(/--[a-z]/);
      expect(update).not.toHaveBeenCalled();
    });

    it("refuses a masking whose emails the org delivers, naming the confirmation's box that lets them go", async () => {
      read.mockResolvedValue(runs([onUpdate('Notify Owner', 1)]));
      const { update } = orgOf(contactsOf(3));

      await send(
        'dataops:anonymize',
        { ...masking, acceptAutomation: true, fromPage: true },
        'page-emails',
      );

      const refused = last('dataops:error')?.payload;
      expect(refused).toMatchObject({ code: 'EMAILS_NOT_ACCEPTED' });
      expect(String(refused?.message)).toContain(
        "Nothing was written. Tick the confirmation's box that lets the org send these emails " +
          'to mask all the same',
      );
      expect(String(refused?.message)).not.toMatch(/--[a-z]/);
      expect(update).not.toHaveBeenCalled();
    });

    it('refuses a restore in the words of its confirmation', async () => {
      const { upsert } = orgOf(contactsOf(2));
      await send(
        'dataops:anonymize',
        { ...masking, snapshot: true, acceptAutomation: true },
        'snap',
      );
      const snapshot = last('dataops:anonymize:response')?.payload.snapshot as {
        operationId: string;
      };

      await send(
        'dataops:rollback',
        { orgId: 'org-1', operationId: snapshot.operationId, fromPage: true },
        'page-restore',
      );

      const refused = last('dataops:error')?.payload;
      expect(refused).toMatchObject({ code: 'AUTOMATION_NOT_ACCEPTED' });
      expect(String(refused?.message)).toContain(
        'Confirm the restore from its confirmation, which lists what fires, to restore all the ' +
          'same',
      );
      expect(String(refused?.message)).not.toMatch(/--[a-z]/);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('answers the read its confirmation lists in its words, and the command line in its flags', async () => {
      read.mockResolvedValue(runs([onUpdate('Notify Owner', 1)]));
      orgOf(contactsOf(3));
      const asked = {
        orgId: 'org-1',
        act: 'masking',
        objects: [{ objectApiName: 'Contact', records: 3 }],
      };

      await send('dataops:automation', { ...asked, fromPage: true }, 'page-read');
      const page = last('dataops:automation:response')?.payload.refusals as Array<{
        message: string;
      }>;
      await send('dataops:automation', asked, 'cli-read');
      const cli = last('dataops:automation:response')?.payload.refusals as Array<{
        message: string;
      }>;

      expect(page.map((r) => r.message).join(' ')).not.toMatch(/--[a-z]/);
      expect(cli.map((r) => r.message).join(' ')).toContain(
        'Add --accept-automation to mask all the same',
      );
      expect(cli.map((r) => r.message).join(' ')).toContain('Add --accept-emails');
    });
  });

  describe("a pipeline's Anonymize step, which nobody watches", () => {
    const step = {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      object: 'Contact',
      pipeline: { name: 'Nightly refresh' },
      answer: { approved: false },
    };

    it('masks nothing an update flow fires on, saying the setting that lets it, until the step accepts it', async () => {
      const rows = contactsOf(3);
      const { update } = orgOf(rows);

      const refused = await handler.anonymizeForPipeline(step).then(
        () => undefined,
        (err: unknown) => err as Error & { code?: string },
      );

      expect(read).toHaveBeenCalledWith('org-1', ['Contact']);
      expect(refused?.code).toBe('AUTOMATION_NOT_ACCEPTED');
      expect(refused?.message).toContain(
        'ORG runs automation as this masking writes over its records: Contact: flow "Notify Owner"',
      );
      // A step has settings, not flags: what lifts it is said as the step sets it.
      expect(refused?.message).toContain(
        'Turn on acceptAutomation in the step to mask all the same',
      );
      expect(refused?.message).not.toMatch(/--[a-z]/);
      expect(update).not.toHaveBeenCalled();
      expect(rows[0]?.FirstName).toBe('First1');
      expect(new AuditTrailStore(store).list().entries[0]).toMatchObject({
        action: 'anonymize_execute',
        outcome: 'stopped',
        details: expect.objectContaining({ code: 'AUTOMATION_NOT_ACCEPTED' }),
      });

      const masked = await handler.anonymizeForPipeline({
        ...step,
        accord: { acceptAutomation: true },
      });
      expect(masked.result).toMatchObject({ status: 'success', recordsProcessed: 3 });
      expect(update).toHaveBeenCalled();
    });

    it('masks nothing whose emails an org on All email delivers until the step accepts them too, whatever an Approval answered', async () => {
      read.mockResolvedValue(runs([onUpdate('Notify Owner', 1)]));
      const { update } = orgOf(contactsOf(3));

      const refused = await handler
        .anonymizeForPipeline({
          ...step,
          answer: { approved: true },
          accord: { acceptAutomation: true },
        })
        .then(
          () => undefined,
          (err: unknown) => err as Error & { code?: string },
        );

      expect(refused?.code).toBe('EMAILS_NOT_ACCEPTED');
      expect(refused?.message).toContain('Turn on acceptEmails in the step to mask all the same');
      expect(refused?.message).not.toMatch(/--[a-z]/);
      expect(update).not.toHaveBeenCalled();

      await handler.anonymizeForPipeline({
        ...step,
        accord: { acceptAutomation: true, acceptEmails: true },
      });
      expect(update).toHaveBeenCalled();
    });
  });

  describe('a masking and a restore that mute, answered once their lease is given back', () => {
    const SET = '0PSxx0000000001AAA';
    /** What the org was sent and what the page was answered, in the order it happened. */
    const events: string[] = [];
    let dir: string;
    let permissions: MemoryPermissionOrg;
    let tracker: LiveOperationTracker;

    beforeEach(() => {
      events.length = 0;
      dir = mkdtempSync(path.join(tmpdir(), 'dataops-mute-'));
      handler.setMuteLeases({ dir, renewEveryMs: 0 });
      // How Live Operations lists the run's end, with what the org still assigns then.
      tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);
      const ended = new Set<string>();
      tracker.onChange((operations) => {
        for (const op of operations) {
          if (op.status === 'running' || ended.has(op.operationId)) continue;
          ended.add(op.operationId);
          events.push(`Live Operations ${op.status}, ${permissions.assignments().length} assigned`);
        }
      });
      permissions = memoryPermissionOrg({
        sets: [{ id: SET, name: 'Flow_Bypass' }],
        beforeWrite: (write) => {
          events.push(write.kind === 'insert' ? 'assign' : 'unassign');
        },
      });
      // The flow's bypass, held by a set of the org the user does not hold.
      read.mockResolvedValue({
        ...runs([
          { ...onUpdate('Notify Owner'), permissions: [{ name: 'Skip_Flows', bypass: true }] },
        ]),
        bypassGrants: [
          {
            permission: 'Skip_Flows',
            permissionSets: [{ name: 'Flow_Bypass', label: 'Flow Bypass', grants: 1 }],
          },
        ],
      });
      // What the page is told as it is told it, with what the org still assigns then.
      vi.mocked(deps.broker.postToWebview).mockImplementation((m: BaseMessage) => {
        if (
          m.type === 'dataops:anonymize:response' ||
          m.type === 'dataops:rollback:response' ||
          m.type === 'operation:completed'
        ) {
          events.push(`${m.type}, ${permissions.assignments().length} assigned`);
        }
      });
    });

    afterEach(() => {
      tracker.dispose();
      rmSync(dir, { recursive: true, force: true });
    });

    it('answers a masking that muted once it took its set back, and says it took it back', async () => {
      const rows = contactsOf(3);
      const { update } = orgOf(rows, permissions);

      await send(
        'dataops:anonymize',
        { ...masking, acceptAutomation: true, muteAutomation: true },
        'run-muted',
      );

      expect(update).toHaveBeenCalled();
      expect(rows[0]?.FirstName).not.toBe('First1');
      // On the trap org, the page's answer came while Trap_Bypass was still
      // assigned, and named nothing taken back: a check made on it saw the
      // bypass held. Live Operations and `operation:completed` still said the
      // run ended before its set was taken back.
      expect(events).toEqual([
        'assign',
        'unassign',
        'operation:completed, 0 assigned',
        'Live Operations completed, 0 assigned',
        'dataops:anonymize:response, 0 assigned',
      ]);
      expect(last('dataops:anonymize:response')?.payload.mutedAutomation).toMatchObject({
        state: 'muted',
        assigned: ['Flow_Bypass'],
        released: true,
        takenBack: ['Flow_Bypass'],
      });
    });

    it('answers a restore that muted once it took its set back, and says it took it back', async () => {
      const rows = contactsOf(2);
      orgOf(rows, permissions);
      await send(
        'dataops:anonymize',
        { ...masking, snapshot: true, acceptAutomation: true },
        'snap',
      );
      const snapshot = last('dataops:anonymize:response')?.payload.snapshot as {
        operationId: string;
      };
      events.length = 0;

      await send(
        'dataops:rollback',
        {
          orgId: 'org-1',
          operationId: snapshot.operationId,
          acceptAutomation: true,
          muteAutomation: true,
        },
        'restore-muted',
      );

      expect(rows[0]?.FirstName).toBe('First1');
      expect(events).toEqual([
        'assign',
        'unassign',
        'operation:completed, 0 assigned',
        'Live Operations completed, 0 assigned',
        'dataops:rollback:response, 0 assigned',
      ]);
      expect(last('dataops:rollback:response')?.payload).toMatchObject({
        totalRestored: 2,
        mutedAutomation: { released: true, takenBack: ['Flow_Bypass'] },
      });
    });
  });
});
