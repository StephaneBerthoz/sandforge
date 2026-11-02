/**
 * What a field mapping makes a run send, field by field: through the bridge's
 * parse of the configuration, the real orchestrator, mapping, transforms and
 * DataSync, against a target that answers as an org does — it takes the
 * fields its describe lets the user create, refuses a record without a field
 * it requires, and gives each record it takes an Id.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { FieldMapping, SyncConfig, SyncObjectConfig, TransformRule } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator';
import { DataSync, type OperationOutcome } from './DataSync';
import { FieldMappingService } from './FieldMapping';
import { TransformPipeline } from './TransformPipeline';
import { ConflictResolver } from './ConflictResolver';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields';
import { SfdmuImporter } from '../migration/SfdmuImporter';
import { syncConfigPayloadSchema } from '../../bridge/validatePayload';

type Row = Record<string, unknown>;

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (n: number): string => `001${String(n).padStart(12, '0')}AAA`;

/** The target's describe of Account, as jsforce returns it, reduced to what a write reads. */
const ACCOUNT: Parameters<typeof targetWriteFieldsOf>[0] = {
  name: 'Account',
  createable: true,
  updateable: true,
  fields: [
    { name: 'Id', type: 'id', createable: false },
    { name: 'Name', type: 'string', createable: true, nillable: false, length: 255 },
    { name: 'BillingCity', type: 'string', createable: true, nillable: true, length: 40 },
    { name: 'ShippingCity', type: 'string', createable: true, nillable: true, length: 40 },
    { name: 'Industry', type: 'picklist', createable: true, nillable: true },
    { name: 'NumberOfEmployees', type: 'int', createable: true, nillable: true, digits: 8 },
    { name: 'Phone', type: 'phone', createable: true, nillable: true },
    { name: 'Description', type: 'textarea', createable: true, nillable: true },
    { name: 'CreatedDate', type: 'datetime', createable: false },
  ],
};

/** The source's accounts, as a query returns them: the envelope, the Id, the system fields. */
const SOURCE: Row[] = [
  {
    attributes: { type: 'Account' },
    Id: fakeId(1),
    Name: 'acme',
    BillingCity: 'Lyon',
    ShippingCity: 'Paris',
    Industry: 'Technology',
    NumberOfEmployees: 250,
    Phone: '+33 1 00 00 00 01',
    Description: 'kept as typed',
    CreatedDate: '2026-10-01T09:00:00.000+0000',
  },
  {
    attributes: { type: 'Account' },
    Id: fakeId(2),
    Name: 'globex',
    BillingCity: null,
    ShippingCity: 'Nantes',
    Industry: null,
    NumberOfEmployees: null,
    Phone: null,
    Description: null,
    CreatedDate: '2026-10-01T09:00:00.000+0000',
  },
];

/** The fields the target requires on a record it creates. */
const REQUIRED = targetWriteFieldsOf(ACCOUNT)
  .fields!.filter((field) => field.createable && field.nillable === false)
  .map((field) => field.name);

/** A target org: records by Id, and every record each write sent it, in order. */
class MemoryTarget {
  readonly records = new Map<string, Row>();
  readonly sent: Row[] = [];
  private next = 1;

  describe = async (): Promise<TargetWriteFields> => targetWriteFieldsOf(ACCOUNT);

  /** What the target holds of each record it created, without its Id. */
  held(): Row[] {
    return [...this.records.values()].map(({ Id: _id, ...fields }) => fields);
  }

  dataSync(): DataSync {
    const unused = async (): Promise<never> => {
      throw new Error('not used');
    };
    return new DataSync({
      describeTargetFields: this.describe,
      insert: async (_object, records) =>
        records.map((record): OperationOutcome => {
          this.sent.push({ ...record });
          // As an org answers a record without a field it requires.
          const missing = REQUIRED.filter((field) => record[field] == null);
          if (missing.length > 0) {
            return {
              success: false,
              errors: [`REQUIRED_FIELD_MISSING: Required fields are missing: [${missing}]`],
            };
          }
          const id = fakeId(100 + this.next++);
          this.records.set(id, { ...record, Id: id });
          return { id, success: true, errors: [] };
        }),
      upsert: unused,
      update: unused,
      delete: unused,
    });
  }
}

function orchestrator(
  target: MemoryTarget,
  querySource = vi.fn(async (_org: string, _oc: SyncObjectConfig) =>
    SOURCE.map((row) => ({ ...row })),
  ),
): SyncOrchestrator {
  return new SyncOrchestrator({
    dataSync: target.dataSync(),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource,
    queryTarget: vi.fn(async () => []),
    describeTargetFields: target.describe,
    // The simulation asks the target which keys it holds: an insert asks none.
    findInTarget: vi.fn(async () => new Map<string, number>()),
  });
}

/** A configuration as the bridge takes it from the page, and parses it before the run. */
function throughTheBridge(config: Record<string, unknown>): SyncConfig {
  return syncConfigPayloadSchema.parse(config) as unknown as SyncConfig;
}

/** The Sync page's configuration of one insert of Account, with the mappings and rules given. */
function accountsWith(
  fieldMappings: FieldMapping[],
  transformRules: TransformRule[] = [],
): Record<string, unknown> {
  return {
    id: 'cfg-mappings',
    name: 'sync-from-ui',
    description: 'Sync from SandForge UI',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    // Emails and phone numbers as read: what is checked here is the mapping alone.
    keepContactPoints: true,
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        externalIdField: '',
        batchSize: 200,
        fieldMappings,
        transformRules,
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
  };
}

/** The fields of a source row the target lets a write carry, as read, but those named. */
function writableWithout(row: Row, ...left: string[]): Row {
  const creatable = targetWriteFieldsOf(ACCOUNT).creatable;
  return Object.fromEntries(
    Object.entries(row).filter(([field]) => creatable.has(field) && !left.includes(field)),
  );
}

describe('SyncOrchestrator — what a field mapping makes a run send', () => {
  it("writes an SFDMU export's one rename onto its target field, and every other field of every record as read", async () => {
    // The export's `BillingCity → ShippingCity` wrote ShippingCity alone: every
    // other field of every record was dropped, unsaid, and the target refused
    // both accounts for the Name they no longer carried.
    const reader = { readFile: async (path: string) => readFileSync(path, 'utf8') };
    const { config: imported } = await new SfdmuImporter(reader).import(
      join(__dirname, '..', 'migration', 'fixtures', 'export-rename.json'),
    );
    const config = throughTheBridge({
      ...imported,
      sourceOrgId: 'src-org',
      targetOrgId: 'tgt-org',
      keepContactPoints: true,
    });
    const target = new MemoryTarget();

    const result = await orchestrator(target).execute(config);

    expect(result.status).toBe('success');
    expect(result.objectResults[0]).toMatchObject({ success: 2, failed: 0 });
    // Field by field, for each record: BillingCity under ShippingCity, the
    // source's own ShippingCity under no name, Phone excluded by the export.
    expect(target.sent).toEqual([
      {
        Name: 'acme',
        ShippingCity: 'Lyon',
        Industry: 'Technology',
        NumberOfEmployees: 250,
        Description: 'kept as typed',
      },
      {
        Name: 'globex',
        ShippingCity: null,
        Industry: null,
        NumberOfEmployees: null,
        Description: null,
      },
    ]);
    expect(target.held()).toEqual(target.sent);
  });

  it('reads what the query of a real export filters: its WHERE reaches the read', async () => {
    // Sync never runs an export's query, and its filter was read from a `where`
    // key SFDMU does not have: the run read every account of the org.
    const reader = { readFile: async (path: string) => readFileSync(path, 'utf8') };
    const { config: imported } = await new SfdmuImporter(reader).import(
      join(__dirname, '..', 'migration', 'fixtures', 'published', 'object-sets', 'export.json'),
    );
    const querySource = vi.fn(async (_org: string, _oc: SyncObjectConfig) =>
      SOURCE.map((row) => ({ ...row })),
    );

    await orchestrator(new MemoryTarget(), querySource).execute(
      throughTheBridge({
        ...imported,
        objects: imported.objects.slice(0, 1),
        sourceOrgId: 'src-org',
        targetOrgId: 'tgt-org',
      }),
    );

    expect(querySource.mock.calls[0][1]).toMatchObject({
      objectApiName: 'Account',
      where: "Name LIKE '%Account To Insert%'",
    });
  });

  it('sends none of the real values of a field a real export fakes, and the target says what it lacks', async () => {
    // SFDMU writes a fake Name. Sync has none to write: copied as read, the
    // account's real name would reach the target where the export hid it.
    const reader = { readFile: async (path: string) => readFileSync(path, 'utf8') };
    const { config: imported } = await new SfdmuImporter(reader).import(
      join(__dirname, '..', 'migration', 'fixtures', 'published', 'mock-fields', 'export.json'),
    );
    const target = new MemoryTarget();

    const result = await orchestrator(target).execute(
      throughTheBridge({ ...imported, sourceOrgId: 'src-org', targetOrgId: 'tgt-org' }),
    );

    expect(target.sent.flatMap((record) => Object.keys(record))).not.toContain('Name');
    expect(result.objectResults[0]).toMatchObject({ success: 0, failed: 2 });
    expect(target.records.size).toBe(0);
  });

  it("counts the export's records as the run writes them in the simulation, none refused", async () => {
    // Simulated, each record carried ShippingCity alone and was counted
    // refused for the Name the target requires.
    const reader = { readFile: async (path: string) => readFileSync(path, 'utf8') };
    const { config: imported } = await new SfdmuImporter(reader).import(
      join(__dirname, '..', 'migration', 'fixtures', 'export-rename.json'),
    );
    const target = new MemoryTarget();

    const simulated = await orchestrator(target).simulate(
      throughTheBridge({
        ...imported,
        sourceOrgId: 'src-org',
        targetOrgId: 'tgt-org',
        keepContactPoints: true,
      }),
    );

    expect(simulated.error).toBeUndefined();
    expect(simulated.objects[0]).toMatchObject({
      objectApiName: 'Account',
      read: 2,
      insert: 2,
      refused: 0,
    });
    expect(target.sent).toEqual([]);
  });

  it("sends every field the page's mappings do not name, the one an Exclude names left out", async () => {
    const target = new MemoryTarget();

    const result = await orchestrator(target).execute(
      throughTheBridge(
        accountsWith([
          { sourceField: 'Description', targetField: 'BillingCity', type: 'rename' },
          { sourceField: 'Phone', targetField: 'Phone', type: 'exclude' },
        ]),
      ),
    );

    expect(result.status).toBe('success');
    expect(target.sent).toEqual([
      { ...writableWithout(SOURCE[0], 'Description', 'Phone'), BillingCity: 'kept as typed' },
      { ...writableWithout(SOURCE[1], 'Description', 'Phone'), BillingCity: null },
    ]);
  });

  it("applies a transform mapping's rule once, and leaves an empty field empty", async () => {
    // The mapping applied its rules, and the pipeline applied them again: a
    // prefix went on twice, and the mapping's own rules turned null into "".
    const target = new MemoryTarget();

    const result = await orchestrator(target).execute(
      throughTheBridge(
        accountsWith([
          {
            sourceField: 'Name',
            targetField: 'Name',
            type: 'transform',
            transformRules: [{ type: 'prefix', config: { prefix: 'X-' } }],
          },
          {
            sourceField: 'Description',
            targetField: 'Description',
            type: 'transform',
            transformRules: [{ type: 'uppercase', config: {} }],
          },
        ]),
      ),
    );

    expect(result.status).toBe('success');
    expect(target.sent).toEqual([
      { ...writableWithout(SOURCE[0]), Name: 'X-acme', Description: 'KEPT AS TYPED' },
      { ...writableWithout(SOURCE[1]), Name: 'X-globex', Description: null },
    ]);
  });
});

describe('SyncOrchestrator — a Regex replace whose pattern is no regular expression', () => {
  const badRule: TransformRule = {
    type: 'regex_replace',
    field: 'Description',
    config: { regex: '[a-', replace: '' },
  };

  it('is refused by the bridge as it parses the configuration, naming the rule, its object and field', () => {
    const objectRule = syncConfigPayloadSchema.safeParse(accountsWith([], [badRule]));
    const mappingRule = syncConfigPayloadSchema.safeParse(
      accountsWith([
        {
          sourceField: 'Phone',
          targetField: 'Phone',
          type: 'transform',
          transformRules: [{ type: 'regex_replace', config: { regex: '(' } }],
        },
      ]),
    );

    expect(objectRule.success).toBe(false);
    expect(objectRule.error?.issues.map((issue) => issue.message)).toEqual([
      'The rule Regex replace on Account.Description, "[a-" (Unterminated character class) ' +
        'has a pattern that is no regular expression: open the configuration and correct it, ' +
        'or remove the rule. Run, it would stop the run at that object before any of its ' +
        'records is written. The sync was not started.',
    ]);
    expect(mappingRule.success).toBe(false);
    expect(mappingRule.error?.issues[0]?.message).toContain(
      'The rule Regex replace on Account.Phone, "(" (Unterminated group)',
    );
  });

  it('is refused by the engine before it reads anything, whoever calls it, and nothing is written', async () => {
    // Run, it threw JavaScript's own SyntaxError at the first record, which
    // stopped the run at Account with words naming neither rule nor object.
    const target = new MemoryTarget();
    const querySource = vi.fn(async () => SOURCE.map((row) => ({ ...row })));
    const engine = orchestrator(target, querySource);
    const parsed = throughTheBridge(accountsWith([]));
    const config: SyncConfig = {
      ...parsed,
      objects: [{ ...parsed.objects[0], transformRules: [badRule] }],
    };

    await expect(engine.execute(config)).rejects.toMatchObject({
      name: 'SyncRunRefused',
      code: 'TRANSFORM_RULE_BAD_PATTERN',
      message: expect.stringMatching(
        /^The rule Regex replace on Account\.Description, "\[a-" \(Unterminated character class\) has a pattern that is no regular expression: .* Nothing was read or written\.$/,
      ),
    });
    await expect(engine.simulate(config)).rejects.toThrow(
      'The rule Regex replace on Account.Description, "[a-"',
    );
    expect(querySource).not.toHaveBeenCalled();
    expect(target.sent).toEqual([]);
  });
});
