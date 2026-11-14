import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { SampleSourceOrg } from '../../test/sampleSourceOrg.js';
import type { GlobalObject } from '../checkpoint/checkpointScope.js';
import { ForgeExecutor, WHOLE_ORG_WINDOW } from './ForgeExecutor.js';
import type { FieldInfo, ForgeExecutorDeps } from './ForgeExecutor.js';
import type { FieldDescribe, GraphDiscoveryDeps, ObjectDescribe } from './GraphDiscoveryService.js';
import { cursorPages } from './queryAllPages.js';
import { SamplePlan } from './sample/samplePlanStore.js';
import { discoverWholeOrg } from './WholeOrgDiscovery.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A sample of the whole org, drawn from the graph discovery makes of the
 * describes as Salesforce gives them, through the run that draws its plan.
 * Run for real on a whole org: a line item's OpportunityId says
 * `cascadeDelete false`, and only the opportunity's list of its children
 * says the delete cascades. Discovery read the field alone and drew a lookup;
 * the run takes its master-details from discovery's graph, so the plan never
 * said it kept three of an opportunity's four lines (`partialMasters: []`),
 * while the sample's own tests, whose fake org declared the field a
 * master-detail itself, stayed green.
 */

type Row = Record<string, unknown>;

/** A fake id: the object's prefix, a letter for the org, a counter; the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}S${String(n).padStart(11, '0')}AAA`;

const ACCOUNT = fakeId('001', 1);
const OPPORTUNITIES = [fakeId('006', 1), fakeId('006', 2)];
const CONTACTS = 8;
const LINES = 4;

const CONFIG: ForgeConfig = {
  inputMode: 'org',
  depth: 'all',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

/** A field of a describe, as discovery reads it. */
function described(name: string, extra: Partial<FieldDescribe> = {}): FieldDescribe {
  return {
    name,
    type: extra.referenceTo ? 'reference' : 'string',
    referenceTo: [],
    relationshipName: null,
    isMasterDetail: false,
    nillable: true,
    createable: name !== 'Id',
    updateable: name !== 'Id',
    ...extra,
  };
}

/** A relation of a parent to children its delete takes along, as the parent's describe lists it. */
const cascades = (childSObject: string, field: string) => ({
  childSObject,
  field,
  relationshipName: `${childSObject}s`,
  isCascadeDelete: true,
});

/**
 * The describes of the source, as a Developer Edition org gave them: no
 * field says the cascade; the account's list says it of its contacts, whose
 * lookup may be empty, and the opportunity's of its lines, whose may not.
 */
const DESCRIBES: Record<string, ObjectDescribe> = {
  Account: {
    name: 'Account',
    fields: [described('Id', { type: 'id' }), described('Name')],
    childRelationships: [cascades('Contact', 'AccountId'), cascades('Opportunity', 'AccountId')],
  },
  Contact: {
    name: 'Contact',
    fields: [
      described('Id', { type: 'id' }),
      described('LastName'),
      described('AccountId', { referenceTo: ['Account'], relationshipName: 'Account' }),
    ],
    childRelationships: [],
  },
  Opportunity: {
    name: 'Opportunity',
    fields: [
      described('Id', { type: 'id' }),
      described('Name'),
      described('AccountId', { referenceTo: ['Account'], relationshipName: 'Account' }),
    ],
    childRelationships: [cascades('OpportunityLineItem', 'OpportunityId')],
  },
  OpportunityLineItem: {
    name: 'OpportunityLineItem',
    fields: [
      described('Id', { type: 'id' }),
      described('OpportunityId', {
        referenceTo: ['Opportunity'],
        relationshipName: 'Opportunity',
        nillable: false,
        updateable: false,
      }),
    ],
    childRelationships: [],
  },
};

const COUNTS: Record<string, number> = {
  Account: 1,
  Contact: CONTACTS,
  Opportunity: OPPORTUNITIES.length,
  OpportunityLineItem: LINES,
};

/** The graph discovery draws of the describes, both orgs listing the four objects. */
async function discovered(): Promise<ForgeGraph> {
  const listed = (name: string): GlobalObject => ({
    name,
    keyPrefix: null,
    queryable: true,
    createable: true,
    updateable: true,
    deletable: true,
    layoutable: true,
  });
  const deps: GraphDiscoveryDeps = {
    describeGlobal: async () => Object.keys(DESCRIBES).map(listed),
    toolingObjects: async () => [],
    recordCounts: async () => ({ sObjects: [] }),
    queryCount: async (_orgId, soql) => COUNTS[/\bFROM\s+(\w+)/i.exec(soql)?.[1] ?? ''] ?? 0,
    describeObject: async (_orgId, objectApiName) => DESCRIBES[objectApiName],
    detectPII: () => [],
  };
  return discoverWholeOrg(deps, CONFIG);
}

/** The same fields, as the run describes them. */
function fieldsOf(objectApiName: string): FieldInfo[] {
  return (DESCRIBES[objectApiName]?.fields ?? []).map((f) => ({
    name: f.name,
    queryable: true,
    createable: f.createable !== false,
    updateable: f.updateable !== false,
    isReference: f.referenceTo.length > 0,
    ...(f.referenceTo.length > 0 ? { referenceTo: f.referenceTo } : {}),
    ...(f.nillable !== undefined ? { nillable: f.nillable } : {}),
  }));
}

/** An account with its contacts, and two opportunities of two lines each. */
function sourceOrg(): SampleSourceOrg {
  const org = new SampleSourceOrg();
  org.columns.set('Account', ['Id', 'Name', 'CreatedDate', 'IsDeleted']);
  org.columns.set('Contact', ['Id', 'LastName', 'AccountId', 'CreatedDate', 'IsDeleted']);
  org.columns.set('Opportunity', ['Id', 'Name', 'AccountId', 'CreatedDate', 'IsDeleted']);
  org.columns.set('OpportunityLineItem', ['Id', 'OpportunityId', 'CreatedDate', 'IsDeleted']);
  org.add('Account', { Id: ACCOUNT, Name: 'A1', IsDeleted: false });
  for (let n = 1; n <= CONTACTS; n++) {
    org.add('Contact', {
      Id: fakeId('003', n),
      LastName: `C${n}`,
      AccountId: ACCOUNT,
      IsDeleted: false,
    });
  }
  OPPORTUNITIES.forEach((id, n) =>
    org.add('Opportunity', { Id: id, Name: `O${n + 1}`, AccountId: null, IsDeleted: false }),
  );
  for (let n = 1; n <= LINES; n++) {
    org.add('OpportunityLineItem', {
      Id: fakeId('00k', n),
      OpportunityId: OPPORTUNITIES[n <= LINES / 2 ? 0 : 1],
      IsDeleted: false,
    });
  }
  return org;
}

/** A run over `source` that writes nothing: a dry run sends no write, and is refused one. */
function executorOver(source: SampleSourceOrg): ForgeExecutor {
  const gather = async (soql: string): Promise<Row[]> => {
    const rows: Row[] = [];
    for await (const page of cursorPages(source, soql)) rows.push(...page);
    return rows;
  };
  const refused = (): never => {
    throw new Error('a dry run wrote to the target');
  };
  const deps = {
    describeFields: async (_org: string, object: string) => fieldsOf(object),
    queryRecords: async (org: string, soql: string) => (org === 'src' ? gather(soql) : []),
    queryPages: (org: string, soql: string, read?: { all?: true }) =>
      org === 'src'
        ? cursorPages(source, soql, read)
        : (async function* none(): AsyncGenerator<Row[]> {
            yield [];
          })(),
    countRecords: async (_org: string, soql: string) => (await source.query(soql)).totalSize,
    insertRecords: async () => refused(),
    updateRecords: async () => refused(),
    isObjectCreatable: async () => true,
    duplicateRuleObjects: async () => new Set<string>(),
  } satisfies ForgeExecutorDeps;
  return new ForgeExecutor(deps);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a sample of the whole org drawn from describes as Salesforce gives them', () => {
  it('says it keeps part of the lines of an opportunity copied whole, and of no account its contacts', async () => {
    const graph = await discovered();
    const dir = mkdtempSync(join(tmpdir(), 'forge-sample-md-'));
    dirs.push(dir);
    const keepAt = join(dir, 'dry');

    await executorOver(sourceOrg()).execute(graph, 'src', 'tgt', () => {}, {
      writeApi: 'auto',
      dryRun: true,
      beforeWrite: async () => {},
      stream: {
        everything: true,
        writeWindow: WHOLE_ORG_WINDOW,
        secondPassPageSize: WHOLE_ORG_WINDOW,
        sample: {
          options: {},
          budget: async () => ({
            budget: { bytes: 20 * 1024, limitedBy: 'storage' },
            bytesLimit: 'storage',
            roomBytes: 1024 * 1024,
          }),
          keepAt,
          fingerprint: 'setup1',
        },
      },
    });

    const { sample } = (await SamplePlan.open(keepAt)).manifest;
    expect(sample.whole.map((w) => w.objectApiName)).toEqual(['Account', 'Opportunity']);
    const lines = sample.objects.find((o) => o.objectApiName === 'OpportunityLineItem');
    const contacts = sample.objects.find((o) => o.objectApiName === 'Contact');
    expect(lines?.kept).toBeLessThan(LINES);
    expect(contacts?.kept).toBeLessThan(CONTACTS);
    expect(sample.partialMasters).toEqual([
      {
        objectApiName: 'Opportunity',
        details: 'OpportunityLineItem',
        field: 'OpportunityId',
        kept: lines?.kept,
        sourceRows: LINES,
      },
    ]);
  });
});
