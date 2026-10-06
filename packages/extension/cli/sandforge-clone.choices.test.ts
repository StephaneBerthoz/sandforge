import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import {
  choicesLines,
  executeOptions,
  main,
  parseArgs,
  queryRootOf,
  readChoicesFile,
  withTemplateFields,
} from './sandforge-clone';

/*
 * The decisions taken on Review, the fields and objects left out, the filters
 * and the mappings: a run of the command takes them from a file, a subset of
 * a Forge config (--config) or a template the Template tab exported
 * (--template), the flags over it.
 */

const mockExecFileSync = vi.mocked(execFileSync);

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const RECORD = '001000000000001AAA';

/** A valid invocation, with `extra` flags appended. */
function argv(...extra: string[]): string[] {
  return ['node', 'sandforge-clone.ts', '--source', 'SRC', '--target', 'TGT', ...extra];
}

const node = (objectApiName: string, piiFields: string[] = []): ForgeGraphNode => ({
  objectApiName,
  recordCount: 1,
  fieldCount: 5,
  status: 'idle',
  progress: 0,
  included: true,
  piiFields,
  anonymizeFields: [...piiFields],
  level: 0,
  successCount: 0,
  failureCount: 0,
  errors: [],
  createableFieldCount: 4,
  estimatedSizeMB: 0,
  estimatedApiCalls: 1,
  batchStrategy: 'auto',
});

const GRAPH: ForgeGraph = {
  nodes: [node('Account', ['Phone', 'Fax']), node('Contact', ['Email'])],
  edges: [],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const SKIPPED = 'picklist_value_refused|Case|Origin|Support|Fax';

/** A config file holding a decision of each kind, and what it leaves out, filters and maps. */
const CONFIG = {
  fieldExclusions: { Account: ['Description'] },
  excludedObjects: ['Task'],
  objectSoqlFilters: { Case: "Status = 'Open'", Contact: 'Email != null' },
  ownerMappings: { '005000000000001AAA': '005000000000101AAA' },
  fieldMappings: { Account: { Region__c: 'Area__c' } },
  picklistValueMappings: [{ object: 'Case', field: 'Origin', from: 'Fax', to: 'Phone' }],
  defaultValues: [{ object: 'Case', field: 'Region__c', value: 'North' }],
  skippedRows: [{ object: 'Case', gapId: SKIPPED }],
  ignoredGaps: ['validation_rule|Contact|||Phone_Format'],
};

/** A template the Template tab exported, of a record, with its depth, caps and anonymization. */
const TEMPLATE = {
  id: 'tpl-1',
  name: 'Accounts with their cases',
  description: '',
  config: {
    inputMode: 'record',
    recordId: RECORD,
    depth: 'direct',
    maxRecordsPerObject: 20,
    anonymizePII: true,
    skipEmpty: true,
    batchSize: 'auto',
    keepContactPoints: true,
    fieldExclusions: { Contact: ['Fax'] },
    truncateFields: [{ object: 'Case', field: 'Subject' }],
  },
  anonymization: {
    rules: { phone: 'redact' },
    fields: [{ objectApiName: 'Account', fieldNames: ['Phone', 'Not_Personal__c'] }],
  },
  objectCount: 3,
  recordCount: 12,
  createdAt: '2026-10-01T08:00:00.000Z',
  lastUsedAt: '2026-10-01T08:00:00.000Z',
};

let dir: string;
let stderr: string;

/** The path of a file holding `content`, written for the test. */
function fileOf(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

/** Run the CLI and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(args);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'sandforge-choices-'));
  stderr = '';
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  // A valid invocation stops at the first org lookup.
  mockExecFileSync.mockImplementation(() => {
    throw new Error('sf org display reached');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('readChoicesFile', () => {
  it('reads a config subset, each part checked as the panel checks a run', () => {
    const read = readChoicesFile('--config', JSON.stringify(CONFIG));

    expect(read).toEqual({ file: { kind: 'config', config: CONFIG } });
  });

  it('refuses a key --config does not take, rather than dropping it', () => {
    const read = readChoicesFile('--config', JSON.stringify({ ...CONFIG, depth: 'full' }));

    expect('refusal' in read && read.refusal.join('\n')).toMatch(/depth/);
    expect('refusal' in read && read.refusal.at(-1)).toContain('--config takes fieldExclusions');
  });

  it('refuses a filter the schema refuses, a file that is no JSON, and one too large', () => {
    const filter = readChoicesFile(
      '--config',
      JSON.stringify({ objectSoqlFilters: { Case: "Status = 'Open' -- x" } }),
    );
    expect('refusal' in filter && filter.refusal[0]).toMatch(
      /^--config \(objectSoqlFilters\.Case\)/,
    );
    expect(readChoicesFile('--config', '{ not json')).toEqual({
      refusal: ['--config: the file is not JSON'],
    });
    expect('refusal' in readChoicesFile('--config', ' '.repeat(1_000_001))).toBe(true);
  });

  it('reads a template the Template tab exported, a byte-order mark before it included', () => {
    const read = readChoicesFile('--template', `\uFEFF${JSON.stringify(TEMPLATE)}`);

    expect('file' in read && read.file.kind).toBe('template');
    expect(readChoicesFile('--template', JSON.stringify(CONFIG))).toHaveProperty('refusal');
  });
});

describe('--config', () => {
  it('applies the file’s decisions, exclusions, filters and mappings, the flags over them', () => {
    const path = fileOf('clone.json', CONFIG);

    const args = parseArgs(
      argv(
        '--record',
        RECORD,
        '--config',
        path,
        '--exclude',
        'Account.Fax',
        '--filter',
        "Case=Status = 'Closed'",
        '--exclude-object',
        'Event',
      ),
    );

    // Exclusions add up; a flag's filter replaces the file's for its object.
    expect(args.fieldExclusions).toEqual({ Account: ['Description', 'Fax'] });
    expect(args.excludedObjects).toEqual(['Task', 'Event']);
    expect(args.objectSoqlFilters).toEqual({
      Case: "Status = 'Closed'",
      Contact: 'Email != null',
    });
    expect(args.ownerMappings).toEqual(CONFIG.ownerMappings);
    expect(args.fieldMappings).toEqual(CONFIG.fieldMappings);
    const options = executeOptions(args, GRAPH, []);
    expect(options.decisions).toEqual({
      picklistValueMappings: CONFIG.picklistValueMappings,
      defaultValues: CONFIG.defaultValues,
      ignoredGaps: CONFIG.ignoredGaps,
      skippedRows: CONFIG.skippedRows,
    });
    expect(options.fieldExclusions).toEqual({ Account: ['Description', 'Fax'] });
    expect(options.objectSoqlFilters?.['Case']).toBe("Status = 'Closed'");
  });

  it('applies no decision without a file', () => {
    expect(
      executeOptions(parseArgs(argv('--record', RECORD)), GRAPH, []).decisions,
    ).toBeUndefined();
  });

  it.each([
    ['a key it does not take', { maxRecordsPerObject: 5 }],
    ['a field name no query could hold', { fieldExclusions: { Account: ['Bad Field'] } }],
    [
      'rows held back under another object than their gap’s',
      { skippedRows: [{ object: 'Lead', gapId: SKIPPED }] },
    ],
  ])('exits 2 on a file holding %s, before any org is loaded', async (_label, content) => {
    expect(await run(argv('--record', RECORD, '--config', fileOf('bad.json', content)))).toBe(2);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(stderr).toContain('--config');
  });

  it('exits 2 on a file it cannot read, or with --template beside it', async () => {
    expect(await run(argv('--record', RECORD, '--config', join(dir, 'missing.json')))).toBe(2);
    expect(stderr).toContain('cannot read');
    const path = fileOf('clone.json', CONFIG);
    expect(await run(argv('--record', RECORD, '--config', path, '--template', path))).toBe(2);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('reaches the org lookup with a valid file', async () => {
    const result = await run(argv('--record', RECORD, '--config', fileOf('clone.json', CONFIG)));

    expect((result as Error).message).toBe('sf org display reached');
  });
});

describe('--template', () => {
  it('clones the template’s record with its depth, cap, anonymization and decisions', () => {
    const args = parseArgs(argv('--template', fileOf('tpl.json', TEMPLATE)));

    expect(args).toMatchObject({
      record: RECORD,
      depth: 'direct',
      maxRecordsPerObject: 20,
      anonymize: true,
      keepContactPoints: true,
      fieldExclusions: { Contact: ['Fax'] },
      decisions: { truncateFields: [{ object: 'Case', field: 'Subject' }] },
      anonymizationRules: { phone: 'redact' },
      choicesFrom: { flag: '--template', path: join(dir, 'tpl.json') },
    });
    expect(executeOptions(args, GRAPH, []).anonymization?.methods).toEqual({ phone: 'redact' });
  });

  it('takes the flags over the template', () => {
    const other = '001000000000002AAA';
    const args = parseArgs(
      argv(
        '--template',
        fileOf('tpl.json', TEMPLATE),
        '--record',
        other,
        '--depth',
        'full',
        '--max',
        '5',
      ),
    );

    expect(args).toMatchObject({ record: other, depth: 'full', maxRecordsPerObject: 5 });
  });

  it('leaves to the query the filter a template of a query holds on its root, and keeps the others', () => {
    const soql = {
      ...TEMPLATE,
      config: {
        ...TEMPLATE.config,
        inputMode: 'soql',
        recordId: undefined,
        soqlQuery: "SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Industry = 'Energy'",
        objectSoqlFilters: { Account: "Industry = 'Energy'", Contact: 'Email != null' },
      },
    };

    const args = parseArgs(argv('--template', fileOf('tpl.json', soql), '--record', RECORD));

    expect(args.objectSoqlFilters).toEqual({ Contact: 'Email != null' });
  });

  it('reads the object a query reads from, its subqueries set aside', () => {
    expect(
      queryRootOf('SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Name != null'),
    ).toBe('Account');
    expect(queryRootOf('select id from opportunity')).toBe('opportunity');
    expect(queryRootOf('SELECT Id')).toBeUndefined();
  });

  it('exits 2 on a template of a query when no record is given', async () => {
    const soql = {
      ...TEMPLATE,
      config: {
        ...TEMPLATE.config,
        inputMode: 'soql',
        recordId: undefined,
        soqlQuery: 'SELECT Id FROM Account',
      },
    };

    expect(await run(argv('--template', fileOf('tpl.json', soql)))).toBe(2);
    expect(stderr).toContain('give --record');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('refuses files with --anonymize from the template until they are accepted as they are', async () => {
    expect(await run(argv('--template', fileOf('tpl.json', TEMPLATE), '--files'))).toBe(2);
    expect(stderr).toContain('--files-as-is');
  });

  it('anonymizes the fields the template names, of those discovery found personal', () => {
    const graph = withTemplateFields(GRAPH, TEMPLATE.anonymization.fields);

    expect(graph.nodes.map((n) => n.anonymizeFields)).toEqual([['Phone'], ['Email']]);
    expect(withTemplateFields(GRAPH, undefined)).toBe(GRAPH);
  });
});

describe('choicesLines', () => {
  it('says what the file brings, the flags included, each decision on a line', () => {
    const args = parseArgs(argv('--record', RECORD, '--config', fileOf('clone.json', CONFIG)));

    expect(choicesLines(args)).toEqual([
      `choices from --config ${join(dir, 'clone.json')}, the flags over it:`,
      '  fields left out: Account.Description',
      '  objects left out: Task',
      "  filter Case: Status = 'Open'",
      '  filter Contact: Email != null',
      '  owners mapped: 1',
      '  renamed: Account.Region__c → Area__c',
      '  decisions (4):',
      '  Case.Origin  map_value "Fax" → "Phone"',
      '  Case.Region__c  set_default "North"',
      '  Case.Origin  skip_rows "Fax" (record type Support)',
      '  ignore validation_rule|Contact|||Phone_Format',
    ]);
  });

  it('says nothing without a file', () => {
    expect(choicesLines(parseArgs(argv('--record', RECORD, '--exclude', 'Account.Fax')))).toEqual(
      [],
    );
  });
});
