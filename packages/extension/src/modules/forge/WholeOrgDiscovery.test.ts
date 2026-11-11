import { describe, it, expect, vi } from 'vitest';
import {
  FORGE_LEFT_OUT_MAX,
  forgeGraphSchema,
  type ForgeConfig,
  type ForgeGraphEdge,
} from '@sandforge/shared';
import type { GlobalObject } from '../checkpoint/checkpointScope.js';
import { TimeoutError } from '../../core/engine/TimeoutManager.js';
import type {
  DiscoveryProgressEvent,
  FieldDescribe,
  GraphDiscoveryDeps,
  ObjectDescribe,
} from './GraphDiscoveryService.js';
import { FORGE_BULK_WRITER, runRequestsEstimate } from './ForgeRunGate.js';
import { discoverWholeOrg, WHOLE_ORG_MAX_NODES, WHOLE_ORG_MAX_PAIRS } from './WholeOrgDiscovery.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONFIG: ForgeConfig = {
  inputMode: 'org',
  depth: 'all',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

/** An object the user may query, create, edit and delete, with a page layout. */
function writable(name: string): GlobalObject {
  return {
    name,
    keyPrefix: null,
    queryable: true,
    createable: true,
    updateable: true,
    deletable: true,
    layoutable: true,
  };
}

/** A lookup of a child, settable unless said. */
function lookup(name: string, referenceTo: string[], extra: Partial<FieldDescribe> = {}) {
  return {
    name,
    type: 'reference',
    referenceTo,
    relationshipName: name.replace(/__c$/, '__r').replace(/Id$/, ''),
    isMasterDetail: false,
    nillable: true,
    createable: true,
    updateable: true,
    ...extra,
  } satisfies FieldDescribe;
}

/** A describe with an id, a name and the lookups given. */
function describeOf(name: string, lookups: FieldDescribe[] = []): ObjectDescribe {
  return {
    name,
    label: `${name} label`,
    fields: [
      { name: 'Id', type: 'id', referenceTo: [], relationshipName: null, isMasterDetail: false },
      {
        name: 'Name',
        type: 'string',
        referenceTo: [],
        relationshipName: null,
        isMasterDetail: false,
      },
      ...lookups,
    ],
    childRelationships: [],
  };
}

/** What a count of an object does: answer a figure, or fail as the org fails. */
type CountAnswer = number | 'timeout' | 'refused' | 'pending' | 'expired' | 'slow';

interface FakeOrg {
  /** Objects of both orgs, with the records the source holds of each. */
  objects: Record<string, CountAnswer>;
  /** Describes of the source, by object; one with no entry gets a bare one. */
  describes?: Record<string, ObjectDescribe>;
  /** The source's approximation, by object. */
  approximate?: Record<string, number>;
  /** Objects only the source has. */
  sourceOnly?: string[];
  /** Objects whose describe fails, every time, with no word of the org's. */
  describeFails?: string[];
  /** Objects whose first describe times out, and the next answers. */
  describeFailsOnce?: string[];
  /** Objects whose describe the org refuses, with a code of its own. */
  describeRefused?: string[];
}

/** Deps over a fake pair of orgs, with every call they receive. */
function fakeDeps(org: FakeOrg) {
  const names = Object.keys(org.objects);
  const counted: Array<{ soql: string; all: boolean }> = [];
  const described: string[] = [];
  const deps: GraphDiscoveryDeps = {
    describeGlobal: vi.fn(async (orgId: string) => [
      ...names.map(writable),
      ...(orgId === 'src' ? (org.sourceOnly ?? []).map(writable) : []),
    ]),
    toolingObjects: vi.fn(async () => []),
    approximateRecordCounts: vi.fn(async () =>
      org.approximate ? new Map(Object.entries(org.approximate)) : undefined,
    ),
    queryCount: vi.fn(
      (_orgId: string, soql: string, _signal?: AbortSignal, options?: { all?: boolean }) => {
        counted.push({ soql, all: options?.all === true });
        const object = /\bFROM\s+(\w+)/i.exec(soql)?.[1] ?? '';
        const answer = org.objects[object];
        if (answer === 'pending') return new Promise<number>(() => undefined);
        if (answer === 'slow') {
          return new Promise<number>((resolve) => setTimeout(() => resolve(5), 20));
        }
        if (answer === 'timeout') return Promise.reject(new TimeoutError('queryCount', 15_000));
        if (answer === 'refused') {
          return Promise.reject(
            Object.assign(new Error('entity type Ledger__c does not support query'), {
              errorCode: 'INVALID_TYPE_FOR_OPERATION',
              name: 'INVALID_TYPE_FOR_OPERATION',
            }),
          );
        }
        if (answer === 'expired') {
          return Promise.reject(
            Object.assign(new Error('Session expired or invalid'), {
              errorCode: 'INVALID_SESSION_ID',
            }),
          );
        }
        return Promise.resolve(answer ?? 0);
      },
    ),
    describeObject: vi.fn(async (_orgId: string, objectApiName: string) => {
      const before = described.filter((name) => name === objectApiName).length;
      described.push(objectApiName);
      if (org.describeFails?.includes(objectApiName)) throw new Error('describe timed out');
      if (org.describeFailsOnce?.includes(objectApiName) && before === 0) {
        throw new TimeoutError(`describe:${objectApiName}`, 30_000);
      }
      if (org.describeRefused?.includes(objectApiName)) {
        throw Object.assign(
          new Error(`INVALID_TYPE: sObject type '${objectApiName}' is not supported.`),
          { errorCode: 'INVALID_TYPE' },
        );
      }
      return org.describes?.[objectApiName] ?? describeOf(objectApiName);
    }),
    detectPII: vi.fn((fields: ReadonlyArray<Pick<FieldDescribe, 'name' | 'type'>>) =>
      fields.filter((f) => f.name === 'Email').map((f) => f.name),
    ),
  };
  return { deps, counted, described };
}

/** The edge from `parent` to `child`, if any. */
function edgeOf(
  edges: ForgeGraphEdge[],
  parent: string,
  child: string,
): ForgeGraphEdge | undefined {
  return edges.find((e) => e.sourceObject === parent && e.targetObject === child);
}

describe('discoverWholeOrg', () => {
  it('lists both orgs instead of resolving a root, and makes a node of every object holding records', async () => {
    const { deps } = fakeDeps({
      objects: { Account: 3, Invoice__c: 2 },
      sourceOnly: ['Legacy__c'],
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(deps.describeGlobal).toHaveBeenCalledWith('src', undefined);
    expect(deps.describeGlobal).toHaveBeenCalledWith('tgt', undefined);
    expect(deps.toolingObjects).toHaveBeenCalledWith('tgt', undefined);
    expect(deps.approximateRecordCounts).toHaveBeenCalledWith('src', undefined);
    expect(graph.nodes.map((n) => [n.objectApiName, n.recordCount, n.included])).toEqual([
      ['Account', 3, true],
      ['Invoice__c', 2, true],
    ]);
    expect(graph.nodes[0].label).toBe('Account label');
    expect(graph.totalRecords).toBe(5);
    expect(graph.truncated).toBe(false);
    expect(graph.leftOut).toEqual([{ objectApiName: 'Legacy__c', reason: 'missingInTarget' }]);
  });

  it('leaves an empty table out without describing it', async () => {
    const { deps, described } = fakeDeps({ objects: { Account: 1, Empty__c: 0 } });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(graph.nodes.map((n) => n.objectApiName)).toEqual(['Account']);
    expect(graph.leftOut).toEqual([{ objectApiName: 'Empty__c', reason: 'empty' }]);
    expect(described).toEqual(['Account']);
  });

  it("keeps an object whose count did not answer in time, at the org's approximation or as unknown", async () => {
    const { deps } = fakeDeps({
      objects: { Big__c: 'timeout', Slow__c: 'timeout' },
      approximate: { Big__c: 420_000 },
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    const [big, slow] = graph.nodes;
    expect(big).toMatchObject({
      objectApiName: 'Big__c',
      recordCount: 420_000,
      recordCountApproximate: true,
      included: true,
    });
    expect(big.recordCountUnknown).toBeUndefined();
    expect(slow).toMatchObject({
      objectApiName: 'Slow__c',
      recordCount: 0,
      recordCountUnknown: true,
      included: true,
    });
    expect(slow.recordCountApproximate).toBeUndefined();
    expect(graph.leftOut).toEqual([]);
  });

  it("does not count an object the org's approximation puts past a million records, unless it is filtered", async () => {
    const { deps, counted } = fakeDeps({
      objects: { Huge__c: 5, Filtered__c: 7 },
      approximate: { Huge__c: 3_000_000, Filtered__c: 2_000_000 },
    });

    const graph = await discoverWholeOrg(deps, {
      ...CONFIG,
      objectSoqlFilters: { Filtered__c: "Region__c = 'EU'" },
    });

    expect(counted.map((c) => c.soql)).toEqual([
      "SELECT COUNT() FROM Filtered__c WHERE (Region__c = 'EU')",
    ]);
    expect(graph.nodes.map((n) => [n.objectApiName, n.recordCount])).toEqual([
      ['Filtered__c', 7],
      ['Huge__c', 3_000_000],
    ]);
    expect(graph.nodes[1].recordCountApproximate).toBe(true);
  });

  it("marks a filtered object whose count did not answer as unknown, not at the whole table's approximation", async () => {
    const { deps } = fakeDeps({
      objects: { Filtered__c: 'timeout' },
      approximate: { Filtered__c: 800_000 },
    });

    const graph = await discoverWholeOrg(deps, {
      ...CONFIG,
      objectSoqlFilters: { Filtered__c: "Region__c = 'EU'" },
    });

    expect(graph.nodes[0]).toMatchObject({
      objectApiName: 'Filtered__c',
      recordCount: 0,
      recordCountUnknown: true,
      included: true,
    });
    expect(graph.nodes[0].recordCountApproximate).toBeUndefined();
  });

  it("leaves an object whose count the org refused out as unreadable, in the org's words", async () => {
    const { deps, described } = fakeDeps({ objects: { Account: 1, Ledger__c: 'refused' } });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(graph.nodes.map((n) => n.objectApiName)).toEqual(['Account']);
    expect(graph.leftOut).toEqual([
      {
        objectApiName: 'Ledger__c',
        reason: 'unreadable',
        detail: expect.stringContaining('does not support query') as unknown as string,
      },
    ]);
    expect(described).toEqual(['Account']);
  });

  it('stops and says so when the session has expired, rather than leave every object out', async () => {
    const { deps } = fakeDeps({ objects: { Account: 'expired' } });

    await expect(discoverWholeOrg(deps, CONFIG)).rejects.toThrow('Session expired');
  });

  it('tells no progress after the session expired, though counts already asked answer later', async () => {
    const { deps } = fakeDeps({ objects: { Aaa__c: 'expired', Bbb__c: 'slow', Ccc__c: 'slow' } });
    const events: DiscoveryProgressEvent[] = [];

    await expect(
      discoverWholeOrg(deps, CONFIG, { onProgress: (event) => events.push(event) }),
    ).rejects.toThrow('Session expired');
    const told = events.length;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(deps.queryCount).toHaveBeenCalledTimes(3);
    expect(events).toHaveLength(told);
    expect(events.some((e) => e.objectApiName !== undefined)).toBe(false);
  });

  it('refuses, before any count, a source that lists more objects left out than a graph holds', async () => {
    const sourceOnly = Array.from({ length: FORGE_LEFT_OUT_MAX + 1 }, (_, i) => `Gone${i}__c`);
    const { deps, counted } = fakeDeps({ objects: { Account: 1 }, sourceOnly });

    await expect(discoverWholeOrg(deps, CONFIG)).rejects.toThrow(
      `lists ${FORGE_LEFT_OUT_MAX + 1} objects a clone of the whole org leaves out`,
    );
    expect(counted).toEqual([]);
  });

  it('refuses a source whose empty tables bring the objects left out past what a graph holds', async () => {
    const sourceOnly = Array.from({ length: FORGE_LEFT_OUT_MAX - 1 }, (_, i) => `Gone${i}__c`);
    const { deps } = fakeDeps({ objects: { Account: 1, Empty1__c: 0, Empty2__c: 0 }, sourceOnly });

    await expect(discoverWholeOrg(deps, CONFIG)).rejects.toThrow(
      `lists ${FORGE_LEFT_OUT_MAX + 1} objects a clone of the whole org leaves out`,
    );
  });

  it('gives a graph that lists every object left out, up to what a graph holds', async () => {
    const sourceOnly = Array.from({ length: FORGE_LEFT_OUT_MAX - 1 }, (_, i) => `Gone${i}__c`);
    const { deps } = fakeDeps({ objects: { Account: 1, Empty__c: 0 }, sourceOnly });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(graph.leftOut).toHaveLength(FORGE_LEFT_OUT_MAX);
    expect(forgeGraphSchema.safeParse(graph).success).toBe(true);
  });

  it('leaves an object whose describe failed twice out, with why', async () => {
    const { deps, described } = fakeDeps({
      objects: { Account: 1, Odd__c: 4 },
      describeFails: ['Odd__c'],
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(graph.nodes.map((n) => n.objectApiName)).toEqual(['Account']);
    expect(graph.leftOut).toEqual([
      { objectApiName: 'Odd__c', reason: 'notDescribed', detail: 'describe timed out' },
    ]);
    expect(described.filter((name) => name === 'Odd__c')).toHaveLength(2);
  });

  it('asks a describe the org did not answer again once, and keeps the table with its relations', async () => {
    const { deps, described } = fakeDeps({
      objects: { Account: 1, Contact: 2 },
      describes: { Contact: describeOf('Contact', [lookup('AccountId', ['Account'])]) },
      describeFailsOnce: ['Account'],
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(graph.nodes.map((n) => n.objectApiName)).toEqual(['Account', 'Contact']);
    expect(edgeOf(graph.edges, 'Account', 'Contact')).toBeDefined();
    expect(graph.leftOut).toEqual([]);
    expect(described.filter((name) => name === 'Account')).toHaveLength(2);
  });

  it('does not ask again a describe the org refused', async () => {
    const { deps, described } = fakeDeps({
      objects: { Account: 1, Odd__c: 4 },
      describeRefused: ['Odd__c'],
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(graph.leftOut).toEqual([
      {
        objectApiName: 'Odd__c',
        reason: 'notDescribed',
        detail: expect.stringContaining('is not supported') as unknown as string,
      },
    ]);
    expect(described.filter((name) => name === 'Odd__c')).toHaveLength(1);
  });

  it('counts the tasks and events through queryAll, the recycle bin left out, and any other object through query', async () => {
    const { deps, counted } = fakeDeps({ objects: { Account: 1, Event: 2, Task: 3 } });

    await discoverWholeOrg(deps, {
      ...CONFIG,
      objectSoqlFilters: { Task: "Status = 'Open'" },
    });

    expect(counted).toEqual([
      { soql: 'SELECT COUNT() FROM Account', all: false },
      { soql: 'SELECT COUNT() FROM Event WHERE IsDeleted = false', all: true },
      { soql: "SELECT COUNT() FROM Task WHERE (Status = 'Open') AND IsDeleted = false", all: true },
    ]);
  });

  it('relates nodes only, one edge a pair, never an object to itself, a managed package included', async () => {
    const { deps } = fakeDeps({
      objects: {
        Account: 2,
        Opportunity: 2,
        Empty__c: 0,
        vlocity_cmt__Party__c: 1,
        Contact: 2,
      },
      describes: {
        Account: describeOf('Account', [lookup('ParentId', ['Account'])]),
        Opportunity: describeOf('Opportunity', [
          lookup('AccountId', ['Account']),
          lookup('Partner_Account__c', ['Account']),
          lookup('Empty__c', ['Empty__c']),
          lookup('OwnerId', ['User']),
        ]),
        Contact: describeOf('Contact', [
          lookup('Party__c', ['vlocity_cmt__Party__c']),
          lookup('AccountId', ['Account'], { isMasterDetail: true, nillable: false }),
          lookup('ReportsToId', ['Account'], { relationshipName: 'ReportsTo' }),
        ]),
      },
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    expect(graph.edges).toHaveLength(3);
    expect(edgeOf(graph.edges, 'Account', 'Opportunity')).toEqual({
      sourceObject: 'Account',
      targetObject: 'Opportunity',
      relationshipName: 'Account',
      type: 'lookup',
      required: false,
    });
    // Master-detail over the lookup seen first, required as one of them is.
    expect(edgeOf(graph.edges, 'Account', 'Contact')).toMatchObject({
      type: 'master-detail',
      required: true,
    });
    expect(edgeOf(graph.edges, 'vlocity_cmt__Party__c', 'Contact')).toBeDefined();
    expect(edgeOf(graph.edges, 'Account', 'Account')).toBeUndefined();
  });

  it('marks a pair no write can set as ordering nothing, and one only an insert sets as wanting its parent first', async () => {
    const { deps } = fakeDeps({
      objects: { Account: 1, Quote: 1, EmailMessage: 1, Case: 1 },
      describes: {
        Quote: describeOf('Quote', [
          lookup('AccountId', ['Account'], { createable: false, updateable: false }),
        ]),
        EmailMessage: describeOf('EmailMessage', [
          lookup('ParentId', ['Case'], { updateable: false }),
          lookup('RelatedToId', ['Case']),
        ]),
      },
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    const quote = edgeOf(graph.edges, 'Account', 'Quote');
    expect(quote).toMatchObject({ settable: false, required: false });
    const email = edgeOf(graph.edges, 'Case', 'EmailMessage');
    expect(email).toMatchObject({ insertOnly: true });
    expect(email?.settable).toBeUndefined();
  });

  it('levels each node from 1 under its longest chain of parents, a cycle on one level, never past 18', async () => {
    // A chain of 25 objects, each the child of the one before; B and C point
    // at each other beside it.
    const chain = Array.from({ length: 25 }, (_, i) => `Chain${String(i).padStart(2, '0')}__c`);
    const objects: Record<string, CountAnswer> = { Cyc_A__c: 1, Cyc_B__c: 1, Cyc_C__c: 1 };
    const describes: Record<string, ObjectDescribe> = {
      Cyc_B__c: describeOf('Cyc_B__c', [
        lookup('A__c', ['Cyc_A__c']),
        lookup('C__c', ['Cyc_C__c']),
      ]),
      Cyc_C__c: describeOf('Cyc_C__c', [lookup('B__c', ['Cyc_B__c'])]),
      // A lookup no write sets orders nothing, and so levels nothing.
      Cyc_A__c: describeOf('Cyc_A__c', [
        lookup('C__c', ['Cyc_C__c'], { createable: false, updateable: false }),
      ]),
    };
    chain.forEach((name, i) => {
      objects[name] = 1;
      describes[name] = describeOf(name, i > 0 ? [lookup('Up__c', [chain[i - 1]])] : []);
    });
    const { deps } = fakeDeps({ objects, describes });

    const graph = await discoverWholeOrg(deps, CONFIG);

    const level = new Map(graph.nodes.map((n) => [n.objectApiName, n.level]));
    expect(chain.map((name) => level.get(name))).toEqual([
      ...Array.from({ length: 18 }, (_, i) => i + 1),
      ...Array.from({ length: 7 }, () => 18),
    ]);
    expect(level.get('Cyc_A__c')).toBe(1);
    expect(level.get('Cyc_B__c')).toBe(2);
    expect(level.get('Cyc_C__c')).toBe(2);
    expect(Math.min(...level.values())).toBe(1);
  });

  it('refuses an org whose objects holding records are more than one run writes, before any describe', async () => {
    const objects: Record<string, CountAnswer> = {};
    for (let i = 0; i <= WHOLE_ORG_MAX_NODES; i++) objects[`Obj${i}__c`] = 1;
    const { deps, described } = fakeDeps({ objects });

    await expect(discoverWholeOrg(deps, CONFIG)).rejects.toThrow(
      `holds records in ${WHOLE_ORG_MAX_NODES + 1} objects`,
    );
    expect(described).toEqual([]);
  });

  it('refuses an org whose objects relate more pairs than one run writes', async () => {
    // 146 objects each pointing at every other: 146 × 145 pairs.
    const names = Array.from({ length: 146 }, (_, i) => `Web${i}__c`);
    const objects: Record<string, CountAnswer> = {};
    const describes: Record<string, ObjectDescribe> = {};
    for (const name of names) {
      objects[name] = 1;
      describes[name] = describeOf(
        name,
        names.filter((other) => other !== name).map((other) => lookup(`${other}_L__c`, [other])),
      );
    }
    const { deps } = fakeDeps({ objects, describes });

    await expect(discoverWholeOrg(deps, CONFIG)).rejects.toThrow(
      `relate ${146 * 145} pairs of objects, more than the ${WHOLE_ORG_MAX_PAIRS}`,
    );
  });

  it('hands back an empty graph, describing nothing, when cancelled while counting', async () => {
    const { deps, described } = fakeDeps({ objects: { Account: 1, Stuck__c: 'pending' } });
    const controller = new AbortController();
    const counting = discoverWholeOrg(deps, CONFIG, {
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'counting' && event.objectApiName === 'Account') controller.abort();
      },
    });

    const graph = await counting;

    expect(graph).toEqual({
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
      truncated: false,
    });
    expect(described).toEqual([]);
  });

  it('says each phase, and how many objects it goes through', async () => {
    const { deps } = fakeDeps({ objects: { Account: 1, Contact: 2, Empty__c: 0 } });
    const events: DiscoveryProgressEvent[] = [];

    await discoverWholeOrg(deps, CONFIG, { onProgress: (event) => events.push(event) });

    expect(events[0]).toEqual({ phase: 'listing', discoveredCount: 0, queueRemaining: 0 });
    const counting = events.filter((e) => e.phase === 'counting');
    expect(counting[0]).toEqual({
      phase: 'counting',
      discoveredCount: 0,
      queueRemaining: 3,
      total: 3,
    });
    expect(counting.at(-1)).toMatchObject({ discoveredCount: 3, queueRemaining: 0, total: 3 });
    const describing = events.filter((e) => e.phase === 'describing');
    expect(describing.map((e) => e.discoveredCount)).toEqual([0, 1, 2]);
    expect(describing.every((e) => e.total === 2)).toBe(true);
    expect(events.map((e) => e.phase)).toEqual([
      'listing',
      ...counting.map(() => 'counting'),
      ...describing.map(() => 'describing'),
    ]);
  });

  it('estimates the calls of each object by the transport the run is likely to write it with', async () => {
    const { deps } = fakeDeps({ objects: { Account: 50_000, Invoice__c: 50_000, Small__c: 10 } });

    const graph = await discoverWholeOrg(deps, CONFIG);

    const calls = new Map(graph.nodes.map((n) => [n.objectApiName, n.estimatedApiCalls]));
    // A duplicate rule may watch an account, which a job cannot waive: REST.
    expect(calls.get('Account')).toBe(runRequestsEstimate([{ rows: 50_000, bulk: false }]));
    expect(calls.get('Invoice__c')).toBe(
      runRequestsEstimate([{ rows: 50_000, bulk: true }], FORGE_BULK_WRITER),
    );
    expect(calls.get('Invoice__c')).toBeLessThan(calls.get('Account') ?? 0);
    expect(calls.get('Small__c')).toBe(1);
    expect(graph.estimatedDurationSeconds).toBeGreaterThan(0);
  });

  it('names the personal fields of each node, selected for anonymization when the run anonymizes', async () => {
    const { deps } = fakeDeps({
      objects: { Contact: 1 },
      describes: {
        Contact: {
          ...describeOf('Contact'),
          fields: [
            ...describeOf('Contact').fields,
            {
              name: 'Email',
              type: 'email',
              referenceTo: [],
              relationshipName: null,
              isMasterDetail: false,
            },
          ],
        },
      },
    });

    const graph = await discoverWholeOrg(deps, { ...CONFIG, anonymizePII: true });

    expect(graph.nodes[0]).toMatchObject({ piiFields: ['Email'], anonymizeFields: ['Email'] });
  });

  it('gives a graph the run journal and the messages accept', async () => {
    const { deps } = fakeDeps({
      objects: { Account: 3, Contact: 2, Big__c: 'timeout', Empty__c: 0, Ledger__c: 'refused' },
      describes: { Contact: describeOf('Contact', [lookup('AccountId', ['Account'])]) },
      approximate: { Big__c: 12 },
      sourceOnly: ['Legacy__c'],
    });

    const graph = await discoverWholeOrg(deps, CONFIG);

    const parsed = forgeGraphSchema.safeParse(graph);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(graph);
  });
});
