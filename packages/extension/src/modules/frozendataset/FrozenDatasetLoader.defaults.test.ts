import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import {
  FrozenDatasetLoader,
  type FrozenDatasetLoaderDeps,
  type FrozenLoadOptions,
} from './FrozenDatasetLoader.js';
import type { FrozenDataset } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadConfig,
  TargetFieldDescribe,
  TargetObjectDescribe,
} from './loadTypes.js';

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-defaults-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
  }
});

interface DmlCall {
  op: 'insert' | 'update' | 'delete';
  objectApiName: string;
  payload: unknown;
}

/** Writer mock: every DML succeeds, with ids of its own. */
function makeWriter(calls: DmlCall[]): FrozenDmlWriter {
  let counter = 0;
  return {
    insert: vi.fn(async (_org: string, objectApiName: string, records: unknown[]) => {
      calls.push({ op: 'insert', objectApiName, payload: records });
      return records.map(() => ({
        id: `REAL-${objectApiName}-${++counter}`,
        success: true,
        errors: [],
      }));
    }),
    update: vi.fn(
      async (_org: string, objectApiName: string, records: Array<Record<string, unknown>>) => {
        calls.push({ op: 'update', objectApiName, payload: records });
        return records.map((r) => ({ id: String(r.Id), success: true, errors: [] }));
      },
    ),
    delete: vi.fn(async (_org: string, objectApiName: string, ids: string[]) => {
      calls.push({ op: 'delete', objectApiName, payload: ids });
      return ids.map((id) => ({ id, success: true, errors: [] }));
    }),
  };
}

/** A writer any call to which fails the test: a preview writes nothing. */
function refusingWriter(): FrozenDmlWriter {
  const refuse = async (): Promise<never> => {
    throw new Error('a preview wrote to the target');
  };
  return { insert: vi.fn(refuse), update: vi.fn(refuse), delete: vi.fn(refuse) };
}

function field(overrides: Partial<TargetFieldDescribe>): TargetFieldDescribe {
  return {
    name: 'Field__c',
    type: 'string',
    createable: true,
    nillable: true,
    defaultedOnCreate: false,
    ...overrides,
  };
}

function dataset(objects: FrozenDataset['objects']): FrozenDataset {
  return { datasetVersion: '1.0.0', objects, recordTypes: {}, personContactSidecar: [] };
}

function makeDeps(
  writer: FrozenDmlWriter,
  sasDir: string,
  describes: Record<string, TargetObjectDescribe>,
  config: FrozenLoadConfig,
  query: (orgId: string, soql: string) => Promise<Array<Record<string, unknown>>> = async () => [],
): FrozenDatasetLoaderDeps {
  return {
    orgAccess: {
      query: vi.fn(query),
      describe: vi.fn(async (_org: string, objectApiName: string) => {
        const describe = describes[objectApiName];
        if (!describe) throw new Error(`sObject ${objectApiName} not found`);
        return describe;
      }),
      picklistValues: vi.fn(async () => []),
    },
    writer,
    guard: new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: { resolveByDeveloperName: vi.fn(async () => '012RT-RESOLVED') },
    mappingStore: new SasReferenceIdMappingStore(sasDir, { guard: new SasPathGuard(repoRoot) }),
    config,
    sasGuard: new SasPathGuard(repoRoot),
  };
}

function options(
  data: FrozenDataset,
  sasDir: string,
  overrides?: Partial<FrozenLoadOptions>,
): FrozenLoadOptions {
  return { orgId: '00D-target', orgTier: 'development', dataset: data, sasDir, ...overrides };
}

/** The values of `fieldName` the load sent for `objectApiName`, in the order it sent them. */
function sent(calls: DmlCall[], objectApiName: string, fieldName: string): unknown[] {
  return calls
    .filter((c) => c.op === 'insert' && c.objectApiName === objectApiName)
    .flatMap((c) => (c.payload as Array<Record<string, unknown>>).map((r) => r[fieldName]));
}

/** Two territories whose names the rules cleared, and a target describing the name as given. */
function territories(name: Partial<TargetFieldDescribe>): {
  data: FrozenDataset;
  describes: Record<string, TargetObjectDescribe>;
} {
  return {
    data: dataset([
      {
        objectApiName: 'ServiceTerritory',
        records: [
          { referenceId: 'ServiceTerritory-000001', fields: { Name: '', IsActive: true } },
          { referenceId: 'ServiceTerritory-000002', fields: { Name: '', IsActive: true } },
        ],
      },
    ]),
    describes: {
      ServiceTerritory: {
        name: 'ServiceTerritory',
        fields: [
          field({ name: 'Name', nillable: false, ...name }),
          field({ name: 'IsActive', type: 'boolean' }),
        ],
      },
    },
  };
}

describe('FrozenDatasetLoader — a declared default for a field the target keeps unique', () => {
  it('gives each record a value of its own, its rank appended', async () => {
    const { data, describes } = territories({ unique: true });
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(calls), sasDir, describes, {
        requiredFieldDefaults: { 'ServiceTerritory.Name': 'Frozen territory' },
      }),
    ).load(options(data, sasDir));

    expect(sent(calls, 'ServiceTerritory', 'Name')).toEqual([
      'Frozen territory 1',
      'Frozen territory 2',
    ]);
    expect(report.requiredDefaults).toEqual([
      {
        objectApiName: 'ServiceTerritory',
        field: 'Name',
        value: 'Frozen territory',
        affectedRecords: 2,
        perRecord: 'unique',
      },
    ]);
  });

  it("numbers a default given for the object's name, which its describe does not call unique", async () => {
    // Run on a client sandbox, the second territory given the same name was
    // refused, "That name is already taken", the describe saying nothing.
    const { data, describes } = territories({ nameField: true });
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(calls), sasDir, describes, {
        requiredFieldDefaults: { 'ServiceTerritory.Name': 'Frozen territory' },
      }),
    ).load(options(data, sasDir));

    expect(sent(calls, 'ServiceTerritory', 'Name')).toEqual([
      'Frozen territory 1',
      'Frozen territory 2',
    ]);
    expect(report.requiredDefaults[0].perRecord).toBe('name');
  });

  it('replaces the tokens the value carries, per record, and appends nothing', async () => {
    const { data, describes } = territories({ unique: true });
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(calls), sasDir, describes, {
        requiredFieldDefaults: { 'ServiceTerritory.Name': 'T{n} of {referenceId}' },
      }),
    ).load(options(data, sasDir));

    expect(sent(calls, 'ServiceTerritory', 'Name')).toEqual([
      'T1 of ServiceTerritory-000001',
      'T2 of ServiceTerritory-000002',
    ]);
    expect(report.requiredDefaults[0].perRecord).toBe('token');
  });

  it('gives every record the value declared for a field neither unique nor a name', async () => {
    const { data, describes } = territories({});
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(calls), sasDir, describes, {
        requiredFieldDefaults: { 'ServiceTerritory.Name': 'Frozen territory' },
      }),
    ).load(options(data, sasDir));

    expect(sent(calls, 'ServiceTerritory', 'Name')).toEqual([
      'Frozen territory',
      'Frozen territory',
    ]);
    expect(report.requiredDefaults[0]).not.toHaveProperty('perRecord');
  });

  it('ranks a record among its object in the whole dataset, whatever else the load leaves out', async () => {
    // The first territory found by its key: the second keeps rank 2, the
    // value it gets on a load that writes both.
    const { data, describes } = territories({ unique: true });
    data.objects[0].records[0].fields.ExternalId__c = 'territory-north';
    data.objects[0].records[1].fields.ExternalId__c = 'territory-south';
    describes.ServiceTerritory.fields.push(field({ name: 'ExternalId__c' }));
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();

    await new FrozenDatasetLoader(
      makeDeps(
        makeWriter(calls),
        sasDir,
        describes,
        {
          identityKeys: { ServiceTerritory: ['ExternalId__c'] },
          requiredFieldDefaults: { 'ServiceTerritory.Name': 'Frozen territory' },
        },
        async (_org, soql) =>
          soql.startsWith('SELECT Id, ExternalId__c FROM ServiceTerritory')
            ? [{ Id: '0HhXX0000000OWNAAA', ExternalId__c: 'territory-north' }]
            : [],
      ),
    ).load(options(data, sasDir, { reload: true }));

    expect(sent(calls, 'ServiceTerritory', 'Name')).toEqual(['Frozen territory 2']);
  });

  it('says in the preview how each record gets its own value, and the first one', async () => {
    const { data, describes } = territories({ unique: true });
    const sasDir = makeTmpDir();

    const plan = await new FrozenDatasetLoader(
      makeDeps(refusingWriter(), sasDir, describes, {
        requiredFieldDefaults: { 'ServiceTerritory.Name': 'Frozen territory' },
      }),
    ).planLoad(options(data, sasDir));

    expect(plan.requiredDefaults).toEqual([
      {
        objectApiName: 'ServiceTerritory',
        field: 'Name',
        affectedRecords: 2,
        perRecord: 'unique',
        example: 'Frozen territory 1',
      },
    ]);
  });
});

/** Business hours, as a dataset whose cases name them carries them, and a case pointing at them. */
function businessHours(name: string): {
  data: FrozenDataset;
  describes: Record<string, TargetObjectDescribe>;
} {
  return {
    data: dataset([
      {
        objectApiName: 'BusinessHours',
        records: [
          {
            referenceId: 'BusinessHours-000001',
            fields: { Name: name, TimeZoneSidKey: 'Europe/Paris' },
          },
        ],
      },
      {
        objectApiName: 'Case',
        records: [
          {
            referenceId: 'Case-000001',
            fields: { Subject: 'Help', BusinessHoursId: 'BusinessHours-000001' },
          },
        ],
      },
    ]),
    describes: {
      BusinessHours: {
        name: 'BusinessHours',
        fields: [
          field({ name: 'Name', nillable: false, nameField: true }),
          field({ name: 'TimeZoneSidKey', nillable: false, type: 'picklist' }),
        ],
      },
      Case: {
        name: 'Case',
        fields: [
          field({ name: 'Subject' }),
          field({ name: 'BusinessHoursId', type: 'reference', referenceTo: ['BusinessHours'] }),
        ],
      },
    },
  };
}

/** A target holding business hours under the names given, answering a lookup by name. */
function holding(byName: Record<string, string>) {
  return async (_org: string, soql: string): Promise<Array<Record<string, unknown>>> => {
    if (!soql.startsWith('SELECT Id, Name FROM BusinessHours')) return [];
    return Object.entries(byName)
      .filter(([name]) => soql.includes(`Name = '${name}'`))
      .map(([name, id]) => ({ Id: id, Name: name }));
  };
}

describe('FrozenDatasetLoader — business hours, which the platform never deletes', () => {
  it('are linked by name to those the target holds on a load without Reload, none inserted', async () => {
    // Every org holds business hours of its own named Default.
    const { data, describes } = businessHours('Default');
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();

    const report = await new FrozenDatasetLoader(
      makeDeps(
        makeWriter(calls),
        sasDir,
        describes,
        {},
        holding({ Default: '01mXX0000000DEFAAA' }),
      ),
    ).load(options(data, sasDir));

    expect(calls.filter((c) => c.objectApiName === 'BusinessHours')).toEqual([]);
    expect(report.perObject.find((o) => o.objectApiName === 'BusinessHours')?.reused).toBe(1);
    expect(sent(calls, 'Case', 'BusinessHoursId')).toEqual(['01mXX0000000DEFAAA']);
  });

  it('are matched by the name the declared default gives them when the rules cleared it', async () => {
    // What the load would write: the same name from one load to the next.
    const { data, describes } = businessHours('');
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();
    const deps = makeDeps(
      makeWriter(calls),
      sasDir,
      describes,
      { requiredFieldDefaults: { 'BusinessHours.Name': 'Frozen hours' } },
      holding({ 'Frozen hours 1': '01mXX0000000FRZAAA' }),
    );

    const report = await new FrozenDatasetLoader(deps).load(options(data, sasDir));

    expect(calls.filter((c) => c.objectApiName === 'BusinessHours')).toEqual([]);
    expect(report.requiredDefaults).toEqual([]);
    expect(sent(calls, 'Case', 'BusinessHoursId')).toEqual(['01mXX0000000FRZAAA']);
  });

  it('are inserted with the numbered default name when the target holds none of that name', async () => {
    const { data, describes } = businessHours('');
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();

    await new FrozenDatasetLoader(
      makeDeps(makeWriter(calls), sasDir, describes, {
        requiredFieldDefaults: { 'BusinessHours.Name': 'Frozen hours' },
      }),
    ).load(options(data, sasDir));

    expect(sent(calls, 'BusinessHours', 'Name')).toEqual(['Frozen hours 1']);
  });

  it('are found again by a reload and kept as created, neither purged nor inserted again', async () => {
    const { data, describes } = businessHours('');
    const config = { requiredFieldDefaults: { 'BusinessHours.Name': 'Frozen hours' } };
    const sasDir = makeTmpDir();
    const first: DmlCall[] = [];
    await new FrozenDatasetLoader(makeDeps(makeWriter(first), sasDir, describes, config)).load(
      options(data, sasDir),
    );
    const inserted = 'REAL-BusinessHours-1';

    const calls: DmlCall[] = [];
    const report = await new FrozenDatasetLoader(
      makeDeps(
        makeWriter(calls),
        sasDir,
        describes,
        config,
        holding({ 'Frozen hours 1': inserted }),
      ),
    ).load(options(data, sasDir, { reload: true }));

    expect(calls.filter((c) => c.objectApiName === 'BusinessHours')).toEqual([]);
    expect(report.purge.failures).toEqual([]);
    expect(report.purge).not.toHaveProperty('keptByThePlatform');
    const [last] = await new SasReferenceIdMappingStore(sasDir, {
      guard: new SasPathGuard(repoRoot),
    }).previousLoads();
    expect(last.created?.flatMap((o) => o.referenceIds)).toContain('BusinessHours-000001');
  });

  it("are left in place by a reload's purge that does not find them again, never counted failed", async () => {
    const { data, describes } = businessHours('Day shift');
    const sasDir = makeTmpDir();
    await new FrozenDatasetLoader(makeDeps(makeWriter([]), sasDir, describes, {})).load(
      options(data, sasDir),
    );
    // The dataset now holds other hours, and the target has the ones the first load wrote.
    data.objects[0].records[0].fields.Name = 'Night shift';

    const calls: DmlCall[] = [];
    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter(calls), sasDir, describes, {}),
    ).load(options(data, sasDir, { reload: true }));

    expect(calls.filter((c) => c.op === 'delete' && c.objectApiName === 'BusinessHours')).toEqual(
      [],
    );
    // The case the first load wrote is purged as any record.
    expect(report.purge.deleted).toEqual({ Case: 1 });
    expect(report.purge.failures).toEqual([]);
    expect(report.purge.keptByThePlatform).toEqual({ BusinessHours: 1 });
    expect(report.status).toBe('completed');
  });

  it('are deactivated by the purge instead when the configuration gives a field to do it by', async () => {
    const { data, describes } = businessHours('Day shift');
    const config = { undeletableObjects: { BusinessHours: 'IsActive' } };
    const sasDir = makeTmpDir();
    await new FrozenDatasetLoader(makeDeps(makeWriter([]), sasDir, describes, config)).load(
      options(data, sasDir),
    );
    data.objects[0].records[0].fields.Name = 'Night shift';

    const report = await new FrozenDatasetLoader(
      makeDeps(makeWriter([]), sasDir, describes, config),
    ).load(options(data, sasDir, { reload: true }));

    expect(report.purge.deactivated).toEqual({ BusinessHours: 1 });
    expect(report.purge).not.toHaveProperty('keptByThePlatform');
  });

  it('are counted in the preview of a reload as the purge would leave them', async () => {
    const { data, describes } = businessHours('Day shift');
    const sasDir = makeTmpDir();
    await new FrozenDatasetLoader(makeDeps(makeWriter([]), sasDir, describes, {})).load(
      options(data, sasDir),
    );
    data.objects[0].records[0].fields.Name = 'Night shift';

    const plan = await new FrozenDatasetLoader(
      makeDeps(refusingWriter(), sasDir, describes, {}),
    ).planLoad(options(data, sasDir, { reload: true }));

    expect(plan.keptByThePlatform).toEqual({ BusinessHours: 1 });
    expect(plan.perObject.find((o) => o.objectApiName === 'BusinessHours')?.toPurge).toBe(0);
  });

  it('are matched by the identity keys the configuration gives them instead of their name', async () => {
    const { data, describes } = businessHours('Default');
    data.objects[0].records[0].fields.Code__c = 'hours-main';
    describes.BusinessHours.fields.push(field({ name: 'Code__c' }));
    const calls: DmlCall[] = [];
    const sasDir = makeTmpDir();
    const query = vi.fn(async (_org: string, soql: string) =>
      soql.startsWith('SELECT Id, Code__c FROM BusinessHours')
        ? [{ Id: '01mXX0000000CODAAA', Code__c: 'hours-main' }]
        : [],
    );

    await new FrozenDatasetLoader(
      makeDeps(
        makeWriter(calls),
        sasDir,
        describes,
        { identityKeys: { BusinessHours: ['Code__c'] } },
        query,
      ),
    ).load(options(data, sasDir));

    expect(calls.filter((c) => c.objectApiName === 'BusinessHours')).toEqual([]);
    expect(query.mock.calls.map(([, soql]) => soql)).not.toContainEqual(
      expect.stringContaining('SELECT Id, Name FROM BusinessHours'),
    );
  });
});
