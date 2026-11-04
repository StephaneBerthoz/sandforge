import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { BaseMessage, ForgeTargetAutomation, ForgeTargetFlow } from '@sandforge/shared';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';

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

/**
 * An org of contacts, read and written as Salesforce does, whose requests
 * answer `/limits` and the line of Apex the deliverability is read with as an
 * org on All email does.
 */
function orgOf(rows: Array<Record<string, unknown>>) {
  const requests: string[] = [];
  const query = vi.fn(async (soql: string) => {
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
  const update = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const conn = {
    query,
    queryMore: vi.fn(),
    describe: vi.fn().mockResolvedValue(contactDescribe),
    sobject: vi.fn(() => ({ update, upsert })),
    soap: { undelete: vi.fn(async () => []) },
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
});
