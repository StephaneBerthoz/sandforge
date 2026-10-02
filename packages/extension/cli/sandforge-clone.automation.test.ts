import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Connection, DescribeSObjectResult } from 'jsforce';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
// The sessions stay the real ones unless a test gives the orgs it runs against.
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});

import { loadOrg, makeConn } from './sfSession.js';
import { selectRows, type FakeRow } from '../src/test/fakeSoql.js';
import { main } from './sandforge-clone';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const ACCOUNT = '001000000000001AAA';
const CONTACT = '003000000000001AAA';
const WELCOME_VERSION = '301000000000001AAA';

/** A clone of an account from SRC to TGT, with `extra` flags. */
function argv(...extra: string[]): string[] {
  return [
    'node',
    'sandforge-clone.ts',
    '--record',
    ACCOUNT,
    '--source',
    'SRC',
    '--target',
    'TGT',
    ...extra,
  ];
}

/** An object as both fake orgs describe it. */
function object(
  name: string,
  keyPrefix: string,
  fields: Array<Record<string, unknown>>,
  childRelationships: Array<Record<string, unknown>> = [],
): DescribeSObjectResult {
  return {
    name,
    keyPrefix,
    createable: true,
    recordTypeInfos: [],
    childRelationships,
    fields: [
      { name: 'Id', type: 'id', createable: false, nillable: false },
      ...fields.map((f) => ({ type: 'string', createable: true, nillable: true, ...f })),
    ].map((f) => ({ referenceTo: [], relationshipName: null, cascadeDelete: false, ...f })),
  } as unknown as DescribeSObjectResult;
}

const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [{ name: 'Name' }],
    [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
  ),
  Contact: object('Contact', '003', [
    { name: 'LastName' },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
  ]),
};

const ROWS: Record<string, FakeRow[]> = {
  Account: [{ Id: ACCOUNT, Name: 'Example' }],
  Contact: [{ Id: CONTACT, LastName: 'Key', AccountId: ACCOUNT }],
};

/** A flow of the target that starts after a contact is created, unless its creator holds `Load_Data`. */
const WELCOME_FLOW = {
  ApiName: 'Contact_Welcome',
  Label: 'Contact welcome',
  TriggerType: 'RecordAfterSave',
  RecordTriggerType: 'Create',
  TriggerObjectOrEvent: { QualifiedApiName: 'Contact' },
  ActiveVersionId: WELCOME_VERSION,
};

/**
 * An org holding an account and its contact. Its automation is the target's
 * welcome flow; what it is asked over each API is recorded, and a refusal of
 * the flows can be set.
 */
function fakeOrg({ refuseFlows }: { refuseFlows?: Error } = {}) {
  const regular: string[] = [];
  const tooling: string[] = [];
  const written: string[] = [];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: unknown[]) => {
        written.push(name);
        return records.map((_, i) => ({
          id: `${DESCRIBES[name].keyPrefix}00000000090${i}AAA`,
          success: true,
          errors: [],
        }));
      },
    }),
    describe$: async (name: string) => DESCRIBES[name],
    describeGlobal: async () => ({
      sobjects: Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    }),
    query: async (soql: string) => {
      regular.push(soql);
      if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
        return page([{ Id: '00D000000000002AAA', IsSandbox: true }]);
      }
      if (soql.includes(' FROM FlowDefinitionView ')) {
        if (refuseFlows) throw refuseFlows;
        return page([WELCOME_FLOW]);
      }
      const counted = /^SELECT COUNT\(\) FROM (\w+)$/.exec(soql);
      if (counted) return { totalSize: (ROWS[counted[1]] ?? []).length, done: true, records: [] };
      if (soql.includes(' FROM RecordType ')) return page([]);
      return page(selectRows(ROWS, soql));
    },
    queryMore: async () => page([]),
    tooling: {
      query: async (soql: string) => {
        tooling.push(soql);
        if (soql.includes(' FROM ApexTrigger ')) return page([]);
        return page([{ Metadata: { start: { filterFormula: 'NOT({!$Permission.Load_Data})' } } }]);
      },
      queryMore: async () => page([]),
    },
    request: async () => ({}),
  };
  return { conn: conn as unknown as Connection, regular, tooling, written };
}

describe('sandforge-clone target automation', () => {
  let printed: string[];
  let errored: string[];
  let stdout: string;
  let orgs: { SRC: ReturnType<typeof fakeOrg>; TGT: ReturnType<typeof fakeOrg> };

  /** Both fake orgs answering for the aliases of `argv`. */
  function withOrgs(target = fakeOrg()): void {
    orgs = { SRC: fakeOrg(), TGT: target };
    vi.mocked(loadOrg).mockImplementation(async (alias) => ({
      alias,
      username: '',
      instanceUrl: `https://${alias.toLowerCase()}.example.com`,
      accessToken: 'token',
    }));
    vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as keyof typeof orgs].conn);
  }

  /** Run the command; the exit code it stopped on, if it stopped on one. */
  async function run(args: string[]): Promise<number | undefined> {
    try {
      await main(args);
      return undefined;
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
  }

  beforeEach(() => {
    printed = [];
    errored = [];
    stdout = '';
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errored.push(String(line));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what the target runs on the objects it writes, and the permission that keeps a flow quiet, before it writes', async () => {
    withOrgs();

    expect(await run(argv('--skip-preflight'))).toBeUndefined();

    const said = printed.indexOf(
      'target automation: what TGT runs on the 2 object(s) the run writes',
    );
    expect(said).toBeGreaterThan(-1);
    expect(printed.slice(said, said + 5)).toEqual([
      'target automation: what TGT runs on the 2 object(s) the run writes',
      '  Contact',
      '    on insert: flow "Contact welcome" (after save; not for a user with Load_Data)',
      '  bypass: assign Load_Data to the user the run writes as, and the flows whose start condition excludes them stay quiet',
      '  read in 3 request(s) to TGT',
    ]);
    // Said before the run read a row, and before it wrote one.
    expect(said).toBeLessThan(printed.indexOf('record-type mapping…'));
    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
  });

  it('reads it from the target alone: its flows over the regular API, its triggers and start conditions over the Tooling API', async () => {
    withOrgs();

    expect(await run(argv('--dry-run', '--skip-preflight'))).toBeUndefined();

    expect(
      orgs.TGT.regular.filter((soql) => soql.includes(' FROM FlowDefinitionView ')),
    ).toHaveLength(1);
    expect(orgs.TGT.tooling.map((soql) => /FROM (\w+)/.exec(soql)?.[1])).toEqual([
      'ApexTrigger',
      'Flow',
    ]);
    expect(orgs.TGT.tooling[1]).toContain(WELCOME_VERSION);
    expect(orgs.SRC.tooling).toEqual([]);
    expect(orgs.SRC.regular.some((soql) => soql.includes(' FROM FlowDefinitionView '))).toBe(false);
  });

  it('prints the summary on stderr in --json mode, and gives it under targetAutomation', async () => {
    withOrgs();

    expect(await run(argv('--dry-run', '--skip-preflight', '--json'))).toBeUndefined();

    expect(printed).toEqual([]);
    expect(errored).toContain(
      '    on insert: flow "Contact welcome" (after save; not for a user with Load_Data)',
    );
    const summary = JSON.parse(stdout) as { targetAutomation: Record<string, unknown> };
    expect(summary.targetAutomation).toEqual({
      objectsRead: ['Account', 'Contact'],
      objects: [
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Contact_Welcome',
              label: 'Contact welcome',
              timing: 'afterSave',
              startsOn: 'create',
              condition: 'read',
              permissions: [{ name: 'Load_Data', bypass: true }],
            },
          ],
          triggers: [],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 3,
    });
  });

  it('says what it could not read, and the run goes on', async () => {
    withOrgs(
      fakeOrg({
        refuseFlows: Object.assign(new Error('insufficient access rights on object id'), {
          name: 'INSUFFICIENT_ACCESS',
          errorCode: 'INSUFFICIENT_ACCESS',
        }),
      }),
    );

    expect(await run(argv('--skip-preflight'))).toBeUndefined();

    expect(printed).toContain(
      '  the flows could not be read: INSUFFICIENT_ACCESS: insufficient access rights on object id',
    );
    expect(printed).toContain('  nothing found in what could be read');
    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
  });

  it('reads nothing of it when it only lists the objects of the graph', async () => {
    withOrgs();

    expect(await run(argv('--list-objects'))).toBeUndefined();

    expect(orgs.TGT.tooling).toEqual([]);
    expect(orgs.TGT.regular.some((soql) => soql.includes(' FROM FlowDefinitionView '))).toBe(false);
  });
});
