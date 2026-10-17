import * as path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';

import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import { ANONYMIZATION_TEMPLATES } from '../templates/anonymizationTemplates.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * A masking run on the accounts of an org with person accounts, against an
 * org that refuses what Salesforce refuses: a field only a person account
 * holds sent with a business account, and a person account's name, which the
 * platform computes.
 *
 * Run for real with the GDPR template, a masking of accounts changed the
 * billing street and the phone of each, and left every person account's first
 * and last names, email, phones, birthdate and mailing address in clear.
 */

/** A field of the account as the describe gives it. */
interface FakeField {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  nillable?: boolean;
  personOnly?: true;
}

const DESCRIBED: FakeField[] = [
  { name: 'Id', label: 'Account ID', type: 'id', updateable: false },
  { name: 'IsPersonAccount', label: 'Is Person Account', type: 'boolean', updateable: false },
  { name: 'Name', label: 'Account Name', type: 'string', updateable: true, nillable: false },
  { name: 'Phone', label: 'Account Phone', type: 'phone', updateable: true, nillable: true },
  { name: 'Website', label: 'Website', type: 'url', updateable: true, nillable: true },
  {
    name: 'BillingStreet',
    label: 'Billing Street',
    type: 'textarea',
    updateable: true,
    nillable: true,
  },
  ...(
    [
      ['FirstName', 'First Name', 'string'],
      ['LastName', 'Last Name', 'string'],
      ['Salutation', 'Salutation', 'picklist'],
      ['PersonEmail', 'Email', 'email'],
      ['PersonMobilePhone', 'Mobile', 'phone'],
      ['PersonHomePhone', 'Home Phone', 'phone'],
      ['PersonBirthdate', 'Birthdate', 'date'],
      ['PersonMailingStreet', 'Mailing Street', 'textarea'],
      ['PersonMailingCity', 'Mailing City', 'string'],
      ['PersonMailingPostalCode', 'Mailing Zip/Postal Code', 'string'],
    ] as const
  ).map(([name, label, type]): FakeField => ({
    name,
    label,
    type,
    updateable: true,
    nillable: true,
    personOnly: true,
  })),
];

/** The fields only a person account holds. */
const PERSON_FIELDS = DESCRIBED.filter((f) => f.personOnly).map((f) => f.name);

/** A business account and a person account, as the org holds them. */
function accounts(): Array<Record<string, unknown>> {
  return [
    {
      Id: '001000000000001AAA',
      IsPersonAccount: false,
      Name: 'Birchwood Dental',
      Phone: '(555) 010-9000',
      Website: 'https://birchwood-dental.test',
      BillingStreet: '1 Birch Lane',
      ...Object.fromEntries(PERSON_FIELDS.map((f) => [f, null])),
    },
    {
      Id: '001000000000002AAA',
      IsPersonAccount: true,
      Name: 'Ottoline Quenneville',
      Phone: '(555) 010-4477',
      Website: null,
      BillingStreet: null,
      FirstName: 'Ottoline',
      LastName: 'Quenneville',
      Salutation: 'Ms.',
      PersonEmail: 'ottoline.q@mail.test',
      PersonMobilePhone: '(555) 010-1234',
      PersonHomePhone: '(555) 010-5678',
      PersonBirthdate: '1984-03-09',
      PersonMailingStreet: '12 Harbour Row',
      PersonMailingCity: 'Portwick',
      PersonMailingPostalCode: '04101-2231',
    },
  ];
}

/** What the org answers for one written record, or undefined when it takes it. */
function refusal(row: Record<string, unknown>, sent: Record<string, unknown>): string | undefined {
  const fields = Object.keys(sent).filter((k) => k !== 'Id' && k !== 'attributes');
  const person = row.IsPersonAccount === true;
  const bad = fields.filter((f) => !person && PERSON_FIELDS.includes(f));
  if (bad.length > 0) {
    return `INVALID_FIELD_FOR_INSERT_UPDATE: Account: bad field names on insert/update call: ${bad.join(', ')}`;
  }
  const fixed = fields.filter(
    (f) => (person && f === 'Name') || DESCRIBED.find((d) => d.name === f)?.updateable !== true,
  );
  if (fixed.length > 0) {
    return `INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: ${fixed.join(', ')}.`;
  }
  return undefined;
}

/** The org: its accounts, read by the fields a statement names, and written as Salesforce writes them. */
function orgOf(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00D000000000001AAA' }], done: true, totalSize: 1 };
    }
    if (soql.includes('IsDeleted = true')) return { records: [], done: true, totalSize: 0 };
    const after = /\bId > '(\w+)'/.exec(soql)?.[1];
    const kept = rows.filter((r) => after === undefined || String(r.Id) > after);
    if (soql.startsWith('SELECT COUNT() '))
      return { records: [], done: true, totalSize: kept.length };
    const fields = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
    const records = kept.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    return { records, done: true, totalSize: records.length };
  });
  const write = (batch: Array<Record<string, unknown>>) =>
    batch.map((sent) => {
      const row = rows.find((r) => r.Id === sent.Id);
      if (!row) return { success: false, errors: [{ message: 'ENTITY_IS_DELETED' }] };
      const refused = refusal(row, sent);
      if (refused) return { success: false, errors: [{ message: refused }] };
      Object.assign(row, sent);
      return { success: true, id: sent.Id };
    });
  const update = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) => write(batch));
  const conn = {
    query,
    queryMore: vi.fn(),
    describe: vi.fn(async () => ({
      name: 'Account',
      label: 'Account',
      createable: true,
      updateable: true,
      deletable: true,
      queryable: true,
      fields: DESCRIBED.map((f) => ({
        ...f,
        createable: f.updateable,
        permissionable: f.updateable,
      })),
      recordTypeInfos: [],
      childRelationships: [],
    })),
    sobject: vi.fn(() => ({ update, upsert })),
    soap: { undelete: vi.fn(async () => []) },
  };
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  return { update, upsert };
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

describe('DataOps masking of the accounts of an org with person accounts', () => {
  let deps: HandlerDeps;
  let handler: DataOpsHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    const store = new ConfigStore(new InMemoryConfigStoreBackend());
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

  it.each(ANONYMIZATION_TEMPLATES.map((t) => [t.name, t.id] as const))(
    "masks with %s every person account's own fields, the name the platform computes left to it, and none on a business account",
    async (_name, templateId) => {
      const rows = accounts();
      const before = accounts();
      const { update } = orgOf(rows);

      await send('dataops:anonymize', { orgId: 'org-1', templateId, objects: ['Account'] });

      expect(last('dataops:error')).toBeUndefined();
      expect(last('dataops:anonymize:response')?.payload).toMatchObject({
        status: 'success',
        recordsFailed: 0,
      });
      const [business, person] = rows;
      // The person's name, email, phones, birthdate and salutation hold
      // something else, whichever template: what it masks on a contact, and
      // what the detector names.
      for (const field of [
        'FirstName',
        'LastName',
        'Salutation',
        'PersonEmail',
        'PersonMobilePhone',
        'PersonHomePhone',
        'PersonBirthdate',
        'PersonMailingStreet',
      ]) {
        expect(person[field], field).not.toEqual(before[1][field]);
      }
      // The business account never went with a field only a person holds,
      // nor the person account with its name.
      const sent = update.mock.calls.flatMap(([batch]) => batch);
      const sentOf = (id: unknown) => sent.find((s) => s.Id === id) ?? {};
      expect(Object.keys(sentOf(business.Id)).filter((k) => PERSON_FIELDS.includes(k))).toEqual([]);
      expect(sentOf(person.Id)).not.toHaveProperty('Name');
      expect(PERSON_FIELDS.every((f) => business[f] === null)).toBe(true);
    },
  );

  it("masks every field of a person account's with the GDPR template, the account's phone as on any account", async () => {
    const rows = accounts();
    const before = accounts();
    orgOf(rows);

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Account'],
    });

    const [business, person] = rows;
    for (const field of PERSON_FIELDS) {
      expect(person[field], field).not.toEqual(before[1][field]);
    }
    expect(person.Phone).toBe('**************');
    expect(person.Name).toBe('Ottoline Quenneville');
    expect(business).toMatchObject({ Name: 'Birchwood Dental', Phone: '**************' });
    expect(business.BillingStreet).not.toBe('1 Birch Lane');
  });

  it("previews a person account's fields as Apply masks them, and a business account's as they stay", async () => {
    orgOf(accounts());

    await send('dataops:anonymize:preview', {
      orgId: 'org-1',
      templateId: 'tpl-gdpr-standard',
      objects: ['Account'],
    });

    const [object] = last('dataops:anonymize:preview:response')?.payload.objects as Array<{
      fields: string[];
      methods?: Record<string, string>;
      rows: Array<{
        id: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }>;
    }>;
    expect(object.fields).toEqual(expect.arrayContaining(['FirstName', 'PersonEmail']));
    expect(object.fields).not.toContain('IsPersonAccount');
    // How each is masked: a contact's rule, or an erasure's method.
    expect(object.methods).toMatchObject({
      Phone: 'mask',
      PersonEmail: 'fake',
      PersonMailingPostalCode: 'mask',
      PersonBirthdate: 'nullify',
    });
    const [business, person] = object.rows;
    expect(person.after.PersonEmail).not.toEqual(person.before.PersonEmail);
    expect(business.after.FirstName).toEqual(business.before.FirstName);
  });

  it('puts every account back as it was from the snapshot, each without what its kind cannot hold', async () => {
    const rows = accounts();
    const before = accounts();
    const { upsert } = orgOf(rows);

    await send('dataops:anonymize', {
      orgId: 'org-1',
      templateId: 'tpl-hipaa-health',
      objects: ['Account'],
      snapshot: true,
    });
    const snapshot = last('dataops:anonymize:response')?.payload.snapshot as {
      operationId: string;
    };
    expect(rows[1].FirstName).not.toBe('Ottoline');

    await send('dataops:rollback', { orgId: 'org-1', operationId: snapshot.operationId }, 'rb-1');

    expect(last('dataops:rollback:response')?.payload).toMatchObject({
      status: 'success',
      totalRestored: 2,
      totalFailed: 0,
    });
    expect(rows).toEqual(before);
    const sent = upsert.mock.calls.flatMap(([batch]) => batch);
    expect(Object.keys(sent[0]).filter((k) => PERSON_FIELDS.includes(k))).toEqual([]);
    expect(sent[1]).not.toHaveProperty('Name');
  });
});
