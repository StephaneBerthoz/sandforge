import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeSweepListing, ForgeUndoObjectResult } from '@sandforge/shared';

import { nodeRunJournal } from '../src/modules/forge/ForgeRunJournal.js';
import { compositeOrg } from '../src/test/compositeOrg.js';
import { parseRemoveArgs as syncRemoveArgs } from './sandforge-sync.js';
import { parseRemoveArgs as seedRemoveArgs } from './sandforge-seed.js';
import { parseArgs as frozenArgs } from './sandforge-frozen.js';
import {
  automationHeldLines,
  clonePreviewLines,
  commandSweepTies,
  otherRunsOf,
  parseRemoveArgs as cloneRemoveArgs,
  quoteCopiesLines,
  removalLines,
  runUserIdOf,
  sweepClassArgsOf,
  sweepListingLines,
  sweepUnsaid,
  sweepLines,
  sweepOrgOf,
  syncRunSpanOf,
} from './sandforge-clone.js';

/**
 * What a removal's command line tells its sweep of the run beside its
 * records, and what it says of what the sweep found and the removal left:
 * the pieces every command line's removal shares (the clone's, Sync's,
 * Seed's and Frozen's), each read without an org.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG = '00D000000000002AAA';
const OTHER_ORG = '00D000000000003AAA';

/** Thrown in place of `process.exit`, with its code. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** What a parse ended on: its result, or the code it exited with and what it wrote. */
function parsed<T>(parse: () => T): { value?: T; code?: number; said: string } {
  let said = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    said += String(chunk);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  try {
    return { value: parse(), said };
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return { code: err.code, said };
    throw err;
  } finally {
    vi.restoreAllMocks();
  }
}

const line = (tool: string, ...args: string[]): string[] => ['node', `${tool}.ts`, ...args];

describe('--sweep-late and --sweep-untied', () => {
  it('are read beside --sweep, each on its own', () => {
    expect(sweepClassArgsOf(['--sweep', '--sweep-late'])).toEqual({ sweepLate: true });
    expect(sweepClassArgsOf(['--sweep', '--sweep-untied'])).toEqual({ sweepUntied: true });
    expect(sweepClassArgsOf(['--sweep'])).toEqual({});
  });

  it('are refused without --sweep, a listing included: a CI line that meant to take them would take nothing', () => {
    expect(sweepClassArgsOf(['--sweep-late'])).toEqual({
      refusal: '--sweep-late takes more of what --sweep lists: give it with --sweep.',
    });
    expect(sweepClassArgsOf(['--sweep-list', '--sweep-late', '--sweep-untied'])).toEqual({
      refusal:
        '--sweep-late and --sweep-untied take more of what --sweep lists: give them with --sweep.',
    });
  });

  it('reach each command line’s removal, and are refused without --sweep, exit 2', () => {
    const remove = ['--remove', 's.json', '--target', 'T'];
    expect(
      parsed(() => cloneRemoveArgs(line('sandforge-clone', ...remove, '--sweep', '--sweep-late')))
        .value,
    ).toMatchObject({ sweep: true, sweepLate: true });
    expect(
      parsed(() => syncRemoveArgs(line('sandforge-sync', ...remove, '--sweep', '--sweep-untied')))
        .value,
    ).toMatchObject({ sweep: true, sweepUntied: true });
    expect(
      parsed(() => seedRemoveArgs(line('sandforge-seed', ...remove, '--sweep', '--sweep-late')))
        .value,
    ).toMatchObject({ sweep: true, sweepLate: true });
    expect(
      parsed(() =>
        frozenArgs(
          line(
            'sandforge-frozen',
            'remove',
            '--config',
            'c.json',
            '--target',
            'T',
            '--sweep',
            '--sweep-untied',
          ),
        ),
      ).value,
    ).toMatchObject({ sweep: true, sweepUntied: true });

    for (const [tool, parse] of [
      ['sandforge-clone', cloneRemoveArgs],
      ['sandforge-sync', syncRemoveArgs],
      ['sandforge-seed', seedRemoveArgs],
    ] as const) {
      const refused = parsed(() => parse(line(tool, ...remove, '--sweep-untied')));
      expect(refused.code).toBe(2);
      expect(refused.said).toContain('give it with --sweep');
    }
    const frozen = parsed(() =>
      frozenArgs(
        line('sandforge-frozen', 'remove', '--config', 'c.json', '--target', 'T', '--sweep-late'),
      ),
    );
    expect(frozen.code).toBe(2);
  });

  it('are refused beside the clone’s --preview, which writes nothing', () => {
    const refused = parsed(() =>
      cloneRemoveArgs(
        line('sandforge-clone', '--remove', 's.json', '--target', 'T', '--preview', '--sweep-late'),
      ),
    );
    expect(refused.code).toBe(2);
    expect(refused.said).toContain('--preview writes nothing: give it without --sweep-late');
  });
});

describe('otherRunsOf', () => {
  let dir: string;
  /** When the run being removed wrote, on this machine's clock. */
  const SPAN = { from: Date.parse('2026-10-15T09:00:00Z'), to: Date.parse('2026-10-15T09:05:00Z') };
  const OWN = { ids: [fakeId('001', 1), fakeId('003', 1)] };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-other-runs-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A clone's journal in the folder: what it created, when it began and ended. */
  async function cloneRan(
    journalId: string,
    org: string,
    from: string,
    to: string,
    created: Array<[string, string]>,
  ): Promise<string> {
    const journals = nodeRunJournal(dir);
    await journals.begin(journalId, org, new Date(from));
    const store = journals.open(journalId);
    store.beginPart(new Date(from));
    for (const [objectApiName, id] of created) {
      store.setMapping('created', `${id.slice(0, 3)}999${id.slice(6)}`, id, objectApiName);
    }
    store.close();
    // The end the run kept, by this machine's clock.
    writeFileSync(
      journals.pathOf(journalId).replace(/\.ndjson$/, '.end.json'),
      `${JSON.stringify({ end: { status: 'success', forgeId: `${journalId}#0`, at: to } })}\n`,
    );
    return journals.pathOf(journalId);
  }

  /** A Seed or Sync run's file in the folder. */
  function runFileOf(
    folder: 'seed-runs' | 'sync-runs',
    runId: string,
    target: { organizationId?: string; alias: string },
    from: string,
    to: string,
    created: Array<[string, string]>,
  ): void {
    mkdirSync(join(dir, folder), { recursive: true });
    const lines = [
      {
        run: {
          runId,
          configId: folder === 'seed-runs' ? 'sandforge-seed' : 'sandforge-sync',
          configName: runId,
          sourceOrgId: 'SRC',
          targetOrgId: target.alias,
          startedAt: from,
          ...(target.organizationId ? { targetOrganizationId: target.organizationId } : {}),
        },
      },
      ...created.map(([object, id]) => ({ object, created: [id], at: from })),
      { end: { at: to, status: 'success' } },
    ];
    writeFileSync(
      join(dir, folder, `${runId}.ndjson`),
      `${lines.map((value) => JSON.stringify(value)).join('\n')}\n`,
    );
  }

  it('names the records of the clones, seeds and syncs of this machine that wrote to the org in the run’s window, each run apart', async () => {
    await cloneRan('beside', ORG, '2026-10-15T09:04:00Z', '2026-10-15T09:06:00Z', [
      ['Account', fakeId('001', 7)],
    ]);
    runFileOf(
      'seed-runs',
      'seed-beside',
      { organizationId: ORG, alias: 'TGT' },
      '2026-10-15T08:58:00Z',
      '2026-10-15T09:00:30Z',
      [['Contact', fakeId('003', 7)]],
    );
    // Named by its alias alone, as a Sync run of an older command line was.
    runFileOf(
      'sync-runs',
      'sync-beside',
      { alias: 'TGT' },
      '2026-10-15T09:02:00Z',
      '2026-10-15T09:03:00Z',
      [['Case', fakeId('500', 7)]],
    );

    const others = await otherRunsOf({
      organizationId: ORG,
      alias: 'TGT',
      span: SPAN,
      own: OWN,
      journalDir: dir,
    });

    expect(others).toEqual(
      expect.arrayContaining([
        { ids: [fakeId('001', 7)] },
        { ids: [fakeId('003', 7)] },
        { ids: [fakeId('500', 7)] },
      ]),
    );
    expect(others).toHaveLength(3);
  });

  it('leaves out the run itself, the runs of another org, and those outside the window but for its minute after', async () => {
    const own = await cloneRan('own', ORG, '2026-10-15T09:00:00Z', '2026-10-15T09:05:00Z', [
      ['Account', fakeId('001', 1)],
    ]);
    // The same run's records, found again in a journal it does not name.
    await cloneRan('again', ORG, '2026-10-15T09:00:00Z', '2026-10-15T09:05:00Z', [
      ['Contact', fakeId('003', 1)],
    ]);
    await cloneRan('elsewhere', OTHER_ORG, '2026-10-15T09:01:00Z', '2026-10-15T09:02:00Z', [
      ['Account', fakeId('001', 8)],
    ]);
    // An hour before.
    await cloneRan('before', ORG, '2026-10-15T07:50:00Z', '2026-10-15T08:00:00Z', [
      ['Account', fakeId('001', 9)],
    ]);
    // Begun within the minute after the run's last write: what it created is in the window.
    await cloneRan('right-after', ORG, '2026-10-15T09:05:40Z', '2026-10-15T09:07:00Z', [
      ['Account', fakeId('001', 6)],
    ]);
    // Two minutes after: not.
    await cloneRan('later', ORG, '2026-10-15T09:07:00Z', '2026-10-15T09:08:00Z', [
      ['Account', fakeId('001', 5)],
    ]);
    runFileOf(
      'seed-runs',
      'seed-own',
      { organizationId: ORG, alias: 'TGT' },
      '2026-10-15T09:01:00Z',
      '2026-10-15T09:02:00Z',
      [['Contact', fakeId('003', 5)]],
    );

    const others = await otherRunsOf({
      organizationId: ORG,
      alias: 'TGT',
      span: SPAN,
      own: { ...OWN, journal: own, runId: 'seed-own' },
      journalDir: dir,
    });

    expect(others).toEqual([{ ids: [fakeId('001', 6)] }]);
  });

  it('takes every run of the org for one of the window when the run’s own span cannot be told', async () => {
    await cloneRan('before', ORG, '2026-10-15T07:50:00Z', '2026-10-15T08:00:00Z', [
      ['Account', fakeId('001', 9)],
    ]);

    expect(
      await otherRunsOf({ organizationId: ORG, span: undefined, own: OWN, journalDir: dir }),
    ).toEqual([{ ids: [fakeId('001', 9)] }]);
  });

  it('counts a Sync run that only wrote over records: it wrote in the window as much as one that created', async () => {
    mkdirSync(join(dir, 'sync-runs'), { recursive: true });
    const at = '2026-10-15T09:02:00.000Z';
    writeFileSync(
      join(dir, 'sync-runs', 'updates.ndjson'),
      [
        {
          run: {
            runId: 'updates',
            configId: 'sandforge-sync',
            configName: 'updates',
            sourceOrgId: 'SRC',
            targetOrgId: 'TGT',
            startedAt: at,
            targetOrganizationId: ORG,
          },
        },
        {
          overwriting: {
            object: 'Account',
            backup: 'sync-before-1',
            ids: [fakeId('001', 4)],
            at,
          },
        },
        { overwrote: { object: 'Account', notWritten: [], at } },
        { end: { at, status: 'success' } },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n',
    );

    expect(
      await otherRunsOf({ organizationId: ORG, span: SPAN, own: OWN, journalDir: dir }),
    ).toEqual([{ ids: [fakeId('001', 4)] }]);
  });

  it('finds none in a folder that keeps no run', async () => {
    expect(
      await otherRunsOf({
        organizationId: ORG,
        span: SPAN,
        own: OWN,
        journalDir: join(dir, 'none'),
      }),
    ).toEqual([]);
  });
});

describe('syncRunSpanOf', () => {
  it('runs from the first write to the end, or to the last write of a run that never ended', () => {
    expect(
      syncRunSpanOf({
        startedAt: '2026-10-15T09:00:00Z',
        firstWrittenAt: '2026-10-15T09:00:10Z',
        end: { at: '2026-10-15T09:05:00Z', status: 'success' },
      }),
    ).toEqual({ from: Date.parse('2026-10-15T09:00:10Z'), to: Date.parse('2026-10-15T09:05:00Z') });
    expect(
      syncRunSpanOf({ startedAt: '2026-10-15T09:00:00Z', lastWriteAt: '2026-10-15T09:03:00Z' }),
    ).toEqual({ from: Date.parse('2026-10-15T09:00:00Z'), to: Date.parse('2026-10-15T09:03:00Z') });
    expect(syncRunSpanOf({ startedAt: '2026-10-15T09:00:00Z' })).toBeUndefined();
  });
});

describe('commandSweepTies', () => {
  it('tells the sweep the other runs, the mute, when the first removal began and what earlier sweeps found made', () => {
    const muted = {
      silenced: [
        { objectApiName: 'Case', kind: 'flow' as const, name: 'Case asset', permission: 'Bypass' },
      ],
      stillRan: [
        {
          objectApiName: 'Case',
          kind: 'trigger' as const,
          name: 'CaseTrigger',
          why: 'noBypass' as const,
        },
      ],
    };
    const ties = commandSweepTies({
      otherRuns: [{ ids: [fakeId('001', 7)] }],
      muted,
      removalSpans: [
        {
          first: '2026-10-15T12:00:00.000+0000',
          last: '2026-10-15T12:01:00.000+0000',
          userId: fakeId('005', 1),
        },
        {
          first: '2026-10-15T11:00:00.000+0000',
          last: '2026-10-15T11:01:00.000+0000',
          userId: fakeId('005', 1),
        },
      ],
      made: [fakeId('00T', 1)],
    });

    expect(ties).toEqual({
      otherRuns: [{ ids: [fakeId('001', 7)] }],
      muted,
      removalBegan: '2026-10-15T11:00:00.000+0000',
      madeEarlier: [fakeId('00T', 1)],
    });
  });

  it('tells nothing more of a run never removed, unmuted, with no other run beside it', () => {
    expect(commandSweepTies({ otherRuns: [] })).toEqual({ otherRuns: [] });
  });
});

describe('runUserIdOf', () => {
  it('takes the first value that is a Salesforce id, and nothing else into a query', () => {
    expect(runUserIdOf(undefined, "005' OR Id != '", fakeId('005', 1))).toBe(fakeId('005', 1));
    expect(runUserIdOf(42, '')).toBeUndefined();
  });
});

describe('sweepOrgOf', () => {
  it('sends a sweep’s counts five to a composite, the removal’s org kept beneath it', async () => {
    const org = compositeOrg({
      tables: {
        Task: [{ Id: fakeId('00T', 1), SystemModstamp: '2026-10-15T09:00:00.000Z' }],
        Asset: [],
      },
    });
    const swept = sweepOrgOf(org.conn as unknown as Connection, 'a test');

    const counts = await swept.counts?.([
      'SELECT COUNT() FROM Task',
      'SELECT COUNT() FROM Asset',
      'SELECT COUNT() FROM Task',
      'SELECT COUNT() FROM Asset',
      'SELECT COUNT() FROM Task',
      'SELECT COUNT() FROM Asset',
      'SELECT COUNT() FROM Task',
    ]);

    expect(counts).toEqual([1, 0, 1, 0, 1, 0, 1]);
    // Seven counts, two calls of the org's day: five in one, two in the next.
    expect(org.calls.filter((call) => call.kind === 'composite')).toHaveLength(2);
    expect(org.calls.filter((call) => call.kind !== 'composite')).toEqual([]);
    expect(typeof swept.queryDeleted).toBe('function');
    expect(typeof swept.userId).toBe('function');
  });
});

/** What a sweep told the ties found: made, late and tied to nothing. */
const TIED: ForgeSweepListing = {
  window: { from: '2026-10-15T08:59:59Z', to: '2026-10-15T09:06:00Z' },
  looked: ['Account', 'Case', 'Task', 'Asset'],
  found: [
    {
      objectApiName: 'Task',
      count: 4,
      names: ['Case follow-up', 'Loose task'],
      classes: { made: 2, sameSave: 1, madeOver: 0, late: 1, untied: 1 },
    },
    {
      objectApiName: 'Asset',
      count: 1,
      names: ['Insured risk'],
      classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
    },
  ],
  unread: [],
  handWork: [],
  untied: { objects: [{ objectApiName: 'Task', count: 1 }] },
  late: [{ objectApiName: 'Task', count: 1 }],
};

describe('sweepUnsaid', () => {
  const listing = { looked: [], found: [], unread: [], handWork: [] };

  it('gives what a sweep read when its question said nothing of it', () => {
    expect(sweepUnsaid({ listing }, undefined)).toBe(listing);
  });

  it('gives nothing once it was said, for a sweep stopped before it read, or none', () => {
    expect(sweepUnsaid({ listing }, listing)).toBeUndefined();
    expect(sweepUnsaid({ listing: undefined }, undefined)).toBeUndefined();
    expect(sweepUnsaid(undefined, undefined)).toBeUndefined();
  });

  it('gives nothing of a sweep refused, whose result says why', () => {
    expect(sweepUnsaid({ listing: { ...listing, refusal: 'No window.' } }, undefined)).toBe(
      undefined,
    );
  });
});

describe('sweepListingLines', () => {
  it('counts what it found and what it takes, says each object’s classes, and what it lists and keeps with the flag that takes it', () => {
    const lines = sweepListingLines(TIED, 'TGT');

    expect(lines).toContain(
      'it found 5 record(s) and would delete 3 of them, children first; per object, all it found:',
    );
    expect(lines).toContain(
      '  Task: 4 — 2 made for the run (1 in the same save), 1 late, 1 tied to nothing of the run (Case follow-up, Loose task, …)',
    );
    expect(lines).toContain('  Asset: 1 — 1 made for the run (Insured risk)');
    expect(lines).toContain(
      "kept, made late — tied to the run but created more than a minute after the record it hangs from, or by the org's Automated Process user: Task: 1 (--sweep-late takes them)",
    );
    expect(lines).toContain(
      "kept, created as the run's user in its window but tied to nothing of it: Task: 1 (--sweep-untied takes them)",
    );
    expect(lines.at(-1)).toContain('check the names before a --sweep');
  });

  it('takes what came late and what is tied to nothing when asked, and says no more that they are kept', () => {
    const lines = sweepListingLines(TIED, 'TGT', { sweepLate: true, sweepUntied: true });

    expect(lines).toContain(
      'it found 5 record(s) and would delete 5 of them, children first; per object, all it found:',
    );
    expect(lines.join('\n')).not.toContain('kept, ');
  });

  it('has the names checked by whoever reads the list before a sweep, not once the sweep began', () => {
    expect(sweepListingLines(TIED, 'TGT').join('\n')).toContain('check the names before a --sweep');
    expect(sweepListingLines(TIED, 'TGT', {}).join('\n')).not.toContain('check the names');
  });

  it('names a few of the objects it looked at: told the ties, every child of the run’s', () => {
    const looked = Array.from({ length: 12 }, (_, n) => `Obj${n}__c`);

    expect(sweepListingLines({ ...TIED, looked }, 'TGT')[0]).toContain(
      'Obj8__c, Obj9__c and 2 more',
    );
  });

  it('says why what is tied to nothing would be refused, and takes none of it even when asked', () => {
    const refusal = 'Another run of this machine wrote to the target in this run’s window.';
    const lines = sweepListingLines(
      { ...TIED, untied: { objects: [{ objectApiName: 'Task', count: 1 }], refusal } },
      'TGT',
      { sweepUntied: true },
    );

    expect(lines).toContain(
      'it found 5 record(s) and would delete 3 of them, children first; per object, all it found:',
    );
    expect(lines).toContain(
      `kept, tied to nothing of the run: Task: 1 — --sweep-untied is refused: ${refusal}`,
    );
  });

  it('names the objects past the most a sweep looks at, and what the run’s mute let run', () => {
    const lines = sweepListingLines(
      {
        ...TIED,
        notLooked: ['Obj1__c', 'Obj2__c'],
        muted: {
          silenced: [
            { objectApiName: 'Case', kind: 'flow', name: 'Case asset', permission: 'Bypass' },
          ],
          stillRan: [
            { objectApiName: 'Case', kind: 'trigger', name: 'CaseTrigger', why: 'noBypass' },
          ],
        },
      },
      'TGT',
    );

    expect(lines).toContain('not looked at, past the 300 objects a sweep counts: Obj1__c, Obj2__c');
    expect(lines).toContain(
      "the run's mute kept 1 automation(s) quiet; what still ran may have made what is listed: CaseTrigger (Case)",
    );
  });

  it('counts nothing of an object past the bound, none of whose records goes', () => {
    const lines = sweepListingLines(
      {
        window: TIED.window,
        looked: ['Task', 'FeedItem'],
        found: [
          {
            objectApiName: 'Task',
            count: 2,
            names: ['Welcome call'],
            classes: { made: 2, madeOver: 0, late: 0, untied: 0 },
          },
          { objectApiName: 'FeedItem', count: 10_000, names: [], overBound: true },
        ],
        unread: [],
        handWork: [],
      },
      'TGT',
    );
    expect(lines).toContain(
      'it found 10002 or more record(s) and would delete 2 of them, children first; per object, all it found:',
    );
    expect(lines).toContain('  FeedItem: 10000 or more (over the bound: none would be deleted)');
  });

  it('says it deletes none of what it found, of a sweep that keeps it all', () => {
    const lines = sweepListingLines(
      {
        window: TIED.window,
        looked: ['Task'],
        found: [
          {
            objectApiName: 'Task',
            count: 1,
            names: ['Late call'],
            classes: { made: 0, madeOver: 0, late: 1, untied: 0 },
          },
        ],
        unread: [],
        handWork: [],
        late: [{ objectApiName: 'Task', count: 1 }],
        untied: { objects: [] },
      },
      'TGT',
      {},
    );
    expect(lines).toContain(
      'it found 1 record(s) and would delete none of them; per object, all it found:',
    );
    expect(lines.join('\n')).not.toContain('delete 0 ');
  });
});

describe('sweepLines', () => {
  it('says what the sweep found and left, by class, with the option that takes each, its status unchanged', () => {
    const lines = sweepLines({
      status: 'success',
      objects: [],
      unread: [],
      handWork: [],
      left: [
        { class: 'late', objects: [{ objectApiName: 'Task', count: 1 }], option: '--sweep-late' },
        {
          class: 'untied',
          objects: [
            { objectApiName: 'Task', count: 5 },
            { objectApiName: 'Note', count: 2 },
          ],
          option: '--sweep-untied',
        },
      ],
    });

    expect(lines).toEqual([
      'sweep: SUCCESS',
      '  left, made late: Task: 1 (--sweep-late takes them)',
      '  left, tied to nothing of the run: Task: 5, Note: 2 (--sweep-untied takes them)',
    ]);
  });

  it('says why the option takes nothing, when it is refused', () => {
    const refusal = 'Another run of this machine wrote to the target in this run’s window.';
    const lines = sweepLines({
      status: 'success',
      objects: [],
      unread: [],
      handWork: [],
      left: [
        {
          class: 'untied',
          objects: [{ objectApiName: 'Task', count: 3 }],
          option: '--sweep-untied',
          refusal,
        },
      ],
    });

    expect(lines).toContain(
      `  left, tied to nothing of the run: Task: 3 — --sweep-untied is refused: ${refusal}`,
    );
  });

  it('says what went once the records of the run that point at it were gone', () => {
    expect(
      sweepLines({
        status: 'success',
        objects: [
          {
            objectApiName: 'Asset',
            found: 1,
            deleted: 1,
            alreadyGone: 0,
            keptChanged: 0,
            refused: 0,
            reasons: [],
            afterRemoval: 1,
          },
        ],
        unread: [],
        handWork: [],
      }),
    ).toContain(
      '  Asset: 1 deleted (1 once the records of the run that point at them were gone) of 1',
    );
  });
});

/** One object's removal, every record deleted unless said otherwise. */
const removed = (
  objectApiName: string,
  planned: number,
  overrides: Partial<ForgeUndoObjectResult> = {},
): ForgeUndoObjectResult => ({
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
});

describe('the platform’s copies of a synced quote’s lines', () => {
  it('are named beside the object’s count once a removal took them: a plan of 2 lines ended in 4 of 4', () => {
    expect(removalLines('success', [removed('QuoteLineItem', 4, { platformCopies: 2 })])).toContain(
      '  QuoteLineItem: 4 deleted of 4 (2 the run wrote, and 2 the platform copied between the quote the run synced and its opportunity)',
    );
    expect(removalLines('success', [removed('Contact', 2)])).toContain('  Contact: 2 deleted of 2');
  });

  it('are counted by the preview, before anything is deleted', () => {
    const lines = clonePreviewLines(
      {
        planned: 4,
        objects: [
          {
            objectApiName: 'QuoteLineItem',
            planned: 4,
            toDelete: 4,
            alreadyGone: 0,
            changedSince: 0,
            keptChanged: 0,
            changedBy: {},
            undeletable: 0,
            notVisible: 0,
            unread: 0,
            platformCopies: 2,
            reasons: [],
          },
        ],
        userNames: {},
      },
      [],
      [],
      false,
    );
    expect(lines).toContain(
      '  QuoteLineItem: 4 to delete of 4 (2 the run wrote, and 2 the platform copied between the quote the run synced and its opportunity)',
    );
  });

  it('are said to come by the plan of a run that created a quote and its lines, before the removal reads them', () => {
    const quote = { objectApiName: 'Quote', ids: [fakeId('0Q0', 1)] };
    expect(
      quoteCopiesLines([{ objectApiName: 'QuoteLineItem', ids: [fakeId('0QL', 1)] }, quote]),
    ).toEqual([
      '  and the lines the platform copied between a quote the run synced and its opportunity, read as the removal begins and counted apart (--preview counts them)',
    ]);
    expect(quoteCopiesLines([{ objectApiName: 'Contact', ids: [fakeId('003', 1)] }])).toEqual([]);
    expect(quoteCopiesLines([quote])).toEqual([]);
  });
});

describe('automationHeldLines', () => {
  const held = [
    removed('Quote', 1, {
      deleted: 0,
      keptDependents: 1,
      heldBy: ['QuoteLineItem'],
      heldByAutomation: 1,
      automationHolders: ['QuoteLineItem'],
    }),
    removed('Opportunity', 5, {
      deleted: 0,
      keptDependents: 5,
      heldBy: ['Quote'],
      heldByAutomation: 5,
      automationHolders: ['QuoteLineItem', 'Task'],
    }),
  ];

  it('names what the automation likely made that kept records of the run, and that --sweep takes it first', () => {
    expect(automationHeldLines(held, {})).toEqual([
      "6 record(s) of the run kept for records created under them during the run, as its user, likely by the target's automation (QuoteLineItem, Task): --sweep takes them first (--sweep-list shows them)",
    ]);
  });

  it('says why a removal that swept left them, and what takes them', () => {
    expect(automationHeldLines(held, { sweep: true })[0]).toContain(
      'the sweep left them — --sweep-list says why; --sweep-late takes those it lists as late',
    );
  });

  it('says nothing when no record was so kept: what holds then is no one’s to guess', () => {
    expect(
      automationHeldLines(
        [removed('Contact', 2, { deleted: 1, keptDependents: 1, heldBy: ['Case'] })],
        {},
      ),
    ).toEqual([]);
  });
});
