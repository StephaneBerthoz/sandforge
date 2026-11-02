import { describe, it, expect, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig, SyncWriteCheck } from '@sandforge/shared';
import { SyncOrchestrator, type SyncOrchestratorDeps } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import { unwritableRefusal, type SyncWriteGate } from './SyncRunGate.js';

/*
 * An upsert of accounts on Name, run between two scratch orgs: its dry run
 * said read 1, insert 1, refused 0, exit 0; the run ended in failure, nothing
 * written, each record refused with the sentence the fake target below gives.
 * The fields carry what the org's describe says of them: the Id is idLookup
 * on every object, Account.Name is not, an External ID is both. Contact.Email
 * is idLookup and no External ID, and a real run upserted on it.
 */

const ACCOUNT_FIELDS = [
  { name: 'Id', createable: false, type: 'id', idLookup: true, externalId: false },
  { name: 'Name', createable: true, type: 'string', idLookup: false, externalId: false },
  {
    name: 'Legacy_Key__c',
    createable: true,
    type: 'string',
    idLookup: true,
    externalId: true,
  },
];

const CONTACT_FIELDS = [
  { name: 'Id', createable: false, type: 'id', idLookup: true, externalId: false },
  { name: 'LastName', createable: true, type: 'string', idLookup: false, externalId: false },
  { name: 'Email', createable: true, type: 'email', idLookup: true, externalId: false },
];

const FIELDS: Readonly<Record<string, typeof ACCOUNT_FIELDS>> = {
  Account: ACCOUNT_FIELDS,
  Contact: CONTACT_FIELDS,
};

const describeTarget = async (objectApiName: string) =>
  targetWriteFieldsOf({
    name: objectApiName,
    createable: true,
    updateable: true,
    fields: FIELDS[objectApiName] ?? [],
  });

/** Upserts as the org answers them: a key the describe does not give refuses every record. */
function targetOrg() {
  const upsert = vi.fn(
    async (objectApiName: string, key: string, rows: Array<Record<string, unknown>>) => {
      const field = FIELDS[objectApiName]?.find((each) => each.name === key);
      const takes = field?.idLookup === true || field?.externalId === true;
      return rows.map((_row, index): OperationOutcome =>
        takes
          ? { id: `001xx000000000${index}AAA`, success: true, errors: [], created: true }
          : {
              success: false,
              errors: [
                `Field name provided, ${key} does not match an External ID, Salesforce Id, or ` +
                  `indexed field for ${objectApiName}`,
              ],
            },
      );
    },
  );
  return { upsert };
}

function objectConfig(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    externalIdField: 'Name',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...overrides,
  };
}

function config(object: SyncObjectConfig = objectConfig()): SyncConfig {
  return {
    id: 'config-upsert-key',
    name: 'Accounts',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [object],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const CHECK: SyncWriteCheck = {
  objects: [],
  total: 0,
  alreadyCopied: 0,
  storage: { verdict: 'fits', estimateMB: 0 },
  emails: [],
  verdict: 'writes',
};

function orchestrator(
  target: ReturnType<typeof targetOrg>,
  rows: Array<Record<string, unknown>>,
  extra: Partial<SyncOrchestratorDeps> = {},
): SyncOrchestrator {
  const unused = async (): Promise<OperationOutcome[]> => [];
  return new SyncOrchestrator({
    dataSync: new DataSync({
      insert: unused,
      update: unused,
      upsert: (object, key, records) => target.upsert(object, key, records),
      delete: unused,
      describeTargetFields: describeTarget,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: async () => rows.map((row) => ({ ...row })),
    queryTarget: async () => [],
    findInTarget: async () => new Map<string, number>(),
    describeTargetFields: describeTarget,
    ...extra,
  });
}

const ACCOUNT = { Id: '001000000000001AAA', Name: 'Northwind', Legacy_Key__c: 'n-1' };

describe('the key of an upsert', () => {
  it('counts every record refused in a simulation, naming the field, where it counted them inserted', async () => {
    const target = targetOrg();

    const simulated = await orchestrator(target, [ACCOUNT]).simulate(config());

    expect(simulated.objects[0]).toMatchObject({ read: 1, insert: 0, refused: 1 });
    expect(simulated.objects[0]?.notes.join(' ')).toContain(
      'The upsert of Account matches on Name, which the target org does not match an upsert on',
    );
    expect(target.upsert).not.toHaveBeenCalled();
  });

  it('holds a simulation to the object the gate is told of, the field beside it', async () => {
    const measure = vi.fn<SyncWriteGate['measure']>(async () => CHECK);
    const writeGate: SyncWriteGate = { measure, hold: vi.fn() };

    await orchestrator(targetOrg(), [ACCOUNT], {
      writeGate,
      countSource: async () => 1,
    }).simulate(config());

    expect(measure.mock.calls[0]?.[0].unwritable).toEqual([
      expect.objectContaining({ objectApiName: 'Account', why: 'notAKey', key: 'Name' }),
    ]);
  });

  it('writes nothing in a run, every record refused in its own words before a call to the org', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, [ACCOUNT]).execute(config());

    expect(target.upsert).not.toHaveBeenCalled();
    expect(result.objectResults[0]).toMatchObject({ success: 0, failed: 1 });
    expect(result.objectResults[0]?.errors[0]).toContain('matches on Name');
  });

  it.each([
    ['an External ID', 'Account', 'Legacy_Key__c', ACCOUNT],
    [
      'an idLookup field that is no External ID',
      'Contact',
      'Email',
      { Id: '003000000000001AAA', LastName: 'Ann', Email: 'ann@example.com' },
    ],
    ['the Id', 'Account', 'Id', ACCOUNT],
  ])('lets through %s', async (_what, objectApiName, externalIdField, row) => {
    const access = await orchestrator(targetOrg(), [row]).simulate(
      config(objectConfig({ objectApiName, externalIdField })),
    );

    expect(access.objects[0]).toMatchObject({ refused: 0 });
  });

  it('takes no key for the Id, as a run sends it', async () => {
    const noKey = objectConfig();
    delete noKey.externalIdField;

    const simulated = await orchestrator(targetOrg(), [ACCOUNT]).simulate(config(noKey));

    expect(simulated.objects[0]).toMatchObject({ refused: 0 });
  });

  it('holds no insert or update to a key it does not send', async () => {
    const simulated = await orchestrator(targetOrg(), [ACCOUNT]).simulate(
      config(objectConfig({ operation: 'insert' })),
    );

    expect(simulated.objects[0]).toMatchObject({ refused: 0 });
  });

  it('asks nothing of a describe that does not say, which is not a refusal of the key', async () => {
    const silent = async (objectApiName: string) =>
      targetWriteFieldsOf({
        name: objectApiName,
        fields: [{ name: 'Name', createable: true, type: 'string' }],
      });

    const simulated = await orchestrator(targetOrg(), [ACCOUNT], {
      describeTargetFields: silent,
    }).simulate(config());

    expect(simulated.objects[0]).toMatchObject({ refused: 0 });
  });
});

describe('what a simulation counts against what the gate counted', () => {
  /** A gate that counted what it is told, as a run's counts the source's rows. */
  const gate = (): SyncWriteGate => ({
    measure: async (counted) => ({
      ...CHECK,
      objects: counted.objects.map(({ objectApiName, rows }) => ({ objectApiName, rows })),
      total: counted.objects.reduce((sum, object) => sum + object.rows, 0),
    }),
    hold: vi.fn(),
  });

  it('says what of the count the run would not write, the rows refused for their fields among them', async () => {
    const rows = [1, 2, 3, 4].map((n) => ({
      Id: `003000000000${n}AAAAAA`.slice(0, 18),
      LastName: n <= 2 ? `Ann ${n}` : null,
      Email: `ann${n}@example.com`,
    }));
    const target = targetOrg();
    const required = async (objectApiName: string) =>
      targetWriteFieldsOf({
        name: objectApiName,
        createable: true,
        updateable: true,
        fields: CONTACT_FIELDS.map((field) =>
          field.name === 'LastName' ? { ...field, nillable: false } : field,
        ),
      });

    const simulated = await orchestrator(target, rows, {
      writeGate: gate(),
      describeTargetFields: required,
      countSource: async () => 4,
    }).simulate(config(objectConfig({ objectApiName: 'Contact', externalIdField: 'Email' })));

    expect(simulated.writeCheck).toMatchObject({ total: 4, notWritten: 2 });
    expect(simulated.objects[0]).toMatchObject({ insert: 2, refused: 2 });
  });

  it('says nothing when it would write all it counted', async () => {
    const simulated = await orchestrator(targetOrg(), [ACCOUNT], {
      writeGate: gate(),
      countSource: async () => 1,
    }).simulate(config(objectConfig({ externalIdField: 'Legacy_Key__c' })));

    expect(simulated.writeCheck).toMatchObject({ total: 1 });
    expect(simulated.writeCheck).not.toHaveProperty('notWritten');
  });
});

describe('unwritableRefusal', () => {
  it('names the key, and says what lifts it: no access does', () => {
    const said = unwritableRefusal(
      [{ objectApiName: 'Account', rows: 3, why: 'notAKey', key: 'Name' }],
      'TGT',
    );

    expect(said).toContain(
      'Account (3 records): its upsert matches on Name, neither an External ID nor an idLookup field in TGT',
    );
    expect(said).toContain('Leave it out of the run, or match on an External ID field of TGT.');
    expect(said).not.toContain('access');
  });
});
