import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection, DescribeSObjectResult } from 'jsforce';
import type { ForgeConfig, ForgeGraph } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { loadOrg, makeConn } from './sfSession.js';
import {
  cliRunSetup,
  cloneInputLine,
  main,
  parseArgs,
  parseRunSummary,
  removalPlan,
  removalPlanLines,
  runSummaryOfFile,
  tablesExecuteOptions,
  tablesLeftOut,
  tablesNotReached,
  tablesQueryOf,
  tablesRunConfig,
} from './sandforge-clone';
import { ForgeOrchestrator } from '../src/modules/forge/ForgeOrchestrator.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  ForgeExecutor,
} from '../src/modules/forge/ForgeExecutor.js';
import type { GraphDiscoveryService } from '../src/modules/forge/GraphDiscoveryService.js';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const MARK = 'TABLES-TEST';
const TARGET_ORG = '00D000000000002AAA';
const OWNER = '005000000000001AAA';

/** A clone of the marked accounts and their marked contacts from SRC to TGT, with `extra` flags. */
function argv(...extra: string[]): string[] {
  return [
    'node',
    'sandforge-clone.ts',
    '--object',
    'Account',
    '--where',
    `AccountNumber = '${MARK}'`,
    '--object',
    'Contact',
    '--where',
    `Department = '${MARK}'`,
    '--source',
    'SRC',
    '--target',
    'TGT',
    '--skip-preflight',
    ...extra,
  ];
}

/** Run the command and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(args);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
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
    [{ name: 'Name' }, { name: 'AccountNumber' }],
    [
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
      { childSObject: 'Case', field: 'AccountId', relationshipName: 'Cases' },
    ],
  ),
  Contact: object('Contact', '003', [
    { name: 'LastName' },
    { name: 'Department' },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
    { name: 'OwnerId', type: 'reference', referenceTo: ['User'] },
  ]),
  Case: object('Case', '500', [
    { name: 'Subject' },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
  ]),
};

const ROWS: Record<string, Array<Record<string, string>>> = {
  Account: [
    { Id: '001000000000001AAA', Name: 'Marked one', AccountNumber: MARK },
    { Id: '001000000000002AAA', Name: 'Marked two', AccountNumber: MARK },
    { Id: '001000000000003AAA', Name: 'Not marked', AccountNumber: 'OTHER' },
  ],
  Contact: [
    {
      Id: '003000000000001AAA',
      LastName: 'One',
      Department: MARK,
      AccountId: '001000000000001AAA',
      OwnerId: OWNER,
    },
    {
      Id: '003000000000002AAA',
      LastName: 'Two',
      Department: MARK,
      AccountId: '001000000000002AAA',
      OwnerId: OWNER,
    },
    {
      Id: '003000000000003AAA',
      LastName: 'Three',
      Department: MARK,
      AccountId: '001000000000002AAA',
      OwnerId: OWNER,
    },
    {
      Id: '003000000000004AAA',
      LastName: 'Not marked',
      Department: 'OTHER',
      AccountId: '001000000000003AAA',
      OwnerId: OWNER,
    },
  ],
  Case: [{ Id: '500000000000001AAA', Subject: 'Never named', AccountId: '001000000000001AAA' }],
};

/** Whether `row` meets every `Field = 'value'` and `Id > 'id'` term of `where`. */
function meets(row: Record<string, string>, where: string | undefined): boolean {
  if (!where) return true;
  for (const [, field, value] of where.matchAll(/(\w+) = '([^']*)'/g)) {
    if (row[field] !== value) return false;
  }
  for (const [, after] of where.matchAll(/Id > '([^']*)'/g)) {
    if (!(row['Id'] > after)) return false;
  }
  return true;
}

/**
 * An org holding the rows above: a sandbox unless `sandbox` says otherwise,
 * of the edition given. Each create call is kept with its rows; each
 * statement read, but its Organization record's.
 */
function fakeOrg({
  id = TARGET_ORG,
  sandbox = true,
  edition,
}: { id?: string; sandbox?: boolean; edition?: string } = {}) {
  const asked: string[] = [];
  const read: string[] = [];
  const creates: Array<{ name: string; rows: Array<Record<string, unknown>> }> = [];
  const upserts: Array<{ name: string; field: string; rows: Array<Record<string, unknown>> }> = [];
  let made = 0;
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: (name: string) => ({
      describe: async () => {
        asked.push(name);
        return DESCRIBES[name];
      },
      create: async (records: Array<Record<string, unknown>>) => {
        creates.push({ name, rows: records });
        return records.map(() => ({
          id: `${DESCRIBES[name].keyPrefix}000000000${String(900 + made++)}AAA`,
          success: true,
          errors: [],
        }));
      },
      upsert: async (records: Array<Record<string, unknown>>, field: string) => {
        upserts.push({ name, field, rows: records });
        return records.map(() => ({
          id: `${DESCRIBES[name].keyPrefix}000000000${String(900 + made++)}AAA`,
          success: true,
          created: true,
          errors: [],
        }));
      },
    }),
    describe$: async (name: string) => DESCRIBES[name],
    describeGlobal: async () => ({
      sobjects: Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    }),
    query: async (soql: string) => {
      if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
        return page([{ Id: id, IsSandbox: sandbox }]);
      }
      if (soql === 'SELECT OrganizationType FROM Organization LIMIT 1') {
        return page([edition ? { OrganizationType: edition } : {}]);
      }
      read.push(soql);
      const statement = /FROM (\w+)(?: WHERE (.*?))?(?: ORDER BY [\w ,]+)?(?: LIMIT \d+)?$/.exec(
        soql,
      );
      const rows = (ROWS[statement?.[1] ?? ''] ?? []).filter((row) => meets(row, statement?.[2]));
      if (/^SELECT COUNT\(\)/.test(soql))
        return { totalSize: rows.length, done: true, records: [] };
      return page(rows.map((row) => ({ ...row })));
    },
    queryMore: async () => page([]),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
    },
    request: async () => ({}),
  };
  return { conn: conn as unknown as Connection, asked, read, creates, upserts };
}

/** Both fake orgs answering for SRC and TGT. */
function withFakeOrgs(target: Parameters<typeof fakeOrg>[0] = {}) {
  const orgs = { SRC: fakeOrg({ id: '00D000000000001AAA' }), TGT: fakeOrg(target) };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as keyof typeof orgs].conn);
  return orgs;
}

describe('sandforge-clone of whole tables', () => {
  let stdout: string[];
  let stderr: string[];
  let printed: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    stderr = [];
    printed = [];
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderr.push(`${String(line)}\n`);
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('sf org display reached');
    });
  });

  afterEach(() => {
    delete process.env['SANDFORGE_FORGE_PAGE_SIZE'];
    vi.restoreAllMocks();
  });

  describe('its command line', () => {
    it('reads each --object with the --where after it, the first the table discovery starts from', () => {
      const args = parseArgs(argv('--object', 'Case'));

      expect(args.record).toBeUndefined();
      expect(args.tables).toEqual([
        { objectApiName: 'Account', where: `AccountNumber = '${MARK}'` },
        { objectApiName: 'Contact', where: `Department = '${MARK}'` },
        { objectApiName: 'Case' },
      ]);
      expect(args.objectSoqlFilters).toEqual({
        Account: `AccountNumber = '${MARK}'`,
        Contact: `Department = '${MARK}'`,
      });
      expect(tablesQueryOf(args.tables ?? [])).toBe(
        `SELECT Id FROM Account WHERE AccountNumber = '${MARK}'`,
      );
      expect(cloneInputLine(args)).toBe(
        `tables=Account (AccountNumber = '${MARK}'), Contact (Department = '${MARK}'), Case`,
      );
    });

    it.each([
      [
        'a --where before any --object',
        ['node', 'sandforge-clone.ts', '--where', "Name = 'x'", ...argv().slice(2)],
      ],
      ['an --object named twice', argv('--object', 'Account')],
      ['two --where for one --object', argv('--where', "Title = 'x'")],
      ['an --object that is not an API name', argv('--object', 'Price book')],
      ['an --object given no name', argv('--object')],
      ['a --where given no condition', argv('--object', 'Case', '--where', '  ')],
      ['--record with --object', argv('--record', '001000000000001AAA')],
      ['--expand-orphans, of a clone of one record', argv('--expand-orphans')],
      ['--rehearse, which holds every row it reads', argv('--rehearse')],
      ['--filter and --where on the same table', argv('--filter', "Contact=Title = 'x'")],
      ['a --where with a comment marker', argv('--object', 'Case', '--where', "Subject = 'a' --")],
    ])('refuses %s with exit 2, before any org is reached', (_label, args) => {
      expect(() => parseArgs(args)).toThrow(ExitCalled);
      expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('takes a template’s choices with the tables, its record or query aside, the flags over it', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-tables-template-'));
      try {
        const template = join(dir, 'template.json');
        writeFileSync(
          template,
          JSON.stringify({
            id: 'env-case-flow-claims',
            name: 'case-flow/claims',
            description: '',
            config: {
              inputMode: 'soql',
              soqlQuery: `SELECT Id FROM Account WHERE AccountNumber = '${MARK}'`,
              depth: 'custom',
              customDepth: 2,
              maxNodes: 20,
              anonymizePII: true,
              skipEmpty: true,
              batchSize: 'auto',
              excludedObjects: ['Task'],
              fieldExclusions: { Contact: ['Department'] },
            },
            anonymization: { rules: { email: 'fake' } },
            objectCount: 0,
            recordCount: 0,
            createdAt: '2026-10-25T09:00:00.000Z',
            lastUsedAt: '2026-10-25T09:00:00.000Z',
          }),
        );

        const args = parseArgs(argv('--template', template));

        expect(args.record).toBeUndefined();
        expect(args.tables?.map((table) => table.objectApiName)).toEqual(['Account', 'Contact']);
        expect(args).toMatchObject({
          depth: 'custom',
          customDepth: 2,
          maxNodes: 20,
          anonymize: true,
          anonymizationRules: { email: 'fake' },
          excludedObjects: ['Task'],
          fieldExclusions: { Contact: ['Department'] },
          // The line's conditions, each the filter of its table.
          objectSoqlFilters: {
            Account: `AccountNumber = '${MARK}'`,
            Contact: `Department = '${MARK}'`,
          },
          choicesFrom: { flag: '--template', path: template },
        });
        expect(execFileSync).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses a template that brings orphan parents with the tables, as it refuses --expand-orphans', () => {
      const dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-tables-template-'));
      try {
        const template = join(dir, 'template.json');
        writeFileSync(
          template,
          JSON.stringify({
            id: 't',
            name: 't',
            description: '',
            config: {
              inputMode: 'record',
              recordId: '001000000000001AAA',
              depth: 'direct',
              anonymizePII: false,
              skipEmpty: true,
              batchSize: 'auto',
              expandOrphanParents: true,
            },
            objectCount: 0,
            recordCount: 0,
            createdAt: '2026-10-25T09:00:00.000Z',
            lastUsedAt: '2026-10-25T09:00:00.000Z',
          }),
        );

        expect(() => parseArgs(argv('--template', template))).toThrow(ExitCalled);
        expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
        expect(stderr.join('')).toContain(
          '--template: the template brings orphan parents (expandOrphanParents), which go with ' +
            'a clone of one record (--record), not with --object.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still asks for a record or a table', () => {
      expect(() =>
        parseArgs(['node', 'sandforge-clone.ts', '--source', 'SRC', '--target', 'TGT']),
      ).toThrow(ExitCalled);
      expect(stderr.join('')).toContain('Missing required flag');
    });

    it('fingerprints a clone of whole tables by its tables, and a clone of a record as before', () => {
      const tables = parseArgs(argv());
      const otherFilter = parseArgs(
        argv().map((arg) => (arg === `Department = '${MARK}'` ? "Department = 'ELSE'" : arg)),
      );
      const record = parseArgs([
        'node',
        'sandforge-clone.ts',
        '--record',
        '001000000000001AAA',
        '--source',
        'SRC',
        '--target',
        'TGT',
      ]);

      expect(cliRunSetup(tables, TARGET_ORG)).toMatchObject({ tables: tables.tables });
      expect(cliRunSetup(otherFilter, TARGET_ORG)).not.toEqual(cliRunSetup(tables, TARGET_ORG));
      // A journal a clone of one record began keeps being taken up: its setup
      // names no tables.
      expect(Object.keys(cliRunSetup(record, TARGET_ORG))).not.toContain('tables');
    });
  });

  describe('its graph and config', () => {
    const graph = {
      nodes: ['Account', 'Contact', 'Case'].map((objectApiName) => ({ objectApiName })),
    } as unknown as Pick<ForgeGraph, 'nodes'>;

    it('leaves out every object discovery reached that the command line does not name', () => {
      const args = parseArgs(argv('--exclude-object', 'Opportunity'));

      expect(tablesLeftOut(graph, args.tables ?? [])).toEqual(['Case']);
      expect(tablesNotReached(graph, args.tables ?? [])).toEqual([]);
      expect(tablesNotReached(graph, [{ objectApiName: 'Opportunity' }])).toEqual(['Opportunity']);
      expect(tablesRunConfig(args, graph)).toMatchObject({
        inputMode: 'soql',
        soqlQuery: `SELECT Id FROM Account WHERE AccountNumber = '${MARK}'`,
        excludedObjects: ['Opportunity', 'Case'],
        objectSoqlFilters: {
          Account: `AccountNumber = '${MARK}'`,
          Contact: `Department = '${MARK}'`,
        },
      });
    });

    it("hands the executor what the panel's orchestrator hands it for the same config", async () => {
      // The panel runs a query through ForgeOrchestrator.execute; the command
      // calls the executor itself, for the summary the orchestrator turns into
      // the history's result. What either hands the executor is one function's.
      const args = parseArgs(argv('--max', '5', '--exclude', 'Contact.Department'));
      const full = {
        nodes: graph.nodes.map((node) => ({ ...node, included: true, anonymizeFields: [] })),
        edges: [],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
        truncated: false,
      } as unknown as ForgeGraph;
      const config: ForgeConfig = tablesRunConfig(args, full);
      const recordTypes = [
        {
          sourceId: '012000000000001AAA',
          targetId: '012000000000002AAA',
          developerName: 'Business',
          sobjectType: 'Account',
        },
      ];
      const handed: Array<ExecuteOptions | undefined> = [];
      const executor = {
        execute: vi.fn(async (...call: unknown[]) => {
          handed.push(call[4] as ExecuteOptions | undefined);
          return {
            successCount: 0,
            updatedCount: 0,
            linkedCount: 0,
            failedCount: 0,
            failedReads: [],
            errors: [],
            remapCount: 0,
            remapTable: {},
            existingSourceIds: [],
            existingRecords: [],
            remapByObject: [],
            createdByObject: [],
            readByObject: [],
            truncatedObjects: [],
          } as unknown as ExecutionSummary;
        }),
      } as unknown as ForgeExecutor;
      const orchestrator = new ForgeOrchestrator({
        discoveryService: { personalFields: () => [] } as unknown as GraphDiscoveryService,
        executor,
      });

      await orchestrator.execute(full, config, {
        recordTypeMappings: recordTypes,
        anonymizationRules: args.anonymizationRules,
        stream: { ceiling: args.readCeiling },
      });
      const options = tablesExecuteOptions(args, config, full, recordTypes, () => []);

      expect(options).toEqual(handed[0]);
      // Whole tables, read page by page to the ceiling, each through its filter.
      expect(options.rootRecordId).toBeUndefined();
      expect(options.stream).toEqual({ ceiling: args.readCeiling });
      expect(options).toMatchObject({
        maxRecordsPerObject: 5,
        excludedObjects: ['Case'],
        fieldExclusions: { Contact: ['Department'] },
        objectSoqlFilters: config.objectSoqlFilters,
      });
    });
  });

  describe('a run', () => {
    it('refuses a production target before reading a row, and writes nothing', async () => {
      const orgs = withFakeOrgs({ sandbox: false });

      expect(await run(argv())).toBe(1);

      expect(stderr.join('')).toContain(
        'TGT is a production org (its Organization record says IsSandbox false, and no ' +
          'edition): sandforge-clone writes to sandboxes and Developer Edition orgs only.',
      );
      expect(orgs.TGT.creates).toEqual([]);
      expect(orgs.SRC.asked).toEqual([]);
    });

    it('clones into a Developer Edition org, which the shared rule takes for a development org', async () => {
      const orgs = withFakeOrgs({ sandbox: false, edition: 'Developer Edition' });

      expect(await run(argv('--json'))).toBeUndefined();

      expect(orgs.TGT.creates.map((call) => call.name)).toEqual(['Account', 'Contact']);
    });

    it('reads and writes only the tables named, under their conditions, a page at a time', async () => {
      process.env['SANDFORGE_FORGE_PAGE_SIZE'] = '1';
      const orgs = withFakeOrgs();

      expect(await run(argv('--json'))).toBeUndefined();

      // The case discovery reached is never read; each table through its filter.
      expect(orgs.SRC.read.some((soql) => / FROM Case\b/.test(soql) && !/COUNT/.test(soql))).toBe(
        false,
      );
      // Parents first; each page written before the next is read: a contact a call.
      expect(orgs.TGT.creates.map((call) => [call.name, call.rows.length])).toEqual([
        ['Account', 1],
        ['Account', 1],
        ['Contact', 1],
        ['Contact', 1],
        ['Contact', 1],
      ]);
      const contacts = orgs.TGT.creates.filter((call) => call.name === 'Contact');
      const accountIds = new Set(
        orgs.TGT.creates
          .filter((call) => call.name === 'Account')
          .flatMap((_, index) => [`001000000000${String(900 + index)}AAA`]),
      );
      for (const { rows } of contacts) {
        // Under the accounts the run created, and without the source's owner,
        // whom the target holds no user of.
        expect(accountIds.has(String(rows[0]['AccountId']))).toBe(true);
        expect(rows[0]).not.toHaveProperty('OwnerId');
      }
      const summary = JSON.parse(stdout.join('')) as Record<string, unknown>;
      expect(summary).toMatchObject({
        objects: [
          { objectApiName: 'Account', where: `AccountNumber = '${MARK}'` },
          { objectApiName: 'Contact', where: `Department = '${MARK}'` },
        ],
        result: { successCount: 5, failedCount: 0 },
      });
      expect(summary).not.toHaveProperty('record');
      expect(stderr.join('')).toContain('executing… (REAL, WHOLE TABLES, READ IN PAGES OF 1)');
    });

    it('upserts a table with an external id a page at a time under --upsert, its keys read first', async () => {
      process.env['SANDFORGE_FORGE_PAGE_SIZE'] = '1';
      const contact = DESCRIBES['Contact'];
      const fields = contact.fields;
      const rows = ROWS['Contact'];
      contact.fields = [
        ...fields,
        {
          ...fields[1],
          name: 'Ext__c',
          type: 'string',
          externalId: true,
        } as (typeof fields)[number],
      ];
      ROWS['Contact'] = rows.map((row, n) => ({ ...row, Ext__c: `contact-key-${n}` }));
      try {
        const orgs = withFakeOrgs();

        expect(await run(argv('--upsert', '--json'))).toBeUndefined();

        // The accounts have no external id and are inserted; the contacts go
        // by theirs, a page at a time.
        expect(orgs.TGT.creates.map((call) => [call.name, call.rows.length])).toEqual([
          ['Account', 1],
          ['Account', 1],
        ]);
        expect(orgs.TGT.upserts.map((call) => [call.name, call.field, call.rows.length])).toEqual([
          ['Contact', 'Ext__c', 1],
          ['Contact', 'Ext__c', 1],
          ['Contact', 'Ext__c', 1],
        ]);
        expect(orgs.SRC.read).toContainEqual(
          expect.stringMatching(
            new RegExp(
              `^SELECT Id, Ext__c FROM Contact WHERE \\(Department = '${MARK}'\\) ORDER BY Id`,
            ),
          ),
        );
        const summary = JSON.parse(stdout.join('')) as { result: Record<string, unknown> };
        expect(summary.result).toMatchObject({ successCount: 5, failedCount: 0 });
        expect(stderr.join('')).toContain(
          'executing… (REAL, WHOLE TABLES, UPSERT, READ IN PAGES OF 1)',
        );
      } finally {
        contact.fields = fields;
        ROWS['Contact'] = rows;
      }
    });

    it('leaves a summary and a journal that --remove takes the run back from, naming its tables', async () => {
      withFakeOrgs();

      expect(await run(argv('--json'))).toBeUndefined();

      const text = stdout.join('');
      const parsed = parseRunSummary(text);
      if ('refusal' in parsed) throw new Error(parsed.refusal);
      const plan = removalPlan(parsed.summary);
      expect(plan.map((object) => [object.objectApiName, object.ids.length])).toEqual([
        ['Contact', 3],
        ['Account', 2],
      ]);
      expect(
        removalPlanLines(parsed.summary, plan, { target: 'TGT', includeChanged: false })[0],
      ).toMatch(/^the clone of Account, Contact wrote to TGT/);

      const journal = String((JSON.parse(text) as { journal: string }).journal);
      const ofJournal = await runSummaryOfFile(journal, readFileSync(journal, 'utf8'), 'TGT');
      if ('refusal' in ofJournal) throw new Error(ofJournal.refusal);
      expect(ofJournal.summary.record).toBeUndefined();
      expect(ofJournal.summary.objects).toEqual([
        { objectApiName: 'Account', where: `AccountNumber = '${MARK}'` },
        { objectApiName: 'Contact', where: `Department = '${MARK}'` },
      ]);
      expect(removalPlan(ofJournal.summary).map((object) => object.ids.length)).toEqual([3, 2]);
    });

    it('gives with a dry run what its gate counted, the count a run is held to, and writes nothing', async () => {
      const orgs = withFakeOrgs();

      expect(await run(argv('--dry-run', '--json'))).toBeUndefined();

      const summary = JSON.parse(stdout.join('')) as Record<string, unknown>;
      expect(summary['writePlan']).toEqual({
        totalRows: 5,
        storageBytes: 5 * 2048,
        objects: [
          { objectApiName: 'Contact', rows: 3, storageBytes: 3 * 2048 },
          { objectApiName: 'Account', rows: 2, storageBytes: 2 * 2048 },
        ],
      });
      expect(summary).not.toHaveProperty('wouldBeRefused');
      expect(orgs.TGT.creates).toEqual([]);
    });

    it('says with a dry run what a real run would be refused for: more records than --max-total', async () => {
      withFakeOrgs();

      expect(await run(argv('--dry-run', '--json', '--max-total', '4'))).toBeUndefined();

      const summary = JSON.parse(stdout.join('')) as { wouldBeRefused?: string[] };
      expect(summary.wouldBeRefused).toEqual([
        expect.stringContaining('The run would write 5 records, more than --max-total 4'),
      ]);
    });

    it('holds a real run to --max-total, writing nothing past it, and gives no write plan of its own', async () => {
      const orgs = withFakeOrgs();

      expect(await run(argv('--json', '--max-total', '4'))).toBe(1);
      expect(orgs.TGT.creates).toEqual([]);
      expect(stderr.join('')).toContain('The run would write 5 records, more than --max-total 4');

      stdout = [];
      expect(await run(argv('--json', '--max-total', '5'))).toBeUndefined();
      expect(JSON.parse(stdout.join(''))).not.toHaveProperty('writePlan');
    });

    it('refuses a table discovery did not reach from the first, before a row is read', async () => {
      const orgs = withFakeOrgs();

      expect(await run(argv('--object', 'Opportunity', '--depth', 'direct'))).toBe(2);

      expect(stderr.join('')).toContain(
        '--object Opportunity: discovery from Account did not reach it',
      );
      expect(orgs.TGT.creates).toEqual([]);
    });
  });
});
