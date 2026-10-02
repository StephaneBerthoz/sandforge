import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Connection } from 'jsforce';
import type { ForgeRemovalSpan, ForgeUndoObjectResult } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
// The files are real; a test can make one write refuse.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});
// The removal is the wizard's own, tested on its own: here, what the command
// hands it and what it makes of the answer.
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/forge/ForgeRunRemoval.js')>();
  return { ...actual, removalOrg: vi.fn(), removeRunRecords: vi.fn() };
});

import { loadOrg, makeConn } from './sfSession.js';
import {
  removalOrg,
  removeRunRecords,
  type RemovalOrg,
  type RunRemovalOptions,
  type RunRemovalOutcome,
} from '../src/modules/forge/ForgeRunRemoval.js';
import {
  main,
  parseRunSummary,
  productionRefusal,
  readEarlierRemovals,
  removalLines,
  removalPlan,
  removalsAfter,
  removalsPath,
  runKey,
  typeOrg,
} from './sandforge-clone';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** Run the command and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(['node', 'sandforge-clone.ts', ...args]);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
}

/** The org the run wrote to, by its own id. */
const TARGET_ORG = '00D000000000002AAA';

/** A fake source id: the object's prefix, then a number. */
const SRC = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
/** The record the run gave that source id in the target. */
const TGT = (prefix: string, n: number): string =>
  `${prefix}${String(n + 900).padStart(12, '0')}AAA`;

/** The account the clone started from, created by the run, and the contacts it created under it. */
const ACCOUNT = SRC('001', 1);
const CONTACTS = [SRC('003', 1), SRC('003', 2)];
/** An account the target already held, which the run linked to. */
const HELD = SRC('001', 2);
/** A contact `--upsert` matched by its external id and wrote over. */
const WRITTEN_OVER = SRC('003', 3);
/** A person account's contact, which the platform wrote with an account the run created. */
const PERSON_CONTACT = SRC('003', 4);

const WRITTEN_BETWEEN = { first: '2026-10-01T10:00:00.000Z', last: '2026-10-01T10:00:05.000Z' };

/** The summary a real run printed with `--json`, with what `overrides` replaces in it. */
function runSummary(
  overrides: Record<string, unknown> = {},
  result: Record<string, unknown> = {},
): Record<string, unknown> {
  const mapped = [ACCOUNT, ...CONTACTS, HELD, WRITTEN_OVER, PERSON_CONTACT];
  return {
    tool: 'sandforge-clone',
    version: 1,
    source: 'SRC',
    target: 'TGT',
    targetOrgId: TARGET_ORG,
    record: ACCOUNT,
    dryRun: false,
    upsert: true,
    expandOrphans: false,
    files: false,
    graph: { nodes: 2, edges: 1, waves: 2, cycles: 0, truncated: false },
    result: {
      successCount: 3,
      updatedCount: 1,
      linkedCount: 2,
      wouldInsertCount: 0,
      failedCount: 0,
      skippedCount: 0,
      remapCount: mapped.length,
      existingRecords: [],
      errors: [],
      remapTable: Object.fromEntries(
        mapped.map((id) => [id, TGT(id.slice(0, 3), Number(id.slice(3, 15)))]),
      ),
      existingSourceIds: [HELD, PERSON_CONTACT],
      updatedSourceIds: [WRITTEN_OVER],
      createdByObject: [
        { objectApiName: 'Account', sourceIds: [ACCOUNT] },
        { objectApiName: 'Contact', sourceIds: CONTACTS },
      ],
      withTheirRecordSourceIds: [PERSON_CONTACT],
      writtenBetween: WRITTEN_BETWEEN,
      readByObject: [],
      failedReads: [],
      ...result,
    },
    elapsedMs: 9_000,
    finishedAt: '2026-10-01T10:00:06.000Z',
    ...overrides,
  };
}

/** One object's result, deleted whole unless `overrides` says otherwise. */
function objectResult(
  objectApiName: string,
  planned: number,
  overrides: Partial<ForgeUndoObjectResult> = {},
): ForgeUndoObjectResult {
  return {
    objectApiName,
    planned,
    deleted: planned,
    alreadyGone: 0,
    keptChanged: 0,
    keptDependents: 0,
    refused: 0,
    heldBy: [],
    unchecked: [],
    reasons: [],
    ...overrides,
  };
}

/** A removal that took every record it set out to take. */
const TOOK_ALL: RunRemovalOutcome = {
  objects: [objectResult('Contact', 2), objectResult('Account', 1)],
  cancelled: false,
  gone: [],
  stamps: {},
};

/** The plan the summary of `runSummary` gives a removal, children first. */
const PLAN = [
  { objectApiName: 'Contact', ids: [TGT('003', 2), TGT('003', 1)] },
  { objectApiName: 'Account', ids: [TGT('001', 1)] },
];

/** When a removal ran by the org's clock, and as which user. */
const span = (first: string, last: string): ForgeRemovalSpan => ({
  first,
  last,
  userId: '005000000000001',
});
const FIRST_SPAN = span('2026-10-01T11:00:00.000Z', '2026-10-01T11:00:20.000Z');
const SECOND_SPAN = span('2026-10-01T12:00:00.000Z', '2026-10-01T12:00:20.000Z');

/**
 * What a first removal left on the account it did not reach: as it deleted
 * the contacts, the org dated their account, modified by the removal's user —
 * a date the org writes with an offset `z.iso.datetime()` refuses.
 */
const FIRST_STAMPS = { [TGT('001', 1)]: '2026-10-01T11:00:07.000+0000' };

/**
 * A first removal stopped once it had deleted the contacts: the next one,
 * told nothing, reads their account as changed since the run, and keeps it.
 */
const STOPPED_AFTER_CONTACTS: RunRemovalOutcome = {
  objects: [objectResult('Contact', 2)],
  cancelled: true,
  gone: [TGT('003', 2), TGT('003', 1)],
  stamps: FIRST_STAMPS,
  span: FIRST_SPAN,
};

describe('sandforge-clone --remove', () => {
  let dir: string;
  let printed: string[];
  let stdout: string[];
  let stderr: string[];
  /** The target as the command reaches it: what its Organization record says. */
  let organization: { Id: string; IsSandbox: boolean };
  const targetConn = {
    query: vi.fn(async () => ({ totalSize: 1, done: true, records: [organization] })),
  } as unknown as Connection;
  const session = { label: 'the removal session' } as unknown as RemovalOrg;

  /** A file holding `content`, and its path. */
  function file(content: unknown, name = 'clone-summary.json'): string {
    const path = join(dir, name);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    return path;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Back to the real write: a refusal a test queued and the command never
    // reached would otherwise refuse the next test's own files.
    vi.mocked(writeFileSync).mockReset();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-remove-'));
    printed = [];
    stdout = [];
    stderr = [];
    organization = { Id: TARGET_ORG, IsSandbox: true };
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      stderr.push(String(line));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.mocked(loadOrg).mockImplementation(async (alias) => ({
      alias,
      username: '',
      instanceUrl: `https://${alias.toLowerCase()}.example.com`,
      accessToken: 'token',
    }));
    vi.mocked(makeConn).mockReturnValue(targetConn);
    vi.mocked(removalOrg).mockReturnValue(session);
    vi.mocked(removeRunRecords).mockResolvedValue(TOOK_ALL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The options the command handed the removal, from its one call. */
  function removalOptions(): RunRemovalOptions {
    expect(removeRunRecords).toHaveBeenCalledTimes(1);
    return vi.mocked(removeRunRecords).mock.calls[0][2];
  }

  describe('its command line', () => {
    it.each([
      ['no org', ['--remove', 'clone-summary.json']],
      ['no summary', ['--remove', '--target', 'TGT']],
      ['a flag of the clone', ['--remove', 'clone-summary.json', '--target', 'TGT', '--dry-run']],
      [
        'a record to clone',
        ['--remove', 'clone-summary.json', '--target', 'TGT', '--record', ACCOUNT],
      ],
      ['a word that is no flag', ['--remove', 'clone-summary.json', '--target', 'TGT', 'now']],
    ])('exits 2 on %s, before anything is read', async (_label, args) => {
      expect(await run(args)).toBe(2);

      expect(loadOrg).not.toHaveBeenCalled();
      expect(stderr.join('')).toContain('--remove takes');
    });
  });

  describe('the summary it reads', () => {
    it("refuses a dry run's summary, which created nothing, and says so before contacting any org", async () => {
      const path = file(runSummary({ dryRun: true }, { createdByObject: [] }));

      expect(await run(['--remove', path, '--target', 'TGT'])).toBe(2);

      expect(stderr.join('')).toContain(
        `--remove ${path} is the summary of a dry run, which wrote nothing to the target: ` +
          'there is nothing of it to remove.',
      );
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('refuses a file that is not JSON, one that is not a summary of the command, and one it cannot read', async () => {
      expect(await run(['--remove', file('sandforge-clone  SRC -> TGT'), '--target', 'TGT'])).toBe(
        2,
      );
      expect(await run(['--remove', file({ tool: 'sandforge-frozen' }), '--target', 'TGT'])).toBe(
        2,
      );
      expect(await run(['--remove', join(dir, 'none.json'), '--target', 'TGT'])).toBe(2);

      const said = stderr.join('');
      expect(said).toContain('is not JSON');
      expect(said).toContain('is not a summary sandforge-clone printed with --json.');
      expect(said).toContain('cannot be read');
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('refuses a summary whose ids or object names are not what they should be, and says where', async () => {
      // Every id of the summary ends up in a query or a delete.
      const path = file(
        runSummary(
          {},
          {
            createdByObject: [
              { objectApiName: 'Account', sourceIds: [ACCOUNT] },
              { objectApiName: "Contact' OR Name != '", sourceIds: ["003' OR Id != '"] },
            ],
          },
        ),
      );

      expect(await run(['--remove', path, '--target', 'TGT'])).toBe(2);

      const said = stderr.join('');
      expect(said).toContain('is not a summary a removal can read');
      expect(said).toContain('result.createdByObject.1.objectApiName: not an API name');
      expect(said).toContain('result.createdByObject.1.sourceIds.0: not a Salesforce id');
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('refuses a summary printed before it said which records the run created', async () => {
      const summary = runSummary();
      delete (summary.result as Record<string, unknown>).createdByObject;

      expect(await run(['--remove', file(summary), '--target', 'TGT'])).toBe(2);

      expect(stderr.join('')).toContain('does not say which records the run created');
      expect(stderr.join('')).toContain('sandforge-cleanup remains for such a run');
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('plans what the run created, children first, and never a record the target held, whichever row names it', () => {
      // A row linked to a record the target held, or written over by
      // --upsert, is not the run's; a summary edited by hand to list one
      // among the created rows does not make it so.
      const read = parseRunSummary(
        JSON.stringify(
          runSummary(
            {},
            {
              createdByObject: [
                { objectApiName: 'Account', sourceIds: [ACCOUNT, HELD] },
                { objectApiName: 'Contact', sourceIds: [...CONTACTS, WRITTEN_OVER] },
              ],
            },
          ),
        ),
      );
      if (!('summary' in read)) throw new Error(read.refusal);

      expect(removalPlan(read.summary)).toEqual([
        { objectApiName: 'Contact', ids: [TGT('003', 2), TGT('003', 1)] },
        { objectApiName: 'Account', ids: [TGT('001', 1)] },
      ]);
    });
  });

  describe('the org it removes from', () => {
    it('refuses another alias than the one the run wrote to, when the summary does not name the org by its id', async () => {
      const path = file(runSummary({ targetOrgId: undefined }));

      expect(await run(['--remove', path, '--target', 'OTHER'])).toBe(2);

      expect(stderr.join('')).toContain(
        'The run wrote to TGT, and its records are removed from that org only: give --target TGT.',
      );
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('takes the run back from the org it wrote to under another alias, known by its id', async () => {
      expect(
        await run(['--remove', file(runSummary()), '--target', 'TGT-RENAMED']),
      ).toBeUndefined();

      expect(loadOrg).toHaveBeenCalledWith('TGT-RENAMED');
      expect(removeRunRecords).toHaveBeenCalledTimes(1);
    });

    it('refuses an org other than the one the run wrote to, and deletes nothing', async () => {
      organization = { Id: '00D000000000003AAA', IsSandbox: true };

      expect(await run(['--remove', file(runSummary()), '--target', 'TGT'])).toBe(1);

      expect(stderr.join('')).toContain(
        `TGT is not the org the run wrote to (${TARGET_ORG}), and its records are removed from ` +
          'that org only. Nothing was deleted.',
      );
      expect(removeRunRecords).not.toHaveBeenCalled();
    });

    it('refuses a production org before reading or deleting anything', async () => {
      organization = { Id: TARGET_ORG, IsSandbox: false };

      expect(await run(['--remove', file(runSummary()), '--target', 'TGT'])).toBe(1);

      expect(stderr.join('')).toContain(
        'TGT is a production org (its Organization record says IsSandbox false): ' +
          'sandforge-clone removes records from sandboxes only. Nothing was deleted.',
      );
      expect(removalOrg).not.toHaveBeenCalled();
      expect(removeRunRecords).not.toHaveBeenCalled();
    });
  });

  describe('the removal', () => {
    it("removes what the run created as the wizard does: from the target, on the run's plan, by the target's dates of the run", async () => {
      expect(await run(['--remove', file(runSummary()), '--target', 'TGT'])).toBeUndefined();

      expect(removalOrg).toHaveBeenCalledWith(targetConn, 'sandforge-clone --remove');
      const [org, plan] = vi.mocked(removeRunRecords).mock.calls[0];
      expect(org).toBe(session);
      expect(plan).toEqual([
        { objectApiName: 'Contact', ids: [TGT('003', 2), TGT('003', 1)] },
        { objectApiName: 'Account', ids: [TGT('001', 1)] },
      ]);
      const options = removalOptions();
      expect(options.runStartedAt).toEqual(new Date(WRITTEN_BETWEEN.first));
      expect(options.runEndedAt).toEqual(new Date(WRITTEN_BETWEEN.last));
      expect(options.includeChanged).toBe(false);
      expect(options.runRecordedAt).toBeUndefined();
      expect(printed).toEqual(
        expect.arrayContaining(['removal: SUCCESS', '  Contact: 2 deleted of 2']),
      );
    });

    it('says before it deletes what it takes per object, and what stays', async () => {
      expect(await run(['--remove', file(runSummary()), '--target', 'TGT'])).toBeUndefined();

      // The person account's contact goes with its account: of the three
      // records the target held, two stay.
      expect(printed).toEqual(
        expect.arrayContaining([
          `the clone of ${ACCOUNT} wrote to TGT until ${WRITTEN_BETWEEN.last}; ` +
            'a removal deletes the 3 record(s) it created, children first:',
          '  Contact: 2',
          '  Account: 1',
          '2 record(s) the target already held, which the run linked to or wrote over, stay',
          'records changed since the run stay, as do those records added since depend on ' +
            '(--include-changed takes them)',
        ]),
      );
    });

    it('dates a run the target did not date by when it ended, as the wizard dates a history entry', async () => {
      const path = file(runSummary({}, { writtenBetween: undefined }));

      expect(await run(['--remove', path, '--target', 'TGT'])).toBeUndefined();

      const options = removalOptions();
      expect(options.runStartedAt).toBeUndefined();
      expect(options.runEndedAt).toBeUndefined();
      expect(options.runDurationMs).toBe(9_000);
      expect(options.runRecordedAt).toEqual(new Date('2026-10-01T10:00:06.000Z'));
    });

    it('takes the records changed since the run too with --include-changed', async () => {
      const path = file(runSummary());

      expect(await run(['--remove', path, '--target', 'TGT', '--include-changed'])).toBeUndefined();

      expect(removalOptions().includeChanged).toBe(true);
      expect(printed).toContain(
        'records changed since the run go too, and what was added to them since',
      );
    });

    it("exits 3 when records of the run stay, and says per object what became of them, with the org's words", async () => {
      vi.mocked(removeRunRecords).mockResolvedValue({
        objects: [
          objectResult('Contact', 2, { deleted: 1, keptChanged: 1 }),
          objectResult('Account', 1, {
            deleted: 0,
            refused: 1,
            reasons: ['DELETE_FAILED: Your attempt to delete Acme could not be completed'],
            filesLeft: { count: 6, names: ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'] },
          }),
        ],
        cancelled: false,
        gone: [],
        stamps: {},
      });

      expect(await run(['--remove', file(runSummary()), '--target', 'TGT'])).toBe(3);

      expect(printed).toEqual(
        expect.arrayContaining([
          'removal: PARTIAL',
          '  Contact: 1 deleted, 1 kept, changed since the run of 2',
          '  Account: 1 refused of 1',
          '      DELETE_FAILED: Your attempt to delete Acme could not be completed',
          '      6 file(s) attached to them stay in the org, as the run did not create them: ' +
            'a.pdf, b.pdf, c.pdf, d.pdf, e.pdf, …',
        ]),
      );
    });

    it('prints the outcome as JSON alone on stdout under --json, every other line on stderr', async () => {
      const path = file(runSummary());

      expect(await run(['--remove', path, '--target', 'TGT', '--json'])).toBeUndefined();

      expect(printed).toEqual([]);
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        tool: 'sandforge-clone',
        version: 1,
        action: 'remove',
        summary: path,
        target: 'TGT',
        targetOrgId: TARGET_ORG,
        includeChanged: false,
        result: { status: 'success', planned: 3, objects: TOOK_ALL.objects },
      });
      expect(stderr).toContain('  Contact: 2');
    });

    it('says there is nothing to remove of a run that created nothing, without contacting the org', async () => {
      const path = file(runSummary({}, { createdByObject: [] }));

      expect(await run(['--remove', path, '--target', 'TGT'])).toBeUndefined();

      expect(printed).toContain('The run created no record: there is nothing of it to remove.');
      expect(loadOrg).not.toHaveBeenCalled();
      expect(removeRunRecords).not.toHaveBeenCalled();
    });

    it('stops on Ctrl-C before its next call to the org, as Cancel does, and exits 3', async () => {
      // A process killed outright left an order the removal had set to Draft
      // a draft: stopped, the removal gives it its status back on its way out.
      const listening = process.listenerCount('SIGINT');
      const once = vi.spyOn(process, 'once');
      vi.mocked(removeRunRecords).mockImplementation(async (_org, _plan, options) => {
        const interrupt = once.mock.calls.find(([event]) => event === 'SIGINT')?.[1];
        expect(options.signal?.aborted).toBe(false);
        (interrupt as () => void)();
        expect(options.signal?.aborted).toBe(true);
        return { ...TOOK_ALL, objects: [objectResult('Contact', 2)], cancelled: true };
      });

      expect(await run(['--remove', file(runSummary()), '--target', 'TGT'])).toBe(3);

      expect(printed).toContain('removal: CANCELLED');
      expect(process.listenerCount('SIGINT')).toBe(listening);
    });
  });

  describe('what a removal keeps for the next one', () => {
    /** The removals file beside a summary, as JSON. */
    const removalsOf = (summaryPath: string): unknown =>
      JSON.parse(readFileSync(removalsPath(summaryPath), 'utf8'));

    it("keeps what it left on the run's records beside the summary, and leaves the summary as it was", async () => {
      const path = file(runSummary());
      const summaryText = readFileSync(path, 'utf8');
      vi.mocked(removeRunRecords).mockResolvedValue(STOPPED_AFTER_CONTACTS);

      expect(await run(['--remove', path, '--target', 'TGT'])).toBe(3);

      expect(removalsPath(path)).toBe(join(dir, 'clone-summary.removals.json'));
      expect(removalsOf(path)).toEqual({
        tool: 'sandforge-clone',
        version: 1,
        run: runKey(PLAN),
        removalStamps: FIRST_STAMPS,
        removalSpans: [FIRST_SPAN],
      });
      expect(readFileSync(path, 'utf8')).toBe(summaryText);
      expect(printed).toContain(
        `what this removal left on the run's records is kept in ${removalsPath(path)}, ` +
          'which the next --remove of this summary reads',
      );
    });

    it("hands a second removal of the summary what the first left, as the wizard hands it a run's history", async () => {
      // Told nothing, the second removal reads the account the first dated,
      // deleting its contacts, as changed since the run, and keeps it.
      const path = file(runSummary());
      vi.mocked(removeRunRecords)
        .mockResolvedValueOnce(STOPPED_AFTER_CONTACTS)
        .mockResolvedValueOnce({ ...TOOK_ALL, span: SECOND_SPAN });

      expect(await run(['--remove', path, '--target', 'TGT'])).toBe(3);
      expect(await run(['--remove', path, '--target', 'TGT'])).toBeUndefined();

      const [first, second] = vi
        .mocked(removeRunRecords)
        .mock.calls.map(([, , options]) => options);
      expect(first.removalStamps).toBeUndefined();
      expect(first.removalSpans).toBeUndefined();
      expect(second.removalStamps).toEqual(FIRST_STAMPS);
      expect(second.removalSpans).toEqual([FIRST_SPAN]);
      expect(printed).toContain(
        `what earlier removals of this summary left on the run's records, read from ` +
          `${removalsPath(path)}, is not a change since the run`,
      );
      // What the second removal adds goes after what the first kept.
      expect(removalsOf(path)).toMatchObject({
        removalStamps: FIRST_STAMPS,
        removalSpans: [FIRST_SPAN, SECOND_SPAN],
      });
    });

    it('reads nothing from the removals file of another run, and replaces it', async () => {
      // Another run's summary saved under the same name since: what its
      // removals wrote is no doing of this run's.
      const path = file(runSummary());
      file(
        {
          tool: 'sandforge-clone',
          version: 1,
          run: runKey([{ objectApiName: 'Account', ids: [TGT('001', 7)] }]),
          removalStamps: { [TGT('001', 7)]: '2026-09-30T11:00:07.000+0000' },
          removalSpans: [FIRST_SPAN],
        },
        'clone-summary.removals.json',
      );
      vi.mocked(removeRunRecords).mockResolvedValue({ ...TOOK_ALL, span: SECOND_SPAN });

      expect(await run(['--remove', path, '--target', 'TGT'])).toBeUndefined();

      const options = removalOptions();
      expect(options.removalStamps).toBeUndefined();
      expect(options.removalSpans).toBeUndefined();
      expect(printed).toContain(
        `${removalsPath(path)} is of another run: it is not read, and what this removal leaves ` +
          'on the records, if anything, takes its place',
      );
      expect(removalsOf(path)).toEqual({
        tool: 'sandforge-clone',
        version: 1,
        run: runKey(PLAN),
        removalStamps: {},
        removalSpans: [SECOND_SPAN],
      });
    });

    it.each([
      ["another run's summary", runSummary({ record: SRC('001', 9) })],
      ['notes that are not JSON', 'what the clone of Monday wrote'],
    ])(
      'refuses %s in the way of the removals file, before contacting any org, and leaves it as it was',
      async (_label, content) => {
        const path = file(runSummary());
        const inTheWay = file(content, 'clone-summary.removals.json');
        const before = readFileSync(inTheWay, 'utf8');

        expect(await run(['--remove', path, '--target', 'TGT'])).toBe(2);

        expect(stderr.join('')).toContain(
          `${inTheWay} is not the record of removals sandforge-clone keeps there, and is not ` +
            'overwritten',
        );
        expect(loadOrg).not.toHaveBeenCalled();
        expect(readFileSync(inTheWay, 'utf8')).toBe(before);
      },
    );

    it('refuses a removals file of the run whose ids or dates are not what they should be, and says where', async () => {
      const path = file(runSummary());
      file(
        {
          tool: 'sandforge-clone',
          version: 1,
          run: runKey(PLAN),
          removalStamps: { [TGT('001', 1)]: 'yesterday' },
          removalSpans: [{ ...FIRST_SPAN, userId: "005' OR Id != '" }],
        },
        'clone-summary.removals.json',
      );

      expect(await run(['--remove', path, '--target', 'TGT'])).toBe(2);

      const said = stderr.join('');
      expect(said).toContain('is not a record of removals a removal can read');
      expect(said).toContain(`removalStamps.${TGT('001', 1)}: not a date`);
      expect(said).toContain('removalSpans.0.userId: not a Salesforce id');
      expect(loadOrg).not.toHaveBeenCalled();
    });

    it('says when what it left cannot be kept, and its own outcome stands', async () => {
      const path = file(runSummary());
      vi.mocked(removeRunRecords).mockResolvedValue({ ...TOOK_ALL, span: FIRST_SPAN });
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });

      expect(await run(['--remove', path, '--target', 'TGT'])).toBeUndefined();

      expect(stderr.join('')).toContain(
        `What this removal left on the run's records could not be kept in ${removalsPath(path)} ` +
          '(EACCES: permission denied): a later --remove of this summary may keep a record this ' +
          'removal wrote to as changed since the run, which --include-changed then takes.',
      );
      expect(existsSync(removalsPath(path))).toBe(false);
      expect(printed).toContain('removal: SUCCESS');
    });

    it('keeps nothing when the removal wrote nothing to the org', async () => {
      const path = file(runSummary());

      expect(await run(['--remove', path, '--target', 'TGT'])).toBeUndefined();

      expect(existsSync(removalsPath(path))).toBe(false);
    });

    it('names the removals file in its JSON once it kept it', async () => {
      const path = file(runSummary());
      vi.mocked(removeRunRecords).mockResolvedValue({ ...TOOK_ALL, span: FIRST_SPAN });

      expect(await run(['--remove', path, '--target', 'TGT', '--json'])).toBeUndefined();

      expect(JSON.parse(stdout.join(''))).toMatchObject({ removalsFile: removalsPath(path) });
    });
  });
});

describe('sandforge-clone removals file', () => {
  it('sits beside the summary under a name of its own, never the summary itself', () => {
    expect(removalsPath('ci/clone-summary.json')).toBe('ci/clone-summary.removals.json');
    expect(removalsPath('RUN.JSON')).toBe('RUN.removals.json');
    expect(removalsPath('clone-summary')).toBe('clone-summary.removals.json');
  });

  it("reads the earlier removals of the summary's run, none without a file, and nothing of another run's", () => {
    const run = runKey(PLAN);
    const kept = (of: string) =>
      JSON.stringify({
        tool: 'sandforge-clone',
        version: 1,
        run: of,
        removalStamps: FIRST_STAMPS,
        removalSpans: [FIRST_SPAN],
      });

    expect(readEarlierRemovals(undefined, run)).toEqual({});
    expect(readEarlierRemovals(kept(run), run)).toEqual({
      earlier: { removalStamps: FIRST_STAMPS, removalSpans: [FIRST_SPAN] },
    });
    expect(readEarlierRemovals(kept('another run'), run)).toEqual({ otherRun: true });
    // A clone's summary saved under that name.
    const refused = readEarlierRemovals('{"tool":"sandforge-clone","dryRun":false}', run);
    expect('refusal' in refused ? refused.refusal : '').toContain('is not overwritten');
  });

  it('names a run by the records it created, whatever their order or the length of their ids', () => {
    const reordered = [
      { objectApiName: 'Account', ids: [TGT('001', 1)] },
      { objectApiName: 'Contact', ids: [TGT('003', 1), TGT('003', 2).slice(0, 15)] },
    ];

    expect(runKey(reordered)).toBe(runKey(PLAN));
    expect(runKey([{ objectApiName: 'Account', ids: [TGT('001', 1)] }])).not.toBe(runKey(PLAN));
  });

  it('adds nothing for a removal that stamped nothing and did not say when it ran', () => {
    expect(removalsAfter(runKey(PLAN), undefined, { stamps: {} })).toBeUndefined();
  });

  it("adds a removal's stamps over the earlier ones for a record both stamped, and its span after theirs", () => {
    const later = { [TGT('001', 1)]: '2026-10-01T12:00:07.000+0000' };

    expect(
      removalsAfter(
        'run',
        {
          removalStamps: { ...FIRST_STAMPS, [TGT('003', 1)]: '2026-10-01T11:00:03.000+0000' },
          removalSpans: [FIRST_SPAN],
        },
        { stamps: later, span: SECOND_SPAN },
      ),
    ).toEqual({
      tool: 'sandforge-clone',
      version: 1,
      run: 'run',
      removalStamps: { ...later, [TGT('003', 1)]: '2026-10-01T11:00:03.000+0000' },
      removalSpans: [FIRST_SPAN, SECOND_SPAN],
    });
  });
});

describe('sandforge-clone removal lines', () => {
  it('names what kept the records held for those that stay, and the objects that went unchecked', () => {
    expect(
      removalLines('partial', [
        objectResult('Opportunity', 1),
        objectResult('Account', 2, {
          deleted: 0,
          alreadyGone: 1,
          keptDependents: 1,
          heldBy: ['Case'],
          unchecked: ['ActionableListMember'],
        }),
      ]),
    ).toEqual([
      'removal: PARTIAL',
      '  Opportunity: 1 deleted of 1',
      '  Account: 1 already gone, 1 kept for records that stay (Case) of 2',
      'not checked, deleted with their parent: ActionableListMember',
    ]);
  });
});

describe('sandforge-clone production guard', () => {
  it('reads an org that does not say it is a sandbox as a production org', async () => {
    const answering = (records: unknown[]) =>
      ({
        query: async () => ({ totalSize: records.length, done: true, records }),
      }) as unknown as Connection;

    expect(await typeOrg(answering([{ Id: TARGET_ORG, IsSandbox: true }]))).toEqual({
      id: TARGET_ORG,
      sandbox: true,
    });
    expect(await typeOrg(answering([{ Id: TARGET_ORG }]))).toEqual({
      id: TARGET_ORG,
      sandbox: false,
    });
    await expect(typeOrg(answering([]))).rejects.toThrow('gave no Organization record');
  });

  it('refuses a production org for a clone and a removal, and lets a sandbox through', () => {
    const production = { id: TARGET_ORG, sandbox: false };

    expect(productionRefusal('TGT', { id: TARGET_ORG, sandbox: true }, 'clone')).toBeUndefined();
    expect(productionRefusal('TGT', production, 'clone')).toContain('Nothing was written');
    expect(productionRefusal('TGT', production, 'remove')).toContain('Nothing was deleted');
  });
});
