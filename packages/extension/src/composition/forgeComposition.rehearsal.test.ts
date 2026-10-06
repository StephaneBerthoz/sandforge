import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Connection } from 'jsforce';
import type { ForgeConfig } from '@sandforge/shared';
import { buildSyntheticForgeGraph } from '@sandforge/shared';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
  },
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../core/connection/ConnectionHelper.js', () => ({ getJsforceConnection: vi.fn() }));

import { getJsforceConnection } from '../core/connection/ConnectionHelper.js';
import { initForgeComposition } from './forgeComposition.js';
import type { ForgeCompositionDeps } from './forgeComposition.js';
import type { ForgeServices } from '../bridge/handlers/ForgeHandler.js';

/*
 * The rehearsal the composition hands the handler: it reads through the run's
 * own deps, and reaches the target through one composite call per round, never
 * through the run's writers.
 */

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

const DESCRIBES: Record<string, unknown> = {
  Account: {
    name: 'Account',
    createable: true,
    keyPrefix: '001',
    fields: [field('Id', 'id'), field('Name', 'string')],
    childRelationships: [],
  },
};

/** What each org was sent, in order. */
let sent: Array<{ orgId: string; what: string; body?: unknown; headers?: Record<string, string> }>;

function fakeConnection(orgId: string) {
  return {
    version: '66.0',
    describe: vi.fn(async (objectApiName: string) => DESCRIBES[objectApiName]),
    describeGlobal: vi.fn(async () => ({ sobjects: [{ name: 'Account', keyPrefix: '001' }] })),
    query: vi.fn(async (soql: string) => {
      sent.push({ orgId, what: 'query' });
      if (/COUNT\(\)/i.test(soql)) return { totalSize: 1, done: true, records: [] };
      if (/\bFROM\s+Account\b/i.test(soql) && orgId === 'src') {
        return { totalSize: 1, done: true, records: [{ Id: '001000000000001AAA', Name: 'Acme' }] };
      }
      return { totalSize: 0, done: true, records: [] };
    }),
    queryMore: vi.fn(async () => ({ totalSize: 0, done: true, records: [] })),
    sobject: () => ({
      create: vi.fn(async () => {
        sent.push({ orgId, what: 'create' });
        return [];
      }),
    }),
    request: vi.fn(
      async (request: {
        method: string;
        url: string;
        body?: string;
        headers?: Record<string, string>;
      }) => {
        sent.push({
          orgId,
          what: `${request.method} ${request.url}`,
          body: request.body ? JSON.parse(request.body) : undefined,
          headers: request.headers,
        });
        return {
          compositeResponse: [
            { body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }], httpStatusCode: 400 },
            { body: [{ errorCode: 'NOT_FOUND', message: 'not found' }], httpStatusCode: 404 },
          ],
        };
      },
    ),
  };
}

async function compose(): Promise<ForgeServices> {
  const setForgeOrchestrator = vi.fn();
  initForgeComposition({
    handlers: { setForgeOrchestrator },
    orgRegistry: {},
    orgManager: {},
    configStore: { get: vi.fn(), set: vi.fn() },
    piiDetector: { detectPII: () => ({ piiFields: [] }) },
    log: vi.fn(),
  } as unknown as ForgeCompositionDeps);
  await vi.waitFor(() => expect(setForgeOrchestrator).toHaveBeenCalled(), { timeout: 5_000 });
  return setForgeOrchestrator.mock.calls[0][1] as ForgeServices;
}

const CONFIG: ForgeConfig = {
  inputMode: 'soql',
  soqlQuery: 'SELECT Id FROM Account',
  depth: 'direct',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

describe('the rehearsal the Forge composition wires', () => {
  beforeEach(() => {
    sent = [];
    vi.mocked(getJsforceConnection).mockReset();
    vi.mocked(getJsforceConnection).mockImplementation(
      async (orgId: string) => fakeConnection(orgId) as unknown as Connection,
    );
  });

  it('reaches the target in one composite call with the headers of a Forge write, and creates nothing through the run’s writers', async () => {
    const services = await compose();
    expect(services.rehearser).toBeDefined();
    const graph = buildSyntheticForgeGraph(['Account']);
    const rehearsal = await services.rehearser!.rehearse(graph, CONFIG, {
      confirm: async () => {},
    });
    expect(rehearsal).toMatchObject({ rows: 1, judged: 1, passed: 1, calls: 1 });
    expect(sent.filter((s) => s.what === 'create')).toEqual([]);
    const composite = sent.filter((s) => s.what === 'POST /composite');
    expect(composite).toHaveLength(1);
    expect(composite[0].orgId).toBe('tgt');
    expect(composite[0].headers).toMatchObject({
      'Content-Type': 'application/json',
      'Sforce-Duplicate-Rule-Header': 'allowSave=true',
      'Sforce-Auto-Assign': 'FALSE',
    });
    expect(composite[0].body).toMatchObject({
      allOrNone: true,
      compositeRequest: [
        {
          url: '/services/data/v66.0/composite/sobjects',
          body: { allOrNone: false, records: [{ attributes: { type: 'Account' }, Name: 'Acme' }] },
        },
        { method: 'PATCH', url: '/services/data/v66.0/sobjects/Account/001000000000000AAA' },
      ],
    });
  });
});
