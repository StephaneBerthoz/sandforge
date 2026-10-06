import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Connection, DescribeSObjectResult } from 'jsforce';
import type { ForgeRehearsal } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});

import { loadOrg, makeConn } from './sfSession.js';
import { selectRows, type FakeRow } from '../src/test/fakeSoql.js';
import { main, parseArgs, rehearsalLines, rehearsalPlanLines } from './sandforge-clone';

/*
 * --rehearse: the clone read and prepared as a real run would, a sample of
 * its rows created in the target in composite calls each rolled back whole,
 * and the platform's verdict printed. Nothing the target is sent through the
 * run's writers.
 */

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const ACCOUNT = '001000000000001AAA';
const CONTACT = '003000000000001AAA';

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

const HALTED = {
  body: [{ errorCode: 'PROCESSING_HALTED', message: 'halted' }],
  httpStatusCode: 400,
};

/**
 * An org holding an account and its contact, running no automation. As a
 * target, it answers a composite call as the platform does: a contact the
 * `refuseContacts` flag refuses stops the call at its request, which keeps the
 * rows' verdicts; otherwise every request is stopped and the closing update
 * fails on its own.
 */
function fakeOrg({ refuseContacts = false, sandbox = true, flows = false } = {}) {
  const created: string[] = [];
  const composites: Array<{
    allOrNone: boolean;
    compositeRequest: Array<Record<string, unknown>>;
  }> = [];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const rows: Record<string, FakeRow[]> = {
    Account: [{ Id: ACCOUNT, Name: 'Example' }],
    Contact: [{ Id: CONTACT, LastName: 'Key', AccountId: ACCOUNT }],
  };
  const conn = {
    version: '66.0',
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: unknown[]) => {
        created.push(name);
        return records.map(() => ({ id: '', success: true, errors: [] }));
      },
    }),
    describe$: async (name: string) => DESCRIBES[name],
    describeGlobal: async () => ({
      sobjects: Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    }),
    query: async (soql: string) => {
      if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
        return page([{ Id: '00D000000000002AAA', IsSandbox: sandbox }]);
      }
      if (soql === 'SELECT OrganizationType FROM Organization LIMIT 1') {
        return page([{ OrganizationType: 'Enterprise Edition' }]);
      }
      if (soql.includes(' FROM FlowDefinitionView ')) {
        return page(
          flows && !soql.includes(" ProcessType = 'Workflow'")
            ? [
                {
                  ApiName: 'Contact_Welcome',
                  Label: 'Contact welcome',
                  TriggerType: 'RecordAfterSave',
                  RecordTriggerType: 'Create',
                  TriggerObjectOrEvent: { QualifiedApiName: 'Contact' },
                  ActiveVersionId: '301000000000001AAA',
                },
              ]
            : [],
        );
      }
      if (/ FROM (DuplicateRule|UserSetupEntityAccess|RecordType) /.test(soql)) return page([]);
      const counted = /^SELECT COUNT\(\) FROM (\w+)$/.exec(soql);
      if (counted) return { totalSize: (rows[counted[1]] ?? []).length, done: true, records: [] };
      return page(selectRows(rows, soql));
    },
    queryMore: async () => page([]),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
    },
    request: async (request: unknown) => {
      const { method, url, body } = request as { method?: string; url?: string; body?: string };
      if (method !== 'POST' || url !== '/composite') return {};
      const sent = JSON.parse(body ?? '{}') as (typeof composites)[number];
      composites.push(sent);
      const collections = sent.compositeRequest.slice(0, -1);
      const answers: unknown[] = collections.map(() => HALTED);
      const at = collections.findIndex((sub) =>
        ((sub.body as { records: Array<{ attributes: { type: string } }> }).records ?? []).some(
          (r) => r.attributes.type === 'Contact',
        ),
      );
      if (refuseContacts && at !== -1) {
        const records = (collections[at].body as { records: unknown[] }).records;
        answers[at] = {
          body: records.map(() => ({
            success: false,
            errors: [
              { statusCode: 'REQUIRED_FIELD_MISSING', message: 'Champs requis', fields: ['Email'] },
            ],
          })),
          httpStatusCode: 200,
        };
        answers.push(HALTED);
      } else {
        answers.push({ body: [{ errorCode: 'NOT_FOUND', message: 'x' }], httpStatusCode: 404 });
      }
      return { compositeResponse: answers };
    },
  };
  return { conn: conn as unknown as Connection, created, composites };
}

describe('sandforge-clone --rehearse', () => {
  let printed: string[];
  let stdout: string;
  let stderr: string;
  let orgs: { SRC: ReturnType<typeof fakeOrg>; TGT: ReturnType<typeof fakeOrg> };

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
    stdout = '';
    stderr = '';
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

  it('prints the cost and the verdicts, creates nothing through the run’s writers, and ends with 0', async () => {
    withOrgs();
    expect(await run(argv('--rehearse', '--skip-preflight'))).toBeUndefined();
    expect(orgs.TGT.created).toEqual([]);
    expect(orgs.TGT.composites).toHaveLength(1);
    expect(orgs.TGT.composites[0].allOrNone).toBe(true);
    expect(printed).toContain(
      'rehearsal: 2 of the 2 record(s) the run would create, created in TGT and rolled back with each call',
    );
    expect(printed).toContain(
      'rehearsed in TGT: 2 judged, 2 would save, 0 refused, 0 not judged (1 call(s), every write rolled back)',
    );
  });

  it('prints each refusal with its status code, field and rows', async () => {
    withOrgs(fakeOrg({ refuseContacts: true }));
    expect(await run(argv('--rehearse', '--skip-preflight'))).toBeUndefined();
    expect(printed).toContain(
      'rehearsed in TGT: 2 judged, 1 would save, 1 refused, 0 not judged (1 call(s), every write rolled back)',
    );
    expect(printed).toContain('  REFUSED  Contact.Email: REQUIRED_FIELD_MISSING, 1 row(s)');
  });

  it('gives the verdicts under rehearsal with --json, stdout carrying the JSON alone', async () => {
    withOrgs();
    expect(await run(argv('--rehearse', '--skip-preflight', '--json'))).toBeUndefined();
    expect(printed).toEqual([]);
    const summary = JSON.parse(stdout) as { action: string; rehearsal: ForgeRehearsal };
    expect(summary.action).toBe('rehearse');
    expect(summary.rehearsal).toMatchObject({ rows: 2, judged: 2, passed: 2, calls: 1 });
  });

  it('sends nothing to a target that runs automation on insert without --accept-automation', async () => {
    withOrgs(fakeOrg({ flows: true }));
    expect(await run(argv('--rehearse', '--skip-preflight'))).toBe(1);
    expect(orgs.TGT.composites).toEqual([]);
  });

  it('sends nothing to a production org', async () => {
    withOrgs(fakeOrg({ sandbox: false }));
    expect(await run(argv('--rehearse', '--skip-preflight'))).toBe(1);
    expect(stderr).toContain('is a production org');
    expect(orgs.TGT.composites).toEqual([]);
  });

  it('refuses what a rehearsal cannot do', () => {
    for (const flag of ['--dry-run', '--upsert', '--files', '--list-objects']) {
      stderr = '';
      expect(() => parseArgs(argv('--rehearse', flag))).toThrow(ExitCalled);
      expect(stderr).toBe(`--rehearse does not go with ${flag}.\n`);
    }
    expect(parseArgs(argv('--rehearse')).rehearse).toBe(true);
    expect(parseArgs(argv()).rehearse).toBe(false);
  });
});

describe("a rehearsal's lines", () => {
  it('say the records created of those the run would, the calls, and the objects', () => {
    expect(
      rehearsalPlanLines(
        {
          rows: 300,
          sampled: 4,
          calls: 1,
          maxCalls: 5,
          objects: [{ objectApiName: 'Case', rows: 4 }],
        },
        'TGT',
      ),
    ).toEqual([
      'rehearsal: 4 of the 300 record(s) the run would create, created in TGT and rolled back with each call',
      '  1 composite call(s), 5 at most if a call stops at a refused record',
      `  ${'Case'.padEnd(40)} 4`,
    ]);
  });

  it('say a refused value with its record type, the rows of the run it stands for, and what was not judged', () => {
    const lines = rehearsalLines(
      {
        gaps: [
          {
            id: 'x',
            kind: 'picklist_value_refused',
            severity: 'warning',
            source: 'rehearsal',
            objectApiName: 'Case',
            field: 'Origin',
            recordType: 'Support',
            value: 'Fax',
            rows: 1,
            detail: {
              statusCode: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
              rowsOfTheRun: 40,
              writtenWithoutTheField: true,
            },
            decisions: ['map_value'],
          },
        ],
        rows: 60,
        sampled: 3,
        judged: 2,
        passed: 1,
        notJudged: 1,
        notJudgedWhy: [{ objectApiName: 'CaseComment', rows: 1, reason: 'parent_refused' }],
        updatesNotRehearsed: 2,
        calls: 1,
        plannedCalls: 1,
      },
      'TGT',
    );
    expect(lines).toEqual([
      'rehearsed in TGT: 2 judged, 1 would save, 1 refused, 1 not judged (1 call(s), every write rolled back)',
      '  refused  Case.Origin "Fax" (record type Support): INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST, 1 row(s), 40 in the run (a real run writes it again without the field)',
      '  not judged  CaseComment: 1 row(s), a record it names was refused',
      '  not rehearsed: the 2 update(s) the run makes after its inserts',
    ]);
  });
});
