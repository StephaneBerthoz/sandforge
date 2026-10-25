import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { forgeTemplateSchema, type EnvForgeResource, type EnvForgeRun } from '@sandforge/shared';

vi.mock('../../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../sfSession.js', async (original) => ({
  ...(await original<typeof import('../../sfSession.js')>()),
  loadOrg: vi.fn(),
  makeConn: vi.fn(),
}));
vi.mock('../../sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('../../sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(),
}));
vi.mock('../../../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../../../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
vi.mock('../../../src/modules/forge/RunVerifier.js', async (original) => ({
  ...(await original<typeof import('../../../src/modules/forge/RunVerifier.js')>()),
  verifiedOrg: vi.fn(),
}));

import {
  parseArgs as parseCloneArgs,
  parseRemoveArgs,
  parseVerifyArgs,
} from '../../sandforge-clone.js';
import { EnvWorld } from '../../testing/envWorld.js';
import { StepAnswerError } from './common.js';
import {
  FORGE_SCRIPT,
  forgeAnonymizes,
  forgeApplyLine,
  forgeDryRunCount,
  forgeDryRunLine,
  forgePreviewLine,
  forgeRemoveLine,
  forgeRunCount,
  forgeRunOfResource,
  forgeTargetRefusal,
  forgeVerifyLine,
  forgeWritten,
  readForgeDryRun,
  readForgePreview,
  readForgeRemoval,
  readForgeRun,
  readForgeSource,
  readForgeVerify,
  realDataNotes,
  realDataRefusal,
  tablesQueryOf,
  verificationShortOf,
  type ForgeDryRunAnswer,
  type ForgeVerifyAnswer,
} from './forge.js';

/*
 * A forge resource's conversion, its source read at the plan, its lines —
 * read by the clone's own parsers — and the readers of its answers, fed what
 * `sandforge-clone`'s own `main` prints, run in this process from a memory
 * source org to a memory target org: a field the clone renames or drops
 * fails here first.
 */

const NOW = new Date('2026-10-25T09:00:00.000Z');
const MARK = 'SFENV forge';

let dir: string;
let journalBefore: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-env-forge-kind-'));
  journalBefore = process.env['SANDFORGE_JOURNAL_DIR'];
  process.env['SANDFORGE_JOURNAL_DIR'] = join(dir, 'journal');
});
afterEach(() => {
  process.env['SANDFORGE_JOURNAL_DIR'] = journalBefore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const tables: EnvForgeResource = {
  kind: 'forge',
  source: 'uat',
  tables: [{ object: 'Account', where: `Name = '${MARK}'` }, { object: 'Contact' }],
};

/** What a resource converts into, or the refusals' messages. */
function converted(resource: EnvForgeResource): EnvForgeRun {
  const read = forgeRunOfResource('demo', 'cloned', resource, dir, NOW);
  if ('refusals' in read) throw new Error(read.refusals.map((r) => r.message).join('\n'));
  return read.run;
}

function refusedWith(resource: EnvForgeResource): string[] {
  const read = forgeRunOfResource('demo', 'cloned', resource, dir, NOW);
  return 'refusals' in read ? read.refusals.map((r) => r.message) : [];
}

/** A templates file of the project holding `entries`. */
function templates(entries: unknown): string {
  mkdirSync(join(dir, '.sandforge'), { recursive: true });
  writeFileSync(join(dir, '.sandforge', 'forge-templates.json'), JSON.stringify(entries));
  return '.sandforge/forge-templates.json';
}

/** A template as the Template tab saves one, of a record. */
const ENTRY = {
  id: 'case-with-history',
  name: 'Case with its history',
  description: '',
  config: {
    inputMode: 'record',
    recordId: '500000000000001AAA',
    depth: 'full',
    anonymizePII: false,
    skipEmpty: true,
    batchSize: 'auto',
    excludedObjects: ['Task'],
    picklistValueMappings: [{ object: 'Case', field: 'Origin', from: 'Fax', to: 'Phone' }],
  },
  anonymization: { rules: { email: 'mask' } },
  objectCount: 4,
  recordCount: 12,
  createdAt: '2026-10-01T09:00:00.000Z',
  lastUsedAt: '2026-10-01T09:00:00.000Z',
};

describe('a forge resource, converted', () => {
  it('converts tables into an exported template the template schema reads, the tables on the line', () => {
    const run = converted({ ...tables, depth: 'custom', customDepth: 2, maxTotal: 40 });

    expect(forgeTemplateSchema.safeParse(run.template).success).toBe(true);
    expect(run.template.config).toMatchObject({
      inputMode: 'soql',
      soqlQuery: `SELECT Id FROM Account WHERE Name = '${MARK}'`,
      depth: 'custom',
      customDepth: 2,
      anonymizePII: false,
      skipEmpty: true,
      batchSize: 'auto',
    });
    expect(run).toMatchObject({ source: 'uat', tables: tables.tables, maxTotal: 40 });
    expect(run.acceptAutomation).toBe(false);
    expect(tablesQueryOf([{ object: 'Case' }])).toBe('SELECT Id FROM Case');
  });

  it('takes a template entry of the project, the file’s depth and anonymization over it, its record aside', () => {
    const run = converted({
      kind: 'forge',
      source: 'uat',
      record: { object: 'Case', where: "CaseNumber = '00001026'" },
      template: { file: templates([{ id: 'other' }, ENTRY]), id: 'case-with-history' },
      depth: 'direct',
      anonymize: { rules: { email: 'fake', phone: 'mask' } },
      accept: { automation: true },
    });

    expect(run.template.config).toMatchObject({
      inputMode: 'record',
      depth: 'direct',
      anonymizePII: true,
      excludedObjects: ['Task'],
      picklistValueMappings: ENTRY.config.picklistValueMappings,
    });
    // The record is the resource's, read at the plan: the entry's is not cloned.
    expect(run.template.config).not.toHaveProperty('recordId');
    expect(run.template.anonymization).toEqual({ rules: { email: 'fake', phone: 'mask' } });
    expect(run.acceptAutomation).toBe(true);
  });

  it('refuses a templates file it cannot read, one that is no JSON, and an id it does not hold', () => {
    const named = (file: string, id = 't'): EnvForgeResource => ({
      ...tables,
      template: { file, id },
    });

    expect(refusedWith(named('none.json'))[0]).toMatch(/^none\.json cannot be read: /);
    writeFileSync(join(dir, 'junk.json'), 'not json');
    expect(refusedWith(named('junk.json'))).toEqual(['junk.json is not JSON']);
    expect(refusedWith(named(templates([ENTRY]), 'none'))).toEqual([
      '.sandforge/forge-templates.json holds no template "none": it holds case-with-history',
    ]);
    expect(
      refusedWith(
        named(templates([{ ...ENTRY, config: { ...ENTRY.config, depth: 'deep' } }]), ENTRY.id),
      ),
    ).toEqual([
      expect.stringMatching(
        /^the template "case-with-history" of \.sandforge\/forge-templates\.json is refused by Forge's template schema at config\.depth: /,
      ),
    ]);
  });

  it('refuses a template that brings orphan parents to a clone of tables, which reads its parents named', () => {
    const file = templates([{ ...ENTRY, config: { ...ENTRY.config, expandOrphanParents: true } }]);

    expect(refusedWith({ ...tables, template: { file, id: ENTRY.id } })).toEqual([
      'the template brings orphan parents (expandOrphanParents), which go with a clone of one record: a clone of tables reads the parents its tables point at, named with them',
    ]);
    expect(
      converted({
        kind: 'forge',
        source: 'uat',
        record: { id: '001000000000001AAA' },
        template: { file, id: ENTRY.id },
      }).template.config.expandOrphanParents,
    ).toBe(true);
  });

  it('warns that a template’s file copy is not made, and copies none', () => {
    const file = templates([{ ...ENTRY, files: { maxFileSizeMB: 10 } }]);
    const read = forgeRunOfResource(
      'demo',
      'cloned',
      { ...tables, template: { file, id: ENTRY.id } },
      dir,
      NOW,
    );

    if ('refusals' in read) throw new Error('refused');
    expect(read.run.template).not.toHaveProperty('files');
    expect(read.warnings.map((w) => w.message)).toEqual([
      'the template copies the files of the cloned records: an environment copies none, and the clone writes the records alone',
    ]);
  });
});

describe('what a forge resource’s fingerprint is of', () => {
  const read = { organizationId: '00D000000000008AAA' };

  it('writes the same of the same resource, whatever the order of its keys, its name, dates and ceiling', () => {
    const one = converted(tables);
    const later = forgeRunOfResource(
      'demo',
      'cloned',
      {
        maxTotal: 3,
        accept: { automation: true },
        tables: tables.tables,
        source: 'uat',
        kind: 'forge',
      },
      dir,
      new Date('2027-01-01T00:00:00.000Z'),
    );
    if ('refusals' in later) throw new Error('refused');

    expect(forgeWritten(later.run, read)).toEqual(forgeWritten(one, read));
  });

  it('writes the source by its Organization Id, and a record of a query by the id it resolved to', () => {
    const run = converted({
      ...tables,
      tables: undefined,
      record: { object: 'Case', where: 'x = 1' },
    });

    expect(forgeWritten(run, read)).toMatchObject({ source: '00D000000000008' });
    expect(forgeWritten(run, { ...read, recordId: '500000000000001AAA' })).toMatchObject({
      record: '500000000000001',
    });
    expect(forgeWritten(run, { ...read, recordId: '500000000000001AAA' })).not.toEqual(
      forgeWritten(run, { ...read, recordId: '500000000000002AAA' }),
    );
    expect(forgeWritten(run, { organizationId: '00D000000000007AAA' })).not.toEqual(
      forgeWritten(run, read),
    );
  });
});

describe('the source of a forge resource, read at the plan', () => {
  /** A source answering its Organization record, and `rows` to a query of a record. */
  function sourceOf(rows: unknown[], count = rows.length) {
    const queries: string[] = [];
    const conn = {
      query: vi.fn(async (soql: string) => {
        queries.push(soql);
        if (soql.includes('FROM Organization')) {
          return {
            totalSize: 1,
            done: true,
            records: [{ Id: '00D000000000008AAA', IsSandbox: true }],
          };
        }
        if (soql.startsWith('SELECT COUNT()')) return { totalSize: count, done: true, records: [] };
        return { totalSize: rows.length, done: true, records: rows };
      }),
    } as unknown as Pick<Connection, 'query'>;
    return { conn, queries };
  }
  const byQuery = (): EnvForgeRun =>
    converted({
      kind: 'forge',
      source: 'uat',
      record: { object: 'Case', where: "CaseNumber = '1'" },
    });

  it('reads the Organization Id of a source, and the one row a record’s query answers', async () => {
    const { conn, queries } = sourceOf([{ Id: '500000000000001AAA' }]);

    expect(await readForgeSource(conn, byQuery(), 'uat', 'SRC')).toEqual({
      organizationId: '00D000000000008AAA',
      recordId: '500000000000001AAA',
    });
    expect(queries).toContain("SELECT Id FROM Case WHERE CaseNumber = '1' LIMIT 2");
    expect(await readForgeSource(sourceOf([]).conn, converted(tables), 'uat', 'SRC')).toEqual({
      organizationId: '00D000000000008AAA',
    });
  });

  it('refuses a query that answers no row, or more than one, with the count', async () => {
    expect(await readForgeSource(sourceOf([]).conn, byQuery(), 'uat', 'SRC')).toEqual({
      refusal:
        "its record query finds no Case in the uat org (SRC) (WHERE CaseNumber = '1'): a record named by a query is one its source answers with exactly one row",
    });
    expect(
      await readForgeSource(sourceOf([{ Id: 'a' }, { Id: 'b' }], 7).conn, byQuery(), 'uat', 'SRC'),
    ).toEqual({
      refusal:
        "its record query finds 7 Case records in the uat org (SRC) (WHERE CaseNumber = '1'), not one: narrow the where to one row, or name the record by its id",
    });
  });

  it('says a source that would not say what it is, or would not answer the query', async () => {
    const silent = { query: vi.fn(async () => ({ records: [] })) } as unknown as Pick<
      Connection,
      'query'
    >;
    const failing = {
      query: vi.fn(async (soql: string) => {
        if (soql.includes('FROM Organization')) {
          return { records: [{ Id: '00D000000000008AAA', IsSandbox: true }] };
        }
        throw new Error('INVALID_FIELD: No such column');
      }),
    } as unknown as Pick<Connection, 'query'>;

    expect(await readForgeSource(silent, byQuery(), 'uat', 'SRC')).toEqual({
      refusal: expect.stringMatching(/^the uat org \(SRC\) could not be read: /),
    });
    expect(await readForgeSource(failing, byQuery(), 'uat', 'SRC')).toEqual({
      refusal:
        'its record query could not be read in the uat org (SRC): INVALID_FIELD: No such column',
    });
  });
});

describe('a forge resource whose source is a production org', () => {
  /** A production source, as its Organization record says it, answering `rows` to a record's query. */
  function productionOf(rows: unknown[] = [{ Id: '500000000000001AAA' }]) {
    const queries: string[] = [];
    const conn = {
      query: vi.fn(async (soql: string) => {
        queries.push(soql);
        if (soql.includes('FROM Organization')) {
          return {
            totalSize: 1,
            done: true,
            records: [
              {
                Id: '00D000000000007AAA',
                IsSandbox: false,
                OrganizationType: 'Enterprise Edition',
              },
            ],
          };
        }
        return { totalSize: rows.length, done: true, records: rows };
      }),
    } as unknown as Pick<Connection, 'query'>;
    return { conn, queries };
  }
  const record = { object: 'Case', where: "CaseNumber = '1'" };

  it('refuses it without anonymize or accept: { realData: true }, naming both ways out, before a record of the source is read', async () => {
    const { conn, queries } = productionOf();

    const read = await readForgeSource(
      conn,
      converted({ kind: 'forge', source: 'uat', record }),
      'uat',
      'PROD',
    );

    expect(read).toEqual({
      refusal:
        'its source, the uat org (PROD), is a production org (its Organization record says ' +
        'IsSandbox false, edition Enterprise Edition): what it clones is real people’s data, ' +
        'written as read into an org built for tests. Give the resource anonymize — Forge’s ' +
        'anonymization, a method for each category of personal field — or, reviewed in the ' +
        'file, accept: { realData: true }. Emails and phone numbers are neutralized either ' +
        'way, unless keepContactPoints: true',
    });
    expect(queries.filter((soql) => !soql.includes('FROM Organization'))).toEqual([]);
  });

  it('reads it, as a production org, when the resource anonymizes what it clones, or the file accepts real data', async () => {
    const anonymized = converted({
      kind: 'forge',
      source: 'uat',
      record,
      anonymize: { rules: { email: 'fake', name: 'fake' } },
    });
    const accepted = converted({
      kind: 'forge',
      source: 'uat',
      record,
      accept: { realData: true },
    });

    for (const run of [anonymized, accepted]) {
      expect(await readForgeSource(productionOf().conn, run, 'uat', 'PROD')).toEqual({
        organizationId: '00D000000000007AAA',
        production: true,
        recordId: '500000000000001AAA',
      });
    }
    expect(accepted.acceptRealData).toBe(true);
    expect(anonymized.acceptRealData).toBe(false);
  });

  it('takes an anonymization that sets no method for any category for none, and says so', () => {
    const empty = converted({
      kind: 'forge',
      source: 'uat',
      tables: [{ object: 'Case' }],
      anonymize: { rules: {} },
    });

    expect(forgeAnonymizes(empty)).toBe(false);
    expect(
      realDataRefusal(empty, 'the uat org (PROD)', {
        id: '00D000000000007AAA',
        sandbox: false,
        edition: 'Enterprise Edition',
      }),
    ).toContain(
      'Its anonymize sets a method for no category of personal field, so it anonymizes nothing.',
    );
    // A template entry that anonymizes brings its anonymization with it.
    const fromEntry = converted({
      kind: 'forge',
      source: 'uat',
      tables: [{ object: 'Case' }],
      template: {
        file: templates([{ ...ENTRY, config: { ...ENTRY.config, anonymizePII: true } }]),
        id: ENTRY.id,
      },
    });
    expect(forgeAnonymizes(fromEntry)).toBe(true);
  });

  it('says in the plan that the data is real, what is done to it, and that emails and phone numbers are neutralized unless kept', () => {
    const source = (production: boolean) => ({
      role: 'uat',
      alias: 'PROD',
      read: {
        organizationId: '00D000000000007AAA',
        ...(production ? { production: true as const } : {}),
      },
    });
    const accepted = converted({
      kind: 'forge',
      source: 'uat',
      record,
      accept: { realData: true },
    });
    const anonymized = converted({
      kind: 'forge',
      source: 'uat',
      record,
      anonymize: { rules: { email: 'fake', phone: 'mask' } },
      keepContactPoints: true,
    });

    expect(realDataNotes(accepted, source(true))).toEqual([
      'real data: its source, the uat org (PROD), is a production org; what it clones is written as read, as the file accepts (accept: { realData: true })',
      'contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range), as the clone does unless keepContactPoints',
    ]);
    expect(realDataNotes(anonymized, source(true))).toEqual([
      'real data: its source, the uat org (PROD), is a production org; what it clones is anonymized as its anonymize says (email fake, phone mask)',
      'contact points: written as read (keepContactPoints: true)',
    ]);
    expect(realDataNotes(accepted, source(false))).toEqual([]);
  });
});

describe('the lines of a forge resource', () => {
  const input = {
    source: 'SRC',
    target: 'TGT',
    templateFile: join(dir ?? tmpdir(), 'template.json'),
    tables: tables.tables ?? [],
    maxTotal: 4,
    acceptAutomation: false,
  };

  it('gives the clone a line it reads: a dry run, then a run held to its count, its summary as it goes', () => {
    const template = join(dir, 'template.json');
    writeFileSync(template, JSON.stringify(converted(tables).template));
    const dry = forgeDryRunLine({ ...input, templateFile: template });
    const run = forgeApplyLine({
      ...input,
      templateFile: template,
      acceptAutomation: true,
      summary: join(dir, '1.summary.json'),
    });

    expect(parseCloneArgs(['node', 'sandforge-clone.ts', ...dry])).toMatchObject({
      dryRun: true,
      json: true,
      skipPreflight: true,
      maxTotal: 4,
      source: 'SRC',
      target: 'TGT',
      tables: [
        { objectApiName: 'Account', where: `Name = '${MARK}'` },
        { objectApiName: 'Contact' },
      ],
    });
    expect(parseCloneArgs(['node', 'sandforge-clone.ts', ...run])).toMatchObject({
      dryRun: false,
      acceptAutomation: true,
      summary: join(dir, '1.summary.json'),
      maxTotal: 4,
    });
    const record = forgeDryRunLine({
      ...input,
      templateFile: template,
      tables: undefined,
      recordId: '001000000000001AAA',
    });
    expect(parseCloneArgs(['node', 'sandforge-clone.ts', ...record])).toMatchObject({
      record: '001000000000001AAA',
      tables: undefined,
    });
  });

  it('gives its removal, its preview and its verification lines they read', () => {
    const summary = join(dir, '1.summary.json');

    expect(
      parseRemoveArgs([
        'node',
        'sandforge-clone.ts',
        ...forgeRemoveLine({ target: 'TGT', summary, includeChanged: true, sweep: true }),
      ]),
    ).toMatchObject({ summaryPath: summary, includeChanged: true, sweep: true, json: true });
    expect(
      parseRemoveArgs([
        'node',
        'sandforge-clone.ts',
        ...forgePreviewLine({ target: 'TGT', summary, acceptAutomation: true }),
      ]),
    ).toMatchObject({ preview: true, acceptAutomation: true, json: true });
    expect(
      parseVerifyArgs([
        'node',
        'sandforge-clone.ts',
        ...forgeVerifyLine({ summary, target: 'TGT', source: 'SRC' }),
      ]),
    ).toEqual({ summaryPath: summary, target: 'TGT', source: 'SRC', json: true, audit: undefined });
  });

  it('refuses a line that names neither a record nor a table, and a value that reads as a flag', () => {
    expect(() => forgeDryRunLine({ ...input, tables: [] })).toThrow(
      'A forge resource clones a record or tables: its line names neither.',
    );
    expect(() => forgeDryRunLine({ ...input, source: '-SRC' })).toThrow(
      '--source cannot be "-SRC"',
    );
  });
});

describe('the answers of sandforge-clone, as a forge resource reads them', () => {
  it('reads a dry run, a run’s summary, its preview, its verification and its removal off what the clone prints', async () => {
    const world = new EnvWorld({ source: { alias: 'SRC' } });
    world.seedSource('Account', [{ Name: MARK }, { Name: MARK }]);
    for (const account of world.source?.all('Account') ?? []) {
      world.seedSource('Contact', [{ LastName: MARK, AccountId: account.Id }]);
    }
    const template = join(dir, 'template.json');
    writeFileSync(template, JSON.stringify(converted(tables).template));
    const line = {
      source: 'SRC',
      target: 'TGT',
      templateFile: template,
      tables: [{ object: 'Account', where: `Name = '${MARK}'` }, { object: 'Contact' }],
      maxTotal: 10_000,
      acceptAutomation: false,
    };
    const summary = join(dir, '1.summary.json');
    const signal = new AbortController().signal;

    const dry = await world.runner(FORGE_SCRIPT, forgeDryRunLine(line), signal);
    const counted = forgeDryRunCount(readForgeDryRun(dry.stdout));
    const ran = await world.runner(
      FORGE_SCRIPT,
      forgeApplyLine({ ...line, maxTotal: counted.total, summary }),
      signal,
    );
    const run = readForgeRun(readFileSync(summary, 'utf8'));
    const preview = readForgePreview(
      (await world.runner(FORGE_SCRIPT, forgePreviewLine({ target: 'TGT', summary }), signal))
        .stdout,
    );
    const verified = readForgeVerify(
      (
        await world.runner(
          FORGE_SCRIPT,
          forgeVerifyLine({ summary, target: 'TGT', source: 'SRC' }),
          signal,
        )
      ).stdout,
    );
    const removal = readForgeRemoval(
      (await world.runner(FORGE_SCRIPT, forgeRemoveLine({ target: 'TGT', summary }), signal))
        .stdout,
    );

    expect(counted).toEqual({
      objects: [
        { object: 'Account', wouldCreate: 2 },
        { object: 'Contact', wouldCreate: 2 },
      ],
      total: 4,
      created: 4,
      storageBytes: 4 * 2048,
      emails: [],
    });
    expect(ran.code).toBe(0);
    expect(forgeRunCount(run)).toEqual({
      objects: [
        { object: 'Account', created: 2, refused: 0, errors: [] },
        { object: 'Contact', created: 2, refused: 0, errors: [] },
      ],
      created: 4,
    });
    expect(preview.preview.planned).toBe(4);
    expect(preview.refusals).toEqual([]);
    expect(verified.result.verdict).toBe('verified');
    expect(verificationShortOf(verified)).toBeUndefined();
    expect(removal.result.status).toBe('success');
    expect(world.records('Account')).toEqual([]);
  });

  it('refuses an answer that does not read as the clone’s, naming the clone', () => {
    expect(() => readForgeDryRun('{"tool":"sandforge-seed"}')).toThrow(StepAnswerError);
    expect(() => readForgeRun('')).toThrow('sandforge-clone did not answer the summary of a run');
  });
});

describe('what a forge dry run counted, as the plan reads it', () => {
  const dry = (over: Partial<ForgeDryRunAnswer> = {}): ForgeDryRunAnswer => ({
    tool: 'sandforge-clone',
    version: 1,
    dryRun: true,
    result: { wouldInsertCount: 3, failedCount: 0 },
    writePlan: {
      totalRows: 3,
      storageBytes: 6144,
      objects: [
        { objectApiName: 'Account', rows: 1, storageBytes: 2048 },
        { objectApiName: 'Contact', rows: 2, storageBytes: 4096 },
      ],
      emails: [{ limit: 'SingleEmail', emails: 2 }],
    },
    ...over,
  });

  it('counts each object as its gate does, exact when the dry run inserts every row it counts', () => {
    expect(forgeDryRunCount(dry())).toEqual({
      objects: [
        { object: 'Account', wouldCreate: 1 },
        { object: 'Contact', wouldCreate: 2 },
      ],
      total: 3,
      created: 3,
      storageBytes: 6144,
      emails: [{ limit: 'SingleEmail', emails: 2 }],
    });
  });

  it('counts each object at most when the dry run links some of the rows its gate counted', () => {
    const counted = forgeDryRunCount(dry({ result: { wouldInsertCount: 2, failedCount: 0 } }));

    expect(counted.objects.every((object) => object.atMost === true)).toBe(true);
    expect(counted).toMatchObject({ total: 3, created: 2 });
  });

  it('refuses a dry run that never came to count, one that counts nothing, and says what a real run would meet', () => {
    expect(forgeDryRunCount(dry({ writePlan: undefined })).refusal).toBe(
      'the clone never came to count what it would write, and a run held to no count is held to nothing',
    );
    expect(
      forgeDryRunCount(dry({ writePlan: { totalRows: 0, storageBytes: 0, objects: [] } })).refusal,
    ).toBe(
      'it would write nothing: the clone reads no record to write; look at its record or the conditions of its tables',
    );
    expect(
      forgeDryRunCount(
        dry({ wouldBeRefused: ['The run would write 3 records, more than --max-total 2'] }),
      ).refusal,
    ).toBe('The run would write 3 records, more than --max-total 2');
  });

  it('folds what the org refused of a run into its objects', () => {
    expect(
      forgeRunCount({
        tool: 'sandforge-clone',
        version: 1,
        dryRun: false,
        result: {
          successCount: 1,
          failedCount: 2,
          createdByObject: [{ objectApiName: 'Account', sourceIds: ['001000000000001AAA'] }],
          errors: [
            { objectApiName: 'Contact', failedCount: 2 },
            { objectApiName: 'Account', failedCount: 0 },
          ],
        },
      }),
    ).toEqual({
      objects: [
        { object: 'Account', created: 1, refused: 0, errors: [] },
        { object: 'Contact', created: 0, refused: 2, errors: ['2 refused by the org'] },
      ],
      created: 1,
    });
  });

  it('says what a verification found short, records not there and lookups that do not hold, or the readings that never agreed', () => {
    const verify = (over: Partial<ForgeVerifyAnswer['result']>): ForgeVerifyAnswer => ({
      tool: 'sandforge-clone',
      version: 1,
      action: 'verify',
      result: {
        verdict: 'partial',
        attempts: 2,
        objects: [
          {
            objectApiName: 'Contact',
            expected: 2,
            present: 1,
            deleted: 1,
            notVisible: 0,
            changed: 0,
            linksChecked: 1,
            linksBroken: 1,
          },
          {
            objectApiName: 'Case',
            expected: 1,
            present: 0,
            deleted: 0,
            notVisible: 0,
            changed: 0,
            linksChecked: 0,
            linksBroken: 0,
            error: 'INVALID_TYPE',
          },
        ],
        ...over,
      },
    });

    expect(verificationShortOf(verify({}))).toBe(
      'Contact 1 of 2 not there; Contact 1 lookup(s) that do not hold; Case not read (INVALID_TYPE)',
    );
    expect(verificationShortOf(verify({ verdict: 'unstable', attempts: 3 }))).toBe(
      "no two of 3 readings agreed: something still writes to the run's records; verify again once it is done",
    );
  });
});

describe('what the org to fill would refuse every row of a forge resource for', () => {
  const answer = (gaps: unknown[]): ForgeDryRunAnswer =>
    readForgeDryRun(
      JSON.stringify({
        tool: 'sandforge-clone',
        version: 1,
        dryRun: true,
        result: { wouldInsertCount: 2, failedCount: 0 },
        writePlan: {
          totalRows: 2,
          storageBytes: 4096,
          objects: [{ objectApiName: 'Account', rows: 2, storageBytes: 4096 }],
        },
        targetGaps: { gaps },
      }),
    );
  const required = {
    id: 'g1',
    kind: 'required_field_missing',
    severity: 'blocking',
    source: 'metadata',
    objectApiName: 'Account',
    field: 'Region__c',
    rows: 0,
    decisions: ['default_value'],
  };

  it('names a field only the org to fill requires and the clone does not write, with the way out', () => {
    // Live, the plan said "Account 2 to write" of a run whose every account
    // the org would refuse: the clone reads the gap and goes on.
    const run = converted(tables);

    expect(forgeTargetRefusal(answer([required]), run.template)).toBe(
      'the org to fill would refuse its rows: Account.Region__c, which the org requires and the ' +
        "clone does not write. Give a field the org requires a value in the template's " +
        'defaultValues (template: { file, id }), leave out an object its user may not create, or ' +
        'run it once the org has requests left',
    );
  });

  it('lets through a field the template gives a value, which the clone writes', () => {
    const run = converted(tables);
    const given = {
      ...run.template,
      config: {
        ...run.template.config,
        defaultValues: [{ object: 'Account', field: 'region__c', value: 'EMEA' }],
      },
    };

    expect(forgeTargetRefusal(answer([required]), given)).toBeUndefined();
  });

  it('names an object its user may not create, and leaves alone what only warns', () => {
    const run = converted(tables);
    const closed = { ...required, kind: 'object_not_createable', field: undefined };
    const warning = { ...required, severity: 'warning' };

    expect(forgeTargetRefusal(answer([closed, warning]), run.template)).toContain(
      'Account, which the user it writes as may not create.',
    );
    expect(forgeTargetRefusal(answer([warning]), run.template)).toBeUndefined();
    expect(forgeTargetRefusal(answer([]), run.template)).toBeUndefined();
  });
});
