import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation, MutedAutomation } from '@sandforge/shared';
import { MemoryRemovalOrg } from '../src/test/memoryRemovalOrg.js';
import { nodeSyncIdMap } from '../src/modules/sync/SyncIdMap.js';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({ alias })),
  makeConn: vi.fn(),
}));
vi.mock('../src/modules/forge/ForgeRunRemoval.js', async (original) => ({
  ...(await original<typeof import('../src/modules/forge/ForgeRunRemoval.js')>()),
  removalOrg: vi.fn(),
}));
/** What the target runs as the removal writes, as it reads it: nothing, unless a test says what. */
const automationRead = vi.fn(async (): Promise<ForgeTargetAutomation> => ({
  objectsRead: [],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 0,
}));
vi.mock('./sandforge-clone.js', async (original) => ({
  ...(await original<typeof import('./sandforge-clone.js')>()),
  targetAutomationReader: vi.fn(() => ({ read: automationRead })),
}));
// The mute as it is, unless a test says how the org refuses it.
vi.mock('../src/modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../src/modules/forge/AutomationMuteLease.js')>();
  return { ...actual, muteForRun: vi.fn(actual.muteForRun) };
});

import { makeConn } from './sfSession.js';
import { MuteRefusedError, muteForRun } from '../src/modules/forge/AutomationMuteLease.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import {
  bothRecorders,
  cliAllowsDeletes,
  configurationToldLines,
  main,
  memoryCreations,
  parseRemoveArgs,
  readRunSummary,
  removalRefusal,
  removalsPathOf,
  removalSummaryLines,
  runOfSummary,
  savedConfigStore,
} from './sandforge-sync.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG_ID = '00D000000000001AAA';
const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const C1 = fakeId('003', 1);

const argv = (...args: string[]): string[] => ['node', 'sandforge-sync.ts', ...args];

/** A run ten minutes ago that created two accounts and a contact. */
function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  return {
    tool: 'sandforge-sync',
    source: 'SRC',
    target: 'TGT',
    targetOrgId: ORG_ID,
    dryRun: false,
    startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    finishedAt: at,
    result: { status: 'success', objectResults: [] },
    created: {
      runId: 'sandforge-sync-1',
      lastWrittenAt: at,
      objects: [
        { objectApiName: 'Account', ids: [A1, A2] },
        { objectApiName: 'Contact', ids: [C1] },
      ],
    },
    elapsedMs: 900,
    ...overrides,
  };
}

/** Stop at `process.exit`, with its code and what was written to stderr. */
function stubExit(): { code: () => number | undefined; stderr: () => string } {
  let code: number | undefined;
  let stderr = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error(`exit ${c}`);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as never);
  return { code: () => code, stderr: () => stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseRemoveArgs', () => {
  it('reads the summary, the target and the two switches', () => {
    expect(
      parseRemoveArgs(
        argv('--remove', 'run.json', '--target', 'TGT', '--include-changed', '--json'),
      ),
    ).toEqual({
      summaryPath: 'run.json',
      target: 'TGT',
      includeChanged: true,
      acceptAutomation: false,
      muteAutomation: false,
      json: true,
      sweep: false,
      sweepList: false,
      leaveUndeletable: false,
    });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--store', 'state')),
    ).toEqual({
      summaryPath: 'run.json',
      target: 'TGT',
      includeChanged: false,
      acceptAutomation: false,
      muteAutomation: false,
      json: false,
      store: 'state',
      sweep: false,
      sweepList: false,
      leaveUndeletable: false,
    });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--leave-undeletable')),
    ).toMatchObject({ leaveUndeletable: true });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--accept-automation')),
    ).toMatchObject({ acceptAutomation: true });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep')),
    ).toMatchObject({ sweep: true, sweepList: false });
    expect(
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep-list')),
    ).toMatchObject({ sweep: false, sweepList: true });
  });

  it('refuses a sweep and its listing asked together', () => {
    const exit = stubExit();
    expect(() =>
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--sweep', '--sweep-list')),
    ).toThrow('exit 2');
    expect(exit.stderr()).toContain('give one of them');
  });

  it('refuses a flag a removal does not read, and a line without its target', () => {
    const exit = stubExit();
    expect(() =>
      parseRemoveArgs(argv('--remove', 'run.json', '--target', 'TGT', '--object', 'Account')),
    ).toThrow('exit 2');
    expect(exit.stderr()).toContain('not "--object"');
    expect(() => parseRemoveArgs(argv('--remove', 'run.json'))).toThrow('exit 2');
  });
});

describe('readRunSummary', () => {
  it('reads the summary a run printed with --json', () => {
    const read = readRunSummary(JSON.stringify(summary()));
    expect('summary' in read && read.summary.created?.objects).toEqual([
      { objectApiName: 'Account', ids: [A1, A2] },
      { objectApiName: 'Contact', ids: [C1] },
    ]);
  });

  it('refuses what it cannot take a run back from, before any org is contacted', () => {
    expect(readRunSummary('not json')).toEqual({
      refusal: 'is not JSON: save the output of a run printed with --json.',
    });
    expect(readRunSummary(JSON.stringify({ ...summary(), tool: 'sandforge-clone' }))).toMatchObject(
      { refusal: expect.stringContaining('is not the summary of a sandforge sync run') },
    );
    expect(readRunSummary(JSON.stringify(summary({ dryRun: true })))).toMatchObject({
      refusal: expect.stringContaining('dry run'),
    });
    expect(readRunSummary(JSON.stringify(summary({ created: undefined })))).toMatchObject({
      refusal: expect.stringContaining('names nothing the run created'),
    });
    // An id that is not one never reaches a delete.
    const forged = summary();
    (forged.created as { objects: Array<{ ids: string[] }> }).objects[0].ids = ["x' OR Id != '"];
    expect(readRunSummary(JSON.stringify(forged))).toMatchObject({
      refusal: expect.stringContaining('created.objects.0.ids.0'),
    });
  });
});

describe('what the command takes back, and from where', () => {
  it('keeps what earlier removals left beside the summary, never in it', () => {
    expect(removalsPathOf('runs/run.json')).toBe('runs/run.removals.json');
    expect(removalsPathOf('run.out')).toBe('run.out.removals.json');
  });

  it('reads the run a summary names as the removal reads a kept run', () => {
    const read = readRunSummary(JSON.stringify(summary()));
    if (!('summary' in read)) throw new Error('refused');
    expect(runOfSummary(read.summary)).toMatchObject({
      runId: 'sandforge-sync-1',
      created: [
        { objectApiName: 'Account', ids: [A1, A2] },
        { objectApiName: 'Contact', ids: [C1] },
      ],
      end: { status: 'success' },
    });
  });

  it('removes from a sandbox or a Developer Edition org, and refuses a production org', () => {
    expect(removalRefusal('TGT', { id: ORG_ID, sandbox: true })).toBeUndefined();
    expect(
      removalRefusal('TGT', { id: ORG_ID, sandbox: false, edition: 'Developer Edition' }),
    ).toBeUndefined();
    expect(
      removalRefusal('TGT', { id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' }),
    ).toBe(
      'TGT is a production org (its Organization record says IsSandbox false, edition ' +
        'Enterprise Edition): sandforge sync removes records from sandboxes and Developer ' +
        'Edition orgs only. Nothing was deleted.',
    );
  });

  it('replaces an attachment in a sandbox or a Developer Edition org, never in a production org', () => {
    // The earlier copy of a changed attachment goes once the new one is
    // written, where the guard lets the run delete: a Developer Edition org,
    // which says IsSandbox false, is typed as the panel types it.
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: true })).toBe(true);
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: false, edition: 'Developer Edition' })).toBe(
      true,
    );
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: false, edition: 'Enterprise Edition' })).toBe(
      false,
    );
    expect(cliAllowsDeletes({ id: ORG_ID, sandbox: false })).toBe(false);
  });

  it('names the configuration of a run it was given the store of, and says what it was told', () => {
    const read = readRunSummary(JSON.stringify(summary({ configId: 'cfg-1' })));
    if (!('summary' in read)) throw new Error('refused');
    expect(runOfSummary(read.summary)).toMatchObject({ configId: 'cfg-1' });

    expect(
      configurationToldLines('cfg-1', {
        readWhole: ['Account'],
        filesForgotten: 2,
        linksForgotten: 3,
      }),
    ).toEqual([
      'configuration cfg-1: its next run reads Account whole',
      'configuration cfg-1: 2 copied file(s) forgotten, copied again by its next run',
      'configuration cfg-1: 3 record(s) forgotten, which no later run points a lookup at',
    ]);
    expect(configurationToldLines(undefined, { readWhole: ['Account'] })).toEqual([]);
  });

  it('keeps in memory what a run created, each object in the order first written', () => {
    const kept = memoryCreations('run-1');
    kept.note('Account', [A1]);
    kept.note('Contact', [C1]);
    kept.note('Account', [A2]);
    kept.note('Account', []);

    expect(kept.created()).toEqual([
      { objectApiName: 'Account', ids: [A1, A2] },
      { objectApiName: 'Contact', ids: [C1] },
    ]);
    expect(kept.lastWrittenAt()).toEqual(expect.any(String));
  });

  it('keeps what a write created in the summary, which keeps no call, and leaves the file what no call answered', () => {
    const kept = memoryCreations('run-1');
    const inFile: string[] = [];
    const both = bothRecorders(kept, {
      runId: 'run-1',
      note: () => {
        throw new Error('every id would go into the file twice');
      },
      noteUnanswered: (_objectApiName, ids) => inFile.push(...ids),
      flush: async () => undefined,
    });

    both.answered?.('Account', [A1, A2]);
    both.noteUnanswered?.('Account', [A1, A2]);

    expect(kept.created()).toEqual([{ objectApiName: 'Account', ids: [A1, A2] }]);
    expect(inFile).toEqual([A1, A2]);
  });

  it('keeps in memory what a delta run deleted as the source had, each record once, dated as a write', () => {
    // Told to the run's file alone: the summary carried a bare count, and a
    // removal from it never brought the records back.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-14T08:00:05.000Z'));
      const kept = memoryCreations('run-1');
      kept.deleted?.('Contact', [C1, C1.slice(0, 15)]);
      kept.deleted?.('Account', [A1]);
      kept.deleted?.('Contact', []);

      expect(kept.deletions()).toEqual([
        { objectApiName: 'Contact', ids: [C1] },
        { objectApiName: 'Account', ids: [A1] },
      ]);
      expect(kept.created()).toEqual([]);
      expect(kept.firstWrittenAt()).toBe('2026-10-14T08:00:05.000Z');
      expect(kept.lastWriteAt()).toBe('2026-10-14T08:00:05.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads what a run deleted from its summary, which the removal brings back from the recycle bin', () => {
    const read = readRunSummary(
      JSON.stringify(
        summary({
          created: {
            runId: 'sandforge-sync-1',
            objects: [],
            deleted: [
              { objectApiName: 'Contact', ids: [C1] },
              { objectApiName: 'Account', ids: [] },
            ],
          },
        }),
      ),
    );
    if (!('summary' in read)) throw new Error('refused');
    expect(runOfSummary(read.summary).deleted).toEqual([{ objectApiName: 'Contact', ids: [C1] }]);
    // An id that is not one never reaches an undelete.
    expect(
      readRunSummary(
        JSON.stringify(
          summary({
            created: {
              runId: 'sandforge-sync-1',
              objects: [],
              deleted: [{ objectApiName: 'Contact', ids: ["x' OR Id != '"] }],
            },
          }),
        ),
      ),
    ).toMatchObject({ refusal: expect.stringContaining('created.deleted.0.ids.0') });
  });

  it('keeps each id once, whichever length it is noted in and however often', () => {
    const kept = memoryCreations('run-1');
    kept.note('Account', [A1, A2]);
    kept.note('Account', [A1]);
    kept.note('Account', [A2.slice(0, 15)]);
    kept.note('Contact', [C1, C1]);

    expect(kept.created()).toEqual([
      { objectApiName: 'Account', ids: [A1, A2] },
      { objectApiName: 'Contact', ids: [C1] },
    ]);
  });

  it('dates its last write by the records it wrote again, adding nothing it created', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-14T08:00:05.000Z'));
      const kept = memoryCreations('run-1');
      kept.note('Account', [A1]);
      vi.setSystemTime(new Date('2026-10-14T08:00:40.000Z'));
      kept.touched?.('Account', 1);

      expect(kept.lastWrittenAt()).toBe('2026-10-14T08:00:40.000Z');
      expect(kept.created()).toEqual([{ objectApiName: 'Account', ids: [A1] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dates its last write by its latest call, an update or an answer that created nothing included', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-14T08:00:05.000Z'));
      const kept = memoryCreations('run-1');
      kept.note('Account', [A1]);
      vi.setSystemTime(new Date('2026-10-14T08:02:00.000Z'));
      kept.writing?.('Account', 30);
      vi.setSystemTime(new Date('2026-10-14T08:03:10.000Z'));
      kept.answered?.('Contact', []);

      expect(kept.lastWriteAt()).toBe('2026-10-14T08:03:10.000Z');
      expect(kept.lastWrittenAt()).toBe('2026-10-14T08:00:05.000Z');
      expect(kept.firstWrittenAt()).toBe('2026-10-14T08:00:05.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sandforge-sync --remove', () => {
  let dir: string;
  let file: string;
  let org: MemoryRemovalOrg;
  let edition: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-remove-'));
    file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify(summary()));
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Account', { Id: A2 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
    edition = 'Developer Edition';
    vi.mocked(removalOrg).mockReturnValue(org);
    vi.mocked(makeConn).mockReturnValue({
      query: vi.fn(async (soql: string) =>
        soql.startsWith('SELECT Id, IsSandbox')
          ? { records: [{ Id: ORG_ID, IsSandbox: false }] }
          : { records: [{ OrganizationType: edition }] },
      ),
    } as unknown as Connection);
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      stdout += chunk;
      return true;
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes from a Developer Edition org what the run created, children first, and keeps what it did beside the summary', async () => {
    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(org.deletes.map((d) => d.objectApiName)).toEqual(['Contact', 'Account']);
    expect(org.all('Account')).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({
      action: 'remove',
      result: { status: 'success', planned: 3 },
    });
    const removals = JSON.parse(readFileSync(join(dir, 'run.removals.json'), 'utf8'));
    expect(removals).toMatchObject({ runId: 'sandforge-sync-1', undo: { deleted: 3 } });

    // A second removal of the summary finds nothing left, and asks nothing of the org.
    stdout = '';
    vi.mocked(makeConn).mockClear();
    await main(argv('--remove', file, '--target', 'TGT', '--json'));
    expect(JSON.parse(stdout)).toMatchObject({ result: { status: 'success', planned: 0 } });
    expect(makeConn).not.toHaveBeenCalled();
  });

  it('refuses a production org, deleting nothing', async () => {
    edition = 'Enterprise Edition';
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain('TGT is a production org');
    expect(org.deletes).toEqual([]);
    expect(existsSync(join(dir, 'run.removals.json'))).toBe(false);
  });

  it.each([
    ['a production org', 'PRODUCTION_TARGET', 'TGT is a production org'],
    [
      'what fires as it deletes',
      'AUTOMATION_NOT_ACCEPTED',
      'TGT runs automation on the records this removal deletes',
    ],
    [
      'objects its user may not delete',
      'UNDELETABLE_NOT_LEFT',
      'The user SandForge connects as may not delete the records of Account (2 records) in ' +
        'TGT. Nothing was removed. Give that user Delete on those objects, or run again with ' +
        '--leave-undeletable to remove the rest and leave them.',
    ],
    [
      'another org than the one the run wrote to',
      'OTHER_ORG',
      'TGT is not the org the run wrote to (00D000000000002AAA), and what it created is ' +
        'removed from that org only. Nothing was deleted.',
    ],
  ])(
    'names the code of a removal refused for %s, on its line and with --json on stdout',
    async (_why, code, words) => {
      // Refused so, it said a sentence with no code on stderr and left stdout
      // empty: a CI job could not tell one refusal from another.
      if (code === 'PRODUCTION_TARGET') edition = 'Enterprise Edition';
      if (code === 'OTHER_ORG') {
        writeFileSync(file, JSON.stringify(summary({ targetOrgId: '00D000000000002AAA' })));
      }
      if (code === 'UNDELETABLE_NOT_LEFT') org.undeletable.add('Account');
      if (code === 'AUTOMATION_NOT_ACCEPTED') {
        automationRead.mockResolvedValueOnce({
          objectsRead: ['Account', 'Contact'],
          objects: [
            {
              objectApiName: 'Account',
              flows: [],
              triggers: [{ name: 'AccountCleanup', events: ['beforeDelete'] }],
            },
          ],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 25,
          requests: 3,
        });
      }
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT', '--json'))).rejects.toThrow(
        'exit 1',
      );

      expect(exit.stderr()).toContain(`refused (${code}): ${words}`);
      expect(JSON.parse(stdout)).toEqual({
        tool: 'sandforge-sync',
        action: 'remove',
        summary: file,
        target: 'TGT',
        refused: { code, message: expect.stringContaining(words) as string },
        elapsedMs: expect.any(Number) as number,
      });
      expect(org.deletes).toEqual([]);
    },
  );

  it('refuses an org that is not the one the run wrote to', async () => {
    writeFileSync(file, JSON.stringify(summary({ targetOrgId: '00D000000000002AAA' })));
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'OTHER'))).rejects.toThrow('exit 1');

    expect(exit.stderr()).toContain('is not the org the run wrote to');
    expect(org.deletes).toEqual([]);
  });

  describe('what the target runs as the removal takes the run back', () => {
    /** What the target reads as running: an Apex trigger before an account is deleted, and one after a contact is undeleted. */
    const firing = (): ForgeTargetAutomation => ({
      objectsRead: ['Account', 'Contact'],
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountCleanup', events: ['beforeDelete'] }],
        },
        {
          objectApiName: 'Contact',
          flows: [],
          triggers: [{ name: 'ContactBack', events: ['afterUndelete'] }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 3,
    });

    it('says what fires as it deletes, before anything is written, and deletes nothing without --accept-automation', async () => {
      // The panel listed it before the org's name was typed; the command
      // read it for the sweep alone, and deleted without a word of it.
      automationRead.mockResolvedValueOnce(firing());
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

      expect(automationRead).toHaveBeenLastCalledWith('TGT', ['Contact', 'Account'], {
        undeletes: true,
      });
      expect(stdout).toContain(
        'removal automation: what TGT runs as the removal takes the run back\n' +
          '  Account: before delete: Apex trigger AccountCleanup\n',
      );
      expect(exit.stderr()).toContain(
        'TGT runs automation on the records this removal deletes: Account: Apex trigger ' +
          'AccountCleanup (before delete). Nothing was written or deleted. Add ' +
          '--accept-automation to remove all the same, or turn that automation off in TGT first.',
      );
      expect(org.deletes).toEqual([]);
      expect(existsSync(join(dir, 'run.removals.json'))).toBe(false);
    });

    it('removes all the same with --accept-automation, having said what fires', async () => {
      automationRead.mockResolvedValueOnce(firing());
      let stderr = '';
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
        stderr += chunk;
        return true;
      }) as never);

      await main(argv('--remove', file, '--target', 'TGT', '--accept-automation', '--json'));

      // On stderr with --json, the outcome alone on stdout.
      expect(stderr).toContain('  Account: before delete: Apex trigger AccountCleanup');
      expect(org.all('Account')).toEqual([]);
      expect(JSON.parse(stdout)).toMatchObject({ result: { status: 'success', planned: 3 } });
    });

    it('names the triggers that run after an undelete, for what a delta run deleted and the removal brings back', async () => {
      const C2 = fakeId('003', 2);
      writeFileSync(
        file,
        JSON.stringify(
          summary({
            created: {
              runId: 'sandforge-sync-1',
              objects: [],
              deleted: [{ objectApiName: 'Contact', ids: [C2] }],
            },
          }),
        ),
      );
      automationRead.mockResolvedValueOnce(firing());
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

      expect(automationRead).toHaveBeenLastCalledWith('TGT', ['Contact'], { undeletes: true });
      expect(stdout).toContain(
        '  Contact: brought back from the recycle bin: Apex trigger ContactBack',
      );
      expect(exit.stderr()).toContain(
        'TGT runs automation as this removal brings back from the recycle bin what the run ' +
          'deleted: Contact: Apex trigger ContactBack.',
      );
      expect(exit.stderr()).not.toContain('AccountCleanup');
    });

    it('says nothing fires, and asks for nothing, when nothing does', async () => {
      await main(argv('--remove', file, '--target', 'TGT'));

      expect(stdout).toContain('  nothing fires on the 2 object(s) it writes records of');
      expect(org.all('Account')).toEqual([]);
    });

    it.each([
      [
        'as it plans the mute',
        'plan',
        {
          code: 'MUTE_PRODUCTION' as const,
          message:
            'TGT is a production org: its automation is never muted there. Nothing was assigned.',
        },
      ],
      [
        'as it takes the lease',
        'lease',
        {
          code: 'MUTE_FAILED' as const,
          message: 'The lease could not be kept. Nothing was assigned.',
        },
      ],
    ])(
      'ends a removal whose mute is refused %s under its code, on stderr and with --json on stdout, nothing written',
      async (_when, when, refusal) => {
        // A sentence on stderr and an empty stdout: a CI job could not tell why.
        if (when === 'plan') {
          vi.mocked(muteForRun).mockRejectedValueOnce(new MuteRefusedError(refusal));
        } else {
          const automation = { objectsRead: [], objects: [], unread: [] } as never;
          const muted: MutedAutomation = {
            state: 'muted',
            assigned: ['PS_Bypass'],
            held: [],
            permissions: ['Bypass'],
            silenced: [],
            stillRan: [],
          };
          vi.mocked(muteForRun).mockResolvedValueOnce({
            automation,
            muted,
            prepared: {
              plan: { assign: [], silenced: [], stillRuns: [] },
              automation,
              planned: muted,
              acquire: async () => {
                throw new MuteRefusedError(refusal);
              },
            },
          });
        }
        const exit = stubExit();

        await expect(
          main(argv('--remove', file, '--target', 'TGT', '--mute-automation', '--json')),
        ).rejects.toThrow('exit 1');

        expect(exit.code()).toBe(1);
        expect(exit.stderr()).toContain(`refused (${refusal.code}): ${refusal.message}\n`);
        expect(JSON.parse(stdout)).toEqual({
          tool: 'sandforge-sync',
          action: 'remove',
          summary: file,
          target: 'TGT',
          refused: refusal,
          elapsedMs: expect.any(Number),
        });
        expect(org.deletes).toEqual([]);
      },
    );

    it('deletes nothing when it could not read what fires, without --accept-automation', async () => {
      automationRead.mockResolvedValueOnce({
        ...firing(),
        objects: [],
        unread: [{ part: 'triggers', reason: 'API_DISABLED' }],
      });
      const exit = stubExit();

      await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 1');

      expect(exit.stderr()).toContain(
        'The Apex triggers of TGT could not be read (API_DISABLED), so what fires as the ' +
          'removal writes is not known. Nothing was written or deleted.',
      );
      expect(org.deletes).toEqual([]);
    });
  });

  describe('of a run of a saved configuration', () => {
    const watermark = {
      sourceOrgId: 'SRC',
      targetOrgId: 'TGT',
      objectApiName: 'Account',
      watermark: '2026-10-14T08:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      recordedAt: '2026-10-14T08:01:00.000Z',
    };
    let state: string;

    beforeEach(() => {
      state = join(dir, 'state');
      writeFileSync(file, JSON.stringify(summary({ configId: 'cfg-1' })));
      const configs = savedConfigStore(state);
      configs.save({
        id: 'cfg-1',
        name: 'Accounts',
        description: '',
        sourceOrgId: 'SRC',
        targetOrgId: 'TGT',
        direction: 'source_to_target',
        mode: 'delta',
        objects: [],
        conflictStrategy: 'source_wins',
        enableRollback: false,
        createdAt: '2026-10-14T08:00:00.000Z',
        updatedAt: '2026-10-14T08:00:00.000Z',
      });
      configs.recordWatermark('cfg-1', watermark);
    });

    it('tells its store what it took, so that the next delta run reads those objects whole', async () => {
      await main(argv('--remove', file, '--target', 'TGT', '--store', state, '--json'));

      expect(JSON.parse(stdout)).toMatchObject({
        result: { status: 'success', readWhole: ['Account'] },
      });
      const delta = savedConfigStore(state).loadDelta('cfg-1');
      expect(delta.kind === 'stored' ? delta.state.entries : []).toEqual([
        { ...watermark, removedAt: expect.any(String) },
      ]);
    });

    it('has its store forget which source records the accounts it took were the copies of', async () => {
      const pairs = nodeSyncIdMap(state);
      const orgs = { sourceOrgId: 'SRC', targetOrgId: 'TGT' };
      await pairs.record('cfg-1', orgs, 'Account', [
        [fakeId('001', 101), A1],
        [fakeId('001', 102), A2],
        // A record of the target the run linked to, which it did not create: kept.
        [fakeId('001', 103), fakeId('001', 800)],
      ]);

      await main(argv('--remove', file, '--target', 'TGT', '--store', state, '--json'));

      expect(JSON.parse(stdout)).toMatchObject({ result: { linksForgotten: 2 } });
      expect([...(await nodeSyncIdMap(state).load('cfg-1', orgs)).values()]).toEqual([
        fakeId('001', 800),
      ]);
    });

    it('says, when its store was not given, that the next delta run is not told', async () => {
      const exit = stubExit();

      await main(argv('--remove', file, '--target', 'TGT', '--json'));

      expect(exit.stderr()).toContain('its store was not given');
      const delta = savedConfigStore(state).loadDelta('cfg-1');
      expect(delta.kind === 'stored' ? delta.state.entries : []).toEqual([watermark]);
    });

    it('refuses a store that holds no such configuration, and a store for a run of none, deleting nothing', async () => {
      const exit = stubExit();

      await expect(
        main(argv('--remove', file, '--target', 'TGT', '--store', join(dir, 'elsewhere'))),
      ).rejects.toThrow('exit 2');
      expect(exit.stderr()).toContain('holds no configuration cfg-1');

      writeFileSync(file, JSON.stringify(summary()));
      await expect(
        main(argv('--remove', file, '--target', 'TGT', '--store', state)),
      ).rejects.toThrow('exit 2');
      expect(exit.stderr()).toContain('names none');
      expect(org.deletes).toEqual([]);
    });
  });

  it('takes the duplicate record sets its deletes left empty, keeps one still holding a record that stays, and names them', async () => {
    // Run for real on a Developer Edition, two runs of the same two contacts:
    // the second's duplicate rule put each of its contacts in a set with the
    // first's, two items a set, made by the Automated Process user. Each
    // removal took its contacts and their items, and both left the sets,
    // empty: 57 sets before, 59 after.
    const LEFT = fakeId('0GK', 1);
    const SHARED = fakeId('0GK', 2);
    const OTHER_RUNS = fakeId('003', 9);
    org = new MemoryRemovalOrg({
      Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
      Contact: [{ childSObject: 'DuplicateRecordItem', field: 'RecordId', cascadeDelete: true }],
    });
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    org.add('Account', { Id: A1 }, at);
    org.add('Account', { Id: A2 }, at);
    org.add('Contact', { Id: C1, AccountId: A1 }, at);
    org.add('Contact', { Id: OTHER_RUNS }, at);
    org.add('DuplicateRecordSet', { Id: LEFT }, at);
    org.add('DuplicateRecordSet', { Id: SHARED }, at);
    org.add(
      'DuplicateRecordItem',
      { Id: fakeId('0GL', 1), RecordId: C1, DuplicateRecordSetId: LEFT },
      at,
    );
    org.add(
      'DuplicateRecordItem',
      { Id: fakeId('0GL', 2), RecordId: C1, DuplicateRecordSetId: SHARED },
      at,
    );
    org.add(
      'DuplicateRecordItem',
      { Id: fakeId('0GL', 3), RecordId: OTHER_RUNS, DuplicateRecordSetId: SHARED },
      at,
    );
    vi.mocked(removalOrg).mockReturnValue(org);

    await main(argv('--remove', file, '--target', 'TGT', '--json'));

    expect(org.all('DuplicateRecordSet').map((row) => row.Id)).toEqual([SHARED]);
    expect(JSON.parse(stdout)).toMatchObject({
      result: {
        status: 'success',
        planned: 3,
        objects: expect.arrayContaining([
          expect.objectContaining({ objectApiName: 'DuplicateRecordSet', planned: 1, deleted: 1 }),
        ]),
      },
    });
  });

  it('exits 3 when it leaves records of the run in the org, and takes them on the next removal', async () => {
    org.touch('Account', A2, new Date(Date.now() + 60_000).toISOString());
    const exit = stubExit();

    await expect(main(argv('--remove', file, '--target', 'TGT'))).rejects.toThrow('exit 3');
    expect(exit.code()).toBe(3);
    expect(org.all('Account').map((row) => row.Id)).toEqual([A2]);

    vi.mocked(process.exit).mockClear();
    await main(argv('--remove', file, '--target', 'TGT', '--include-changed'));

    expect(org.all('Account')).toEqual([]);
    expect(process.exit).not.toHaveBeenCalled();
  });
});

describe('removalSummaryLines', () => {
  it('names, for a removal stopped part way, what it never reached, an object it never got to too', () => {
    const counts = { alreadyGone: 0, keptChanged: 0, keptDependents: 0, refused: 0 };
    const lists = { heldBy: [], unchecked: [], reasons: [] };

    expect(
      removalSummaryLines('cancelled', [
        { objectApiName: 'Contact', planned: 5, deleted: 3, notReached: 2, ...counts, ...lists },
        { objectApiName: 'Account', planned: 1, deleted: 0, notReached: 1, ...counts, ...lists },
      ]),
    ).toEqual([
      'removal: CANCELLED',
      '  Contact: 3 deleted, 2 not reached of 5',
      '  Account: 1 not reached of 1',
    ]);
  });

  it('says what a removal including changes took along that the run never wrote', () => {
    const counts = { alreadyGone: 0, keptChanged: 0, keptDependents: 0, refused: 0 };
    const lists = { heldBy: [], unchecked: [], reasons: [] };

    expect(
      removalSummaryLines('success', [
        {
          objectApiName: 'Account',
          planned: 1,
          deleted: 1,
          tookAlong: { count: 2, objects: ['Contact', 'Task'] },
          ...counts,
          ...lists,
        },
      ]),
    ).toEqual([
      'removal: SUCCESS',
      '  Account: 1 deleted of 1',
      "      took along 2 record(s) that were not the run's, added or changed since it: Contact, Task",
    ]);
  });
});
