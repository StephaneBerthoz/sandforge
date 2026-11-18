import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CheckpointListEntry, EnvReplayResource } from '@sandforge/shared';
import { parseArgs as parseCheckpointLine } from '../../sandforge-checkpoint.js';
import { StepAnswerError } from './common.js';
import {
  REPLAY_CHECKPOINT_NOT_FOUND,
  readReplayCheckpoint,
  readReplayDryRun,
  readReplayPreview,
  readReplayRemoval,
  readReplayRun,
  replayApplyLine,
  replayDryRunCount,
  replayDryRunLine,
  replayFileOf,
  replayObjectsOf,
  replayOfSummaryFile,
  replayPreviewLine,
  replayPurgedWhole,
  replayRemoveLine,
  replayRunCount,
  replayRunOfResource,
  replayWritten,
  resolveReplayCheckpoint,
  type EnvReplayRun,
  type ReplayCheckpointPlace,
} from './replay.js';

/*
 * The replay kind: a checkpoint resolved by id from this machine's files,
 * its lines exact — each choice its own flag, a key named by its variable,
 * never by its value —, its fingerprint of what it writes, and its answers
 * read as every kind's are.
 */

const folder = mkdtempSync(join(tmpdir(), 'sandforge-env-replay-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const UAT_BEFORE = '00D000000000001AAA';
const UAT_NOW = '00D000000000002AAA';
const OTHER = '00D000000000003AAA';

/** The org a replay goes into: the sandbox uat, refreshed since its checkpoints were taken. */
const TARGET = {
  alias: 'uat',
  organizationId: UAT_NOW,
  username: 'admin@acme.com.uat',
  instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
};

/** A checkpoint as the store lists it: of an org, named, taken at an hour of the 14th. */
function listed(
  checkpointId: string,
  name: string,
  org: {
    organizationId: string;
    alias?: string;
    username: string;
    instanceUrl: string;
    tier: string;
  },
  hour: number,
  over: Partial<CheckpointListEntry> = {},
): CheckpointListEntry {
  return {
    checkpointId,
    organizationId: org.organizationId,
    checkpoint: {
      checkpointId,
      name,
      org,
      takenAt: `2026-11-14T${String(hour).padStart(2, '0')}:00:00.000Z`,
    },
    valid: false,
    why: 'refreshed',
    ...over,
  } as unknown as CheckpointListEntry;
}

const BEFORE_REFRESH = {
  organizationId: UAT_BEFORE,
  username: 'admin@acme.com.uat',
  instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
  tier: 'sandbox',
};
const ENTRIES = [
  listed('ck-20261114-090000-aaaa', 'uat-before-refresh', BEFORE_REFRESH, 9),
  listed('ck-20261114-170000-bbbb', 'uat-before-refresh', BEFORE_REFRESH, 17),
  // The same name, of another org: never this sandbox's.
  listed(
    'ck-20261114-200000-cccc',
    'uat-before-refresh',
    {
      organizationId: OTHER,
      alias: 'dev',
      username: 'admin@acme.com.dev',
      instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com',
      tier: 'sandbox',
    },
    20,
    { valid: true, why: undefined },
  ),
  // Of the sandbox as it is now: its own checkpoint, which a replay never takes.
  listed(
    'ck-20261115-090000-dddd',
    'uat-before-refresh',
    { ...BEFORE_REFRESH, organizationId: UAT_NOW },
    21,
    { valid: true, why: undefined },
  ),
];

const byName: EnvReplayRun = { checkpoint: { name: 'uat-before-refresh' } };

describe('a replay resource, converted', () => {
  it('runs the checkpoint and the choices of the file, and lists the objects it names', () => {
    const resource: EnvReplayResource = {
      kind: 'replay',
      checkpoint: { name: 'uat-before-refresh' },
      from: 'prod',
      objects: ['Account'],
      excludeObjects: ['Task'],
      owners: 'same',
      mask: false,
      maxRecords: 100,
      accept: { automation: true },
    };
    const converted = replayRunOfResource('test-data', resource);
    if ('refusals' in converted) throw new Error('refused');

    expect(converted.run).toEqual({
      checkpoint: { name: 'uat-before-refresh' },
      from: 'prod',
      objects: ['Account'],
      excludeObjects: ['Task'],
      owners: 'same',
      mask: false,
      maxRecords: 100,
      acceptAutomation: true,
    });
    expect(replayObjectsOf(converted.run)).toEqual([{ object: 'Account' }]);
    expect(replayObjectsOf(byName)).toEqual([]);
  });

  it('refuses a choice the replay refuses, where the file wrote it', () => {
    const resource = {
      kind: 'replay',
      checkpoint: { id: 'ck-20261114-090000-aaaa' },
      excludeObjects: ['1Task'],
    } as EnvReplayResource;

    expect(replayRunOfResource('test-data', resource)).toEqual({
      refusals: [
        expect.objectContaining({
          path: ['resources', 'test-data', 'excludeObjects', 0],
          message: expect.stringMatching(/^refused by the choices a replay takes: /),
        }),
      ],
    });
  });
});

describe('the checkpoint of a replay, resolved', () => {
  it('takes by name the newest of this sandbox before its refresh, by its username or its My Domain, never its own nor another org’s', () => {
    expect(resolveReplayCheckpoint(byName, {}, ENTRIES, TARGET)).toEqual({
      checkpointId: 'ck-20261114-170000-bbbb',
      organizationId: UAT_BEFORE,
      name: 'uat-before-refresh',
      takenAt: '2026-11-14T17:00:00.000Z',
    });
    // Connected as another user, the My Domain host still tells it.
    expect(
      resolveReplayCheckpoint(byName, {}, ENTRIES, { ...TARGET, username: 'ci@acme.com.uat' }),
    ).toMatchObject({ checkpointId: 'ck-20261114-170000-bbbb' });
  });

  it('refuses a name this machine keeps of no sandbox before its refresh, naming where one comes from', () => {
    const scratch = {
      alias: 'C3T',
      organizationId: OTHER.replace('3', '4'),
      username: 'test-x@example.com',
      instanceUrl: 'https://flow-x.scratch.my.salesforce.com',
    };

    expect(resolveReplayCheckpoint(byName, {}, ENTRIES, scratch)).toEqual({
      code: REPLAY_CHECKPOINT_NOT_FOUND,
      refusal:
        "no checkpoint of C3T before its refresh named 'uat-before-refresh' is kept on this " +
        'machine: take one before the next refresh: pnpm exec tsx ' +
        'packages/extension/cli/sandforge-checkpoint.ts take --org C3T --name uat-before-refresh; ' +
        'or name an exported file: checkpoint: { file: …, keyEnv: … }',
    });
  });

  it('takes by name with from the newest of the org its role’s alias names, and by id the one kept', () => {
    expect(
      resolveReplayCheckpoint(
        { checkpoint: { name: 'uat-before-refresh' }, from: 'prod' },
        { from: 'dev' },
        ENTRIES,
        TARGET,
      ),
    ).toMatchObject({ checkpointId: 'ck-20261114-200000-cccc', organizationId: OTHER });
    expect(
      resolveReplayCheckpoint(
        { checkpoint: { id: 'ck-20261114-090000-aaaa' } },
        {},
        ENTRIES,
        TARGET,
      ),
    ).toMatchObject({ checkpointId: 'ck-20261114-090000-aaaa', organizationId: UAT_BEFORE });
    expect(
      resolveReplayCheckpoint(
        { checkpoint: { id: 'ck-20261101-000000-zzzz' } },
        {},
        ENTRIES,
        TARGET,
      ),
    ).toMatchObject({ code: REPLAY_CHECKPOINT_NOT_FOUND });
    // Damaged, or of a take that failed: none to replay.
    const failed = listed('ck-20261114-230000-eeee', 'uat-before-refresh', BEFORE_REFRESH, 23, {
      why: 'failed',
    });
    expect(resolveReplayCheckpoint(byName, {}, [...ENTRIES, failed], TARGET)).toMatchObject({
      checkpointId: 'ck-20261114-170000-bbbb',
    });
    // One id kept under two orgs is not chosen between.
    const twice = listed(
      'ck-20261114-090000-aaaa',
      'x',
      { ...BEFORE_REFRESH, organizationId: OTHER },
      9,
    );
    expect(
      resolveReplayCheckpoint(
        { checkpoint: { id: 'ck-20261114-090000-aaaa' } },
        {},
        [...ENTRIES, twice],
        TARGET,
      ),
    ).toMatchObject({ code: 'AMBIGUOUS' });
  });

  it('reads a checkpoint file’s header without its key, and a store this machine holds none in', async () => {
    const header = {
      checkpointId: 'ck-20261114-170000-bbbb',
      organizationId: UAT_BEFORE,
      takenAt: '2026-11-14T17:00:00.000Z',
    };
    const fromFile: EnvReplayRun = {
      checkpoint: { file: '/runner/uat.sfcheckpoint', keyEnv: 'UAT_CHECKPOINT_KEY' },
    };
    const asked: string[] = [];
    type HeaderRead = Awaited<ReturnType<NonNullable<ReplayCheckpointPlace['readHeader']>>>;
    const where: ReplayCheckpointPlace = {
      storeRoot: join(folder, 'no-store'),
      readHeader: (file: string) => {
        asked.push(file);
        return Promise.resolve({
          read: { header, headerBytes: 1, headerHash: Buffer.alloc(0), size: 1 },
        } as unknown as HeaderRead);
      },
    };

    expect(
      await readReplayCheckpoint(fromFile, { file: '/runner/uat.sfcheckpoint' }, TARGET, where),
    ).toEqual(header);
    expect(asked).toEqual(['/runner/uat.sfcheckpoint']);
    expect(await readReplayCheckpoint(fromFile, {}, TARGET, where)).toMatchObject({
      code: REPLAY_CHECKPOINT_NOT_FOUND,
    });
    // No store on this machine: nothing kept, nothing to replay by name.
    expect(await readReplayCheckpoint(byName, {}, TARGET, where)).toMatchObject({
      code: REPLAY_CHECKPOINT_NOT_FOUND,
    });
  });

  it('reads a checkpoint file’s path from the file or its variable, from the root', () => {
    expect(replayFileOf('test-data', '/runner/uat.sfcheckpoint', {})).toEqual({
      file: '/runner/uat.sfcheckpoint',
    });
    expect(
      replayFileOf('test-data', { env: 'UAT_FILE' }, { UAT_FILE: ' /w/uat.sfcheckpoint ' }),
    ).toEqual({
      file: '/w/uat.sfcheckpoint',
    });
    expect(replayFileOf('test-data', { env: 'UAT_FILE' }, {})).toEqual({
      refusal: expect.objectContaining({
        path: ['resources', 'test-data', 'checkpoint', 'file'],
        message:
          "the variable UAT_FILE is not set: set it in the job's environment to the path of the " +
          'checkpoint file test-data replays',
      }),
    });
    expect(
      replayFileOf('test-data', { env: 'UAT_FILE' }, { UAT_FILE: 'uat.sfcheckpoint' }),
    ).toEqual({
      refusal: expect.objectContaining({
        message:
          'the variable UAT_FILE holds uat.sfcheckpoint, which is not a path from the root: give ' +
          'the checkpoint file from the root',
      }),
    });
  });

  it('fingerprints the checkpoint by the id and the org it resolved to, unread by what names it', () => {
    const read = { checkpointId: 'ck-20261114-170000-bbbb', organizationId: UAT_BEFORE };

    expect(replayWritten(byName, read)).toEqual({
      kind: 'replay',
      kindVersion: 1,
      checkpoint: { id: 'ck-20261114-170000-bbbb', organizationId: UAT_BEFORE.slice(0, 15) },
      owners: 'same',
      customSettings: false,
      mask: false,
      contactPoints: 'neutralized',
      objects: null,
      excludeObjects: null,
    });
    expect(replayWritten(byName, undefined)).toMatchObject({
      checkpoint: { unread: { name: 'uat-before-refresh', from: null } },
    });
    expect(replayWritten(byName, { code: 'X', refusal: 'none' })).toMatchObject({
      checkpoint: { unread: { name: 'uat-before-refresh', from: null } },
    });
    expect(replayWritten({ checkpoint: { file: '/a', keyEnv: 'K' } }, undefined)).toMatchObject({
      checkpoint: { unread: 'file' },
    });
  });
});

describe('the lines of a replay resource', () => {
  const RESOLVED = { checkpointId: 'ck-20261114-170000-bbbb', organizationId: UAT_BEFORE };
  const line = {
    name: 'test-data',
    run: byName,
    place: { read: RESOLVED },
    target: 'uat',
    store: '/journal/checkpoints',
  };

  it('dry-runs and runs the checkpoint the plan resolved, a replace replaying again', () => {
    expect(replayDryRunLine({ ...line, again: false })).toEqual([
      'replay',
      '--checkpoint',
      'ck-20261114-170000-bbbb',
      '--from',
      UAT_BEFORE,
      '--target',
      'uat',
      '--store',
      '/journal/checkpoints',
      '--dry-run',
      '--json',
    ]);
    expect(
      replayApplyLine({ ...line, again: true, acceptAutomation: true, maxRecords: 252 }),
    ).toEqual([
      'replay',
      '--checkpoint',
      'ck-20261114-170000-bbbb',
      '--from',
      UAT_BEFORE,
      '--target',
      'uat',
      '--store',
      '/journal/checkpoints',
      '--again',
      '--accept-automation',
      '--max-records',
      '252',
      '--yes',
      '--json',
    ]);
    expect(() => replayApplyLine({ ...line, again: false, maxRecords: 0 })).toThrow(
      'test-data has no count from its dry run to be held to: plan again.',
    );
    expect(() =>
      replayDryRunLine({
        ...line,
        run: { checkpoint: { file: '/a', keyEnv: 'K' } },
        place: {},
        again: false,
      }),
    ).toThrow('test-data names a checkpoint file that was not resolved: plan again.');
  });

  it('writes lines sandforge checkpoint replay reads as they are meant: the checkpoint, the store, each choice, the bound', () => {
    const parse = (args: string[]) =>
      parseCheckpointLine(['node', 'sandforge-checkpoint.ts', ...args]);
    const everyChoice: EnvReplayRun = {
      ...byName,
      objects: ['Account', 'Contact', 'Case'],
      excludeObjects: ['Task', 'Event'],
      owners: 'me',
      customSettings: true,
      mask: true,
      keepContactPoints: true,
      maxRecords: 500,
    };

    expect(
      parse(
        replayApplyLine({
          ...line,
          run: everyChoice,
          again: true,
          acceptAutomation: true,
          maxRecords: 252,
        }),
      ),
    ).toMatchObject({
      command: 'replay',
      // parseArgs resolves the store: a drive letter in front of it on Windows.
      storeRoot: resolve('/journal/checkpoints'),
      storeNamed: true,
      json: true,
      replay: {
        action: 'replay',
        checkpoint: 'ck-20261114-170000-bbbb',
        from: UAT_BEFORE,
        target: 'uat',
        choices: {
          owners: 'me',
          customSettings: true,
          mask: true,
          contactPoints: 'kept',
          objects: ['Account', 'Contact', 'Case'],
          excluded: ['Task', 'Event'],
          link: [],
        },
        again: true,
        acceptAutomation: true,
        maxRecords: 252,
        yes: true,
      },
    });
    expect(parse(replayDryRunLine({ ...line, run: everyChoice, again: false }))).toMatchObject({
      replay: { action: 'dryRun', again: false, maxRecords: 500, yes: false },
    });
    expect(
      parse(
        replayDryRunLine({
          ...line,
          run: { checkpoint: { file: '/runner/uat.sfcheckpoint', keyEnv: 'UAT_CHECKPOINT_KEY' } },
          place: { file: '/runner/uat.sfcheckpoint' },
          again: false,
        }),
      ),
    ).toMatchObject({
      replay: { file: '/runner/uat.sfcheckpoint', keyEnv: 'UAT_CHECKPOINT_KEY' },
    });
    const removal = { replayed: RESOLVED, target: 'uat', store: '/journal/checkpoints' };
    expect(
      parse(
        replayRemoveLine({ ...removal, includeChanged: true, sweep: true, acceptAutomation: true }),
      ),
    ).toMatchObject({
      replay: {
        action: 'remove',
        checkpoint: 'ck-20261114-170000-bbbb',
        from: UAT_BEFORE,
        includeChanged: true,
        sweep: true,
        acceptAutomation: true,
        yes: true,
        preview: false,
      },
    });
    expect(parse(replayPreviewLine(removal))).toMatchObject({
      replay: { action: 'remove', preview: true, yes: false },
    });
  });

  it('takes a replay back, or previews it, by the checkpoint it wrote from, never by a file', () => {
    const removal = {
      replayed: RESOLVED,
      target: 'uat',
      store: '/journal/checkpoints',
    };
    const base = [
      'replay',
      '--checkpoint',
      'ck-20261114-170000-bbbb',
      '--from',
      UAT_BEFORE,
      '--target',
      'uat',
      '--store',
      '/journal/checkpoints',
      '--remove',
    ];

    expect(replayRemoveLine(removal)).toEqual([...base, '--yes', '--json']);
    expect(replayPreviewLine({ ...removal, sweep: true, acceptAutomation: true })).toEqual([
      ...base,
      '--preview',
      '--sweep',
      '--accept-automation',
      '--json',
    ]);
  });

  it('reads the checkpoint a run wrote from out of the answer kept as its summary', () => {
    const kept = join(folder, 'test-data.1.summary.json');
    writeFileSync(
      kept,
      JSON.stringify({
        command: 'replay',
        checkpoint: { id: 'ck-20261114-170000-bbbb', organizationId: UAT_BEFORE, name: 'x' },
        exit: 0,
      }),
    );
    expect(replayOfSummaryFile(kept)).toEqual(RESOLVED);
    const other = join(folder, 'seed.summary.json');
    writeFileSync(other, JSON.stringify({ tool: 'sandforge-seed' }));
    expect(() => replayOfSummaryFile(other)).toThrow(
      `${other} names no checkpoint a replay wrote from: the replay it is the summary of cannot ` +
        'be taken back from it.',
    );
    mkdirSync(join(folder, 'a-folder'));
    expect(() => replayOfSummaryFile(join(folder, 'a-folder'))).toThrow('names no checkpoint');
  });
});

describe('what the replay answers', () => {
  const base = {
    command: 'replay',
    checkpoint: { id: 'ck-20261114-170000-bbbb', organizationId: UAT_BEFORE },
    target: { alias: 'uat' },
    exit: 0,
  };
  const dryObject = (objectApiName: string, toInsert: number) => ({
    objectApiName,
    fromFiles: toInsert,
    toInsert,
    toLink: 0,
    notSent: 0,
    toPurge: 0,
    toDeactivate: 0,
  });

  it('counts a dry run, the emails its gate counted, and what it leaves out without refusing', () => {
    const answer = readReplayDryRun(
      JSON.stringify({
        ...base,
        action: 'dryRun',
        objects: [dryObject('Account', 40), dryObject('Contact', 212)],
        plan: {
          emails: {
            counted: [
              { limit: 'SingleEmail', emails: 3 },
              { limit: 'X', emails: 1 },
            ],
          },
        },
        replay: {
          records: { toCreate: 252 },
          owners: { kept: 18, toRunningUser: 4 },
          filesLeft: [{ objectApiName: 'ContentVersion', name: 'a.pdf' }],
          requests: 5,
        },
      }),
    );
    const count = replayDryRunCount(answer);

    expect(answer.tool).toBe('sandforge-checkpoint');
    expect(count).toMatchObject({
      objects: [
        { object: 'Account', wouldCreate: 40 },
        { object: 'Contact', wouldCreate: 212 },
      ],
      total: 252,
      created: 252,
      emails: [{ limit: 'SingleEmail', emails: 3 }],
      notes: [
        '1 file(s) of the checkpoint are not replayed: a checkpoint keeps no file’s content',
        '4 record(s) go to the user connected: their owner is not an active user of the org',
      ],
    });
    expect(count.storageBytes).toBeGreaterThan(0);
    expect(count.refusal).toBeUndefined();
  });

  /**
   * As a real dry run answered: its reads of the org took 27 requests, its
   * gate counted 40 with them, and it refused 4 accounts in a currency the
   * org had not activated before anything was written, the 113 others to
   * create. The plan said "Account 113 to write", "0 blocked", nothing of
   * the 4, and that the script estimated no request.
   */
  const refusing = {
    ...base,
    action: 'dryRun',
    objects: [dryObject('Account', 113)],
    plan: { apiRequests: { verdict: 'fits', estimate: 40, remaining: 4_961_845, max: 5_000_000 } },
    replay: {
      records: { toCreate: 113, linkedById: 0, linkedByKey: 0, refusedBeforeWrite: 10 },
      owners: { kept: 0, toRunningUser: 0 },
      filesLeft: [],
      requests: 27,
      refused: [
        {
          object: 'Account',
          records: 4,
          reason: 'inactiveCurrency',
          path: 'activate GBP in uat, or leave Account out',
        },
        {
          object: 'Contact',
          records: 6,
          reason: 'parentRefused',
          path: 'its Account is refused: lift that first',
        },
      ],
    },
  };

  it('counts the API requests its dry run estimates, its reads of the org among them', () => {
    expect(replayDryRunCount(readReplayDryRun(JSON.stringify(refusing))).apiRequests).toBe(40);
    // A dry run that gave no estimate is one the plan says it does not count.
    expect(
      replayDryRunCount(
        readReplayDryRun(
          JSON.stringify({ ...base, action: 'dryRun', objects: [dryObject('Account', 1)] }),
        ),
      ).apiRequests,
    ).toBeUndefined();
  });

  it('names per object the records it refuses before anything is written, with its way out, and that a run of the others ends partial', () => {
    const count = replayDryRunCount(readReplayDryRun(JSON.stringify(refusing)));

    expect(count.refusal).toBeUndefined();
    expect(count.objects).toEqual([{ object: 'Account', wouldCreate: 113 }]);
    expect(count.notes).toEqual([
      'Account: 4 record(s) refused before anything is written, which leave a run partial — ' +
        'their currency is not active in the other org: activate GBP in uat, or leave Account out',
      'Contact: 6 record(s) refused before anything is written, which leave a run partial — a ' +
        'parent of theirs is refused, and no orphan is written: its Account is refused: lift ' +
        'that first',
    ]);
  });

  it('refuses a dry run that creates nothing, says nothing, or is refused, in the replay’s own words and codes', () => {
    const read = (over: Record<string, unknown>) =>
      replayDryRunCount(readReplayDryRun(JSON.stringify({ ...base, action: 'dryRun', ...over })));

    expect(read({ objects: [dryObject('Account', 0)] }).refusal).toBe(
      'it would create nothing: every record of the checkpoint is one the org holds already, ' +
        'linked, or one the replay leaves out',
    );
    expect(read({}).refusal).toBe(
      'the replay never came to say what it would create, and a run held to no count is held to ' +
        'nothing',
    );
    expect(
      read({
        objects: [dryObject('Account', 2)],
        refused: { code: 'REPLAY_REAL_DATA', message: 'it goes across masked only' },
        refusals: ['Account: a flow runs'],
        refusalCodes: ['AUTOMATION_NOT_ACCEPTED'],
      }),
    ).toMatchObject({
      refusal: 'it goes across masked only Account: a flow runs',
      refusalCodes: ['REPLAY_REAL_DATA', 'AUTOMATION_NOT_ACCEPTED'],
    });
    expect(() => readReplayDryRun(JSON.stringify({ ...base, action: 'replay' }))).toThrow(
      StepAnswerError,
    );
  });

  it('counts a run, and tells whether a replay again purged those before it whole', () => {
    const run = readReplayRun(
      JSON.stringify({
        ...base,
        action: 'replay',
        objects: [{ objectApiName: 'Contact', fromFiles: 212, inserted: 210, failed: 2 }],
        result: { purge: { failures: [], leftUnrecorded: {} } },
      }),
    );

    expect(replayRunCount(run)).toEqual({
      objects: [{ object: 'Contact', created: 210, refused: 2, errors: ['2 refused by the org'] }],
      created: 210,
    });
    expect(replayPurgedWhole(run)).toBe(true);
    expect(replayPurgedWhole({ ...run, result: { purge: { failures: [{}] } } })).toBe(false);
    expect(replayPurgedWhole({ ...run, result: {} })).toBe(false);
    expect(
      replayRunCount({ ...run, objects: undefined, refused: { code: 'X', message: 'refused' } }),
    ).toEqual({ objects: [], created: 0, refusal: 'refused' });
  });

  it('counts per object the records a run refused before anything is written, with its way out, beside those the org refused', () => {
    const run = readReplayRun(
      JSON.stringify({
        ...base,
        exit: 3,
        action: 'replay',
        objects: [{ objectApiName: 'Account', fromFiles: 113, inserted: 112, failed: 1 }],
        replay: refusing.replay,
      }),
    );

    expect(replayRunCount(run)).toEqual({
      objects: [
        {
          object: 'Account',
          created: 112,
          refused: 5,
          errors: [
            '1 refused by the org',
            '4 refused before anything is written — their currency is not active in the other ' +
              'org: activate GBP in uat, or leave Account out',
          ],
        },
        // Every record of it refused: the load counted none of it to write.
        {
          object: 'Contact',
          created: 0,
          refused: 6,
          errors: [
            '6 refused before anything is written — a parent of theirs is refused, and no ' +
              'orphan is written: its Account is refused: lift that first',
          ],
        },
      ],
      created: 112,
    });
  });

  it('reads a preview of its removal, nothing to take when it took all already', () => {
    expect(
      readReplayPreview(
        JSON.stringify({
          ...base,
          action: 'remove',
          refused: { code: 'ALREADY_REMOVED', message: 'removed on 2026-11-19' },
        }),
      ),
    ).toEqual({
      tool: 'sandforge-checkpoint',
      preview: { planned: 0, objects: [], userNames: {} },
      refusals: [],
      removalAlone: [],
    });
    expect(
      readReplayPreview(
        JSON.stringify({
          ...base,
          action: 'remove',
          preview: true,
          objects: [],
          refusals: ['uat runs a flow as contacts are deleted'],
          refusalCodes: ['AUTOMATION_NOT_ACCEPTED'],
        }),
      ),
    ).toMatchObject({
      refusals: ['uat runs a flow as contacts are deleted'],
      refusalCodes: ['AUTOMATION_NOT_ACCEPTED'],
    });
    expect(() =>
      readReplayPreview(
        JSON.stringify({ ...base, action: 'remove', objects: [{ objectApiName: 'Contact' }] }),
      ),
    ).toThrow(StepAnswerError);
  });

  it('reads a removal, nothing taken when there was nothing left, a refusal never read as one', () => {
    expect(
      readReplayRemoval(
        JSON.stringify({
          ...base,
          action: 'remove',
          refused: { code: 'NO_LOAD', message: 'no replay' },
        }),
      ),
    ).toEqual({
      tool: 'sandforge-checkpoint',
      result: { status: 'success', planned: 0, objects: [] },
    });
    expect(() =>
      readReplayRemoval(
        JSON.stringify({
          ...base,
          action: 'remove',
          refused: { code: 'AUTOMATION_NOT_ACCEPTED', message: 'a flow runs' },
        }),
      ),
    ).toThrow('the removal was refused: a flow runs');
    expect(() =>
      readReplayRemoval(
        JSON.stringify({ ...base, action: 'remove', removal: { status: 'odd', objects: [] } }),
      ),
    ).toThrow(StepAnswerError);
  });
});
