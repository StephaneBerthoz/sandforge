import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import {
  endOfAThrow,
  executeOptions,
  fieldExclusionsUnmatchedLines,
  fieldExclusionsUnmatchedOf,
  fieldExclusionsUnmatchedRefusal,
  graphLine,
  jsonResult,
  journalGoneWords,
  missingFlagsWords,
  neverClonedTableRefusal,
  notCountedObjectsOf,
  orphanParentsCappedLine,
  parseArgs,
  parseRemoveArgs,
  resumeChangedWords,
  runSummaryOfFile,
  summaryLines,
  sweepUserHint,
  tablesNotReachedWords,
  templateWithoutInputWords,
  wholeOrgMaxTotalRefusal,
  wholeOrgRefusalWords,
  cliRunSetup,
} from './sandforge-clone';
import { SfSessionError } from './sfFailure.js';
import { nodeRunJournal } from '../src/modules/forge/ForgeRunJournal.js';
import type { ExecutionSummary } from '../src/modules/forge/ForgeExecutor.js';

/*
 * What the clone's command line says when it refuses, and what it says of a
 * run that left something undone: each refusal names what it is and what to
 * do, on the surface it is read on — a flag, a command — never a page or a
 * flag that does not lift it.
 */

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A line of the command, `extra` after its orgs. */
function line(...extra: string[]): string[] {
  return ['node', 'sandforge-clone.ts', '--source', 'SRC', '--target', 'TGT', ...extra];
}

/** A node of a graph, as discovery builds one. */
function node(name: string, over: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: name,
    recordCount: 3,
    fieldCount: 4,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...over,
  };
}

/** A graph of these nodes and no lookup. */
function graphOf(...nodes: ForgeGraphNode[]): ForgeGraph {
  return { nodes, edges: [] } as unknown as ForgeGraph;
}

/** A summary that wrote nothing, with `over` on it. */
function summaryOf(over: Partial<ExecutionSummary> = {}): ExecutionSummary {
  return {
    successCount: 0,
    wouldInsertCount: 0,
    updatedCount: 0,
    linkedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 0,
    existingRecords: [],
    errors: [],
    remapTable: {},
    existingSourceIds: [],
    updatedSourceIds: [],
    createdByObject: [],
    remapByObject: [],
    readByObject: [],
    failedReads: [],
    ...over,
  } as unknown as ExecutionSummary;
}

describe('sandforge-clone, its refusals and what they name', () => {
  let stderr: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stderr = '';
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('sf org display reached');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a line that lacks what a clone needs', () => {
    it('names the flags missing, and the three things a clone starts from', () => {
      expect(() => parseArgs(['node', 'sandforge-clone.ts', '--target', 'TGT'])).toThrow(
        ExitCalled,
      );

      expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
      expect(stderr).toBe(
        'Missing what to clone: --record <id> for one record, --object <ApiName> for whole ' +
          'tables, or --depth all for the whole org; --source <alias>. Run with --help for usage.\n',
      );
      expect(missingFlagsWords(['--target'])).toBe(
        'Missing --target <alias>. Run with --help for usage.',
      );
    });
  });

  describe('a whole org, which takes no rehearsal nor upsert', () => {
    it('names --dry-run for a rehearsal, which says what a real run would be refused for', () => {
      expect(() => parseArgs(line('--depth', 'all', '--rehearse'))).toThrow(ExitCalled);

      expect(stderr).toContain(
        '--depth all clones the whole org, and does not go with --rehearse: a rehearsal holds ' +
          'every row it prepares: --dry-run counts what a real run would write and says what ' +
          'would refuse it, writing nothing.',
      );
    });

    it('names what copies the org again without its records twice, for an upsert', () => {
      expect(() => parseArgs(line('--depth', 'all', '--upsert'))).toThrow(ExitCalled);

      expect(stderr).toContain('--resume <journal> takes up a run that stopped');
      expect(stderr).toContain('--remove <summary> takes back a run that ended');
      expect(stderr).toContain(
        'pnpm exec tsx packages/extension/cli/sandforge-empty.ts --target <alias> --objects ' +
          '<A,B> --dry-run says what emptying',
      );
      expect(stderr).not.toMatch(/(^|[\s"`])sandforge-empty /);
    });
  });

  describe('tables, which take no rehearsal', () => {
    it('names --dry-run beside --record', () => {
      expect(() => parseArgs(line('--object', 'Account', '--rehearse'))).toThrow(ExitCalled);

      expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
      expect(stderr).toContain('it does not go with --rehearse');
      expect(stderr).toContain(
        '--dry-run reads the tables and counts what a real run would write, and says what ' +
          'would refuse it, writing nothing.',
      );
    });

    it.each([
      ['AccountHistory', 'no clone writes it — users and their access, metadata'],
      ['User', 'no clone writes it'],
      ['ContentVersion', 'a file goes with the record it hangs on, never as a table of its own'],
    ])('says what a table no clone writes is, %s, and what to do', (object, what) => {
      expect(neverClonedTableRefusal(object)).toContain(`--object ${object}: ${what}`);
      expect(neverClonedTableRefusal(object)).not.toContain('--depth');
    });

    it('names the table, and no flag, relayed by an environment, whose file names its tables', () => {
      process.env['SANDFORGE_RELAYED_BY'] = 'sandforge env apply';
      try {
        expect(neverClonedTableRefusal('ContentVersion')).toBe(
          'the table ContentVersion: a file goes with the record it hangs on, never as a table ' +
            'of its own. Leave it out.',
        );
        expect(
          fieldExclusionsUnmatchedRefusal(
            [{ objectApiName: 'Contact', field: 'emial', missing: 'field', nearest: 'Email' }],
            { flag: '--template', path: '/tmp/x/cloned.json' },
          ),
        ).toBe(
          'the exclusion Contact.emial: Contact has no field emial (Email?): it leaves nothing ' +
            'out, and the field the run was asked to keep back would be written with every ' +
            'row. Name the field as the source does — whatever its case — or leave the ' +
            'exclusion out of the template the resource names. Nothing was read or written.',
        );
      } finally {
        delete process.env['SANDFORGE_RELAYED_BY'];
      }
    });

    it('takes a managed package’s object picked by name, and any table a clone writes', () => {
      expect(neverClonedTableRefusal('vlocity_ins__Party__c')).toBeUndefined();
      expect(neverClonedTableRefusal('Contact')).toBeUndefined();
    });

    it('says why discovery did not reach a table, and only what reaches it', () => {
      expect(
        tablesNotReachedWords(['Opportunity'], {
          root: 'Account',
          objects: 3,
          depth: 'direct',
          customDepth: 5,
          truncated: false,
          env: false,
        }),
      ).toBe(
        '--object Opportunity: discovery from Account did not reach it (3 object(s), depth ' +
          'direct): name first a table it hangs from or points at, or raise --depth.',
      );
      // At the deepest walk and short of the cap, neither flag reaches it.
      expect(
        tablesNotReachedWords(['Opportunity'], {
          root: 'Account',
          objects: 3,
          depth: 'custom',
          customDepth: 10,
          truncated: false,
          env: false,
        }),
      ).toBe(
        '--object Opportunity: discovery from Account did not reach it (3 object(s), depth 10): ' +
          'name first a table it hangs from or points at; no lookup joins it to Account within ' +
          'the deepest walk, so clone it in a run of its own.',
      );
      expect(
        tablesNotReachedWords(['Opportunity'], {
          root: 'Account',
          objects: 50,
          depth: 'custom',
          customDepth: 10,
          truncated: true,
          env: true,
        }),
      ).toContain(
        "cut at its cap): name first a table it hangs from or points at, or raise the resource's maxNodes.",
      );
      // Discovery never walks into a package's namespace: more depth reaches nothing.
      const pkg = tablesNotReachedWords(['vlocity_ins__Party__c'], {
        root: 'Account',
        objects: 3,
        depth: 'direct',
        customDepth: 5,
        truncated: true,
        env: false,
      });
      expect(pkg).toContain(
        '--object vlocity_ins__Party__c: discovery does not walk into the objects of a managed ' +
          "package's namespace",
      );
      expect(pkg).toContain('name it first, the table discovery starts from');
      expect(pkg).not.toContain('raise');
    });
  });

  describe('a template the line cannot run as it is', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-refusals-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('names --object and --where with --template for a template of a query, its root under its condition', () => {
      const template = join(dir, 'template.json');
      writeFileSync(
        template,
        JSON.stringify({
          id: 't',
          name: 't',
          description: '',
          config: {
            inputMode: 'soql',
            soqlQuery: "SELECT Id FROM Account WHERE Industry = 'Energy'",
            depth: 'direct',
            anonymizePII: false,
            skipEmpty: true,
            batchSize: 'auto',
            objectSoqlFilters: { Account: "Industry = 'Energy'" },
          },
          objectCount: 0,
          recordCount: 0,
          createdAt: '2026-11-14T00:00:00.000Z',
          lastUsedAt: '2026-11-14T00:00:00.000Z',
        }),
      );

      expect(() => parseArgs(line('--template', template))).toThrow(ExitCalled);

      expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
      expect(stderr).toBe(
        '--template: the template clones from a query, which the command runs as whole ' +
          `tables: give --object Account --where "Industry = 'Energy'" with --template, its ` +
          "root under the query's condition, and an --object for each other table to clone; " +
          'or --record to clone one record with its choices.\n',
      );
      expect(templateWithoutInputWords('record', undefined, undefined)).toBe(
        '--template: the template clones from a record it does not name: give --record.',
      );
    });
  });

  describe('--max-orphans', () => {
    it('bounds the parents --expand-orphans copies, handed to the run and in its fingerprint', () => {
      const args = parseArgs(
        line('--record', '001000000000001AAA', '--expand-orphans', '--max-orphans', '60'),
      );

      expect(args.maxOrphans).toBe(60);
      expect(executeOptions(args, graphOf(node('Account')), [])).toMatchObject({
        expandOrphanParents: true,
        maxOrphanParentExpansions: 60,
      });
      expect(cliRunSetup(args, '00D000000000002AAA')).toMatchObject({ maxOrphans: 60 });
      // Not given, the fingerprint is the one a journal was begun with.
      const without = parseArgs(line('--record', '001000000000001AAA', '--expand-orphans'));
      expect(cliRunSetup(without, '00D000000000002AAA')).not.toHaveProperty('maxOrphans');
      expect(executeOptions(without, graphOf(node('Account')), [])).not.toHaveProperty(
        'maxOrphanParentExpansions',
      );
    });

    it.each([
      [['--max-orphans', '60'], '--max-orphans goes with --expand-orphans'],
      [
        ['--expand-orphans', '--max-orphans', '0'],
        '--max-orphans takes a whole number of parents, 1 to 1000',
      ],
      [['--expand-orphans', '--max-orphans', '1001'], '--max-orphans takes a whole number'],
      [['--expand-orphans', '--max-orphans', 'lots'], '--max-orphans takes a whole number'],
    ])('refuses %j before any org is reached', (extra, said) => {
      expect(() => parseArgs(line('--record', '001000000000001AAA', ...extra))).toThrow(ExitCalled);
      expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
      expect(stderr).toContain(said);
    });

    it('is refused with tables and with the whole org, which copy no parent from outside', () => {
      expect(() =>
        parseArgs(line('--object', 'Account', '--expand-orphans', '--max-orphans', '5')),
      ).toThrow(ExitCalled);
      expect(stderr).toContain('it does not go with --expand-orphans, --max-orphans');
      stderr = '';
      expect(() => parseArgs(line('--depth', 'all', '--max-orphans', '5'))).toThrow(ExitCalled);
      expect(stderr).toContain('does not go with --max-orphans');
    });
  });

  describe('a whole org past what the line holds it to', () => {
    it('names the sample that fits the target past --max-total, unless it is one', () => {
      expect(wholeOrgMaxTotalRefusal(240_000, 10_000)).toBe(
        'The clone of the whole org would write 240000 records, more than the 10000 ' +
          '--max-total holds it to: give --max-total the count its dry run says, copy a sample ' +
          'of the org that fits the target and --max-total (--fit share, its dry run first), or ' +
          'leave objects out (--exclude-object) or narrow them (--filter).',
      );
      expect(wholeOrgMaxTotalRefusal(240_000, 10_000, true)).not.toContain('--fit share');
    });

    it('names the sample, the objects left out and the filters past the requests or batches it has', () => {
      const batches =
        'The run writes through Bulk API jobs that take about 900 of the daily Bulk API ' +
        'batches, and TGT has 10 of its 15000 left: its jobs would be refused part way ' +
        'through. Run it once the org has batches to spare — the limit is counted over the ' +
        'last 24 hours, and Bulk API 1.0 shares it — or leave objects out. Nothing was written.';
      expect(wholeOrgRefusalWords(batches)).toContain(
        '— or leave objects out (--exclude-object), narrow them (--filter), or copy a sample ' +
          'of the org that fits the target (--fit share, its dry run first). Nothing was written.',
      );
      expect(wholeOrgRefusalWords(batches, true)).toContain(
        '— or leave objects out (--exclude-object), narrow them (--filter). Nothing was written.',
      );
      expect(
        wholeOrgRefusalWords(
          'Run it once the org has requests to spare — the limit is counted over the last 24 ' +
            'hours — or write fewer records. Nothing was written.',
        ),
      ).toContain('narrow them (--filter), or copy a sample of the org that fits the target');
    });
  });

  describe('fields left out that name nothing of the source', () => {
    const unmatched = [
      { objectApiName: 'Contact', field: 'emial', missing: 'field' as const, nearest: 'Email' },
      { objectApiName: 'Polcy__c', field: 'Name', missing: 'object' as const },
    ];

    it('are found whatever their case, an object the source lacks told by its describe', async () => {
      const fieldsOf = vi.fn(async (object: string) => {
        if (object === 'Polcy__c')
          throw Object.assign(new Error('nope'), { errorCode: 'NOT_FOUND' });
        if (object === 'Broken__c') throw new Error('timed out');
        return ['Id', 'LastName', 'Email'];
      });

      expect(
        await fieldExclusionsUnmatchedOf(
          { contact: ['EMAIL', 'emial'], Polcy__c: ['Name'], Broken__c: ['X'] },
          graphOf(node('Contact')),
          fieldsOf,
        ),
      ).toEqual(unmatched);
      // Matched to the graph's own name, described once each.
      expect(fieldsOf.mock.calls.map(([object]) => object)).toEqual([
        'Contact',
        'Polcy__c',
        'Broken__c',
      ]);
      expect(await fieldExclusionsUnmatchedOf({}, graphOf(node('Contact')), fieldsOf)).toEqual([]);
    });

    it('refuse a run in words that name each with the field nearest it, the file’s too', () => {
      expect(fieldExclusionsUnmatchedRefusal(unmatched)).toBe(
        '--exclude Contact.emial: Contact has no field emial (Email?); --exclude Polcy__c.Name: ' +
          'the source has no object Polcy__c: they leave nothing out, and the field the run was ' +
          'asked to keep back would be written with every row. Name the field as the source ' +
          'does — whatever its case — or leave the exclusion out. Nothing was read or written.',
      );
      expect(
        fieldExclusionsUnmatchedRefusal(unmatched.slice(0, 1), {
          flag: '--config',
          path: 'choices.json',
        }),
      ).toContain(
        'leave the exclusion out of --exclude, or of the fieldExclusions of --config choices.json.',
      );
    });

    it('are said in the summary, its lines and its JSON', () => {
      const summary = summaryOf({ fieldExclusionsUnmatched: unmatched });

      expect(summaryLines(summary)).toEqual(
        expect.arrayContaining(fieldExclusionsUnmatchedLines(unmatched)),
      );
      expect(fieldExclusionsUnmatchedLines(unmatched)).toEqual([
        'left nothing out, naming no field of the source (2):',
        '  --exclude Contact.emial: Contact has no field emial (Email?)',
        '  --exclude Polcy__c.Name: the source has no object Polcy__c',
      ]);
      expect(jsonResult(summary)).toMatchObject({ fieldExclusionsUnmatched: unmatched });
      expect(jsonResult(summaryOf())).not.toHaveProperty('fieldExclusionsUnmatched');
    });
  });

  describe('a summary past the ids it keeps', () => {
    it('counts per object what the run created, its ids in the journal', () => {
      const summary = summaryOf({
        remapInJournal: true,
        remapByObject: [
          { objectApiName: 'Account', created: 2, linked: 0 },
          { objectApiName: 'Pricebook2', created: 0, linked: 1 },
          { objectApiName: 'Contact', created: 60_000, linked: 3 },
        ],
      } as Partial<ExecutionSummary>);

      expect(jsonResult(summary)).toMatchObject({
        remapInJournal: true,
        createdCountByObject: [
          { objectApiName: 'Account', created: 2 },
          { objectApiName: 'Contact', created: 60_000 },
        ],
      });
      expect(jsonResult(summaryOf())).not.toHaveProperty('createdCountByObject');
    });
  });

  describe('parents from outside the run past the most it copies', () => {
    it('are said with the cap and what raises it, in the lines and the JSON', () => {
      const capped = { cap: 20, notCopied: 7, objects: ['Account', 'Contact'] };
      const summary = summaryOf({ orphanParentsCapped: capped });

      expect(orphanParentsCappedLine(capped)).toBe(
        'parents from outside the run not copied: 7 past the 20 --expand-orphans copies at ' +
          'most (--max-orphans raises it), of Account, Contact; the rows that cannot be written ' +
          'without one were refused',
      );
      expect(summaryLines(summary)).toContain(orphanParentsCappedLine(capped));
      expect(jsonResult(summary)).toMatchObject({ orphanParentsCapped: capped });
      expect(jsonResult(summaryOf())).not.toHaveProperty('orphanParentsCapped');
    });
  });

  describe('objects discovery could not count', () => {
    it('are named, those it left out and those it kept, in the line and the JSON', () => {
      const graph = graphOf(
        node('Account'),
        node('Case', { included: true, recordCount: 0, recordCountUnknown: true }),
        node('Secret__c', {
          included: false,
          recordCount: 0,
          status: 'error',
          errors: ['Record count unavailable: INSUFFICIENT_ACCESS'],
        }),
        node('Empty__c', { included: false, recordCount: 0 }),
      );

      expect(notCountedObjectsOf(graph)).toEqual({ refused: ['Secret__c'], unanswered: ['Case'] });
      expect(graphLine(graph, { waves: [], cycleResolutions: [] }, 50)).toContain(
        '2 included, 1 of them kept though their count got no answer (Case), 1 not counted ' +
          '(Secret__c);',
      );
    });
  });

  describe('a run --resume cannot take up as the line sets it', () => {
    it('names what differs from the run its journal began, as far as the journal keeps it', () => {
      const then = graphOf(node('Account'), node('Contact'));
      const now = graphOf(node('Account'), node('Contact', { included: false }));
      expect(
        resumeChangedWords(
          {
            recordId: '001000000000001AAA',
            startedWith: {
              graph: then,
              config: {
                inputMode: 'record',
                recordId: '001000000000001AAA',
                depth: 'full',
                sourceOrgId: 'SRC',
                targetOrgId: 'TGT',
                anonymizePII: false,
                skipEmpty: true,
                batchSize: 'auto',
              },
            },
          } as never,
          {
            graph: now,
            record: '001000000000002AAA',
            config: {
              inputMode: 'record',
              recordId: '001000000000002AAA',
              depth: 'direct',
              sourceOrgId: 'SRC',
              targetOrgId: 'TGT',
              anonymizePII: true,
              skipEmpty: true,
              batchSize: 'auto',
            },
          },
        ),
      ).toBe(
        '--record (001000000000001AAA then, 001000000000002AAA now); --depth, --anonymize ' +
          'differ; it took Contact, which this one leaves',
      );
      // A journal that keeps nothing to tell names the flags only its fingerprint holds.
      expect(resumeChangedWords({}, { graph: now })).toContain(
        'what differs is among what its journal does not keep: --upsert',
      );
    });
  });

  describe('a summary whose journal is gone', () => {
    it('says what still takes the run back: a checkpoint, or emptying its objects', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-gone-'));
      try {
        const file = join(dir, 'summary.json');
        const text = JSON.stringify({
          tool: 'sandforge-clone',
          version: 1,
          source: 'SRC',
          target: 'TGT',
          objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
          dryRun: false,
          elapsedMs: 1,
          journal: join(dir, 'gone.ndjson'),
          part: 0,
          result: {
            remapInJournal: true,
            remapTable: {},
            existingSourceIds: [],
            updatedSourceIds: [],
            createdByObject: [],
          },
        });
        writeFileSync(file, text);

        const read = await runSummaryOfFile(file, text, 'TGT', nodeRunJournal(dir));

        expect(read).toEqual({
          refusal:
            `keeps the ids of its records in ${join(dir, 'gone.ndjson')}, which cannot be read. ` +
            journalGoneWords('TGT', ['Account', 'Contact']),
        });
        expect(journalGoneWords('TGT', ['Account', 'Contact'])).toBe(
          'Its records can no longer be removed or verified from here. A checkpoint taken ' +
            'before the run takes TGT back: pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts ' +
            'list --org TGT names them, pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts ' +
            'rewind --org TGT --checkpoint <id> rewinds to one. Without one, pnpm exec tsx ' +
            'packages/extension/cli/sandforge-empty.ts --target TGT --objects Account,Contact ' +
            '--dry-run says what emptying its objects would delete: every record of them, not ' +
            "only the run's.",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('a sweep that cannot tell the user the run wrote as', () => {
    it('takes --sweep-user with a sweep, a user’s id', () => {
      expect(
        parseRemoveArgs([
          'node',
          'sandforge-clone.ts',
          '--remove',
          's.json',
          '--target',
          'TGT',
          '--sweep-list',
          '--sweep-user',
          '005000000000009AAA',
        ]).sweepUser,
      ).toBe('005000000000009AAA');
      for (const extra of [
        ['--sweep-user', '005000000000009AAA'],
        ['--sweep', '--sweep-user', '001000000000009AAA'],
      ]) {
        expect(() =>
          parseRemoveArgs([
            'node',
            'sandforge-clone.ts',
            '--remove',
            's.json',
            '--target',
            'TGT',
            ...extra,
          ]),
        ).toThrow(ExitCalled);
      }
      expect(stderr).toContain('--sweep-user goes with --sweep or --sweep-list');
      expect(stderr).toContain('--sweep-user takes the id of a user');
    });

    it('names --sweep-user when the summary keeps no user and none was given', () => {
      const refusal =
        'The user the run wrote as could not be read: none of its records is left in the org ' +
        'or its recycle bin to tell it. Nothing is swept.';
      expect(sweepUserHint(refusal, { kept: false, given: false, target: 'TGT' })).toBe(
        '  --sweep-user <id> names the user the run wrote as, which its summary does not keep: ' +
          '"sf org display user --target-org TGT" gives the id of the user sf signs in as, the ' +
          'one a run of this machine wrote as',
      );
      expect(sweepUserHint(refusal, { kept: true, given: false, target: 'TGT' })).toBeUndefined();
      expect(
        sweepUserHint('The target did not date this run’s writes.', {
          kept: false,
          given: false,
          target: 'TGT',
        }),
      ).toBeUndefined();
    });
  });

  describe('how the command ends on what it threw', () => {
    it('says a refusal of sf as it is, without FATAL and its frames', () => {
      const refused = new SfSessionError(
        'SRC',
        'sf does not know SRC: sf org login web --alias SRC adds it.',
      );

      expect(endOfAThrow(refused)).toEqual({
        line: 'sf does not know SRC: sf org login web --alias SRC adds it. Nothing was read from SRC.',
        exitCode: 1,
      });
      expect(endOfAThrow(new Error('Invalid SF org alias: "-x" (an alias)'))).toEqual({
        line: 'Invalid SF org alias: "-x" (an alias)',
        exitCode: 2,
      });
      const fault = new Error('boom');
      expect(endOfAThrow(fault).line).toBe(`FATAL: ${fault.stack ?? ''}`);
      expect(endOfAThrow(fault).exitCode).toBe(1);
    });
  });
});
