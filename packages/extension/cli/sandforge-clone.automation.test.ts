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

/** A flow of the target that starts after a contact is updated, unless its writer holds `Load_Data`. */
const SYNC_FLOW = {
  ApiName: 'Contact_Sync',
  Label: 'Contact sync',
  TriggerType: 'RecordAfterSave',
  RecordTriggerType: 'Update',
  TriggerObjectOrEvent: { QualifiedApiName: 'Contact' },
  ActiveVersionId: '301000000000002AAA',
};

/**
 * An org holding an account and its contact. Its automation is the target's
 * welcome flow, or none, with `moreFlows`, and, unless told, a duplicate rule
 * on contacts; the custom permission `Load_Data` is held by `permissionSets`,
 * none unless told. What it is asked over each API is recorded, with the
 * headers each write sent, a refusal of the flows can be set, and what its
 * limits say.
 */
function fakeOrg({
  refuseFlows,
  noFlows = false,
  moreFlows = [],
  permissionSets = [],
  limits = {},
  duplicateRules = [
    { DeveloperName: 'Contact_Rule', MasterLabel: 'Contact rule', SobjectType: 'Contact' },
  ],
  validationRules = [],
  duplicateActions = {},
}: {
  refuseFlows?: Error;
  noFlows?: boolean;
  moreFlows?: Array<Record<string, unknown>>;
  /** The permission sets that include `Load_Data`: their API names, and what each grants. */
  permissionSets?: Array<{ name: string; grants: number }>;
  limits?: unknown;
  duplicateRules?: Array<Record<string, unknown>>;
  /** Its active validation rules, each with a formula a permission keeps quiet. */
  validationRules?: Array<Record<string, unknown>>;
  /** What its duplicate rules do on insert, by full name, as the Metadata API reads them. */
  duplicateActions?: Record<string, Record<string, unknown>>;
} = {}) {
  const regular: string[] = [];
  const tooling: string[] = [];
  const written: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: unknown[], options?: { headers?: Record<string, string> }) => {
        written.push(name);
        headers.push(options?.headers);
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
      if (soql.includes(" ProcessType = 'Workflow'")) return page([]);
      if (soql.includes(' FROM FlowDefinitionView ')) {
        if (refuseFlows) throw refuseFlows;
        return page([...(noFlows ? [] : [WELCOME_FLOW]), ...moreFlows]);
      }
      if (soql.includes(' FROM DuplicateRule ')) return page(duplicateRules);
      if (soql.includes(' FROM UserSetupEntityAccess ')) return page([]);
      if (soql.includes(' FROM CustomPermission ')) {
        return page([
          { Id: '0CP000000000001AAA', DeveloperName: 'Load_Data', NamespacePrefix: null },
        ]);
      }
      if (soql.includes(" WHERE SetupEntityType = 'CustomPermission' ")) {
        return page(
          permissionSets.map(({ name }, i) => ({
            SetupEntityId: '0CP000000000001AAA',
            ParentId: `0PS00000000000${i}AAA`,
            Parent: { Name: name, Label: name, NamespacePrefix: null },
          })),
        );
      }
      if (/ FROM (SetupEntityAccess|ObjectPermissions) WHERE ParentId IN /.test(soql)) {
        const objects = soql.includes('FROM ObjectPermissions');
        return page(
          permissionSets.map(({ grants }, i) => ({
            ParentId: `0PS00000000000${i}AAA`,
            n: objects ? 0 : grants,
          })),
        );
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
        if (soql.includes(' FROM WorkflowRule')) return page([]);
        if (soql.includes(' FROM ValidationRule WHERE Active = true')) return page(validationRules);
        if (soql.includes(' FROM ValidationRule WHERE Id ')) {
          return page([
            {
              Metadata: {
                errorConditionFormula: 'AND(NOT($Permission.Load_Data), ISBLANK(LastName))',
              },
            },
          ]);
        }
        return page([{ Metadata: { start: { filterFormula: 'NOT({!$Permission.Load_Data})' } } }]);
      },
      queryMore: async () => page([]),
    },
    request: async (request: unknown) => {
      const url = typeof request === 'string' ? request : (request as { url?: string }).url;
      return url === '/limits' ? limits : {};
    },
    metadata: {
      read: async (_type: string, fullNames: string[]) =>
        fullNames.map((fullName) => ({ fullName, ...duplicateActions[fullName] })),
    },
  };
  return { conn: conn as unknown as Connection, regular, tooling, written, headers };
}

describe('sandforge-clone target automation', () => {
  let printed: string[];
  let errored: string[];
  let stdout: string;
  let stderr: string;
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
    stderr = '';
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
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
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

    expect(await run(argv('--skip-preflight', '--accept-automation'))).toBeUndefined();

    const said = printed.indexOf(
      'target automation: what TGT runs on the 2 object(s) the run writes',
    );
    expect(said).toBeGreaterThan(-1);
    expect(printed.slice(said, said + 7)).toEqual([
      'target automation: what TGT runs on the 2 object(s) the run writes',
      '  Contact',
      '    on insert: flow "Contact welcome" (after save; not for a user with Load_Data (not held))',
      '    duplicate rules: "Contact rule": the run saves a record a rule only alerts on; a rule that blocks still refuses it',
      '  bypass: assign Load_Data to the user the run writes as, and the flows whose start condition excludes them stay quiet',
      '    Load_Data: no permission set of TGT holds it: an admin creates one that includes it',
      // Flows, triggers, processes, workflow rules and duplicate rules; the
      // start condition; the permissions of the user the run writes as; the
      // custom permission it does not hold, and the permission sets that hold
      // it: none.
      '  read in 9 request(s) to TGT',
    ]);
    // Said before the run read a row, and before it wrote one.
    expect(said).toBeLessThan(printed.indexOf('record-type mapping…'));
    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
  });

  it('reads it from the target alone: its flows and rules over the regular API, its triggers, workflow rules and start conditions over the Tooling API', async () => {
    withOrgs();

    expect(await run(argv('--dry-run', '--skip-preflight'))).toBeUndefined();

    expect(
      orgs.TGT.regular.filter((soql) => soql.includes(' FROM FlowDefinitionView ')),
    ).toHaveLength(2);
    // Then the read of the target's gaps, which asks its validation rules there.
    expect(orgs.TGT.tooling.map((soql) => /FROM (\w+)/.exec(soql)?.[1])).toEqual([
      'ApexTrigger',
      'WorkflowRule',
      'Flow',
      'ValidationRule',
    ]);
    expect(orgs.TGT.tooling[2]).toContain(WELCOME_VERSION);
    expect(orgs.SRC.tooling).toEqual([]);
    expect(orgs.SRC.regular.some((soql) => soql.includes(' FROM FlowDefinitionView '))).toBe(false);
  });

  it("keeps the target's assignment rules off on every write, and applies them when asked", async () => {
    // The fake target runs a flow on insert: a real run goes on only when told to.
    withOrgs();
    expect(await run(argv('--skip-preflight', '--accept-automation'))).toBeUndefined();
    expect(orgs.TGT.headers).toEqual([
      { 'Sforce-Duplicate-Rule-Header': 'allowSave=true', 'Sforce-Auto-Assign': 'FALSE' },
      { 'Sforce-Duplicate-Rule-Header': 'allowSave=true', 'Sforce-Auto-Assign': 'FALSE' },
    ]);

    withOrgs();
    expect(
      await run(argv('--skip-preflight', '--accept-automation', '--apply-assignment-rules')),
    ).toBeUndefined();
    expect(orgs.TGT.headers.map((sent) => sent?.['Sforce-Auto-Assign'])).toEqual(['TRUE', 'TRUE']);
    expect(printed).toContain('\nexecuting… (REAL, ASSIGNMENT-RULES)');
  });

  it('prints the summary on stderr in --json mode, and gives it under targetAutomation', async () => {
    withOrgs();

    expect(await run(argv('--dry-run', '--skip-preflight', '--json'))).toBeUndefined();

    expect(printed).toEqual([]);
    expect(errored).toContain(
      '    on insert: flow "Contact welcome" (after save; not for a user with Load_Data (not held))',
    );
    const summary = JSON.parse(stdout) as {
      applyAssignmentRules: boolean;
      targetAutomation: Record<string, unknown>;
    };
    expect(summary.applyAssignmentRules).toBe(false);
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
              permissions: [{ name: 'Load_Data', bypass: true, held: false }],
              paths: [],
              messages: [],
              switches: [],
            },
          ],
          triggers: [],
          processes: [],
          workflowRules: [],
          assignmentRules: [],
          duplicateRules: [{ name: 'Contact rule', developerName: 'Contact_Rule' }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      definitionsNotRead: 0,
      definitionsBound: 15,
      bypassGrants: [{ permission: 'Load_Data', permissionSets: [] }],
      requests: 9,
    });
  });

  /** A target that refuses its flows to the user the run reads as. */
  const flowsRefused = () =>
    fakeOrg({
      refuseFlows: Object.assign(new Error('insufficient access rights on object id'), {
        name: 'INSUFFICIENT_ACCESS',
        errorCode: 'INSUFFICIENT_ACCESS',
      }),
      duplicateRules: [],
    });

  it('says what it could not read, and goes on when told to', async () => {
    withOrgs(flowsRefused());

    expect(await run(argv('--skip-preflight', '--accept-automation'))).toBeUndefined();

    expect(printed).toContain(
      '  the flows could not be read: INSUFFICIENT_ACCESS: insufficient access rights on object id',
    );
    expect(printed).toContain('  nothing found in what could be read');
    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
  });

  it('writes nothing when a flow of the target fires on insert, naming it, unless told to go on', async () => {
    // It printed the flow, then wrote anyway, and the flow ran on each record.
    withOrgs();

    expect(await run(argv('--skip-preflight'))).toBe(1);

    expect(stderr).toBe(
      'TGT runs automation on the records this clone inserts: Contact: flow "Contact welcome". ' +
        'No permission set of TGT holds Load_Data: an admin creates one that includes it, and ' +
        'assigns it to the user the clone writes as. Nothing was written. Add ' +
        '--accept-automation to clone all the same, or turn that automation off in TGT first.\n',
    );
    expect(orgs.TGT.written).toEqual([]);
    // Refused before it read a row of the source: discovery counted them only.
    expect(
      orgs.SRC.regular.some((soql) => /^SELECT (?!COUNT\(\)).* FROM Contact\b/.test(soql)),
    ).toBe(false);
    expect(printed).not.toContain('record-type mapping…');
  });

  it('writes nothing when what fires as it updates the records it inserted would run, naming it, unless told to go on', async () => {
    // With --upsert, a record the target holds is written over: an update.
    withOrgs(fakeOrg({ noFlows: true, moreFlows: [SYNC_FLOW] }));

    expect(await run(argv('--skip-preflight', '--upsert'))).toBe(1);

    expect(stderr).toContain(
      'TGT runs automation as this clone updates records it inserted (a record the target holds ' +
        'written over by --upsert): Contact: flow "Contact sync".',
    );
    expect(orgs.TGT.written).toEqual([]);

    withOrgs(fakeOrg({ noFlows: true, moreFlows: [SYNC_FLOW] }));
    expect(await run(argv('--skip-preflight', '--upsert', '--accept-automation'))).toBeUndefined();
    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
  });

  it('asks nothing of a flow on update when the clone updates nothing', async () => {
    withOrgs(fakeOrg({ noFlows: true, moreFlows: [SYNC_FLOW] }));

    expect(await run(argv('--skip-preflight'))).toBeUndefined();

    expect(stderr).toBe('');
    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
  });

  it('gives in its refusal the command that assigns the smallest permission set holding the bypass, and runs none', async () => {
    withOrgs(
      fakeOrg({
        permissionSets: [
          { name: 'Integration', grants: 120 },
          { name: 'Data_Load', grants: 1 },
        ],
      }),
    );
    vi.mocked(loadOrg).mockImplementation(async (alias) => ({
      alias,
      username: alias === 'TGT' ? 'loader@example.com.dev' : '',
      instanceUrl: `https://${alias.toLowerCase()}.example.com`,
      accessToken: 'token',
    }));

    expect(await run(argv('--skip-preflight'))).toBe(1);

    expect(stderr).toContain(
      'Data_Load is the smallest permission set of TGT that holds Load_Data; Integration holds ' +
        'it too. Assigned to the user the clone writes as, it keeps quiet what Load_Data ' +
        'excludes: sf org assign permset --name Data_Load --target-org TGT --on-behalf-of ' +
        'loader@example.com.dev',
    );
    expect(printed).toContain(
      '    Load_Data: held by permission set Data_Load, the smallest; also held by Integration: ' +
        'sf org assign permset --name Data_Load --target-org TGT --on-behalf-of loader@example.com.dev',
    );
    // Shown, never run: nothing was assigned, nor written.
    expect(orgs.TGT.written).toEqual([]);
  });

  it('writes nothing when it could not read what fires, unless told to go on', async () => {
    withOrgs(flowsRefused());

    expect(await run(argv('--skip-preflight'))).toBe(1);

    expect(stderr).toContain(
      'The flows of TGT could not be read (INSUFFICIENT_ACCESS: insufficient access rights on ' +
        'object id), so what fires as the clone inserts is not known. Nothing was written.',
    );
    expect(orgs.TGT.written).toEqual([]);
  });

  it('runs a dry run all the same, saying what a real run would need', async () => {
    withOrgs();

    expect(await run(argv('--skip-preflight', '--dry-run'))).toBeUndefined();

    expect(printed).toContain(
      '  a real run writes nothing without --accept-automation: see what fires as it inserts ' +
        'and updates, or could not be read, above',
    );
    expect(stderr).toBe('');
    expect(orgs.TGT.written).toEqual([]);
  });

  it('writes when nothing fires on insert, without being told to', async () => {
    withOrgs(fakeOrg({ noFlows: true }));

    expect(await run(argv('--skip-preflight'))).toBeUndefined();

    expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
  });

  describe('what the target holds against the rows', () => {
    const NAME_RULE = {
      Id: '03d000000000001AAA',
      ValidationName: 'Name_Format',
      NamespacePrefix: null,
      ErrorDisplayField: 'LastName',
      ErrorMessage: 'Use capitals',
      EntityDefinition: { QualifiedApiName: 'Contact' },
    };
    /** A target running no flow, with a rule on contacts' names and a duplicate rule that blocks. */
    const withGaps = () =>
      fakeOrg({
        noFlows: true,
        validationRules: [NAME_RULE],
        duplicateActions: { 'Contact.Contact_Rule': { actionOnInsert: 'Block' } },
        limits: { DailyApiRequests: { Max: 15_000, Remaining: 14_000 } },
      });

    it('says it before a row is read, on a dry run too, from the target alone', async () => {
      withOrgs(withGaps());

      expect(await run(argv('--dry-run', '--skip-preflight'))).toBeUndefined();

      const said = printed.indexOf(
        'target gaps: what TGT holds against the rows, read from its metadata',
      );
      expect(said).toBeGreaterThan(-1);
      expect(printed.slice(said + 1, said + 6)).toEqual([
        '  Contact',
        '    warning: duplicate rule "Contact rule": blocks an insert it matches: a row it ' +
          'matches is refused, whatever allowSave says',
        '    warning: validation rule "Name_Format" on LastName: "Use capitals" (not when ' +
          '$Permission.Load_Data; a row it refuses goes again without LastName)',
        '  info: API budget: the run takes at most about 4 call(s) (2 write(s) of 200 rows, 2 read(s)), ' +
          'counted on whole tables; 14000 of 15000 daily requests left',
        // The rules, the duplicate rules, the limits, the two objects described
        // in the target, the formula, the duplicate rule's action, and the
        // permissions of the user: the source's describes were discovery's.
        '  read in 8 request(s) to TGT',
      ]);
      expect(said).toBeLessThan(printed.indexOf('record-type mapping…'));
      expect(orgs.SRC.tooling).toEqual([]);
      expect(orgs.TGT.written).toEqual([]);
    });

    it('stops nothing: a real run writes all the same', async () => {
      withOrgs(withGaps());

      expect(await run(argv('--skip-preflight'))).toBeUndefined();

      expect(printed).toContain(
        'target gaps: what TGT holds against the rows, read from its metadata',
      );
      expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
    });

    it('gives them under targetGaps in --json', async () => {
      withOrgs(withGaps());

      expect(await run(argv('--dry-run', '--skip-preflight', '--json'))).toBeUndefined();

      const summary = JSON.parse(stdout) as {
        targetGaps: { gaps: Array<Record<string, unknown>>; unread: unknown[]; requests: number };
      };
      expect(summary.targetGaps.requests).toBe(8);
      expect(summary.targetGaps.unread).toEqual([]);
      expect(summary.targetGaps.gaps.map((gap) => [gap.kind, gap.severity, gap.id])).toEqual([
        ['duplicate_rule', 'warning', 'duplicate_rule|Contact|||Contact_Rule'],
        ['validation_rule', 'warning', 'validation_rule|Contact|LastName||Name_Format'],
        ['api_budget', 'info', 'api_budget|Account|||'],
      ]);
    });
  });

  describe('before the first write', () => {
    const STORAGE = { DataStorageMB: { Max: 200, Remaining: 150 } };

    it('says the records it is about to write per object, and the data storage they take', async () => {
      withOrgs(fakeOrg({ noFlows: true, limits: STORAGE }));

      expect(await run(argv('--skip-preflight'))).toBeUndefined();

      const at = printed.indexOf(
        'write gate: 2 record(s) to write to TGT, about 0.01 MB of data storage',
      );
      expect(at).toBeGreaterThan(-1);
      expect(printed.slice(at + 1, at + 4)).toEqual([
        `  ${'Account'.padEnd(42)}${'1'.padStart(8)}`,
        `  ${'Contact'.padEnd(42)}${'1'.padStart(8)}`,
        '  data storage of TGT: 150 MB left of 200 MB',
      ]);
      expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
    });

    it('refuses a run past --max-total before it writes anything', async () => {
      withOrgs(fakeOrg({ noFlows: true, limits: STORAGE }));

      expect(await run(argv('--skip-preflight', '--max-total', '1'))).toBe(1);

      expect(stderr).toBe(
        'The run would write 2 records, more than --max-total 1: narrow the clone (--max, ' +
          '--exclude-object, --filter), or raise --max-total. Nothing was written.\n',
      );
      expect(orgs.TGT.written).toEqual([]);
    });

    it('refuses records the target has no data storage left for, before it writes anything', async () => {
      withOrgs(fakeOrg({ noFlows: true, limits: { DataStorageMB: { Max: 200, Remaining: 0 } } }));

      expect(await run(argv('--skip-preflight'))).toBe(1);

      expect(stderr).toBe(
        'The records to write take about 0.01 MB of data storage, and TGT has 0 MB left of ' +
          '200 MB: leave objects out, lower the records per object, or free data storage in ' +
          'TGT. Nothing was written.\n',
      );
      expect(orgs.TGT.written).toEqual([]);
    });

    it('says when it could not read what the target has left, and writes all the same', async () => {
      withOrgs(fakeOrg({ noFlows: true }));

      expect(await run(argv('--skip-preflight'))).toBeUndefined();

      expect(
        printed.some((line) =>
          line.startsWith('  the data storage TGT has left could not be read ('),
        ),
      ).toBe(true);
      expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
    });

    it('says on a dry run what would stop a real one there, and writes nothing', async () => {
      withOrgs(fakeOrg({ noFlows: true, limits: STORAGE }));

      expect(await run(argv('--skip-preflight', '--dry-run', '--max-total', '1'))).toBe(undefined);

      expect(printed).toContain(
        '  a real run would be refused: The run would write 2 records, more than --max-total 1: ' +
          'narrow the clone (--max, --exclude-object, --filter), or raise --max-total.',
      );
      expect(orgs.TGT.written).toEqual([]);
    });
  });

  it('reads nothing of it when it only lists the objects of the graph', async () => {
    withOrgs();

    expect(await run(argv('--list-objects'))).toBeUndefined();

    expect(orgs.TGT.tooling).toEqual([]);
    expect(orgs.TGT.regular.some((soql) => soql.includes(' FROM FlowDefinitionView '))).toBe(false);
  });
});
