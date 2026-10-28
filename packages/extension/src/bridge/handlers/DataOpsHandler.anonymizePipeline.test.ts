/**
 * A pipeline's Anonymize step, through `DataOpsHandler.anonymizeForPipeline`:
 * the masking run the DataOps page runs, held to the same gates with nobody
 * to watch it. A production org is refused whatever the Approval step
 * answered, a sandbox marked Staging needs that Approval, a step given retries
 * or a condition with no object is refused, every field the template names is
 * one the org shows before anything is asked or written, and what the run
 * writes over is kept, whole, before its first write. The run is recorded,
 * listed and resumed as the page's.
 */
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseMessage } from '@sandforge/shared';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { PIPELINE_MASKING_REFUSAL, type PipelineMaskingRequest } from './anonymizePipeline.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { AnonymizationTemplateStore } from '../../modules/dataops/AnonymizationTemplateStore.js';
import {
  MaskingCheckpointStore,
  maskingFingerprint,
} from '../../modules/dataops/MaskingCheckpointStore.js';
import { StepCancelledError } from '../../modules/automation/StepExecutor.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { ANONYMIZATION_TEMPLATES } from '../templates/anonymizationTemplates.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** What each kind of org the tests mask is, as Org Manager holds it. */
const ORGS: Record<
  string,
  { orgType: string; alias: string; staging?: boolean; metadata?: { edition: string } }
> = {
  'org-dev': { orgType: 'Developer', alias: 'my-dev-org' },
  'org-old-dev': {
    orgType: 'Production',
    alias: 'my-old-dev-org',
    metadata: { edition: 'Developer Edition' },
  },
  'org-scratch': { orgType: 'Scratch', alias: 'my-scratch' },
  'org-sandbox': { orgType: 'Sandbox', alias: 'my-sandbox' },
  'org-prod': { orgType: 'Production', alias: 'my-prod' },
  'org-uat': { orgType: 'Sandbox', alias: 'my-uat', staging: true },
};

/** The fields of a contact the GDPR template masks, and one it leaves. */
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

/** An object's describe, each field of `fields` one the running user may write. */
function describeOf(name: string, fields: readonly string[]) {
  return {
    name,
    label: name,
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields: fields.map((field) => ({
      name: field,
      label: field,
      type: field === 'Id' ? 'id' : 'string',
      createable: field !== 'Id',
      updateable: field !== 'Id',
      permissionable: field !== 'Id',
    })),
    recordTypeInfos: [],
    childRelationships: [],
  };
}

/** `count` contacts, the first `scoped` of them under the last name the filter picks. */
function contactsOf(count: number, scoped = count): Array<Record<string, unknown>> {
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

/** How the fake org answers beside its rows. */
interface OrgOptions {
  /** Per object, its describe: a contact's whole by default. */
  describes?: Record<string, ReturnType<typeof describeOf>>;
  /** Ids the org refuses to update, as a validation rule would. */
  refuses?: (id: string) => boolean;
  /** Called before each update is answered, with its number from 1. */
  beforeUpdate?: (call: number) => void;
}

/**
 * An org of contacts, read and written the way Salesforce does: a filter of
 * the shape `(Field LIKE 'prefix%')`, the rows past an Id, a LIMIT, the fields
 * a statement names, an update and an upsert on Id that change the rows.
 */
function orgOf(rows: Array<Record<string, unknown>>, options: OrgOptions = {}) {
  const statements: string[] = [];
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
  let updates = 0;
  const update = vi.fn(async (batch: Array<Record<string, unknown>>) => {
    options.beforeUpdate?.(++updates);
    return batch.map((sent) => {
      if (options.refuses?.(String(sent.Id))) {
        return { success: false, errors: [{ message: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }] };
      }
      Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
      return { success: true, id: sent.Id };
    });
  });
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) =>
    batch.map((sent) => {
      Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
      return { success: true, id: sent.Id };
    }),
  );
  const contact = describeOf('Contact', CONTACT_FIELDS);
  const conn = {
    query,
    queryMore: vi.fn(),
    describe: vi.fn(async (name: string) => options.describes?.[name] ?? contact),
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

/** The ids every update sent. */
function idsSent(update: ReturnType<typeof vi.fn>): string[] {
  return update.mock.calls.flatMap(([batch]) =>
    (batch as Array<Record<string, unknown>>).map((r) => String(r.Id)),
  );
}

describe('DataOpsHandler.anonymizeForPipeline', () => {
  let deps: HandlerDeps;
  let handler: DataOpsHandler;
  let store: ConfigStore;
  let guard: ProductionGuard;
  let registry: BackgroundOperationRegistry;
  let tracker: LiveOperationTracker;
  let cap: number | undefined;
  // The window's guard, with its modals: a pipeline must never open one.
  const requestConfirmation = vi.fn(async () => true);
  const requestRunConfirmation = vi.fn(async () => true);

  const trail = () => new AuditTrailStore(store).list().entries;
  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);

  beforeEach(() => {
    vi.clearAllMocks();
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    cap = undefined;
    guard = new ProductionGuard({ requestConfirmation, requestRunConfirmation });
    registry = new BackgroundOperationRegistry();
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      stateSync: {},
      orgManager: { getOrg: vi.fn((orgId: string) => ORGS[orgId]) },
      orgRegistry: {},
      configStore: store,
      secretVault: {},
      authProvider: {},
      sfdxBridge: {},
      services: {
        getSandforgeSetting: (key: string, fallback: unknown) =>
          key === 'backup.maxRecordsPerObject' && cap !== undefined ? cap : fallback,
      },
      infraServices: { productionGuard: guard, backgroundRegistry: registry },
      nextId: () => String(++ids),
    } as unknown as HandlerDeps;
    handler = new DataOpsHandler(deps);
    handler.setBackupRecordStore(memoryBackups());
    tracker = new LiveOperationTracker();
    handler.setLiveOperationTracker(tracker);
  });

  afterEach(() => {
    tracker.dispose();
    registry.dispose();
  });

  const mask = (request: Partial<PipelineMaskingRequest> = {}, signal?: AbortSignal) =>
    handler.anonymizeForPipeline(
      {
        orgId: 'org-dev',
        templateId: 'tpl-gdpr-standard',
        object: 'Contact',
        pipeline: { name: 'Nightly refresh' },
        answer: { approved: false },
        ...request,
      },
      signal,
    );

  describe('the org', () => {
    it('refuses a production org whatever the Approval answered, before a connection opens', async () => {
      const { update } = orgOf(contactsOf(3));

      await expect(mask({ orgId: 'org-prod', answer: { approved: true } })).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.production,
        message: expect.stringMatching(/^my-prod is a production org/),
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();
      expect(requestConfirmation).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('masks a Developer Edition org, an older one registered as production, and a scratch org with no Approval before it', async () => {
      const rows = contactsOf(3);
      const { update } = orgOf(rows);

      for (const orgId of ['org-dev', 'org-old-dev', 'org-scratch', 'org-sandbox']) {
        const { result } = await mask({ orgId });
        expect(result.status).toBe('success');
      }
      expect(update).toHaveBeenCalledTimes(4);
      expect(requestConfirmation).not.toHaveBeenCalled();
    });

    it('refuses a sandbox marked Staging that no Approval approved, and masks it once one did', async () => {
      const { update } = orgOf(contactsOf(3));

      await expect(mask({ orgId: 'org-uat' })).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.needsApproval,
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();

      const approved = await mask({ orgId: 'org-uat', answer: { approved: true } });
      expect(approved.result).toMatchObject({ status: 'success', recordsProcessed: 3 });
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('refuses an org SandForge does not know, before a connection opens', async () => {
      await expect(mask({ orgId: 'org-gone', answer: { approved: true } })).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.orgUnknown,
        message: expect.stringContaining('org-gone'),
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();
    });

    it("answers Production Guard's question with the Approval, and opens no modal", async () => {
      // Past 10,000 rows the guard asks on a staging sandbox: a modal left
      // open held the run until someone came back to press it.
      const { update } = orgOf(contactsOf(10_001));

      const outcome = await mask({ orgId: 'org-uat', answer: { approved: true } });

      expect(outcome.result).toMatchObject({ status: 'success', recordsProcessed: 10_001 });
      expect(update).toHaveBeenCalled();
      expect(requestConfirmation).not.toHaveBeenCalled();
      expect(requestRunConfirmation).not.toHaveBeenCalled();
      expect(trail()).toEqual([
        expect.objectContaining({ operationId: outcome.operationId, guard: 'confirmed' }),
      ]);
    });

    it('puts the same question to the modal for a masking run of the DataOps page', async () => {
      orgOf(contactsOf(10_001));

      await handler.handle(
        inboundRequest({
          id: 'mask-page',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: { orgId: 'org-uat', templateId: 'tpl-gdpr-standard', objects: ['Contact'] },
        }),
      );

      expect(requestConfirmation).toHaveBeenCalledOnce();
    });

    it('refuses with the code the page is refused with when no Production Guard runs, writing nothing', async () => {
      const { update } = orgOf(contactsOf(3));
      deps.infraServices = { backgroundRegistry: registry } as HandlerDeps['infraServices'];

      await expect(mask({ answer: { approved: true } })).rejects.toMatchObject({
        code: 'NOT_INITIALIZED',
      });
      expect(update).not.toHaveBeenCalled();
      expect(trail()).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'NOT_INITIALIZED' } }),
      ]);
    });
  });

  describe('the step', () => {
    it('refuses a step given retries before a connection opens, and masks the same step given none', async () => {
      const { update } = orgOf(contactsOf(3));

      await expect(mask({ retries: 2 })).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.retries,
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();

      expect((await mask({ retries: 0 })).result.status).toBe('success');
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('refuses a condition with no object before a connection opens, and masks only the rows it holds once given one', async () => {
      const rows = contactsOf(30, 20);
      const { update } = orgOf(rows);

      await expect(mask({ object: undefined, where: WHERE })).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.filterNeedsObject,
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();

      const { result } = await mask({ object: 'Contact', where: WHERE });
      expect(idsSent(update)).toEqual(rows.slice(0, 20).map((r) => r.Id));
      expect(result).toMatchObject({ status: 'success', recordsProcessed: 20 });
    });

    it('refuses a template neither shipped nor saved, and masks with one the DataOps page saved', async () => {
      const { update } = orgOf(contactsOf(3));

      await expect(mask({ templateId: 'tpl-deleted' })).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.templateMissing,
        message: expect.stringContaining('tpl-deleted: it was deleted on the DataOps page'),
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();

      new AnonymizationTemplateStore(store).save({
        id: 'tpl-saved-emails',
        name: 'Emails',
        description: '',
        complianceFramework: 'custom',
        rules: [{ fieldPattern: 'Contact.Email', ruleType: 'hash', description: '' }],
        saved: true,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
      const { result } = await mask({ templateId: 'tpl-saved-emails' });
      expect(result).toMatchObject({ status: 'success', recordsProcessed: 3 });
      expect(update.mock.calls[0][0]).toEqual([
        { Id: expect.any(String), Email: expect.not.stringContaining('@example.com') },
        expect.anything(),
        expect.anything(),
      ]);
    });
  });

  describe('the coverage, before the guard', () => {
    it('refuses a template naming a field the org does not show the user, before the guard is asked, writing nothing', async () => {
      // Field-level security hides Email: the describe does not list it.
      const hidden = describeOf(
        'Contact',
        CONTACT_FIELDS.filter((f) => f !== 'Email'),
      );
      const { update } = orgOf(contactsOf(3), { describes: { Contact: hidden } });
      const check = vi.spyOn(guard, 'check');

      await expect(mask()).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.fieldsUnseen,
        message: expect.stringContaining('masks Contact.Email, which the org does not show'),
      });
      expect(check).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(store.getKeysByPrefix('backup:')).toEqual([]);
      // Said to the step alone: no page waits on the run.
      expect(posted('dataops:error')).toEqual([]);
      expect(trail()).toEqual([
        expect.objectContaining({
          action: 'anonymize_execute',
          outcome: 'stopped',
          details: { code: PIPELINE_MASKING_REFUSAL.fieldsUnseen },
        }),
      ]);
    });

    it('masks the same org once the field is shown, as the page masks the hidden one partly', async () => {
      const hidden = describeOf(
        'Contact',
        CONTACT_FIELDS.filter((f) => f !== 'Email'),
      );
      const { update } = orgOf(contactsOf(3), { describes: { Contact: hidden } });
      await handler.handle(
        inboundRequest({
          id: 'mask-page',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: { orgId: 'org-dev', templateId: 'tpl-gdpr-standard', objects: ['Contact'] },
        }),
      );
      // The page's run writes the other fields and ends partial on Email.
      expect(posted('dataops:anonymize:response')[0]?.payload).toMatchObject({
        status: 'partial',
        fieldsNotFound: [{ objectApiName: 'Contact', fieldApiName: 'Email' }],
      });
      expect(update).toHaveBeenCalledTimes(1);

      orgOf(contactsOf(3));
      expect((await mask()).result).toMatchObject({ status: 'success', fieldsNotFound: [] });
    });

    it('refuses an object the template has no rule for, and masks one it has', async () => {
      const { update } = orgOf(contactsOf(3));

      await expect(mask({ object: 'Case' })).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.masksNothing,
        message: expect.stringContaining('has no rule for Case'),
      });
      expect(update).not.toHaveBeenCalled();

      expect((await mask({ object: 'Contact' })).result.recordsProcessed).toBe(3);
    });

    it("refuses an object whose rules mask none of the org's fields, and masks it where they do", async () => {
      // A template of contact rules asked for Account derives rules for person
      // accounts alone, and this org has none.
      new AnonymizationTemplateStore(store).save({
        id: 'tpl-saved-contacts',
        name: 'Contacts',
        description: '',
        complianceFramework: 'custom',
        rules: [{ fieldPattern: 'Contact.LastName', ruleType: 'fake', description: '' }],
        saved: true,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
      const business = describeOf('Account', ['Id', 'Name', 'LastName']);
      const { update } = orgOf(contactsOf(3), { describes: { Account: business } });

      await expect(
        mask({ templateId: 'tpl-saved-contacts', object: 'Account' }),
      ).rejects.toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.masksNothing,
        message: expect.stringContaining('masks no field of Account'),
      });
      expect(update).not.toHaveBeenCalled();

      const persons = describeOf('Account', ['Id', 'Name', 'IsPersonAccount', 'LastName']);
      orgOf(contactsOf(3), { describes: { Account: persons } });
      expect(
        (await mask({ templateId: 'tpl-saved-contacts', object: 'Account' })).result.status,
      ).toBe('success');
    });
  });

  describe('the snapshot', () => {
    it('keeps the masked fields of the rows it masks before its first write, and a restore of it puts them back', async () => {
      const rows = contactsOf(30, 20);
      const before = rows.map((r) => ({ ...r }));
      const { statements, query, update, upsert } = orgOf(rows);

      const { result } = await mask({ where: WHERE });

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
      const snapshot = result.snapshot as { operationId: string; totalRecords: number };
      expect(snapshot).toEqual({
        operationId: expect.stringMatching(/-snapshot$/),
        totalRecords: 20,
      });
      // Listed with the org's backups on the DataOps page.
      await handler.handle(
        inboundRequest({
          id: 'list-1',
          type: 'backup:list',
          timestamp: Date.now(),
          payload: { orgId: 'org-dev' },
        }),
      );
      const listed = posted('backup:list:result')[0]?.payload.backups as Array<{
        operationId: string;
      }>;
      expect(listed.map((b) => b.operationId)).toEqual([snapshot.operationId]);

      await handler.handle(
        inboundRequest({
          id: 'rb-1',
          type: 'dataops:rollback',
          timestamp: Date.now(),
          payload: { orgId: 'org-dev', operationId: snapshot.operationId },
        }),
      );
      expect(upsert).toHaveBeenCalled();
      expect(rows).toEqual(before);
    });

    it('writes nothing when the snapshot cannot hold every row it would mask', async () => {
      cap = 100;
      const { update } = orgOf(contactsOf(150));

      await expect(mask()).rejects.toMatchObject({
        code: 'SNAPSHOT_NOT_TAKEN',
        message: expect.stringContaining('Contact 100 of 150 (stopped at the cap)'),
      });
      expect(update).not.toHaveBeenCalled();
      expect(trail()).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'SNAPSHOT_NOT_TAKEN' } }),
      ]);
    });
  });

  describe('what it says and what it keeps', () => {
    it('ends with the result the page is answered for the same run', async () => {
      orgOf(contactsOf(3));
      await handler.handle(
        inboundRequest({
          id: 'mask-page',
          type: 'dataops:anonymize',
          timestamp: Date.now(),
          payload: {
            orgId: 'org-dev',
            templateId: 'tpl-gdpr-standard',
            objects: ['Contact'],
            snapshot: true,
          },
        }),
      );
      const page = posted('dataops:anonymize:response')[0]?.payload;

      orgOf(contactsOf(3));
      const { result } = await mask();

      expect(result).toEqual({
        ...page,
        snapshot: { operationId: expect.stringMatching(/-snapshot$/), totalRecords: 3 },
      });
      expect(result.snapshot?.operationId).not.toBe(
        (page?.snapshot as { operationId: string }).operationId,
      );
    });

    it('says how many rows of each object the org refused, which still hold their values', async () => {
      const rows = contactsOf(5);
      orgOf(rows, { refuses: (id) => id === rows[1].Id || id === rows[3].Id });

      const { result } = await mask();

      expect(result).toMatchObject({
        status: 'partial',
        recordsProcessed: 3,
        recordsFailed: 2,
        recordsNotMasked: 2,
        objects: [{ objectApiName: 'Contact', total: 5, processed: 3, failed: 2, notMasked: 2 }],
      });
      expect(rows[1].Email).toBe('person2@example.com');
      expect(trail()).toEqual([expect.objectContaining({ outcome: 'partial' })]);
    });

    it('lists the run in Live Operations, records it in the audit trail as the page does, and posts no answer to a page', async () => {
      orgOf(contactsOf(3));

      const { operationId } = await mask();

      expect(registry.get(operationId)).toMatchObject({
        module: 'dataops',
        status: 'completed',
        description: 'Pipeline anonymization with GDPR Standard',
      });
      expect(tracker.get(operationId)?.status).toBe('completed');
      expect(trail()).toEqual([
        expect.objectContaining({
          operationId,
          action: 'anonymize_execute',
          outcome: 'success',
          guard: 'allowed',
          objects: [expect.objectContaining({ objectApiName: 'Contact', updated: 3 })],
        }),
      ]);
      expect(posted('dataops:anonymize:response')).toEqual([]);
      expect(posted('dataops:error')).toEqual([]);
    });

    it('holds its org as written to while it runs, so no checkpoint of it is taken meanwhile', async () => {
      const writing: boolean[] = [];
      orgOf(contactsOf(3), { beforeUpdate: () => writing.push(handler.isWritingTo('org-dev')) });

      await mask();

      expect(writing).toEqual([true]);
      expect(handler.isWritingTo('org-dev')).toBe(false);
    });

    it('rejects with what it masked and left of each object when the org fails it, naming its snapshot and keeping where it got for a resume', async () => {
      const rows = contactsOf(450);
      orgOf(rows, {
        beforeUpdate: (call) => {
          if (call === 2) {
            throw Object.assign(
              new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.'),
              {
                errorCode: 'REQUEST_LIMIT_EXCEEDED',
              },
            );
          }
        },
      });

      const failed = mask({ orgId: 'org-sandbox' });

      await expect(failed).rejects.toMatchObject({
        message: expect.stringMatching(
          /^REQUEST_LIMIT_EXCEEDED.* — 200 masked before it stopped; 250 still hold their original values \(Contact 250\)\.$/,
        ),
        snapshot: { operationId: expect.stringMatching(/-snapshot$/), totalRecords: 450 },
      });
      expect(trail()).toEqual([expect.objectContaining({ outcome: 'partial' })]);
      const checkpoint = new MaskingCheckpointStore(store).load(
        'org-sandbox',
        'tpl-gdpr-standard',
        maskingFingerprint(ANONYMIZATION_TEMPLATES[0].rules, ['Contact'], undefined),
      );
      expect(checkpoint?.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Contact', afterId: rows[199].Id }),
      ]);
    });
  });

  describe('a cancel', () => {
    it("stops the run on the step's signal at the next batch, with what it masked before the stop", async () => {
      const step = new AbortController();
      const { update } = orgOf(contactsOf(450), {
        beforeUpdate: (call) => {
          if (call === 1) step.abort();
        },
      });

      const { operationId, result } = await mask({ orgId: 'org-sandbox' }, step.signal);

      expect(update).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        cancelled: true,
        recordsProcessed: 200,
        recordsNotMasked: 250,
      });
      expect(registry.get(operationId)?.status).toBe('aborted');
      expect(tracker.get(operationId)?.status).toBe('cancelled');
    });

    it('writes nothing when the step was cancelled before the run started', async () => {
      const step = new AbortController();
      step.abort();
      const { update } = orgOf(contactsOf(3));

      const refused = mask({}, step.signal);

      await expect(refused).rejects.toBeInstanceOf(StepCancelledError);
      expect(update).not.toHaveBeenCalled();
      expect(store.getKeysByPrefix('backup:')).toEqual([]);
      expect(trail()).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'ABORTED_BEFORE_START' } }),
      ]);
    });
  });
});
