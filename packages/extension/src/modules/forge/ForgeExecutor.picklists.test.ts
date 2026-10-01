import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from './ForgeExecutor.js';
import type {
  RecordTypePicklist,
  RecordTypePicklists,
} from '../../core/metadata/recordTypePicklists.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The account the clone starts from. */
const ACCOUNT = id('001', 1);
/** Record types: the source's, and the target's the mapping translates them to. */
const SOURCE_RETAIL = id('012', 1);
const SOURCE_TRADE = id('012', 2);
const TARGET_RETAIL = id('012', 101);
const TARGET_TRADE = id('012', 102);

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

/** Two restricted picklists, every value of each active in both orgs. */
const FIELDS: FieldInfo[] = [
  field('Id'),
  field('Name'),
  field('Account__c', { isReference: true, referenceTo: ['Account'], nillable: false }),
  field('RecordTypeId', { isReference: true, referenceTo: ['RecordType'] }),
  field('Status__c', {
    type: 'picklist',
    restrictedPicklist: true,
    picklistValues: ['New', 'Open', 'Old'],
  }),
  field('Kind__c', { type: 'picklist', restrictedPicklist: true, picklistValues: ['A', 'B'] }),
];

const FIELDS_OF: Record<string, FieldInfo[]> = {
  Account: [field('Id'), field('Name')],
  Order__c: FIELDS,
};

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 3,
    fieldCount: FIELDS_OF[objectApiName].length,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: FIELDS_OF[objectApiName].length - 1,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

const ORDERS: ForgeGraphEdge = {
  sourceObject: 'Account',
  targetObject: 'Order__c',
  relationshipName: 'Orders__r',
  type: 'lookup',
};

const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Order__c', 1)],
  edges: [ORDERS],
  totalRecords: 4,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const SOURCE: Record<string, FakeRow[]> = {
  Account: [{ Id: ACCOUNT, Name: 'Acme' }],
  Order__c: [
    // Active in the target, and not kept by the record type it goes in with.
    order(1, 'One', SOURCE_RETAIL, 'Old', 'A'),
    order(2, 'Two', SOURCE_RETAIL, 'Open', 'B'),
    order(3, 'Three', SOURCE_TRADE, 'Old', 'A'),
  ],
};

/** An order of the account, with its record type and picklist values. */
function order(n: number, name: string, recordType: string, status: string, kind: string): FakeRow {
  return {
    Id: id('a01', n),
    Name: name,
    Account__c: ACCOUNT,
    RecordTypeId: recordType,
    Status__c: status,
    Kind__c: kind,
  };
}

/** The account the target created, which the orders point at. */
const NEW_ACCOUNT = id('001', 901);

const OPTIONS: ExecuteOptions = {
  rootRecordId: ACCOUNT,
  rootObjectApiName: 'Account',
  recordTypeMappings: [
    { sourceId: SOURCE_RETAIL, targetId: TARGET_RETAIL, developerName: 'Retail' },
    { sourceId: SOURCE_TRADE, targetId: TARGET_TRADE, developerName: 'Trade' },
  ],
};

const keeps = (values: string[], defaultValue: string | null = null): RecordTypePicklist => ({
  values,
  defaultValue,
});

/** What each record type of the target allows, by its id there. */
const TARGET_RECORD_TYPES: Record<string, RecordTypePicklists> = {
  [TARGET_RETAIL]: new Map([
    ['Status__c', keeps(['New', 'Open'], 'New')],
    ['Kind__c', keeps(['A', 'B'])],
  ]),
  [TARGET_TRADE]: new Map([
    ['Status__c', keeps(['New', 'Old'])],
    ['Kind__c', keeps(['A'])],
  ]),
};

/** A source holding the rows above, and a target that takes every record it is sent. */
function fakeOrgs(
  recordTypePicklists: ForgeExecutorDeps['recordTypePicklists'] = async (_org, _object, rt) =>
    TARGET_RECORD_TYPES[rt],
) {
  const sent: Array<Record<string, unknown>> = [];
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS_OF[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) =>
      org === 'src' ? selectRows(SOURCE, soql) : [],
    ),
    insertRecords: vi.fn(
      async (
        _org: string,
        object: string,
        rows: Record<string, unknown>[],
      ): Promise<InsertResult[]> => {
        if (object !== 'Order__c') {
          return rows.map(() => ({ id: NEW_ACCOUNT, success: true, errors: [] }));
        }
        sent.push(...rows);
        return rows.map(() => ({ id: id('a01', 900 + ++next), success: true, errors: [] }));
      },
    ),
    recordTypePicklists: vi.fn(recordTypePicklists),
  } satisfies ForgeExecutorDeps;
  return { deps, sent };
}

/** Run the clone and keep what the object's line said. */
async function run(deps: ForgeExecutorDeps, options: ExecuteOptions = OPTIONS) {
  const events: ForgeProgressEvent[] = [];
  const summary = await new ForgeExecutor(deps).execute(
    GRAPH,
    'src',
    'tgt',
    (event) => events.push(event),
    options,
  );
  const line = events.filter((e) => e.objectName === 'Order__c').at(-1)?.message ?? '';
  return { summary, line };
}

describe('ForgeExecutor, picklist values and the record type a row goes in with', () => {
  it("replaces a value the row's record type does not keep with its default, and writes the row", async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps);

    const written = (name: string, recordType: string, status: string, kind: string) => ({
      Name: name,
      Account__c: NEW_ACCOUNT,
      RecordTypeId: recordType,
      Status__c: status,
      Kind__c: kind,
    });
    expect(sent).toEqual([
      written('One', TARGET_RETAIL, 'New', 'A'),
      written('Two', TARGET_RETAIL, 'Open', 'B'),
      // Trade keeps "Old" and "A".
      written('Three', TARGET_TRADE, 'Old', 'A'),
    ]);
    // Every row written, the account with them, none failed: what the run
    // counts is what it was.
    expect(summary.successCount).toBe(4);
    expect(summary.failedCount).toBe(0);
  });

  it('reads what each record type allows once, whatever its rows and fields', async () => {
    const { deps } = fakeOrgs();

    await run(deps);

    expect(deps.recordTypePicklists.mock.calls).toEqual([
      ['tgt', 'Order__c', TARGET_RETAIL],
      ['tgt', 'Order__c', TARGET_TRADE],
    ]);
  });

  it('says on the object’s line and in the summary which values it replaced or left out, and why', async () => {
    const { deps } = fakeOrgs();

    const { summary, line } = await run(deps);

    expect(summary.picklistValuesChanged).toEqual([
      {
        objectApiName: 'Order__c',
        field: 'Status__c',
        reason: 'record-type',
        values: ['Old'],
        rows: 1,
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default',
      },
    ]);
    expect(line).toBe(
      'Completed Order__c: 3 succeeded, 0 failed, picklist values not written as read: ' +
        'Status__c on 1 row: "Old" not allowed for record type Retail, replaced by "New", ' +
        'the default of record type Retail',
    );
  });

  it('says the values it changed on the line of a write the target refused', async () => {
    const { deps } = fakeOrgs();
    deps.insertRecords.mockImplementation(async (_org, object, rows) =>
      rows.map(() =>
        object === 'Order__c'
          ? { id: '', success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no'] }
          : { id: NEW_ACCOUNT, success: true, errors: [] },
      ),
    );

    const { summary, line } = await run(deps);

    expect(line).toContain(
      'Failed all Order__c records: 3 failed, picklist values not written as read: Status__c on 1 row',
    );
    expect(summary.failedCount).toBe(3);
  });

  it('checks the rows of a record type it could not read against the values of each field, and says so once', async () => {
    const { deps, sent } = fakeOrgs(async (_org, _object, rt) => {
      if (rt === TARGET_RETAIL) throw new Error('INVALID_TYPE: not supported by the UI API');
      return TARGET_RECORD_TYPES[rt];
    });

    const { summary } = await run(deps);

    // Active in the target, "Old" goes as it did before the record type was read.
    expect(sent[0]).toEqual({
      Name: 'One',
      Account__c: NEW_ACCOUNT,
      RecordTypeId: TARGET_RETAIL,
      Status__c: 'Old',
      Kind__c: 'A',
    });
    expect(summary.errors).toEqual([
      {
        objectApiName: 'Order__c',
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary:
              "(picklist values of record type Retail could not be read — checked against each field's values)",
            messages: ['INVALID_TYPE: not supported by the UI API'],
          },
        ],
      },
    ]);
    expect(summary.picklistValuesChanged).toBeUndefined();
  });

  it('reads no record type without a record type mapping, and checks the values of each field as before', async () => {
    const { deps, sent } = fakeOrgs();

    const { summary } = await run(deps, { ...OPTIONS, recordTypeMappings: undefined });

    expect(deps.recordTypePicklists).not.toHaveBeenCalled();
    expect(sent.map((row) => row['Status__c'])).toEqual(['Old', 'Open', 'Old']);
    expect(summary.picklistValuesChanged).toBeUndefined();
  });
});
