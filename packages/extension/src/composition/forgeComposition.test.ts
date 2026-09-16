import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Connection } from 'jsforce';
import type { ForgeConfig } from '@sandforge/shared';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../core/connection/ConnectionHelper.js', () => ({ getJsforceConnection: vi.fn() }));

import { getJsforceConnection } from '../core/connection/ConnectionHelper.js';
import { initForgeComposition } from './forgeComposition.js';
import type { ForgeCompositionDeps } from './forgeComposition.js';
import type { ForgeOrchestrator } from '../modules/forge/ForgeOrchestrator.js';
import type { ForgeServices } from '../bridge/handlers/ForgeHandler.js';

/** A field as jsforce's describe returns it, reduced to what Forge reads. */
function field(name: string, type: string, referenceTo: string[] = []) {
  return {
    name,
    type,
    createable: type !== 'id',
    nillable: type !== 'id',
    referenceTo,
    relationshipName: referenceTo.length > 0 ? name.replace(/Id$/, '') : null,
    cascadeDelete: false,
    picklistValues: [],
    externalId: false,
  };
}

/** Account with two children: discovery at depth `direct` finds three objects. */
const DESCRIBES: Record<string, unknown> = {
  Account: {
    name: 'Account',
    createable: true,
    fields: [field('Id', 'id'), field('Name', 'string')],
    childRelationships: [
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
      { childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities' },
    ],
  },
  Contact: {
    name: 'Contact',
    createable: true,
    fields: [
      field('Id', 'id'),
      field('LastName', 'string'),
      field('AccountId', 'reference', ['Account']),
    ],
    childRelationships: [],
  },
  Opportunity: {
    name: 'Opportunity',
    createable: true,
    fields: [
      field('Id', 'id'),
      field('Name', 'string'),
      field('AccountId', 'reference', ['Account']),
    ],
    childRelationships: [],
  },
};

const PREFIX: Record<string, string> = { Account: '001', Contact: '003', Opportunity: '006' };

/** An 18-character id for `object`, numbered `n`. */
function sfId(object: string, n: number): string {
  return `${PREFIX[object]}${String(n).padStart(12, '0')}AAA`;
}

/** Describe calls per `org::object`, across every connection handed out. */
let describeCalls: Map<string, number>;

/** A connection to `orgId` that counts describes and answers queries and writes. */
function fakeConnection(orgId: string) {
  return {
    describe: vi.fn(async (objectApiName: string) => {
      const key = `${orgId}::${objectApiName}`;
      describeCalls.set(key, (describeCalls.get(key) ?? 0) + 1);
      return DESCRIBES[objectApiName];
    }),
    describeGlobal: vi.fn(async () => ({
      sobjects: Object.keys(PREFIX).map((name) => ({ name, keyPrefix: PREFIX[name] })),
    })),
    query: vi.fn(async (soql: string) => {
      const object = /\bFROM\s+(\w+)/i.exec(soql)?.[1] ?? '';
      if (/COUNT\(\)/i.test(soql)) return { totalSize: 2, done: true, records: [] };
      const records = [1, 2].map((n) => ({
        Id: sfId(object, n),
        Name: `${object} ${n}`,
        LastName: `${object} ${n}`,
        ...(object === 'Account' ? {} : { AccountId: sfId('Account', n) }),
      }));
      return { totalSize: records.length, done: true, records };
    }),
    queryMore: vi.fn(async () => ({ totalSize: 0, done: true, records: [] })),
    sobject: (objectApiName: string) => ({
      create: vi.fn(async (records: unknown[]) =>
        records.map((_, i) => ({ id: sfId(objectApiName, 900 + i), success: true, errors: [] })),
      ),
    }),
  };
}

/** Wire the composition and hand back what it injects into the handlers. */
async function compose(): Promise<{ orchestrator: ForgeOrchestrator; services: ForgeServices }> {
  const setForgeOrchestrator = vi.fn();
  const deps = {
    handlers: { setForgeOrchestrator },
    orgRegistry: {},
    orgManager: {},
    configStore: { get: vi.fn(), set: vi.fn() },
    piiDetector: { detectPII: () => ({ piiFields: [] }) },
    log: vi.fn(),
  } as unknown as ForgeCompositionDeps;
  initForgeComposition(deps);
  await vi.waitFor(() => expect(setForgeOrchestrator).toHaveBeenCalled(), { timeout: 5_000 });
  const [orchestrator, services] = setForgeOrchestrator.mock.calls[0] as [
    ForgeOrchestrator,
    ForgeServices,
  ];
  return { orchestrator, services };
}

const SOQL_CONFIG: ForgeConfig = {
  inputMode: 'soql',
  soqlQuery: 'SELECT Id FROM Account',
  depth: 'direct',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

describe('initForgeComposition', () => {
  beforeEach(() => {
    describeCalls = new Map();
    vi.mocked(getJsforceConnection).mockReset();
    vi.mocked(getJsforceConnection).mockImplementation(
      async (orgId: string) => fakeConnection(orgId) as unknown as Connection,
    );
  });

  it('describes each object at most once per org across discovery, the run and the drift check', async () => {
    const { orchestrator, services } = await compose();

    const graph = await orchestrator.discover(SOQL_CONFIG);
    expect(graph.nodes.map((n) => n.objectApiName)).toEqual(['Account', 'Contact', 'Opportunity']);

    const result = await orchestrator.execute(graph, SOQL_CONFIG);
    await services.metadataDiff?.compare('src', 'tgt', ['Account', 'Contact', 'Opportunity']);

    // The run wrote to the target: its describes were needed, not skipped.
    expect(result.idRemapCount).toBeGreaterThan(0);
    expect([...describeCalls.keys()].sort()).toEqual([
      'src::Account',
      'src::Contact',
      'src::Opportunity',
      'tgt::Account',
      'tgt::Contact',
      'tgt::Opportunity',
    ]);
    for (const [key, count] of describeCalls) {
      expect({ key, count }).toEqual({ key, count: 1 });
    }
  });

  it('names an object whose source read a bound stopped in the run result', async () => {
    // The source keeps a Contact cursor open forever: the page bound is what
    // ends the read, and only the composition sees that it did.
    vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
      const connection = fakeConnection(orgId);
      if (orgId !== 'src') return connection as unknown as Connection;
      const answer = connection.query;
      return {
        ...connection,
        query: vi.fn(async (soql: string) => {
          const page = await answer(soql);
          if (!/\bFROM\s+Contact\b/i.test(soql) || /COUNT\(\)/i.test(soql)) return page;
          return { ...page, done: false, nextRecordsUrl: '/next' };
        }),
        queryMore: vi.fn(async () => ({
          totalSize: 0,
          done: false,
          nextRecordsUrl: '/next',
          records: [],
        })),
      } as unknown as Connection;
    });
    const { orchestrator } = await compose();

    const graph = await orchestrator.discover(SOQL_CONFIG);
    const result = await orchestrator.execute(graph, SOQL_CONFIG);

    expect(result.truncatedObjects).toEqual(['Contact']);
  });

  it('joins a describe already under way instead of sending a second one', async () => {
    const { services } = await compose();

    await Promise.all([
      services.metadataDiff?.compare('src', 'tgt', ['Account']),
      services.metadataDiff?.compare('src', 'tgt', ['Account']),
    ]);

    expect(describeCalls.get('src::Account')).toBe(1);
    expect(describeCalls.get('tgt::Account')).toBe(1);
  });

  it('describes an object again once the caller re-discovers', async () => {
    const { orchestrator, services } = await compose();

    await services.metadataDiff?.compare('src', 'tgt', ['Account']);
    expect(describeCalls.get('tgt::Account')).toBe(1);

    orchestrator.clearDiscoveryCache();
    await services.metadataDiff?.compare('src', 'tgt', ['Account']);

    expect(describeCalls.get('tgt::Account')).toBe(2);
  });

  it('drops the describes of the orgs a caller names and leaves the others warm', async () => {
    const { orchestrator, services } = await compose();

    await services.metadataDiff?.compare('src', 'tgt', ['Account']);
    expect(describeCalls.get('src::Account')).toBe(1);
    expect(describeCalls.get('tgt::Account')).toBe(1);

    // Re-reading one org's schema is no reason to make every other org pay for
    // its describes again.
    orchestrator.clearDiscoveryCache(['tgt']);
    await services.metadataDiff?.compare('src', 'tgt', ['Account']);

    expect(describeCalls.get('src::Account')).toBe(1);
    expect(describeCalls.get('tgt::Account')).toBe(2);
  });

  it('shows a field deployed on the target once the caller re-discovers', async () => {
    // The source always has Industry; the target gains it partway through, the
    // way a deployment lands between two drift checks.
    let targetHasIndustry = false;
    vi.mocked(getJsforceConnection).mockImplementation(async (orgId: string) => {
      const connection = fakeConnection(orgId);
      const hasIndustry = orgId === 'src' ? () => true : () => targetHasIndustry;
      return {
        ...connection,
        describe: vi.fn(async (objectApiName: string) => {
          const described = (await connection.describe(objectApiName)) as {
            fields: unknown[];
          };
          if (objectApiName !== 'Account' || !hasIndustry()) return described;
          return { ...described, fields: [...described.fields, field('Industry', 'string')] };
        }),
      } as unknown as Connection;
    });
    const { orchestrator, services } = await compose();

    const drift = await services.metadataDiff?.compare('src', 'tgt', ['Account']);
    expect(drift?.map((d) => d.fieldApiName)).toEqual(['Industry']);

    targetHasIndustry = true;
    // Still the cached describes: the drift is reported exactly as before.
    expect(await services.metadataDiff?.compare('src', 'tgt', ['Account'])).toEqual(drift);

    orchestrator.clearDiscoveryCache();
    expect(await services.metadataDiff?.compare('src', 'tgt', ['Account'])).toEqual([]);
  });

  it('sends no describe once discovery was cancelled while the connection was opening', async () => {
    // Discovery opens one connection per request (the describe and the count);
    // every pending one is held so that both are opened after the cancel.
    const pendingOpens: Array<() => void> = [];
    const connection = fakeConnection('src');
    vi.mocked(getJsforceConnection).mockImplementation(
      () =>
        new Promise<Connection>((resolve) => {
          pendingOpens.push(() => resolve(connection as unknown as Connection));
        }),
    );
    const { orchestrator } = await compose();
    const controller = new AbortController();

    const discovery = orchestrator.discover(SOQL_CONFIG, { signal: controller.signal });
    await vi.waitFor(() => expect(getJsforceConnection).toHaveBeenCalledTimes(2));
    controller.abort();
    const graph = await discovery;
    for (const open of pendingOpens) open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(graph.nodes).toEqual([]);
    expect(connection.describe).not.toHaveBeenCalled();
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('sends no describeGlobal once a record-mode discovery was cancelled while the connection was opening', async () => {
    // Record mode starts by reading the org's key prefixes, so describeGlobal
    // is the request the cancel has to reach.
    const pendingOpens: Array<() => void> = [];
    const connection = fakeConnection('src');
    vi.mocked(getJsforceConnection).mockImplementation(
      () =>
        new Promise<Connection>((resolve) => {
          pendingOpens.push(() => resolve(connection as unknown as Connection));
        }),
    );
    const { orchestrator } = await compose();
    const controller = new AbortController();

    const discovery = orchestrator.discover(
      { ...SOQL_CONFIG, inputMode: 'record', soqlQuery: undefined, recordId: sfId('Account', 1) },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(getJsforceConnection).toHaveBeenCalled());
    controller.abort();
    const graph = await discovery;
    for (const open of pendingOpens) open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(graph.nodes).toEqual([]);
    expect(connection.describeGlobal).not.toHaveBeenCalled();
    expect(connection.describe).not.toHaveBeenCalled();
  });
});
