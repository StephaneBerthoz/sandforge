import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CheckpointListEntry,
  OrgCheckpoint,
  RewindDiff,
  RewindDiffObject,
} from '@sandforge/shared';
import {
  checkpointsOf,
  defaultName,
  invalidRefusal,
  listEntryJson,
  orgDiffers,
  parseArgs,
  previewExitCode,
  previewLines,
  previewTotals,
  requestsLine,
  resolveCheckpoint,
} from './sandforge-checkpoint.js';

/*
 * The command line of Checkpoint & Rewind, read without any org: its words,
 * which checkpoint a line means, and how a preview's answer is said and ends
 * the command. The commands themselves, through the extension's host on the
 * memory org, are in `sandforge-checkpoint.host.test.ts`.
 */

const argv = (...args: string[]): string[] => ['node', 'sandforge-checkpoint.ts', ...args];

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run a parse meant to be refused, and report the exit and what it said. */
function refused(...args: string[]): { code: number | undefined; stderr: string; stdout: string } {
  let code: number | undefined;
  let stderr = '';
  let stdout = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += chunk;
    return true;
  }) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    stdout += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, stderr, stdout };
}

describe('parseArgs', () => {
  const NOW = new Date('2026-10-22T14:05:31.000Z');

  it('takes everything people work in by default, named by the date and time, kept 30 days', () => {
    const args = parseArgs(argv('take', '--org', 'DEV-SB'), NOW);
    expect(args).toMatchObject({
      command: 'take',
      org: 'DEV-SB',
      estimate: false,
      json: false,
      take: { name: '2026-10-22 14:05 UTC', mode: 'everything', keepDays: 30 },
    });
    expect(defaultName(NOW)).toBe('2026-10-22 14:05 UTC');
  });

  it('takes the objects picked, leaves out those excluded, and carries the fields not compared and the limit', () => {
    const args = parseArgs(
      argv(
        'take',
        '--org',
        'DEV-SB',
        '--object',
        'Account',
        '--object',
        'Case',
        '--exclude-object',
        'Task',
        '--ignore-field',
        'Case.Last_Touched__c',
        '--max-total',
        '1000',
        '--keep-days',
        '0',
        '--name',
        '  Clean baseline ',
        '--estimate',
        '--json',
      ),
      NOW,
    );
    expect(args).toMatchObject({
      command: 'take',
      estimate: true,
      json: true,
      take: {
        name: 'Clean baseline',
        mode: 'picked',
        objects: ['Account', 'Case'],
        excluded: ['Task'],
        ignoredFields: ['Case.Last_Touched__c'],
        maxTotal: 1000,
        keepDays: 0,
      },
    });
  });

  it('lists the whole store without --org, and previews the latest checkpoint unless one is named', () => {
    expect(parseArgs(argv('list'))).toMatchObject({ command: 'list' });
    expect(parseArgs(argv('list')).command === 'list' && 'org' in parseArgs(argv('list'))).toBe(
      false,
    );
    expect(parseArgs(argv('preview', '--org', 'DEV-SB'))).toMatchObject({
      command: 'preview',
      checkpoint: 'latest',
      failOnChange: false,
    });
    expect(
      parseArgs(argv('preview', '--org', 'DEV-SB', '--checkpoint', 'baseline', '--fail-on-change')),
    ).toMatchObject({ checkpoint: 'baseline', failOnChange: true });
    expect(parseArgs(argv('delete', '--org', 'DEV-SB', '--all', '--yes'))).toMatchObject({
      command: 'delete',
      all: true,
      yes: true,
    });
  });

  it('keeps the checkpoints where --store names, made absolute', () => {
    const args = parseArgs(argv('list', '--store', 'relative/store'));
    expect(
      args.storeRoot.endsWith('/relative/store') || args.storeRoot.endsWith('\\relative\\store'),
    ).toBe(true);
    expect(args.storeRoot).not.toBe('relative/store');
  });

  it('refuses, exit 2 and nothing on stdout, a flag no command reads, or one another command reads', () => {
    for (const line of [
      ['take', '--org', 'DEV-SB', '--dry-run'],
      ['list', '--checkpoint', 'baseline'],
      ['preview', '--org', 'DEV-SB', '--estimate'],
      ['delete', '--org', 'DEV-SB', '--fail-on-change'],
      ['take', '--org=DEV-SB'],
      ['preview', '--org', 'DEV-SB', '--fail-on-change=true'],
    ]) {
      const { code, stdout, stderr } = refused(...line);
      expect(code, line.join(' ')).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain('Nothing was run');
    }
  });

  it('refuses a line without its command, and a command it does not have, rewind among them for now', () => {
    expect(refused('--org', 'DEV-SB').code).toBe(2);
    expect(refused().code).toBe(2);
    const rewind = refused('rewind', '--org', 'DEV-SB', '--yes');
    expect(rewind.code).toBe(2);
    expect(rewind.stderr).toContain('"rewind" is not a command of sandforge-checkpoint');
  });

  it('refuses a take, a preview or a delete without --org, and an org or a name given twice', () => {
    for (const command of ['take', 'preview', 'delete']) {
      const { code, stderr } = refused(command);
      expect(code).toBe(2);
      expect(stderr).toContain(`${command} needs --org`);
    }
    expect(refused('take', '--org', 'A', '--org', 'B').stderr).toContain('--org is given 2 times');
    expect(refused('take', '--org', 'A', '--name', 'x', '--name', 'y').code).toBe(2);
    expect(refused('take', '--org').stderr).toContain('--org wants a value');
  });

  it('refuses, before any org is reached, what the take’s handler would refuse, naming the flag', () => {
    const cases: Array<[string[], string]> = [
      [['--keep-days', '1.5'], '--keep-days takes a whole number'],
      [['--keep-days', '3651'], '--keep-days:'],
      [['--max-total', '0'], '--max-total:'],
      [['--max-total', 'all'], '--max-total takes a whole number'],
      [['--ignore-field', 'Last_Touched__c'], '--ignore-field: Expected an Object.Field name'],
      [['--object', 'Account', '--object', 'Account'], '--object: An object is named twice'],
      [['--exclude-object', 'Case WHERE Id != null'], '--exclude-object:'],
      [['--name', '   '], '--name:'],
    ];
    for (const [flags, said] of cases) {
      const { code, stderr } = refused('take', '--org', 'DEV-SB', ...flags);
      expect(code, flags.join(' ')).toBe(2);
      expect(stderr).toContain(said);
    }
  });

  it('refuses a delete that names one checkpoint and all of them', () => {
    const { code, stderr } = refused('delete', '--org', 'DEV-SB', '--all', '--checkpoint', 'x');
    expect(code).toBe(2);
    expect(stderr).toContain('not both');
  });

  it('prints its help, which documents each command, the JSON it answers with and its exit codes', () => {
    const { code, stdout } = refused('take', '--help');
    expect(code).toBe(0);
    for (const said of [
      'take      read the org',
      'list      name the checkpoints kept',
      'preview   say what a rewind would delete',
      'delete    delete a checkpoint from this machine',
      '--max-total <n>                refuse, before reading, more than <n> records (default: 500000)',
      '--keep-days <n>                when it expires (default: 30; 0 keeps it until deleted)',
      'A production org is refused before anything is read or written, exit 1. No flag lifts it.',
      'JSON (--json), one value on stdout:',
      '[{id, name, org, organizationId, takenAt, records, bytes, expiresAt,',
      '{checkpoint, requests?, estimate}: the checkpoint as kept',
      'requests, {total, byPhase}, the API requests the take sent',
      'estimate.requestsByPhase splits',
      '{checkpoint: {id, name, takenAt, org}, toDelete, toGiveBack, toBringBack,',
      '{refusal: {code, message}}',
      'Exit codes: 0 done',
      '3 with --fail-on-change, the org differs',
      '130, 143, 129 Ctrl-C, SIGTERM or SIGHUP stopped it.',
    ]) {
      expect(stdout).toContain(said);
    }
    // No line of the help says a command it does not have.
    expect(stdout).not.toMatch(/^ {2}(rewind|undo) /m);
  });
});

// ─── Which checkpoints are an org's ──────────────────────────────────────────

const ORG_A = '00D000000000001AAA';
const ORG_B = '00D000000000002AAA';

/** A kept checkpoint, as the store lists it. */
function entry(
  checkpointId: string,
  organizationId: string,
  org: { alias?: string; username: string } | undefined,
  extra: Partial<CheckpointListEntry> & { name?: string } = {},
): CheckpointListEntry {
  const { name, ...rest } = extra;
  return {
    checkpointId,
    organizationId,
    ...(org
      ? {
          checkpoint: {
            checkpointId,
            name: name ?? 'Before UAT',
            org: { organizationId, ...org },
            takenAt: '2026-10-22T14:06:01.000Z',
            objects: [{ records: 3 }],
            bytes: 2048,
            expiresAt: '2026-11-21T14:05:31.000Z',
          } as unknown as OrgCheckpoint,
        }
      : {}),
    valid: org !== undefined,
    ...(org === undefined ? { why: 'damaged' as const } : {}),
    ...rest,
  };
}

describe('checkpointsOf', () => {
  const all = [
    entry('ck-20261022-160000-cccc', ORG_A, { alias: 'DEV-SB', username: 'tester@example.com' }),
    // Taken in the editor, under another alias of the same org.
    entry('ck-20261022-150000-bbbb', ORG_A, {
      alias: 'my-sandbox',
      username: 'tester@example.com',
    }),
    // A damaged one, filed under the org.
    entry('ck-20261022-140000-aaaa', ORG_A, undefined),
    entry('ck-20261021-140000-dddd', ORG_B, { alias: 'OTHER', username: 'other@example.com' }),
  ];

  it('holds the org’s checkpoints by its alias or username, with the others kept of the same org', () => {
    const ids = (entries: CheckpointListEntry[]) => entries.map((e) => e.checkpointId);
    expect(ids(checkpointsOf(all, 'DEV-SB'))).toEqual([
      'ck-20261022-160000-cccc',
      'ck-20261022-150000-bbbb',
      'ck-20261022-140000-aaaa',
    ]);
    expect(ids(checkpointsOf(all, 'Tester@Example.com'))).toHaveLength(3);
    expect(ids(checkpointsOf(all, 'OTHER'))).toEqual(['ck-20261021-140000-dddd']);
    expect(checkpointsOf(all, 'UNKNOWN')).toEqual([]);
    // Once the org has answered, by its Organization Id too, in either form.
    expect(ids(checkpointsOf(all, 'UNKNOWN', ORG_B.slice(0, 15)))).toEqual([
      'ck-20261021-140000-dddd',
    ]);
  });
});

describe('resolveCheckpoint', () => {
  const all = [
    entry(
      'ck-20261022-160000-cccc',
      ORG_A,
      { alias: 'DEV-SB', username: 'u@example.com' },
      { name: 'baseline' },
    ),
    entry(
      'ck-20261022-150000-bbbb',
      ORG_A,
      { alias: 'DEV-SB', username: 'u@example.com' },
      { name: 'Before UAT' },
    ),
    entry(
      'ck-20261022-140000-aaaa',
      ORG_A,
      { alias: 'DEV-SB', username: 'u@example.com' },
      { name: 'baseline' },
    ),
    entry('ck-20261021-140000-dddd', ORG_B, { alias: 'OTHER', username: 'o@example.com' }),
  ];
  const ofOrg = checkpointsOf(all, 'DEV-SB');

  it('takes the newest for latest, the one of a name, and an id wherever it is kept', () => {
    expect(resolveCheckpoint(all, ofOrg, 'latest', 'DEV-SB')).toEqual({ entry: all[0] });
    expect(resolveCheckpoint(all, ofOrg, 'Before UAT', 'DEV-SB')).toEqual({ entry: all[1] });
    expect(resolveCheckpoint(all, ofOrg, 'ck-20261021-140000-dddd', 'DEV-SB')).toEqual({
      entry: all[3],
    });
  });

  it('names a name several checkpoints have, with their ids, rather than pick one', () => {
    expect(resolveCheckpoint(all, ofOrg, 'baseline', 'DEV-SB')).toEqual({
      ambiguous: expect.stringContaining(
        "2 checkpoints of DEV-SB are named 'baseline': give the id of the one you mean with --checkpoint (ck-20261022-160000-cccc, ck-20261022-140000-aaaa)",
      ) as unknown,
    });
  });

  it('says when nothing matches', () => {
    expect(resolveCheckpoint(all, [], 'latest', 'EMPTY')).toEqual({
      none: 'No checkpoint of EMPTY is kept on this machine.',
    });
    expect(resolveCheckpoint(all, ofOrg, 'nightly', 'DEV-SB')).toMatchObject({
      none: expect.stringContaining("named 'nightly'") as unknown,
    });
    expect(resolveCheckpoint(all, ofOrg, 'ck-20261022-140000-zzzz', 'DEV-SB')).toMatchObject({
      none: expect.stringContaining('ck-20261022-140000-zzzz') as unknown,
    });
  });
});

describe('invalidRefusal', () => {
  it('refuses the preview of a checkpoint the list says cannot be used, with the code the extension gives it', () => {
    const of = { alias: 'DEV-SB', username: 'u@example.com' };
    expect(invalidRefusal(entry('ck-20261022-160000-cccc', ORG_A, of))).toBeUndefined();
    expect(invalidRefusal(entry('ck-20261022-160000-cccc', ORG_A, undefined))?.code).toBe(
      'DAMAGED',
    );
    expect(
      invalidRefusal(
        entry('ck-20261022-160000-cccc', ORG_A, of, { valid: false, why: 'scratchExpired' }),
      ),
    ).toEqual({
      code: 'SCRATCH_EXPIRED',
      message:
        "The scratch org of checkpoint 'Before UAT' has expired: its checkpoints can only be deleted.",
    });
    expect(
      invalidRefusal(entry('ck-20261022-160000-cccc', ORG_A, of, { valid: false, why: 'taking' }))
        ?.code,
    ).toBe('TAKING');
  });
});

describe('listEntryJson', () => {
  it('lists every key of a checkpoint, and nulls what a damaged one cannot say', () => {
    const kept = listEntryJson(
      entry('ck-20261022-160000-cccc', ORG_A, { alias: 'DEV-SB', username: 'u@example.com' }),
    );
    expect(kept).toEqual({
      id: 'ck-20261022-160000-cccc',
      name: 'Before UAT',
      org: 'DEV-SB',
      organizationId: ORG_A,
      takenAt: '2026-10-22T14:06:01.000Z',
      records: 3,
      bytes: 2048,
      expiresAt: '2026-11-21T14:05:31.000Z',
      expiresSoon: false,
      binReachSince: null,
      valid: true,
    });
    expect(listEntryJson(entry('ck-20261022-140000-aaaa', ORG_A, undefined))).toEqual({
      id: 'ck-20261022-140000-aaaa',
      name: null,
      org: null,
      organizationId: ORG_A,
      takenAt: null,
      records: null,
      bytes: null,
      expiresAt: null,
      expiresSoon: false,
      binReachSince: null,
      valid: false,
      why: 'damaged',
    });
  });
});

// ─── What a preview says, and how it ends the command ────────────────────────

/** One object of a diff, nothing to do unless the patch says so. */
function object(patch: Partial<RewindDiffObject> = {}): RewindDiffObject {
  return {
    objectApiName: 'Account',
    toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 0 },
    toGiveBack: { records: 0, fields: 0, clearedLookups: 0 },
    toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0 },
    cannotUndo: [],
    outside: [],
    touched: 0,
    unexplained: 0,
    lastChangedBy: {},
    notCompared: [],
    ...patch,
  };
}

function diffOf(objects: RewindDiffObject[], patch: Partial<RewindDiff> = {}): RewindDiff {
  return {
    checkpointId: 'ck-20261022-160000-cccc',
    previewId: 'pv-20261022-170000-eeee',
    readAt: '2026-10-22T17:00:00.000Z',
    objects,
    undoCannot: [],
    unread: [],
    userNames: {},
    activeLastHour: [],
    ...patch,
  };
}

describe('requestsLine', () => {
  const byPhase = {
    guard: 4,
    scope: 12,
    start: 3,
    counts: 41,
    bin: 48,
    snapshot: 12,
    stability: 42,
  };

  it('says what the take sent, phase by phase, each beside what its estimate said where they differ', () => {
    expect(
      requestsLine(
        { total: 162, byPhase },
        { apiRequests: 155, requestsByPhase: { ...byPhase, bin: 41, stability: 42 } },
      ),
    ).toBe(
      '  sent 162 API requests to the org, about 155 estimated: guard 4, scope 12, start 3, ' +
        'counts 41, bin 48 (41), snapshot 12, stability 42',
    );
  });

  it('says what it sent alone when no estimate came with it', () => {
    expect(requestsLine({ total: 162, byPhase }, undefined)).toBe(
      '  sent 162 API requests to the org: guard 4, scope 12, start 3, counts 41, bin 48, ' +
        'snapshot 12, stability 42',
    );
  });
});

describe('previewTotals and orgDiffers', () => {
  it('counts the three numbers, every class of each', () => {
    const diff = diffOf([
      object({
        toDelete: { createdSince: 3, broughtBackSince: 1, comesBackWithParent: 2 },
        toGiveBack: { records: 5, fields: 9, clearedLookups: 1 },
        toBringBack: { inBin: 4, withParent: 2, deletedWhileTaken: 1 },
      }),
      object({ objectApiName: 'Case', toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } }),
    ]);
    expect(previewTotals(diff)).toEqual({ toDelete: 6, toGiveBack: 6, toBringBack: 7 });
    expect(orgDiffers(diff)).toBe(true);
  });

  it('says the org differs for what a rewind cannot take back, records it does not hold dated before it, and an object it could not read', () => {
    for (const diff of [
      diffOf([object({ cannotUndo: [{ reason: 'goneForGood', count: 2 }] })]),
      diffOf([object({ unexplained: 1 })]),
      diffOf([], { unread: [{ objectApiName: 'Case', reason: 'its read ended early' }] }),
    ]) {
      expect(previewTotals(diff)).toEqual({ toDelete: 0, toGiveBack: 0, toBringBack: 0 });
      expect(orgDiffers(diff)).toBe(true);
      expect(previewExitCode(diff, true)).toBe(3);
      expect(previewExitCode(diff, false)).toBe(0);
    }
  });

  it('does not take records touched since that hold their checkpoint values for a difference', () => {
    const diff = diffOf([object({ touched: 52 })]);
    expect(orgDiffers(diff)).toBe(false);
    expect(previewExitCode(diff, true)).toBe(0);
  });
});

describe('previewLines', () => {
  const checkpoint = { name: 'Before UAT', takenAt: '2026-10-20T14:05:31.000Z' };
  const estimate = { records: 4, apiRequests: 12, apiRequestsLeft: 14_900, seconds: 3, bytes: 0 };

  it('leads with the three numbers, then each object and who last changed it', () => {
    const lines = previewLines('DEV-SB', checkpoint, {
      diff: diffOf(
        [
          object({
            toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
            toGiveBack: { records: 2, fields: 2, clearedLookups: 0 },
            lastChangedBy: { '005000000000003AAA': 3 },
          }),
          object({
            objectApiName: 'Case',
            toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
            lastChangedBy: { '005000000000003AAA': 1 },
          }),
        ],
        {
          userNames: { '005000000000003AAA': 'Ada Tester' },
          undoCannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }],
        },
      ),
      estimate,
      refusal: { code: 'API_BUDGET', message: 'This rewind takes about 500 API requests.' },
    });
    expect(lines[0]).toBe(
      "Rewind DEV-SB to 'Before UAT' (2026-10-20 14:05 UTC), read at 2026-10-22 17:00:00 UTC:",
    );
    expect(lines[1]).toBe('  1 to delete · 2 to give back · 1 to bring back');
    expect(lines).toContain('  last changed by: Ada Tester 4');
    expect(lines.join('\n')).toMatch(/Account +1 +2 +0 +0/);
    expect(lines.join('\n')).toMatch(/Case +0 +0 +1 +0/);
    expect(lines).toContain(
      "  undo couldn't bring back: OpportunityLineItem 3 — Salesforce undeletes them only with their parent, and their parent stays",
    );
    expect(lines).toContain('  about 3 s · about 12 API requests of the 14,900 left today');
    expect(lines.at(-1)).toBe(
      '  a rewind now would be refused: This rewind takes about 500 API requests.',
    );
  });

  it('says there is nothing to rewind when the org is as it was', () => {
    const lines = previewLines('DEV-SB', checkpoint, { diff: diffOf([]), estimate });
    expect(lines).toContain(
      "  DEV-SB is as it was at 'Before UAT' among the objects and fields it holds: nothing to rewind.",
    );
  });
});
