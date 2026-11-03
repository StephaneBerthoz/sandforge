/**
 * A masking run of the DataOps page masks every field its template names on
 * the rows it reads, or nothing, as a pipeline's does: a field the org does
 * not show the user stays in clear in every record, and a run that masked the
 * rest and ended partial left a person believing the org was anonymized.
 *
 * The org here answers as Salesforce does. A describe lists only what the
 * connected user may read; a statement or an update naming a field the
 * describe leaves out is refused, `INVALID_FIELD`, whole.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BaseMessage } from '@sandforge/shared';
import { DataOpsHandler } from './DataOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { PIPELINE_MASKING_REFUSAL } from './anonymizePipeline.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { AnonymizationTemplateStore } from '../../modules/dataops/AnonymizationTemplateStore.js';
import { BackupRecordStore } from '../../modules/dataops/BackupRecordStore.js';
import {
  MaskingCheckpointStore,
  maskingFingerprint,
} from '../../modules/dataops/MaskingCheckpointStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * One object of the fake org: the fields the user is shown, and its rows; the
 * fields the user may read and not edit, and whether it may edit the object.
 */
interface FakeObject {
  shown: readonly string[];
  rows: Array<Record<string, unknown>>;
  readOnly?: readonly string[];
  editable?: false;
}

/** An object's describe, as the org gives it to the connected user. */
function describeOf(name: string, object: FakeObject) {
  const editable = (field: string) => field !== 'Id' && !(object.readOnly ?? []).includes(field);
  return {
    name,
    label: name,
    createable: object.editable ?? true,
    updateable: object.editable ?? true,
    deletable: true,
    queryable: true,
    fields: ['Id', ...object.shown].map((field) => ({
      name: field,
      label: field,
      type: field === 'Id' ? 'id' : 'string',
      createable: editable(field),
      updateable: editable(field),
      permissionable: field !== 'Id',
    })),
    recordTypeInfos: [],
    childRelationships: [],
  };
}

/** The refusal of a field the connected user is not shown, as the org words it. */
function noSuchColumn(field: string, object: string): Error {
  return Object.assign(
    new Error(`INVALID_FIELD: No such column '${field}' on entity '${object}'.`),
    { errorCode: 'INVALID_FIELD' },
  );
}

/** An org holding `objects`, each answered as Salesforce answers that object. */
function orgOf(objects: Record<string, FakeObject>) {
  const objectOf = (soql: string): string => /\bFROM (\w+)/.exec(soql)?.[1] ?? '';
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00D000000000001AAA' }], done: true, totalSize: 1 };
    }
    const name = objectOf(soql);
    const object = objects[name];
    if (!object) throw new Error(`INVALID_TYPE: sObject type '${name}' is not supported.`);
    if (soql.startsWith('SELECT COUNT() ')) {
      return { records: [], done: true, totalSize: object.rows.length };
    }
    if (soql.includes('IsDeleted = true')) return { records: [], done: true, totalSize: 0 };
    const fields = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
    for (const field of fields) {
      if (field !== 'Id' && !object.shown.includes(field)) throw noSuchColumn(field, name);
    }
    const after = /\bId > '(\w+)'/.exec(soql)?.[1];
    const records = object.rows
      .filter((row) => after === undefined || String(row.Id) > after)
      .map((row) => Object.fromEntries(fields.map((f) => [f, row[f]])));
    return { records, done: true, totalSize: records.length };
  });
  const update = vi.fn(async (batch: Array<Record<string, unknown>>) =>
    batch.map((sent) => ({ success: true, id: sent.Id })),
  );
  const conn = {
    query,
    queryMore: vi.fn(),
    describe: vi.fn(async (name: string) => {
      const object = objects[name];
      if (!object) throw new Error(`NOT_FOUND: The requested resource does not exist: ${name}`);
      return describeOf(name, object);
    }),
    sobject: vi.fn(() => ({ update, upsert: vi.fn() })),
    soap: { undelete: vi.fn(async () => []) },
  };
  vi.mocked(getJsforceConnection).mockResolvedValue(conn as never);
  return { conn, query, update };
}

const CONTACTS = [
  { Id: '003000000000001', FirstName: 'Ada', Birthdate: '1815-12-10' },
  { Id: '003000000000002', FirstName: 'Grace', Birthdate: '1906-12-09' },
];
const LEADS = [{ Id: '00Q000000000001', Email: 'lead@example.org', Phone: '+1 415 555 0142' }];

/** A template of the user's, masking these fields. */
const RULES = [
  { fieldPattern: 'Contact.FirstName', ruleType: 'nullify', description: '' },
  { fieldPattern: 'Contact.Birthdate', ruleType: 'nullify', description: '' },
  { fieldPattern: 'Lead.Email', ruleType: 'nullify', description: '' },
  { fieldPattern: 'Lead.Phone', ruleType: 'nullify', description: '' },
] as const;

/** The refusal's words of what to do: read and edit access, or the field out of the template. */
const WHAT_TO_DO =
  'give that user read and edit access to the field, or take the field out of the template.';

describe('DataOpsHandler: a masking run of the page covers its template, or writes nothing', () => {
  let deps: HandlerDeps;
  let handler: DataOpsHandler;
  let store: ConfigStore;
  let guard: ProductionGuard;

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
    guard = new ProductionGuard({
      requestConfirmation: vi.fn(async () => true),
      requestRunConfirmation: vi.fn(async () => true),
    });
    let ids = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      stateSync: {},
      orgManager: { getOrg: vi.fn(() => ({ orgType: 'Sandbox', alias: 'my-sandbox' })) },
      orgRegistry: {},
      configStore: store,
      secretVault: {},
      authProvider: {},
      sfdxBridge: {},
      services: { getSandforgeSetting: (_key: string, fallback: unknown) => fallback },
      infraServices: {
        productionGuard: guard,
        backgroundRegistry: new BackgroundOperationRegistry(),
      },
      nextId: () => String(++ids),
    } as unknown as HandlerDeps;
    handler = new DataOpsHandler(deps);
    const files = new Map<string, string>();
    handler.setBackupRecordStore(
      new BackupRecordStore({
        storagePath: '/storage',
        readFile: async (p) => files.get(p) ?? '',
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
        listFiles: async () => [],
      }),
    );
    new AnonymizationTemplateStore(store).save({
      id: 'tpl-saved-people',
      name: 'People',
      description: '',
      complianceFramework: 'custom',
      rules: [...RULES],
      saved: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  const request = (type: string, payload: Record<string, unknown>, id = 'mask-1') =>
    handler.handle(
      inboundRequest({
        id,
        type,
        timestamp: Date.now(),
        payload: { orgId: 'org-1', templateId: 'tpl-saved-people', ...payload },
      }),
    );

  it('refuses a field the org hides, naming it and what to do, before the guard is asked, a snapshot is read or a record is written', async () => {
    // Field-level security hides Birthdate: the describe leaves it out as it
    // would for an org without it. The run masked every first name, ended
    // partial, and left every birthdate in clear.
    const { update, query } = orgOf({
      Contact: { shown: ['FirstName'], rows: CONTACTS },
      Lead: { shown: ['Email', 'Phone'], rows: LEADS },
    });
    const check = vi.spyOn(guard, 'check');

    await request('dataops:anonymize', { snapshot: true });

    const [refused] = posted('dataops:error');
    expect(refused.correlationId).toBe('mask-1');
    expect(refused.payload).toMatchObject({
      code: PIPELINE_MASKING_REFUSAL.fieldsUnseen,
      fieldsNotFound: [{ objectApiName: 'Contact', fieldApiName: 'Birthdate' }],
      objectsNotCovered: [],
      retryable: false,
    });
    const message = String(refused.payload.message);
    expect(message).toContain('masks Contact.Birthdate, which the org does not show');
    expect(message).toContain('field-level security hides it');
    expect(message).toContain(WHAT_TO_DO);
    expect(message).toMatch(/Nothing was masked\.$/);

    expect(update).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(store.getKeysByPrefix('backup:')).toEqual([]);
    // Counted, and no row of any object read.
    expect(query.mock.calls.every(([soql]) => String(soql).startsWith('SELECT COUNT()'))).toBe(
      true,
    );
    expect(posted('dataops:anonymize:response')).toEqual([]);
    expect(posted('operation:started')).toEqual([]);
    expect(posted('operation:failed')).toHaveLength(1);
    expect(trail()).toEqual([
      expect.objectContaining({
        action: 'anonymize_execute',
        outcome: 'stopped',
        details: { code: PIPELINE_MASKING_REFUSAL.fieldsUnseen },
      }),
    ]);
  });

  it('names every field the org hides at once, whichever object each is on', async () => {
    const { update } = orgOf({
      Contact: { shown: ['FirstName'], rows: CONTACTS },
      Lead: { shown: ['Email'], rows: LEADS },
    });

    await request('dataops:anonymize', {});

    expect(posted('dataops:error')[0].payload.fieldsNotFound).toEqual([
      { objectApiName: 'Contact', fieldApiName: 'Birthdate' },
      { objectApiName: 'Lead', fieldApiName: 'Phone' },
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('says so of an object none of whose fields can be masked, and writes nothing on the others', async () => {
    // Every rule of Lead hidden: its rows were read and counted as processed,
    // with nothing written over them.
    const { update } = orgOf({
      Contact: { shown: ['FirstName', 'Birthdate'], rows: CONTACTS },
      Lead: { shown: [], rows: LEADS },
    });

    await request('dataops:anonymize', {});

    const { payload } = posted('dataops:error')[0];
    expect(payload).toMatchObject({
      code: PIPELINE_MASKING_REFUSAL.fieldsUnseen,
      objectsNotCovered: ['Lead'],
      fieldsNotFound: [
        { objectApiName: 'Lead', fieldApiName: 'Email' },
        { objectApiName: 'Lead', fieldApiName: 'Phone' },
      ],
    });
    expect(String(payload.message)).toContain('No field of Lead can be masked.');
    expect(String(payload.message)).toContain(WHAT_TO_DO);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an object whose rules mask nothing in this org, which a run called a success', async () => {
    // A template of contact rules asked for Account derives rules for person
    // accounts alone, and this org has none: every account was counted as
    // processed, with nothing written.
    new AnonymizationTemplateStore(store).save({
      id: 'tpl-saved-contacts',
      name: 'Contacts',
      description: '',
      complianceFramework: 'custom',
      rules: [{ fieldPattern: 'Contact.LastName', ruleType: 'fake', description: '' }],
      saved: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const { update } = orgOf({
      Account: { shown: ['Name'], rows: [{ Id: '001000000000001', Name: 'Acme' }] },
    });

    await request('dataops:anonymize', { templateId: 'tpl-saved-contacts', objects: ['Account'] });

    expect(posted('dataops:error')[0].payload).toMatchObject({
      code: PIPELINE_MASKING_REFUSAL.masksNothing,
      fieldsNotFound: [],
      objectsNotCovered: ['Account'],
      message: expect.stringContaining('masks no field of Account'),
    });
    // No access would change it: the template names no field of Account.
    const message = String(posted('dataops:error')[0].payload.message);
    expect(message).toContain('Choose an object its rules name, or another template.');
    expect(message).not.toContain('access');
    expect(posted('dataops:anonymize:response')).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a template with no rule for the object it is asked to mask, which a run called a success', async () => {
    const { update } = orgOf({ Case: { shown: ['Subject'], rows: [{ Id: '500000000000001' }] } });

    await request('dataops:anonymize', { objects: ['Case'] });

    expect(posted('dataops:error')[0].payload).toMatchObject({
      code: PIPELINE_MASKING_REFUSAL.masksNothing,
      objectsNotCovered: ['Case'],
      message: expect.stringContaining('has no rule for Case'),
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('masks an org whose hidden field is on an object with no row: nothing there is left in clear', async () => {
    const { conn, update } = orgOf({
      Contact: { shown: ['FirstName', 'Birthdate'], rows: CONTACTS },
      Lead: { shown: [], rows: [] },
    });

    await request('dataops:anonymize', {});

    expect(posted('dataops:error')).toEqual([]);
    expect(posted('dataops:anonymize:response')[0].payload).toMatchObject({
      status: 'success',
      recordsProcessed: 2,
      recordsNotMasked: 0,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(conn.describe.mock.calls.map(([name]) => name)).not.toContain('Lead');
  });

  it('asks the org for each object once, a snapshot, its access and its rows reading the same answer', async () => {
    const { conn } = orgOf({
      Contact: { shown: ['FirstName', 'Birthdate'], rows: CONTACTS },
      Lead: { shown: ['Email', 'Phone'], rows: LEADS },
    });

    await request('dataops:anonymize', { snapshot: true });

    expect(posted('dataops:anonymize:response')[0].payload).toMatchObject({ status: 'success' });
    // Account too, once, for whether the org has person accounts.
    expect(conn.describe.mock.calls.map(([name]) => name).sort()).toEqual([
      'Account',
      'Contact',
      'Lead',
    ]);
  });

  it('fails aloud on a field hidden while the guard is asked, rather than mask the rest of a run it checked', async () => {
    // What was checked is what is masked: a describe read again as the run
    // reached the object would leave the field out without a word.
    const contact: FakeObject = { shown: ['FirstName', 'Birthdate'], rows: CONTACTS };
    const { update } = orgOf({ Contact: contact, Lead: { shown: ['Email', 'Phone'], rows: [] } });
    const check = guard.check.bind(guard);
    vi.spyOn(guard, 'check').mockImplementation((asked) => {
      contact.shown = ['FirstName'];
      return check(asked);
    });

    await request('dataops:anonymize', {});

    expect(posted('dataops:anonymize:response')).toEqual([]);
    expect(posted('dataops:error')[0].payload.message).toContain('INVALID_FIELD');
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a resume as it refuses a run, and leaves what it would resume kept', async () => {
    const template = new AnonymizationTemplateStore(store)
      .list()
      .find((t) => t.id === 'tpl-saved-people');
    const objects = ['Contact', 'Lead'];
    const checkpoints = new MaskingCheckpointStore(store);
    const fingerprint = maskingFingerprint(template?.rules ?? [], objects, undefined);
    checkpoints.save({
      id: 'cp-1',
      orgId: 'org-1',
      templateId: 'tpl-saved-people',
      fingerprint,
      savedAt: '2026-11-01T00:00:00.000Z',
      objects: [{ objectApiName: 'Contact', done: false, refused: [] }],
    });
    const { update } = orgOf({
      Contact: { shown: ['FirstName'], rows: CONTACTS },
      Lead: { shown: ['Email', 'Phone'], rows: [] },
    });

    await request('dataops:anonymize', { resumeFrom: 'cp-1' });

    expect(posted('dataops:error')[0].payload.code).toBe(PIPELINE_MASKING_REFUSAL.fieldsUnseen);
    expect(update).not.toHaveBeenCalled();
    expect(checkpoints.load('org-1', 'tpl-saved-people', fingerprint)?.id).toBe('cp-1');
  });

  it('masks every rule of an object whatever the case its rules name it in, once', async () => {
    // `contact.Birthdate` is the field Salesforce reads as Contact.Birthdate:
    // asked for Contact, the run masked the first names alone and said success.
    new AnonymizationTemplateStore(store).save({
      id: 'tpl-saved-cases',
      name: 'Cases',
      description: '',
      complianceFramework: 'custom',
      rules: [
        { fieldPattern: 'Contact.FirstName', ruleType: 'nullify', description: '' },
        { fieldPattern: 'contact.Birthdate', ruleType: 'nullify', description: '' },
      ],
      saved: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const { update } = orgOf({ Contact: { shown: ['FirstName', 'Birthdate'], rows: CONTACTS } });

    for (const objects of [['Contact'], undefined]) {
      update.mockClear();
      await request('dataops:anonymize', {
        templateId: 'tpl-saved-cases',
        ...(objects ? { objects } : {}),
      });

      expect(posted('dataops:error')).toEqual([]);
      const sent = update.mock.calls.flatMap(([batch]) => batch);
      expect(sent).toEqual(
        CONTACTS.map((c) =>
          expect.objectContaining({ Id: c.Id, FirstName: null, Birthdate: null }),
        ),
      );
    }
  });

  describe('on the person accounts of Account', () => {
    /**
     * Field-level security of a person account's fields is its contact's: the
     * one that hides Birthdate from the user hides PersonBirthdate too, and
     * the describe of Account leaves it out as that of Contact leaves out
     * Birthdate.
     */
    const PERSON_SHOWN = [
      'IsPersonAccount',
      'Name',
      'FirstName',
      'LastName',
      'Phone',
      'PersonEmail',
      'PersonMailingStreet',
      'PersonMailingCity',
      'PersonMailingPostalCode',
    ];
    const CONTACT_SHOWN = [
      'FirstName',
      'LastName',
      'Email',
      'Phone',
      'MailingStreet',
      'MailingCity',
      'MailingPostalCode',
      'Description',
    ];
    const PERSONS = [
      {
        Id: '001000000000001',
        IsPersonAccount: true,
        Name: 'Ada Lovelace',
        FirstName: 'Ada',
        LastName: 'Lovelace',
        Phone: '+1 415 555 0101',
        PersonEmail: 'ada@example.org',
        PersonMailingStreet: '12 St James Square',
        PersonMailingCity: 'London',
        PersonMailingPostalCode: 'SW1Y 4JH',
        PersonBirthdate: '1815-12-10',
      },
    ];

    it('refuses a field of a person account the org hides, asked for Account alone, before a record is written', async () => {
      // Contact is not in the run, so nothing named Contact.Birthdate: the
      // rule for PersonBirthdate was dropped without a word, the rest of the
      // person accounts masked, the run a success and every birthdate in clear.
      const { update, query } = orgOf({
        Account: { shown: PERSON_SHOWN, rows: PERSONS },
        Contact: { shown: CONTACT_SHOWN, rows: [] },
      });

      await request('dataops:anonymize', {
        templateId: 'tpl-ccpa-california',
        objects: ['Account'],
        snapshot: true,
      });

      const [refused] = posted('dataops:error');
      expect(refused?.payload).toMatchObject({
        code: PIPELINE_MASKING_REFUSAL.fieldsUnseen,
        fieldsNotFound: [{ objectApiName: 'Account', fieldApiName: 'PersonBirthdate' }],
        objectsNotCovered: [],
      });
      expect(String(refused?.payload.message)).toContain(
        'masks Account.PersonBirthdate, which the org does not show',
      );
      expect(posted('dataops:anonymize:response')).toEqual([]);
      expect(update).not.toHaveBeenCalled();
      expect(query.mock.calls.every(([soql]) => String(soql).startsWith('SELECT COUNT()'))).toBe(
        true,
      );
    });

    it('names that field in the preview, as Apply is then refused for it', async () => {
      orgOf({
        Account: { shown: PERSON_SHOWN, rows: PERSONS },
        Contact: { shown: CONTACT_SHOWN, rows: [] },
      });

      await request(
        'dataops:anonymize:preview',
        { templateId: 'tpl-ccpa-california', objects: ['Account'] },
        'preview-1',
      );

      expect(posted('dataops:anonymize:preview:response')[0].payload.fieldsNotFound).toEqual([
        { objectApiName: 'Account', fieldApiName: 'PersonBirthdate' },
      ]);
    });

    it('masks a person account whose contact field the platform gives no person account field, as before', async () => {
      // A contact's description is shown, and a person account has no
      // PersonDescription: nothing hides it, there is none to mask.
      new AnonymizationTemplateStore(store).save({
        id: 'tpl-saved-notes',
        name: 'Notes',
        description: '',
        complianceFramework: 'custom',
        rules: [
          { fieldPattern: 'Contact.LastName', ruleType: 'fake', description: '' },
          { fieldPattern: 'Contact.Description', ruleType: 'nullify', description: '' },
        ],
        saved: true,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
      const { update } = orgOf({
        Account: { shown: PERSON_SHOWN, rows: PERSONS },
        Contact: { shown: CONTACT_SHOWN, rows: [] },
      });

      await request('dataops:anonymize', { templateId: 'tpl-saved-notes', objects: ['Account'] });

      expect(posted('dataops:error')).toEqual([]);
      expect(posted('dataops:anonymize:response')[0].payload).toMatchObject({
        status: 'success',
      });
      expect(update).toHaveBeenCalled();
    });
  });

  describe('its preview, before the click', () => {
    it('names a field the user may read and not edit, and an object it may not edit, which Apply is then refused for', async () => {
      // A read-only field passed Preview, the dry run and an environment's
      // plan, and Apply was then refused, CRUD_FLS_DENIED.
      const { update } = orgOf({
        Contact: { shown: ['FirstName', 'Birthdate'], readOnly: ['Birthdate'], rows: CONTACTS },
        Lead: { shown: ['Email', 'Phone'], editable: false, rows: LEADS },
      });

      await request('dataops:anonymize:preview', {}, 'preview-1');
      await request('dataops:anonymize', {}, 'apply-1');

      const preview = posted('dataops:anonymize:preview:response')[0].payload;
      expect(
        (preview.objects as Array<{ objectApiName: string; writeDenied?: unknown }>).map((o) => [
          o.objectApiName,
          o.writeDenied,
        ]),
      ).toEqual([
        ['Contact', { deniedFields: ['Birthdate'] }],
        ['Lead', { deniedFields: [] }],
      ]);
      expect(preview.fieldsNotFound).toEqual([]);
      const refused = posted('dataops:error')[0].payload;
      expect(refused.code).toBe('CRUD_FLS_DENIED');
      expect(String(refused.message)).toContain(
        "fields [Birthdate] of 'Contact' are not updateable",
      );
      expect(String(refused.message)).toContain("User lacks 'update' permission on 'Lead'");
      expect(update).not.toHaveBeenCalled();
    });

    it('names no access on an object with no row, as Apply refuses nothing for it', async () => {
      orgOf({
        Contact: { shown: ['FirstName', 'Birthdate'], rows: CONTACTS },
        Lead: { shown: ['Email', 'Phone'], readOnly: ['Email'], rows: [] },
      });

      await request('dataops:anonymize:preview', {}, 'preview-1');

      const preview = posted('dataops:anonymize:preview:response')[0].payload;
      expect((preview.objects as Array<{ writeDenied?: unknown }>).some((o) => o.writeDenied)).toBe(
        false,
      );
    });

    it('names what Apply is then refused for, field for field', async () => {
      const org = {
        Contact: { shown: ['FirstName'], rows: CONTACTS },
        Lead: { shown: [], rows: LEADS },
      };
      orgOf(org);

      await request('dataops:anonymize:preview', {}, 'preview-1');
      await request('dataops:anonymize', {}, 'apply-1');

      const preview = posted('dataops:anonymize:preview:response')[0].payload;
      const refused = posted('dataops:error')[0].payload;
      expect(preview.fieldsNotFound).toEqual(refused.fieldsNotFound);
      expect(refused.fieldsNotFound).toHaveLength(3);
      const notCovered = (preview.objects as Array<{ objectApiName: string; notCovered?: true }>)
        .filter((o) => o.notCovered)
        .map((o) => o.objectApiName);
      expect(notCovered).toEqual(refused.objectsNotCovered);
      expect(notCovered).toEqual(['Lead']);
    });

    it('names nothing on an object with no row, as Apply refuses nothing for it', async () => {
      const org = {
        Contact: { shown: ['FirstName', 'Birthdate'], rows: CONTACTS },
        Lead: { shown: [], rows: [] },
      };
      orgOf(org);

      await request('dataops:anonymize:preview', {}, 'preview-1');
      await request('dataops:anonymize', {}, 'apply-1');

      const preview = posted('dataops:anonymize:preview:response')[0].payload;
      expect(preview.fieldsNotFound).toEqual([]);
      expect(
        (preview.objects as Array<{ objectApiName: string; notCovered?: true }>).some(
          (o) => o.notCovered,
        ),
      ).toBe(false);
      expect(posted('dataops:error')).toEqual([]);
      expect(posted('dataops:anonymize:response')[0].payload).toMatchObject({ status: 'success' });
    });

    it('marks an object whose rules mask nothing, which Apply refuses with no field to name', async () => {
      new AnonymizationTemplateStore(store).save({
        id: 'tpl-saved-contacts',
        name: 'Contacts',
        description: '',
        complianceFramework: 'custom',
        rules: [{ fieldPattern: 'Contact.LastName', ruleType: 'fake', description: '' }],
        saved: true,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
      orgOf({ Account: { shown: ['Name'], rows: [{ Id: '001000000000001', Name: 'Acme' }] } });

      await request(
        'dataops:anonymize:preview',
        { templateId: 'tpl-saved-contacts', objects: ['Account'] },
        'preview-1',
      );

      expect(posted('dataops:anonymize:preview:response')[0].payload).toMatchObject({
        fieldsNotFound: [],
        objects: [{ objectApiName: 'Account', notCovered: true }],
      });
    });
  });
});
