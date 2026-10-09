import { describe, it, expect, vi } from 'vitest';
import type {
  ForgeConfig,
  ForgeGraph,
  ForgeGraphNode,
  ForgeRehearsalProgress,
} from '@sandforge/shared';
import type { FieldInfo, ForgeExecutorDeps } from '../ForgeExecutor.js';
import type { GraphDiscoveryService } from '../GraphDiscoveryService.js';
import { ForgeRehearser, type ForgeRehearserDeps } from './ForgeRehearser.js';
import { RehearsalCancelledError } from './rehearse.js';

type Composite = ForgeRehearserDeps['composite'];

vi.mock('../../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT_ID = id('001', 1);

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Account: [field('Id'), field('Name')],
  Contact: [
    field('Id'),
    field('LastName'),
    field('Email', { type: 'email', length: 80 }),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: true }),
  ],
};

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: ACCOUNT_ID,
  depth: 'direct',
  sourceOrgId: 'src',
  targetOrgId: 'tgt',
  anonymizePII: false,
  skipEmpty: true,
  batchSize: 'auto',
};

/** The run's deps: a source holding an account and its contact, and writers that must never be called. */
function reads(): ForgeExecutorDeps {
  return {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      if (/FROM Account\b/.test(soql)) return [{ Id: ACCOUNT_ID, Name: 'Acme' }];
      if (/FROM Contact\b/.test(soql)) {
        return [
          {
            Id: id('003', 1),
            LastName: 'Example',
            Email: 'jane@example.com',
            AccountId: ACCOUNT_ID,
          },
        ];
      }
      return [];
    }),
    insertRecords: vi.fn(async () => {
      throw new Error('the run’s writer was called');
    }),
    updateRecords: vi.fn(async () => {
      throw new Error('the run’s writer was called');
    }),
    describeObject: vi.fn(async (_org: string, object: string) => ({
      keyPrefix: object === 'Account' ? '001' : '003',
      recordTypes: [],
    })),
  };
}

const HALTED = {
  body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }],
  httpStatusCode: 400,
};

/** A target that creates every row: every request stopped, the closing update failing on its own. */
function everyRowPasses() {
  return vi.fn<Composite>(async (_org, body) => ({
    compositeResponse: [
      ...body.compositeRequest.slice(0, -1).map(() => HALTED),
      { body: [{ errorCode: 'NOT_FOUND', message: 'x' }], httpStatusCode: 404 },
    ],
  }));
}

function rehearser(run: ForgeExecutorDeps, composite: ReturnType<typeof everyRowPasses>) {
  return new ForgeRehearser({
    reads: run,
    discoveryService: { personalFields: vi.fn(() => []) } as unknown as GraphDiscoveryService,
    composite,
    apiPath: async () => '/services/data/v66.0',
  });
}

describe('a rehearsal of a run, through the run’s own executor', () => {
  it('sends the rows as the run would write them, the contact naming the account its call creates', async () => {
    const run = reads();
    const composite = everyRowPasses();
    const result = await rehearser(run, composite).rehearse(GRAPH, CONFIG, {
      confirm: async () => {},
    });
    expect(result).toMatchObject({ rows: 2, judged: 2, passed: 2, calls: 1 });
    const [, body, headers] = composite.mock.calls[0];
    const records = body.compositeRequest
      .slice(0, -1)
      .map((sub) => (sub.body as { records: Array<Record<string, unknown>> }).records);
    expect(records[0]).toEqual([{ attributes: { type: 'Account' }, Name: 'Acme' }]);
    expect(records[1][0]).toMatchObject({
      attributes: { type: 'Contact' },
      LastName: 'Example',
      AccountId: '@{rows0[0].id}',
    });
    // Neutralized as the run neutralizes it: never the address the source holds.
    expect(records[1][0]['Email']).not.toBe('jane@example.com');
    expect(String(records[1][0]['Email'])).toMatch(/\.invalid$/);
    expect(headers).toEqual({
      'Sforce-Duplicate-Rule-Header': 'allowSave=true',
      'Sforce-Auto-Assign': 'FALSE',
    });
    expect(run.insertRecords).not.toHaveBeenCalled();
    expect(run.updateRecords).not.toHaveBeenCalled();
  });

  it('goes through the write stage of a config that asks for a simulation', async () => {
    const composite = everyRowPasses();
    const result = await rehearser(reads(), composite).rehearse(
      GRAPH,
      { ...CONFIG, dryRun: true },
      { confirm: async () => {} },
    );
    expect(result.rows).toBe(2);
    expect(composite).toHaveBeenCalledTimes(1);
  });

  it('lets the target’s assignment rules apply only when the run asks for them', async () => {
    const composite = everyRowPasses();
    await rehearser(reads(), composite).rehearse(
      GRAPH,
      { ...CONFIG, applyAssignmentRules: true },
      { confirm: async () => {} },
    );
    expect(composite.mock.calls[0][2]['Sforce-Auto-Assign']).toBe('TRUE');
    const sub = composite.mock.calls[0][1].compositeRequest[0];
    expect(sub.httpHeaders?.['Sforce-Auto-Assign']).toBe('TRUE');
  });

  it('says the objects it reads, then waits on the user, before the first call', async () => {
    const progress: ForgeRehearsalProgress[] = [];
    const composite = everyRowPasses();
    const confirm = vi.fn(async () => {
      expect(composite).not.toHaveBeenCalled();
    });
    await rehearser(reads(), composite).rehearse(GRAPH, CONFIG, {
      confirm,
      onProgress: (p) => progress.push(p),
    });
    expect(progress.some((p) => p.phase === 'reading' && p.objectApiName === 'Contact')).toBe(true);
    expect(progress.findIndex((p) => p.phase === 'confirming')).toBeGreaterThan(
      progress.findIndex((p) => p.phase === 'reading'),
    );
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ rows: 2, calls: 1 }));
  });

  it('stops reading once its signal is aborted, sends nothing and says it was cancelled', async () => {
    const base = reads();
    const controller = new AbortController();
    // Cancelled from Live Operations as the source is read.
    const run: ForgeExecutorDeps = {
      ...base,
      queryRecords: vi.fn(async (org: string, soql: string) => {
        controller.abort();
        return base.queryRecords(org, soql);
      }),
    };
    const composite = everyRowPasses();
    const confirm = vi.fn(async () => {});

    await expect(
      rehearser(run, composite).rehearse(GRAPH, CONFIG, { confirm, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RehearsalCancelledError);
    // Stopped where it was: the contacts were never read.
    const read = vi.mocked(run.queryRecords).mock.calls.map(([, soql]) => soql);
    expect(read.some((soql) => /FROM Account\b/.test(soql))).toBe(true);
    expect(read.some((soql) => /FROM Contact\b/.test(soql))).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(composite).not.toHaveBeenCalled();
  });

  it('names a refused value’s record type by the run’s record type table', async () => {
    const run = reads();
    vi.mocked(run.queryRecords).mockImplementation(async (org, soql) => {
      if (org !== 'src') return [];
      if (/FROM Account\b/.test(soql)) return [{ Id: ACCOUNT_ID, Name: 'Acme' }];
      return [];
    });
    const composite = vi.fn<Composite>(async () => ({
      compositeResponse: [
        {
          body: [
            {
              success: false,
              errors: [
                {
                  statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
                  message: 'x',
                  fields: ['Name'],
                },
              ],
            },
          ],
          httpStatusCode: 200,
        },
        HALTED,
      ],
    }));
    const result = await rehearser(run, composite).rehearse(GRAPH, CONFIG, {
      confirm: async () => {},
      recordTypeMappings: [],
    });
    expect(result.gaps[0]).toMatchObject({ kind: 'picklist_value_refused', value: 'Acme' });
  });
});
