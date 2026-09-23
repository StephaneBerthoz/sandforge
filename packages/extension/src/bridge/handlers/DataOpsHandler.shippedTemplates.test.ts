import { createHash } from 'node:crypto';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';

import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ANONYMIZATION_TEMPLATES } from '../templates/anonymizationTemplates.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * The masking templates that ship, run the way the DataOps page runs them:
 * `dataops:anonymize` with a template id and no object list, against an org
 * that reads and refuses the way Salesforce does.
 *
 * Every test before these handed the handler a two-field describe and a mock
 * that took whatever it was sent, so none of them could see what a real org
 * does with a masking run: the CCPA and HIPAA templates threw before writing
 * anything, Sandbox Data Scrub emptied the websites it was meant to replace,
 * HIPAA emptied the postal codes it was meant to shorten, and every record of
 * every template went back with the system and compound fields it was read
 * with, which Salesforce refuses whole.
 */

/** A field as a describe lists it. */
interface FakeField {
  name: string;
  type: string;
  length?: number;
  updateable: boolean;
  nillable?: boolean;
}

/** What every record of every object carries, and nobody may write. */
const SYSTEM_FIELDS: FakeField[] = [
  { name: 'Id', type: 'id', length: 18, updateable: false, nillable: false },
  { name: 'IsDeleted', type: 'boolean', updateable: false, nillable: false },
  { name: 'CreatedDate', type: 'datetime', updateable: false, nillable: false },
  { name: 'LastModifiedDate', type: 'datetime', updateable: false, nillable: false },
  { name: 'SystemModstamp', type: 'datetime', updateable: false, nillable: false },
];

/**
 * The objects the templates address, cut down to the fields they name and to
 * the read-only ones a full read brings back with them: the compound name and
 * address, a flag, the audit dates. Types and lengths are a standard org's.
 */
const DESCRIBED: Record<string, FakeField[]> = {
  Contact: [
    ...SYSTEM_FIELDS,
    { name: 'Name', type: 'string', length: 121, updateable: false },
    { name: 'FirstName', type: 'string', length: 40, updateable: true, nillable: true },
    { name: 'LastName', type: 'string', length: 80, updateable: true, nillable: false },
    { name: 'Email', type: 'email', length: 80, updateable: true, nillable: true },
    { name: 'Phone', type: 'phone', length: 40, updateable: true, nillable: true },
    { name: 'Birthdate', type: 'date', updateable: true, nillable: true },
    { name: 'MailingStreet', type: 'textarea', length: 255, updateable: true, nillable: true },
    { name: 'MailingCity', type: 'string', length: 40, updateable: true, nillable: true },
    { name: 'MailingState', type: 'string', length: 80, updateable: true, nillable: true },
    { name: 'MailingPostalCode', type: 'string', length: 20, updateable: true, nillable: true },
    { name: 'MailingAddress', type: 'address', updateable: false, nillable: true },
  ],
  Lead: [
    ...SYSTEM_FIELDS,
    { name: 'Name', type: 'string', length: 121, updateable: false },
    { name: 'FirstName', type: 'string', length: 40, updateable: true, nillable: true },
    { name: 'LastName', type: 'string', length: 80, updateable: true, nillable: false },
    { name: 'Email', type: 'email', length: 80, updateable: true, nillable: true },
    { name: 'Phone', type: 'phone', length: 40, updateable: true, nillable: true },
    { name: 'Street', type: 'textarea', length: 255, updateable: true, nillable: true },
    { name: 'Company', type: 'string', length: 255, updateable: true, nillable: false },
    { name: 'Address', type: 'address', updateable: false, nillable: true },
    { name: 'IsConverted', type: 'boolean', updateable: false, nillable: false },
  ],
  Account: [
    ...SYSTEM_FIELDS,
    { name: 'Name', type: 'string', length: 255, updateable: true, nillable: false },
    { name: 'Phone', type: 'phone', length: 40, updateable: true, nillable: true },
    { name: 'Website', type: 'url', length: 255, updateable: true, nillable: true },
    { name: 'BillingStreet', type: 'textarea', length: 255, updateable: true, nillable: true },
    { name: 'BillingAddress', type: 'address', updateable: false, nillable: true },
  ],
  Opportunity: [
    ...SYSTEM_FIELDS,
    { name: 'Name', type: 'string', length: 120, updateable: true, nillable: false },
    { name: 'StageName', type: 'picklist', length: 255, updateable: true, nillable: false },
    { name: 'CloseDate', type: 'date', updateable: true, nillable: false },
    { name: 'IsClosed', type: 'boolean', updateable: false, nillable: false },
  ],
};

/** The audit fields and the query attributes every record is read with. */
function system(type: string, id: string): Record<string, unknown> {
  return {
    attributes: { type, url: `/services/data/v62.0/sobjects/${type}/${id}` },
    Id: id,
    IsDeleted: false,
    CreatedDate: '2026-01-05T09:00:00.000+0000',
    LastModifiedDate: '2026-02-11T16:30:00.000+0000',
    SystemModstamp: '2026-02-11T16:30:00.000+0000',
  };
}

/**
 * The org before a run. One person is both a contact and a lead, with the
 * same address on each; a second contact and a second account hold almost
 * nothing, which is how a real org's records look.
 */
function seedRecords(): Record<string, Array<Record<string, unknown>>> {
  const street = { street: '12 Harbour Row', city: 'Portwick', postalCode: '04101-2231' };
  return {
    Contact: [
      {
        ...system('Contact', '003000000000001AAA'),
        Name: 'Ottoline Quenneville',
        FirstName: 'Ottoline',
        LastName: 'Quenneville',
        Email: 'ottoline.q@mail.test',
        Phone: '(555) 010-4477',
        Birthdate: '1984-03-09',
        MailingStreet: '12 Harbour Row',
        MailingCity: 'Portwick',
        MailingState: 'ME',
        MailingPostalCode: '04101-2231',
        MailingAddress: street,
      },
      {
        ...system('Contact', '003000000000002AAA'),
        Name: 'Bartholomew Okafor',
        FirstName: 'Bartholomew',
        LastName: 'Okafor',
        Email: null,
        Phone: null,
        Birthdate: null,
        MailingStreet: null,
        MailingCity: null,
        MailingState: null,
        MailingPostalCode: '90210',
        MailingAddress: { postalCode: '90210' },
      },
    ],
    Lead: [
      {
        ...system('Lead', '00Q000000000001AAA'),
        Name: 'Ottoline Quenneville',
        FirstName: 'Ottoline',
        LastName: 'Quenneville',
        Email: 'ottoline.q@mail.test',
        Phone: '(555) 010-4477',
        Street: '12 Harbour Row',
        Company: 'Birchwood Dental',
        Address: street,
        IsConverted: false,
      },
    ],
    Account: [
      {
        ...system('Account', '001000000000001AAA'),
        Name: 'Birchwood Dental',
        Phone: '(555) 010-9000',
        Website: 'https://birchwood-dental.test',
        BillingStreet: '1 Birch Lane',
        BillingAddress: { street: '1 Birch Lane' },
      },
      {
        ...system('Account', '001000000000002AAA'),
        Name: 'Harbour Clinic',
        Phone: null,
        Website: null,
        BillingStreet: null,
        BillingAddress: null,
      },
    ],
    Opportunity: [
      {
        ...system('Opportunity', '006000000000001AAA'),
        Name: 'Birchwood Dental renewal',
        StageName: 'Prospecting',
        CloseDate: '2026-12-01',
        IsClosed: false,
      },
    ],
  };
}

/** An address as the org checks one on an Email field. */
const ORG_EMAIL_FORMAT = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * What Salesforce answers for one record of an update, or undefined when it
 * takes it: a field nobody may write refuses the whole record, and so do an
 * Email field that holds no address, a required field emptied and a value
 * longer than its field.
 */
function refusal(objectApiName: string, payload: Record<string, unknown>): string | undefined {
  const fields = new Map(DESCRIBED[objectApiName].map((f) => [f.name, f]));
  const sent = Object.keys(payload).filter((k) => k !== 'Id' && k !== 'attributes');
  const readOnly = sent.filter((k) => fields.get(k)?.updateable !== true);
  if (readOnly.length > 0) {
    return `INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: ${readOnly.join(', ')}.`;
  }
  for (const name of sent) {
    const field = fields.get(name) as FakeField;
    const value = payload[name];
    if (value === null || value === '') {
      if (field.nillable === false)
        return `REQUIRED_FIELD_MISSING: Required fields are missing: [${name}]`;
      continue;
    }
    if (field.type === 'email' && !ORG_EMAIL_FORMAT.test(String(value))) {
      return `INVALID_EMAIL_ADDRESS: ${name}: invalid email address: ${String(value)}`;
    }
    if (field.length !== undefined && String(value).length > field.length) {
      return `STRING_TOO_LONG: ${name}: data value too large`;
    }
  }
  return undefined;
}

/** The org: its records, a connection onto them, and what each update was sent. */
function fakeOrg() {
  const records = seedRecords();
  const sent: Array<{ objectApiName: string; payload: Record<string, unknown> }> = [];
  const connection = {
    describe: vi.fn(async (objectApiName: string) => ({
      name: objectApiName,
      label: objectApiName,
      createable: true,
      updateable: true,
      deletable: true,
      queryable: true,
      fields: DESCRIBED[objectApiName].map((f) => ({
        ...f,
        label: f.name,
        length: f.length ?? 0,
        createable: f.updateable,
        permissionable: f.updateable,
      })),
      recordTypeInfos: [],
      childRelationships: [],
    })),
    query: vi.fn(async (soql: string) => {
      const objectApiName = /\bFROM\s+(\w+)/.exec(soql)?.[1] ?? '';
      return { records: structuredClone(records[objectApiName] ?? []), done: true };
    }),
    sobject: vi.fn((objectApiName: string) => ({
      update: vi.fn(async (batch: Array<Record<string, unknown>>) =>
        batch.map((payload) => {
          sent.push({ objectApiName, payload });
          const refused = refusal(objectApiName, payload);
          if (refused) return { success: false, errors: [{ message: refused }] };
          const record = records[objectApiName].find((r) => r.Id === payload.Id);
          if (!record) return { success: false, errors: [{ message: 'ENTITY_IS_DELETED' }] };
          for (const [name, value] of Object.entries(payload)) {
            if (name !== 'attributes') record[name] = value;
          }
          return { success: true, id: payload.Id };
        }),
      ),
    })),
  };
  return { records, sent, connection };
}

function createDeps(): HandlerDeps {
  let idCounter = 0;
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    stateSync: {},
    orgManager: { getOrg: vi.fn(() => ({ orgType: 'Sandbox' })) },
    orgRegistry: {},
    configStore,
    secretVault: {},
    authProvider: {},
    sfdxBridge: {},
    infraServices: { productionGuard: new ProductionGuard() },
    nextId: () => String(++idCounter),
  } as unknown as HandlerDeps;
}

/** A template that ships, by id. */
function shipped(templateId: string) {
  const template = ANONYMIZATION_TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new Error(`no template ${templateId}`);
  return template;
}

describe('DataOps masking with the templates that ship', () => {
  let deps: HandlerDeps;
  let org: ReturnType<typeof fakeOrg>;
  let requests = 0;

  beforeEach(() => {
    deps = createDeps();
    org = fakeOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
  });

  /** Everything the handler posted, in order. */
  function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  }

  /** Apply a template the way the page does: its id, and no object list. */
  async function apply(
    templateId: string,
    handler = new DataOpsHandler(deps),
  ): Promise<Record<string, unknown> | undefined> {
    requests += 1;
    await handler.handle(
      inboundRequest({
        id: `mask-${requests}`,
        type: 'dataops:anonymize',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', templateId },
      } as BaseMessage),
    );
    return posted()
      .filter((m) => m.type === 'dataops:anonymize:response')
      .at(-1)?.payload;
  }

  /** What the org answered on the error channel. */
  function errors(): unknown[] {
    return posted()
      .filter((m) => m.type === 'dataops:error')
      .map((m) => m.payload.message);
  }

  it.each(ANONYMIZATION_TEMPLATES.map((t) => [t.name, t.id] as const))(
    'runs %s to the end, and the org takes every record it writes',
    async (_name, templateId) => {
      const before = seedRecords();

      const response = await apply(templateId);

      expect(errors()).toEqual([]);
      expect(response).toMatchObject({ status: 'success', recordsFailed: 0, errors: [] });
      // Every value a rule of the template addresses is gone from the org.
      for (const rule of shipped(templateId).rules) {
        const [objectApiName, field] = rule.fieldPattern.split('.');
        before[objectApiName].forEach((original, index) => {
          if (original[field] === null) return;
          expect(org.records[objectApiName][index][field], rule.fieldPattern).not.toEqual(
            original[field],
          );
        });
      }
    },
  );

  it('hashes an email under the window’s key into an address the org takes, the same on a contact and on a lead', async () => {
    await apply('tpl-ccpa-california');

    const [contact] = org.records.Contact;
    const [lead] = org.records.Lead;
    expect(contact.Email).toMatch(/^sha256-[0-9a-f]{32}@example\.invalid$/);
    // The same person is one pseudonym across objects: that is what a hash
    // keeps and a made-up address would not.
    expect(lead.Email).toBe(contact.Email);
    // Keyed: not the bare digest anybody could compute from a list of addresses.
    const unkeyed = createHash('sha256').update('ottoline.q@mail.test').digest('hex');
    expect(String(contact.Email)).not.toContain(unkeyed.slice(0, 32));
  });

  it('hashes an address the same way on every run of a window, and another way in the next window', async () => {
    const window = new DataOpsHandler(deps);
    await apply('tpl-ccpa-california', window);
    const first = org.records.Contact[0].Email;

    org = fakeOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
    await apply('tpl-ccpa-california', window);
    expect(org.records.Contact[0].Email).toBe(first);

    // No salt is written into a template or anywhere else: the next window
    // draws its own key, so its pseudonyms are not these.
    const elsewhere = new Set<unknown>();
    for (let k = 0; k < 4; k++) {
      org = fakeOrg();
      vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
      await apply('tpl-ccpa-california', new DataOpsHandler(deps));
      elsewhere.add(org.records.Contact[0].Email);
    }
    expect(elsewhere.has(first)).toBe(false);
    expect(elsewhere.size).toBe(4);
  });

  it('masks all of a contact’s phone but its last four digits, as the GDPR template says', async () => {
    await apply('tpl-gdpr-standard');

    expect(org.records.Contact.map((c) => c.Phone)).toEqual(['**********4477', null]);
    // The rules that say nothing of the kind mask the whole number.
    expect(org.records.Lead[0].Phone).toBe('**************');
  });

  it('keeps the first three characters of a postal code, as the HIPAA template says', async () => {
    await apply('tpl-hipaa-health');

    expect(org.records.Contact.map((c) => c.MailingPostalCode)).toEqual(['041', '902']);
  });

  it('writes the placeholder URL Sandbox Data Scrub means into a website, and nothing into an account that had none', async () => {
    await apply('tpl-sandbox-scrub');

    expect(org.records.Account.map((a) => a.Website)).toEqual(['https://example.com', null]);
  });

  it('writes back only the Id and the fields a template names, never the system or compound fields it read', async () => {
    await apply('tpl-gdpr-standard');

    expect(org.sent.length).toBeGreaterThan(0);
    for (const { objectApiName, payload } of org.sent) {
      const named = shipped('tpl-gdpr-standard')
        .rules.map((r) => r.fieldPattern.split('.'))
        .filter(([object]) => object === objectApiName)
        .map(([, field]) => field);
      expect(Object.keys(payload).every((k) => k === 'Id' || named.includes(k))).toBe(true);
    }
  });

  it('leaves a field that held nothing empty, rather than inventing a value or a digest for it', async () => {
    await apply('tpl-ccpa-california');

    // A digest of nothing is not an address, and the org would have refused
    // the whole contact over it, leaving the name it holds unmasked.
    const [, emptyContact] = org.records.Contact;
    expect(emptyContact.Email).toBeNull();
    expect(emptyContact.LastName).not.toBe('Okafor');

    await apply('tpl-gdpr-standard');
    const [, emptyAccount] = org.records.Account;
    expect(emptyAccount).toMatchObject({ Phone: null, BillingStreet: null });
  });

  it('counts a record with nothing to mask as done, and records only what it wrote', async () => {
    const response = await apply('tpl-gdpr-standard');

    // Three objects, five records read; the second account holds nothing the
    // template masks, so it is not written, and nothing is left to mask on it.
    expect(org.sent.map((s) => s.payload.Id)).not.toContain('001000000000002AAA');
    expect(response).toMatchObject({ status: 'success', recordsProcessed: 5, recordsFailed: 0 });
    const { entries } = new AuditTrailStore(deps.configStore).list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'anonymize_execute',
      outcome: 'success',
      objects: [
        { objectApiName: 'Contact', updated: 2, failed: 0 },
        { objectApiName: 'Lead', updated: 1, failed: 0 },
        { objectApiName: 'Account', updated: 1, failed: 0 },
      ],
    });
  });
});
