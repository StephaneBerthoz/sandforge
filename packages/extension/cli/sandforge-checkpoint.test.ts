import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CheckpointListEntry,
  ForgeTargetAutomation,
  OrgCheckpoint,
  RewindDiff,
  RewindDiffObject,
  RewindResult,
} from '@sandforge/shared';
import {
  acceptanceRefusal,
  checkpointsOf,
  defaultName,
  invalidRefusal,
  listEntryJson,
  orgDiffers,
  parseArgs,
  previewExitCode,
  previewJson,
  previewLines,
  previewTotals,
  requestsLine,
  resolveCheckpoint,
  resultExitCode,
  resultJson,
  rewindLines,
  rewindQuestion,
  rewindStepsOf,
  undoLines,
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

  it('refuses a line without its command, and a command it does not have', () => {
    expect(refused('--org', 'DEV-SB').code).toBe(2);
    expect(refused().code).toBe(2);
    const restore = refused('restore', '--org', 'DEV-SB', '--yes');
    expect(restore.code).toBe(2);
    expect(restore.stderr).toContain(
      '"restore" is not a command of sandforge-checkpoint: take, list, preview, rewind, undo or delete',
    );
  });

  it('rewinds to the latest checkpoint unless one is named, asking first, with nothing accepted unless said', () => {
    expect(parseArgs(argv('rewind', '--org', 'DEV-SB'))).toEqual({
      command: 'rewind',
      org: 'DEV-SB',
      checkpoint: 'latest',
      dryRun: false,
      acceptAutomation: false,
      acceptNoUndo: false,
      acceptRecreate: false,
      acceptOutside: false,
      ignoreFields: [],
      yes: false,
      storeRoot: expect.any(String) as unknown,
      json: false,
    });
    expect(
      parseArgs(
        argv(
          'rewind',
          '--org',
          'DEV-SB',
          '--checkpoint',
          'baseline',
          '--yes',
          '--dry-run',
          '--accept-automation',
          '--accept-no-undo',
          '--accept-recreate',
          '--accept-outside',
          '--ignore-field',
          'Case.Last_Touched__c',
          '--json',
        ),
      ),
    ).toMatchObject({
      command: 'rewind',
      checkpoint: 'baseline',
      yes: true,
      dryRun: true,
      acceptAutomation: true,
      acceptNoUndo: true,
      acceptRecreate: true,
      acceptOutside: true,
      ignoreFields: ['Case.Last_Touched__c'],
      json: true,
    });
  });

  it('undoes the org’s last rewind unless a checkpoint is named', () => {
    const plain = parseArgs(argv('undo', '--org', 'DEV-SB'));
    expect(plain).toMatchObject({ command: 'undo', acceptAutomation: false, yes: false });
    expect('checkpoint' in plain).toBe(false);
    expect(
      parseArgs(
        argv('undo', '--org', 'DEV-SB', '--checkpoint', 'baseline', '--yes', '--accept-automation'),
      ),
    ).toMatchObject({ checkpoint: 'baseline', yes: true, acceptAutomation: true });
  });

  it('refuses, exit 2, a rewind or an undo told not to ask that does not name its checkpoint', () => {
    for (const command of ['rewind', 'undo']) {
      const none = refused(command, '--org', 'DEV-SB', '--yes');
      expect(none.code, command).toBe(2);
      expect(none.stdout).toBe('');
      expect(none.stderr).toContain(`${command} --yes needs --checkpoint <id|name>`);
      const latest = refused(command, '--org', 'DEV-SB', '--checkpoint', 'latest', '--yes');
      expect(latest.code, command).toBe(2);
      expect(latest.stderr).toContain(
        `${command} --yes needs the checkpoint named by its id or its name, not latest`,
      );
    }
  });

  it('refuses, exit 2, what a rewind or an undo does not read, a flag given its value after =, and a field it cannot name', () => {
    for (const line of [
      ['rewind', '--org', 'DEV-SB', '--dry-run=true'],
      ['rewind', '--org', 'DEV-SB', '--fail-on-change'],
      ['rewind', '--org', 'DEV-SB', '--estimate'],
      ['undo', '--org', 'DEV-SB', '--dry-run'],
      ['undo', '--org', 'DEV-SB', '--accept-no-undo'],
      ['undo', '--org', 'DEV-SB', '--ignore-field', 'Case.Subject'],
      ['preview', '--org', 'DEV-SB', '--yes'],
    ]) {
      const { code, stdout, stderr } = refused(...line);
      expect(code, line.join(' ')).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain('Nothing was run');
    }
    const field = refused('rewind', '--org', 'DEV-SB', '--ignore-field', 'Last_Touched__c');
    expect(field.code).toBe(2);
    expect(field.stderr).toContain('--ignore-field: Expected an Object.Field name');
    const twice = refused(
      'rewind',
      '--org',
      'DEV-SB',
      '--ignore-field',
      'Case.Subject',
      '--ignore-field',
      'Case.Subject',
    );
    expect(twice.stderr).toContain('--ignore-field: A field is listed twice');
    expect(refused('rewind').stderr).toContain('rewind needs --org');
    expect(refused('undo').stderr).toContain('undo needs --org');
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
      'rewind    return the org to a checkpoint: bring back from the recycle bin the records deleted',
      "undo      take back the org's last rewind: bring back what it deleted, give back what it wrote",
      'delete    delete a checkpoint from this machine',
      '--checkpoint <id|name|latest>  which one (default: latest, for undo the one the last rewind went',
      '--dry-run                      the preview, then stop',
      '--accept-automation            rewind even when the org runs flows, Apex triggers, processes or',
      '--accept-no-undo               rewind even when undo could not bring back some records it deletes',
      '--accept-recreate              make again, with new Ids, the records deleted since that the',
      '--accept-outside               (a checkpoint of picked objects) also delete the records outside it',
      '--ignore-field <Object.Field>  stop comparing a field from now on; kept in the checkpoint',
      '--yes                          do not ask before writing; without it and with no terminal — a CI',
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
      '  rewind --dry-run   as preview',
      '  rewind             {checkpoint: {id, name, takenAt, org}, rewindId, status, deleted, givenBack,',
      '  undo               as rewind, without recreated, cannotUndo, carriers and undo, with',
      'Exit codes: 0 done',
      'rewind or undo with --yes and no checkpoint named, or a question with no terminal',
      '--fail-on-change, the org differs',
      '4 unstable (someone else changed\nrecords during the rewind or the undo: left as they made them)',
      '130, 143, 129 Ctrl-C, SIGTERM or\nSIGHUP stopped it — run rewind again: it takes up from what still differs',
    ]) {
      expect(stdout).toContain(said);
    }
    // "In clear", a calque of the French "en clair", read as "clearly".
    expect(stdout).toContain(
      "A checkpoint holds the records' values as the org held them, personal data among them,\nunencrypted, in files only you can read",
    );
    expect(stdout).not.toMatch(/\bin clear\b/);
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
    expect(previewTotals(diff)).toEqual({
      toDelete: 6,
      toGiveBack: 6,
      toBringBack: 7,
      toRecreate: 0,
    });
    expect(orgDiffers(diff)).toBe(true);
  });

  it('counts the records to make again with new Ids apart, and the org differs for them', () => {
    const diff = diffOf([
      object({ toRecreate: 2 }),
      object({ objectApiName: 'Case', toRecreate: 1 }),
    ]);
    expect(previewTotals(diff)).toEqual({
      toDelete: 0,
      toGiveBack: 0,
      toBringBack: 0,
      toRecreate: 3,
    });
    expect(orgDiffers(diff)).toBe(true);
    expect(previewExitCode(diff, true)).toBe(3);
  });

  it('says the org differs for what a rewind cannot take back, records it does not hold dated before it, and an object it could not read', () => {
    for (const diff of [
      diffOf([object({ cannotUndo: [{ reason: 'goneForGood', count: 2 }] })]),
      diffOf([object({ unexplained: 1 })]),
      diffOf([], { unread: [{ objectApiName: 'Case', reason: 'its read ended early' }] }),
    ]) {
      expect(previewTotals(diff)).toEqual({
        toDelete: 0,
        toGiveBack: 0,
        toBringBack: 0,
        toRecreate: 0,
      });
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

  it('counts beside the three numbers the records to make again with new Ids, and says what a new Id breaks', () => {
    const lines = previewLines('DEV-SB', checkpoint, {
      diff: diffOf([object({ objectApiName: 'Contact', toRecreate: 2 })]),
      estimate,
    });
    expect(lines[1]).toBe('  0 to delete · 0 to give back · 0 to bring back · 2 to make again');
    expect(lines).toContain(
      '  to make again, with new Ids: Contact 2 — deleted since and no longer in the recycle bin: made again from the checkpoint, the lookups it holds that named them naming the new Ids; anything outside Salesforce that names their old Ids no longer finds them',
    );
  });

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

  it('says in a line of its own the records Undo couldn’t bring back as deleted before a record they point at, which the rewind deletes next', () => {
    const lines = previewLines('DEV-SB', checkpoint, {
      diff: diffOf(
        [
          object({
            objectApiName: 'Case',
            toDelete: { createdSince: 2, broughtBackSince: 0, comesBackWithParent: 0 },
          }),
        ],
        {
          undoCannot: [
            { objectApiName: 'OpportunityLineItem', count: 3 },
            { objectApiName: 'Case', count: 2, reason: 'deletedBeforeParent' },
          ],
        },
      ),
      estimate,
    });
    expect(lines.filter((line) => line.startsWith("  undo couldn't bring back:"))).toEqual([
      "  undo couldn't bring back: OpportunityLineItem 3 — Salesforce undeletes them only with their parent, and their parent stays",
      "  undo couldn't bring back: Case 2 — deleted before a record they point at, which the rewind deletes next: Salesforce cannot bring them back after that",
    ]);
  });

  it('says the emails the rewind’s writes make the org send, per daily limit, against what it has left, and prints them in --json', () => {
    const emails = [
      {
        limit: 'SingleEmail' as const,
        emails: 40,
        objects: [
          {
            objectApiName: 'Account',
            write: 'update' as const,
            records: 20,
            perRecord: 2,
            sentBy: ['Account touch', 'Owner alert'],
          },
        ],
        alertsCounted: true as const,
        verdict: 'exceeds' as const,
        remaining: 12,
        max: 15,
      },
      {
        limit: 'DailyWorkflowEmails' as const,
        emails: 20,
        objects: [],
        verdict: 'unread' as const,
        unread: 'INSUFFICIENT_ACCESS',
      },
    ];
    const answer = {
      diff: diffOf([object({ toGiveBack: { records: 20, fields: 20, clearedLookups: 0 } })]),
      estimate,
      emails,
    };

    const lines = previewLines('DEV-SB', checkpoint, answer);

    expect(lines).toContain(
      "  emails: DEV-SB's automation sends about 40 single emails as the rewind writes (Account touch, Owner alert), its email alerts among them: DEV-SB counts them against its single emails, as a Developer Edition does, more than the 12 of 15 left today: a rewind is refused",
    );
    expect(lines).toContain(
      "  emails: DEV-SB's automation sends about 20 workflow emails as the rewind writes (—); what it has left today could not be read (INSUFFICIENT_ACCESS)",
    );
    expect(previewJson('DEV-SB', { checkpointId: 'ck-1', ...checkpoint }, answer).emails).toEqual(
      emails,
    );
  });

  it('offers --accept-recreate whenever the rewind brings records back, for one Salesforce answers is no longer in the recycle bin, and says nothing of it when it brings none back', () => {
    const offer =
      '  if Salesforce answers that a record to bring back is no longer in the recycle bin — it still lists one emptied from it as deleted —, --accept-recreate makes it again with a new Id, with what was to come back with it; without it, the rewind leaves them and names them';
    const bringing = previewLines('DEV-SB', checkpoint, {
      diff: diffOf([object({ toBringBack: { inBin: 2, withParent: 3, deletedWhileTaken: 0 } })]),
      estimate,
    });
    expect(bringing).toContain(offer);
    const giving = previewLines('DEV-SB', checkpoint, {
      diff: diffOf([object({ toGiveBack: { records: 1, fields: 1, clearedLookups: 0 } })]),
      estimate,
    });
    expect(giving).not.toContain(offer);
  });

  it('says the records it brings back for a moment, in none of the three numbers, and what the org runs on them runs twice; counts them in --json', () => {
    const answer = {
      diff: diffOf([
        object({
          toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0, carriers: 2 },
        }),
        object({
          objectApiName: 'Contact',
          toDelete: { createdSince: 0, broughtBackSince: 0, comesBackWithParent: 1 },
          toGiveBack: { records: 2, fields: 2, clearedLookups: 0 },
          toBringBack: { inBin: 0, withParent: 2, deletedWhileTaken: 0 },
        }),
      ]),
      estimate,
    };

    const lines = previewLines('DEV-SB', checkpoint, answer);

    expect(lines[1]).toBe('  1 to delete · 2 to give back · 2 to bring back');
    expect(lines).toContain(
      '  brought back for a moment: Account 2 — records the checkpoint does not hold that took records of it along when deleted since: Salesforce gives those back with them only, so they come back, then go back to the recycle bin with what came back with them; what the org runs on them runs twice',
    );
    const json = previewJson('DEV-SB', { checkpointId: 'ck-1', ...checkpoint }, answer);
    expect(json).toMatchObject({ toDelete: 1, toGiveBack: 2, toBringBack: 2, carriers: 2 });
    expect(
      previewJson('DEV-SB', { checkpointId: 'ck-1', ...checkpoint }, { diff: diffOf([]), estimate })
        .carriers,
    ).toBe(0);
  });

  it('says why records deleted with a parent the rewind does not bring back stay in the recycle bin, each reason in its own words', () => {
    const lines = previewLines('DEV-SB', checkpoint, {
      diff: diffOf([
        object({
          objectApiName: 'Contact',
          cannotUndo: [{ reason: 'deletedWithParentOutside', count: 3 }],
        }),
        object({
          objectApiName: 'Note__c',
          cannotUndo: [{ reason: 'deletedWithCreatedParent', count: 1 }],
        }),
      ]),
      estimate,
    });
    expect(lines.filter((line) => line.startsWith("  can't be taken back:"))).toEqual([
      "  can't be taken back: Contact 3 — deleted with their parent, a record of an object the checkpoint does not hold: they come back with that parent only, which a checkpoint that holds its object brings back",
      "  can't be taken back: Note__c 1 — deleted with a parent created since that Salesforce does not undelete on its own: they come back with that parent only",
    ]);
  });

  it('says there is nothing to rewind when the org is as it was', () => {
    const lines = previewLines('DEV-SB', checkpoint, { diff: diffOf([]), estimate });
    expect(lines).toContain(
      "  DEV-SB is as it was at 'Before UAT' among the objects and fields it holds: nothing to rewind.",
    );
  });
});

// ─── What a rewind and an undo say, and how they end the command ─────────────

/** What the org runs, found by a read that sends nothing. */
function automation(patch: Partial<ForgeTargetAutomation> = {}): ForgeTargetAutomation {
  return {
    objectsRead: [],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 0,
    requests: 0,
    ...patch,
  };
}

/** A trigger on `objectApiName` running on `events`. */
function triggerOn(objectApiName: string, events: Array<'afterInsert' | 'afterUpdate'>) {
  return { objectApiName, flows: [], triggers: [{ name: `${objectApiName}Audit`, events }] };
}

const NOTHING_ACCEPTED = { acceptAutomation: false, acceptNoUndo: false, acceptRecreate: false };

describe('rewindStepsOf and acceptanceRefusal', () => {
  const diff = diffOf([
    object({ toGiveBack: { records: 2, fields: 2, clearedLookups: 0 } }),
    object({
      objectApiName: 'Order',
      toDelete: { createdSince: 1, broughtBackSince: 0, comesBackWithParent: 0 },
    }),
    object({
      objectApiName: 'Case',
      toBringBack: { inBin: 1, withParent: 0, deletedWhileTaken: 0 },
    }),
  ]);

  it('says which objects each step of a rewind writes, an order deleted set back to Draft first', () => {
    expect(rewindStepsOf(diff)).toEqual({
      bringBack: ['Case'],
      recreate: [],
      giveBack: ['Account'],
      setToDraft: ['Order'],
      delete: ['Order'],
    });
  });

  it('refuses without --accept-recreate a rewind that makes records again with new Ids, saying what a new Id breaks', () => {
    const remade = diffOf([object({ objectApiName: 'Contact', toRecreate: 2 })]);
    expect(rewindStepsOf(remade).recreate).toEqual(['Contact']);
    expect(acceptanceRefusal('DEV-SB', { diff: remade }, NOTHING_ACCEPTED)).toEqual({
      code: 'RECREATE',
      message:
        '2 Contact record(s) deleted since are no longer in the recycle bin, or Salesforce keeps ' +
        'them there for good: this rewind makes them again from the checkpoint, with new Ids. ' +
        'Anything outside Salesforce that names their old Ids — an integration, a link, a report ' +
        'filter — no longer finds them. Rewind refused; give --accept-recreate to rewind all the ' +
        'same. No record was written.',
    });
    expect(
      acceptanceRefusal(
        'DEV-SB',
        { diff: remade },
        { acceptAutomation: false, acceptNoUndo: false, acceptRecreate: true },
      ),
    ).toBeUndefined();
  });

  it('refuses deletions Undo couldn’t bring back without --accept-no-undo, before anything else', () => {
    const refusal = acceptanceRefusal(
      'DEV-SB',
      { diff: { ...diff, undoCannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }] } },
      NOTHING_ACCEPTED,
    );
    expect(refusal).toEqual({
      code: 'NO_UNDO',
      message:
        "Undo couldn't bring back 3 OpportunityLineItem record(s) this rewind deletes: " +
        'Salesforce undeletes them only with their parent, which stays. Rewind refused; give ' +
        '--accept-no-undo to rewind all the same. No record was written.',
    });
    expect(
      acceptanceRefusal(
        'DEV-SB',
        { diff: { ...diff, undoCannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }] } },
        { acceptAutomation: false, acceptNoUndo: true, acceptRecreate: false },
      ),
    ).toBeUndefined();
  });

  it('refuses without --accept-no-undo a rewind that deletes records before a record they point at, which it deletes next, each reason in its own words', () => {
    const before = { objectApiName: 'Case', count: 2, reason: 'deletedBeforeParent' as const };
    expect(
      acceptanceRefusal('DEV-SB', { diff: { ...diff, undoCannot: [before] } }, NOTHING_ACCEPTED),
    ).toEqual({
      code: 'NO_UNDO',
      message:
        "Undo couldn't bring back 2 Case record(s) this rewind deletes: deleted before a record " +
        'they point at, which the rewind deletes next, Salesforce cannot bring them back after ' +
        'that. Rewind refused; give --accept-no-undo to rewind all the same. No record was ' +
        'written.',
    });
    expect(
      acceptanceRefusal(
        'DEV-SB',
        {
          diff: {
            ...diff,
            undoCannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }, before],
          },
        },
        NOTHING_ACCEPTED,
      )?.message,
    ).toBe(
      "Undo couldn't bring back 3 OpportunityLineItem record(s) this rewind deletes: " +
        'Salesforce undeletes them only with their parent, which stays. ' +
        "Undo couldn't bring back 2 Case record(s) this rewind deletes: deleted before a record " +
        'they point at, which the rewind deletes next, Salesforce cannot bring them back after ' +
        'that. Rewind refused; give --accept-no-undo to rewind all the same. No record was ' +
        'written.',
    );
    expect(
      acceptanceRefusal(
        'DEV-SB',
        { diff: { ...diff, undoCannot: [before] } },
        { acceptAutomation: false, acceptNoUndo: true, acceptRecreate: false },
      ),
    ).toBeUndefined();
  });

  it('refuses automation the rewind’s own writes fire, or that could not all be read, without --accept-automation', () => {
    const fires = automation({ objects: [triggerOn('Account', ['afterUpdate'])] });
    expect(acceptanceRefusal('DEV-SB', { diff, automation: fires }, NOTHING_ACCEPTED)).toEqual({
      code: 'AUTOMATION',
      message:
        'DEV-SB: 1 flow(s), trigger(s) or rule(s) of Account run as the rewind brings records ' +
        'back, gives them their values back or deletes them. Rewind refused; give ' +
        '--accept-automation to rewind all the same. No record was written.',
    });
    const blind = automation({ unread: [{ part: 'flows', reason: 'Tooling API timed out' }] });
    expect(
      acceptanceRefusal('DEV-SB', { diff, automation: blind }, NOTHING_ACCEPTED)?.message,
    ).toContain('what runs as the rewind writes could not all be read');
    for (const found of [fires, blind]) {
      expect(
        acceptanceRefusal(
          'DEV-SB',
          { diff, automation: found },
          { acceptAutomation: true, acceptNoUndo: false, acceptRecreate: false },
        ),
      ).toBeUndefined();
    }
  });

  it('lets through automation the rewind’s writes do not fire: on insert, or on an object it does not write', () => {
    const quiet = automation({
      objects: [triggerOn('Account', ['afterInsert']), triggerOn('Contact', ['afterUpdate'])],
    });
    expect(acceptanceRefusal('DEV-SB', { diff, automation: quiet }, NOTHING_ACCEPTED)).toBe(
      undefined,
    );
    expect(acceptanceRefusal('DEV-SB', { diff }, NOTHING_ACCEPTED)).toBeUndefined();
  });

  it('names the object of what it brings back for a moment among those it brings back and deletes, and refuses without --accept-automation what runs on them', () => {
    const carried = diffOf([
      object({ toBringBack: { inBin: 0, withParent: 0, deletedWhileTaken: 0, carriers: 1 } }),
      object({
        objectApiName: 'Contact',
        toGiveBack: { records: 1, fields: 1, clearedLookups: 0 },
        toBringBack: { inBin: 0, withParent: 1, deletedWhileTaken: 0 },
      }),
    ]);
    expect(rewindStepsOf(carried)).toEqual({
      bringBack: ['Account', 'Contact'],
      recreate: [],
      giveBack: ['Contact'],
      setToDraft: [],
      delete: ['Account'],
    });
    const restore = automation({
      objects: [
        {
          objectApiName: 'Account',
          flows: [],
          triggers: [{ name: 'AccountRestore', events: ['afterUndelete'] }],
        },
      ],
    });
    expect(
      acceptanceRefusal('DEV-SB', { diff: carried, automation: restore }, NOTHING_ACCEPTED)?.code,
    ).toBe('AUTOMATION');
    expect(
      rewindQuestion(
        'DEV-SB',
        { name: 'Before UAT', takenAt: '2026-10-20T14:05:31.000Z' },
        carried,
      ),
    ).toBe(
      "Rewind DEV-SB to 'Before UAT': it deletes the 0 record(s) created since 2026-10-20 14:05 " +
        'UTC, gives 1 record(s) their values from then back, and brings back 1 record(s) from ' +
        'the recycle bin, with 1 record(s) brought back for a moment that had taken records of ' +
        'the checkpoint along, then deleted again — whoever made these changes. What it changes is ' +
        'kept, so it can be undone. Type DEV-SB to rewind it:',
    );
  });

  it('asks the question the page asks, with what the rewind does and the alias to type', () => {
    expect(
      rewindQuestion('DEV-SB', { name: 'Before UAT', takenAt: '2026-10-20T14:05:31.000Z' }, diff),
    ).toBe(
      "Rewind DEV-SB to 'Before UAT': it deletes the 1 record(s) created since 2026-10-20 14:05 " +
        'UTC, gives 2 record(s) their values from then back, and brings back 1 record(s) from ' +
        'the recycle bin — whoever made these changes. What it changes is kept, so it can be ' +
        'undone. Type DEV-SB to rewind it:',
    );
  });
});

/** A rewind's result, with nothing in it unless the patch says so. */
function resultOf(patch: Partial<RewindResult> = {}): RewindResult {
  return {
    checkpointId: 'ck-20261022-160000-cccc',
    rewindId: 'rw-20261022-170000-ffff',
    status: 'success',
    deleted: [],
    restored: [],
    undeleted: [],
    residual: [],
    passes: 1,
    apiRequests: { used: 40, leftToday: 14_860 },
    finishedAt: '2026-10-22T17:01:00.000Z',
    ...patch,
  };
}

const DID: Partial<RewindResult> = {
  deleted: [
    {
      objectApiName: 'Case',
      planned: 2,
      deleted: 1,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 1,
      heldBy: [],
      unchecked: [],
      reasons: ['ENTITY_IS_LOCKED: locked by an approval'],
    },
  ],
  restored: [
    {
      objectApiName: 'Account',
      planned: 3,
      restored: 2,
      keptChanged: 1,
      alreadyGone: 0,
      refused: 0,
      notKept: 0,
      reasons: [],
    },
  ],
  undeleted: [
    {
      objectApiName: 'Account',
      planned: 3,
      undeleted: 2,
      alreadyBack: 1,
      goneForGood: 0,
      refused: 0,
      reasons: [],
    },
  ],
};

describe('rewindLines, undoLines and resultJson', () => {
  const checkpoint = {
    checkpointId: 'ck-20261022-160000-cccc',
    name: 'Before UAT',
    takenAt: '2026-10-20T14:05:31.000Z',
    ignoredFields: ['Case.Last_Touched__c'],
  };

  it('says a rewind that went through, what it did, how long it can be undone and what it sent', () => {
    const lines = rewindLines(
      'DEV-SB',
      checkpoint,
      resultOf({
        ...DID,
        undo: {
          until: '2026-11-06T17:00:00.000Z',
          cannot: [{ objectApiName: 'OpportunityLineItem', count: 3 }],
        },
      }),
    );
    expect(lines).toEqual([
      "DEV-SB is back at 'Before UAT': read again, nothing differs among the objects and fields it holds.",
      '  deleted 1 record(s) created since the checkpoint (in the recycle bin for up to 15 days)',
      '  gave 2 record(s) back their checkpoint values',
      '  brought back 2 record(s) deleted since the checkpoint, with their original Ids, and 1 that came back with them',
      '  undo it until 2026-11-06 17:00 UTC, sooner if the recycle bin fills: undo --org DEV-SB --checkpoint ck-20261022-160000-cccc',
      "  undo couldn't bring back: OpportunityLineItem 3 — Salesforce undeletes them only with their parent",
      '  sent 40 API requests to the org; 14,860 left today',
    ]);
  });

  it('names each journal of an earlier rewind the rewind deleted once it ended, before what it sent, and keeps them in its JSON', () => {
    const removedJournals = [
      {
        checkpointId: 'ck-20261021-090000-bbbb',
        name: 'Baseline',
        rewindId: 'rw-20261021-100000-aaaa',
      },
    ];
    const result = resultOf({ ...DID, removedJournals });
    const lines = rewindLines('DEV-SB', checkpoint, result);

    expect(lines.slice(-2)).toEqual([
      "  removed the journal of rewind rw-20261021-100000-aaaa of 'Baseline': undo reaches the last rewind of the org alone",
      '  sent 40 API requests to the org; 14,860 left today',
    ]);
    expect(
      (resultJson('rewind', 'DEV-SB', checkpoint, result) as { result: RewindResult }).result
        .removedJournals,
    ).toEqual(removedJournals);
  });

  it('says Undo couldn’t bring back, in a line of its own, what the rewind deleted before a record it points at, and gives the reason in its JSON', () => {
    const cannot = [
      { objectApiName: 'OpportunityLineItem', count: 3 },
      { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' as const },
    ];
    const result = resultOf({ ...DID, undo: { until: '2026-11-06T17:00:00.000Z', cannot } });
    const lines = rewindLines('DEV-SB', checkpoint, result);
    expect(lines.filter((line) => line.startsWith("  undo couldn't bring back:"))).toEqual([
      "  undo couldn't bring back: OpportunityLineItem 3 — Salesforce undeletes them only with their parent",
      "  undo couldn't bring back: Case 1 — deleted before a record they point at, which the rewind deleted next: Salesforce cannot bring them back after that",
    ]);
    expect((resultJson('rewind', 'DEV-SB', checkpoint, result) as { undo?: unknown }).undo).toEqual(
      {
        until: '2026-11-06T17:00:00.000Z',
        cannot: [
          { object: 'OpportunityLineItem', count: 3 },
          { object: 'Case', count: 1, reason: 'deletedBeforeParent' },
        ],
      },
    );
  });

  it('names each record that still differs with why, and who changed one during the rewind', () => {
    const names = { '005000000000003AAA': 'Ada Tester' };
    const partial = rewindLines(
      'DEV-SB',
      checkpoint,
      resultOf({
        status: 'partial',
        residual: [
          { objectApiName: 'Case', reason: 'automation', count: 2, ids: [] },
          { objectApiName: 'Case', reason: 'refused', count: 1, ids: [], message: 'Locked' },
          { objectApiName: 'Account', reason: 'goneForGood', count: 1, ids: [] },
          { objectApiName: 'Account', reason: 'changedSincePreview', count: 1, ids: [] },
        ],
        unread: [{ objectApiName: 'Task', reason: 'its read ended early' }],
      }),
      names,
    );
    expect(partial[0]).toBe(
      "DEV-SB is back at 'Before UAT' but for 5 record(s) that still differ, each said with why:",
    );
    expect(partial).toEqual(
      expect.arrayContaining([
        '  Case 2 — kept by your automation, which sets them again on save: rewind --ignore-field <Object.Field> stops comparing such a field',
        '  Case 1 — refused: Locked',
        "  Account 1 — deleted since and no longer in the recycle bin, and not made again (a file, whose body the checkpoint does not hold, or a record deleted while it was taken): they can't come back",
        '  Account 1 — changed since the preview: rewind again to take them',
        '  could not be read again: Task — its read ended early (never taken for unchanged)',
      ]),
    );
    const unstable = rewindLines(
      'DEV-SB',
      checkpoint,
      resultOf({
        status: 'unstable',
        residual: [
          {
            objectApiName: 'Account',
            reason: 'changedDuringRewind',
            by: '005000000000003AAA',
            count: 2,
            ids: [],
          },
        ],
      }),
      names,
    );
    expect(unstable[0]).toBe(
      'Someone kept writing to DEV-SB during the rewind: Ada Tester changed 2 record(s), left as they made them. Rewind again once they have stopped.',
    );
    expect(unstable).toContain(
      '  Account 2 — changed during the rewind by Ada Tester: left as they made them',
    );
    expect(rewindLines('DEV-SB', checkpoint, resultOf({ status: 'cancelled' }))[0]).toBe(
      "Stopped part way: DEV-SB is between 'Before UAT' and now. Rewind again to finish: it takes up from what still differs, and undo still returns DEV-SB to how it was before the rewind.",
    );
  });

  it('says an undo, what it took back, what it kept changed since the rewind, and what the org refused it', () => {
    const lines = undoLines('DEV-SB', checkpoint, resultOf({ ...DID, status: 'partial' }));
    expect(lines).toEqual([
      "DEV-SB is back as it was before its rewind to 'Before UAT', except 2 record(s), each said with why:",
      '  sent back to the recycle bin 1 record(s) the rewind brought back',
      '  brought back 3 record(s) the rewind deleted',
      '  gave 2 record(s) back the values they had before the rewind',
      '  kept 1 record(s) changed since the rewind: undo leaves them as they are now',
      '  Case 1 — refused: ENTITY_IS_LOCKED: locked by an approval',
      '  sent 40 API requests to the org; 14,860 left today',
    ]);
    expect(undoLines('DEV-SB', checkpoint, resultOf())[0]).toBe(
      "DEV-SB is back as it was before its rewind to 'Before UAT'.",
    );
  });

  it('says an undo deleted again what the rewind made again, with what went with it, never that it sent it back (live: two accounts and a contact made again, two contacts gone with their account)', () => {
    const removed = (objectApiName: string, deleted: number, alreadyGone: number) => ({
      objectApiName,
      planned: deleted + alreadyGone,
      deleted,
      alreadyGone,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    });
    const lines = undoLines(
      'DEV-SB',
      checkpoint,
      resultOf({
        deleted: [removed('Account', 2, 0), removed('Contact', 1, 2)],
        remade: [
          { objectApiName: 'Account', count: 2 },
          { objectApiName: 'Contact', count: 3 },
        ],
      }),
    );
    expect(lines).toContain(
      '  deleted again 3 record(s) the rewind made again, with what went with them',
    );
    expect(lines.filter((line) => line.startsWith('  sent back to the recycle bin'))).toEqual([]);
    // Beside a record it brought back: each said in its own words.
    const both = undoLines(
      'DEV-SB',
      checkpoint,
      resultOf({
        deleted: [removed('Account', 3, 0)],
        remade: [{ objectApiName: 'Account', count: 1 }],
      }),
    );
    expect(both).toEqual(
      expect.arrayContaining([
        '  sent back to the recycle bin 2 record(s) the rewind brought back',
        '  deleted again 1 record(s) the rewind made again, with what went with them',
      ]),
    );
  });

  it('says of what the org answered is no longer in the recycle bin, left, what makes it again', () => {
    const lines = rewindLines(
      'DEV-SB',
      checkpoint,
      resultOf({
        status: 'partial',
        residual: [{ objectApiName: 'Account', reason: 'notInBin', count: 2, ids: [] }],
      }),
    );
    expect(lines).toContain(
      '  Account 2 — no longer in the recycle bin — emptied from it, or kept there for good —: Salesforce still lists them as deleted but will not bring them back; --accept-recreate makes them again with new Ids',
    );
  });

  it('answers a rewind’s JSON with each brick’s tally, what Undo can still reach, the verify and the result as the extension gave it', () => {
    const result = resultOf({
      ...DID,
      status: 'partial',
      residual: [
        {
          objectApiName: 'Account',
          reason: 'changedDuringRewind',
          by: '005000000000003AAA',
          count: 1,
          ids: ['001000000000001AAA'],
        },
      ],
      undo: { until: '2026-11-06T17:00:00.000Z', cannot: [] },
    });
    const json = resultJson(
      'rewind',
      'DEV-SB',
      checkpoint,
      result,
      diffOf([object({ cannotUndo: [{ reason: 'goneForGood', count: 2 }] })]),
    );
    expect(json).toEqual({
      checkpoint: {
        id: 'ck-20261022-160000-cccc',
        name: 'Before UAT',
        takenAt: '2026-10-20T14:05:31.000Z',
        org: 'DEV-SB',
      },
      rewindId: 'rw-20261022-170000-ffff',
      status: 'partial',
      deleted: { planned: 2, done: 1, left: 1 },
      givenBack: { planned: 3, done: 2, left: 1 },
      broughtBack: { planned: 3, done: 3, left: 0 },
      recreated: { planned: 0, done: 0, left: 0 },
      cannotUndo: [{ object: 'Account', reason: 'goneForGood', count: 2 }],
      undo: { until: '2026-11-06T17:00:00.000Z', cannot: [] },
      verify: { differences: 1, stable: true, passes: 1, notCompared: ['Case.Last_Touched__c'] },
      residual: [
        { object: 'Account', reason: 'changedDuringRewind', by: '005000000000003AAA', count: 1 },
      ],
      unread: [],
      objects: [
        { object: 'Case', deleted: 1, givenBack: 0, broughtBack: 0, refused: 1 },
        { object: 'Account', deleted: 0, givenBack: 2, broughtBack: 3, refused: 0 },
      ],
      apiRequests: { used: 40, leftToday: 14_860 },
      result,
    });
    const undone = resultJson('undo', 'DEV-SB', checkpoint, resultOf());
    expect(undone).not.toHaveProperty('cannotUndo');
    expect(undone).not.toHaveProperty('undo');
    expect(undone).not.toHaveProperty('recreated');
  });

  it('says, of what a rewind brought back and deleted, what came back for a moment, and lists it in its JSON (P-B1)', () => {
    const carried = {
      deleted: [
        {
          ...DID.deleted![0],
          objectApiName: 'Account',
          planned: 1,
          deleted: 1,
          refused: 0,
          reasons: [],
        },
      ],
      restored: [
        { ...DID.restored![0], objectApiName: 'Contact', planned: 1, restored: 1, keptChanged: 0 },
      ],
      undeleted: [{ ...DID.undeleted![0], planned: 1, undeleted: 1, alreadyBack: 0 }],
      carriers: [{ objectApiName: 'Account', count: 1 }],
      passes: 2,
    };
    const result = resultOf(carried);

    expect(rewindLines('DEV-SB', checkpoint, result)).toEqual([
      "DEV-SB is back at 'Before UAT': read again, nothing differs among the objects and fields it holds.",
      '  deleted 1 record(s) created since the checkpoint (in the recycle bin for up to 15 days)',
      '  gave 1 record(s) back their checkpoint values',
      '  brought back 1 record(s) deleted since the checkpoint, with their original Ids',
      '  of them, brought back for a moment and deleted again: Account 1 — records the checkpoint does not hold that had taken records of it along, back in the recycle bin with what came back with them',
      '  sent 40 API requests to the org; 14,860 left today',
    ]);
    expect(resultJson('rewind', 'DEV-SB', checkpoint, result).carriers).toEqual([
      { object: 'Account', count: 1 },
    ]);
    expect(resultJson('rewind', 'DEV-SB', checkpoint, resultOf())).not.toHaveProperty('carriers');

    const stopped = rewindLines(
      'DEV-SB',
      checkpoint,
      resultOf({ ...carried, status: 'cancelled', deleted: [] }),
    );
    expect(stopped).toContain(
      '  of them, brought back for a moment: Account 1 — records the checkpoint does not hold that had taken records of it along; stopped before it was through, those it had not deleted again yet are still in the org: rewind again deletes them, with what came back with them',
    );
    expect(
      rewindLines('DEV-SB', checkpoint, resultOf({ ...carried, status: 'failure' })).join('\n'),
    ).not.toContain('brought back for a moment');
  });

  it('says what an undo sent back to the recycle bin on its own that had gone there with a record the rewind brought back for a moment, and lists it in its JSON (P-B1)', () => {
    const result = resultOf({
      deleted: [
        {
          ...DID.deleted![0],
          objectApiName: 'Contact',
          planned: 1,
          deleted: 1,
          refused: 0,
          reasons: [],
        },
      ],
      carriedAlone: [{ objectApiName: 'Contact', count: 1 }],
    });

    expect(undoLines('DEV-SB', checkpoint, result)).toEqual([
      "DEV-SB is back as it was before its rewind to 'Before UAT'.",
      '  sent back to the recycle bin 1 record(s) the rewind brought back',
      '  of them, back in the recycle bin on their own: Contact 1 — they had gone there with a record the rewind brought back for a moment, which stays there; they come back alone, under the parent the checkpoint gave them',
      '  sent 40 API requests to the org; 14,860 left today',
    ]);
    expect(resultJson('undo', 'DEV-SB', checkpoint, result).carriedAlone).toEqual([
      { object: 'Contact', count: 1 },
    ]);
    expect(resultJson('undo', 'DEV-SB', checkpoint, result)).not.toHaveProperty('carriers');
  });

  it('says what a rewind made again with new Ids, counts it in its JSON, and names an insert the org refused', () => {
    const result = resultOf({
      ...DID,
      status: 'partial',
      recreated: [
        {
          objectApiName: 'Contact',
          planned: 3,
          created: 2,
          refused: 1,
          reasons: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: A phone is required'],
        },
      ],
    });

    expect(rewindLines('DEV-SB', checkpoint, result)).toContain(
      '  made again 2 record(s) the recycle bin no longer held, with new Ids',
    );
    const json = resultJson('rewind', 'DEV-SB', checkpoint, result);
    expect(json.recreated).toEqual({ planned: 3, done: 2, left: 1 });
    expect(json.objects).toContainEqual({
      object: 'Contact',
      deleted: 0,
      givenBack: 0,
      broughtBack: 0,
      refused: 1,
    });
  });
});

describe('resultExitCode', () => {
  it('ends a rewind or an undo 0 done, 3 partial, 4 unstable, 1 when nothing went through, and with the code of the signal that stopped it', () => {
    expect(resultExitCode('success')).toBe(0);
    expect(resultExitCode('partial')).toBe(3);
    expect(resultExitCode('unstable')).toBe(4);
    expect(resultExitCode('failure')).toBe(1);
    expect(resultExitCode('cancelled', 'SIGINT')).toBe(130);
    expect(resultExitCode('cancelled', 'SIGTERM')).toBe(143);
    expect(resultExitCode('cancelled', 'SIGHUP')).toBe(129);
    // Stopped by nothing this command sent: what it asked was not done.
    expect(resultExitCode('cancelled')).toBe(1);
  });
});
