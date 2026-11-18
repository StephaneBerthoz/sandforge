import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvUsersResource, UsersApplyAnswer } from '@sandforge/shared';
import { parseArgs as parseUsersLine } from '../../sandforge-users.js';
import { StepAnswerError } from './common.js';
import {
  USERS_SCRIPT,
  changeWords,
  readUsersApply,
  readUsersPlan,
  readUsersRemoval,
  usersApplyLine,
  usersConfigOf,
  usersDriftWhy,
  usersDryRunCount,
  usersDryRunLine,
  usersHeldOf,
  usersKeptWhy,
  usersObjectsOf,
  usersRemoveLine,
  usersRunCount,
  usersRunNumberOf,
  usersRunOfResource,
  usersRunOfSummaryFile,
  usersSetUpOf,
  usersWritten,
} from './users.js';

/*
 * The users kind: the file's users given to `sandforge users` as they are
 * written, fingerprinted by what they set up, its lines exact, and its
 * answers read with the contract's own schemas — never an address, and no
 * removal of an address asked back.
 */

const folder = mkdtempSync(join(tmpdir(), 'sandforge-env-users-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const resource: EnvUsersResource = {
  kind: 'users',
  defaults: { email: 'restore', frozen: false },
  users: [
    { username: 'jane.qa@acme.com', permissionSets: ['QA_Tools'], groups: ['QA_Team'] },
    { username: 'paul.qa@acme.com', active: true, profile: 'QA Tester' },
  ],
};

const ORG = {
  organizationId: '00D000000000002AAA',
  kind: 'sandbox',
  alias: 'TGT',
  username: 'admin@acme.com.uat',
};
const JANE = '005000000000001AAA';
const PAUL = '005000000000002AAA';

/** A plan's answer, as the script prints it with --json. */
function planOf(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    org: ORG,
    users: [
      {
        username: 'jane.qa@acme.com.uat',
        given: 'jane.qa@acme.com',
        userId: JANE,
        address: 'invalid',
        changes: [
          { what: 'frozen', from: true, to: false },
          { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
          { what: 'email', to: 'awaiting' },
        ],
        emailsToPeople: 1,
      },
      { username: 'paul.qa@acme.com.uat', userId: PAUL, changes: [] },
    ],
    licenses: [{ name: 'Salesforce Platform', total: 10, used: 7, toUse: 1 }],
    emailsToPeople: 1,
    apiRequests: 8,
    ...over,
  });
}

/** A run's answer, as the script prints it with --json. */
function applied(over: Partial<UsersApplyAnswer> = {}): UsersApplyAnswer {
  return {
    org: { ...ORG, kind: 'sandbox' },
    run: 3,
    status: 'success',
    users: [
      {
        username: 'jane.qa@acme.com.uat',
        userId: JANE,
        before: { isActive: true, isFrozen: true, profileId: '00e000000000001AAA' },
        done: [
          { what: 'frozen', from: true, to: false },
          { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
          { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
        ],
        created: {
          permissionSetAssignments: ['0Pa000000000001AAA'],
          groupMembers: ['011000000000001AAA'],
        },
        address: 'awaiting',
      },
    ],
    emailsToPeople: 1,
    apiRequests: 9,
    ...over,
  };
}

describe('a users resource, converted', () => {
  it('runs the file’s users and defaults as written, with what the file accepts of what fires as they are written', () => {
    expect(usersRunOfResource(resource)).toEqual({
      run: { defaults: resource.defaults, users: resource.users },
      warnings: [],
    });
    const accepting = usersRunOfResource({ ...resource, accept: { automation: true } });
    expect(accepting.run.acceptAutomation).toBe(true);
    expect(usersObjectsOf(accepting.run)).toEqual([{ object: 'User', count: 2 }]);
    // The config holds the users alone: an acceptance is the line's flag.
    expect(usersConfigOf(accepting.run)).toEqual({
      defaults: resource.defaults,
      users: resource.users,
    });
    // What it accepts changes no user: the same fingerprint.
    expect(usersWritten(accepting.run)).toEqual(usersWritten(usersRunOfResource(resource).run));
  });

  it('fingerprints each user with its defaults, the usernames and the names whatever their case, and an address kept as one not named', () => {
    expect(usersWritten(usersRunOfResource(resource).run)).toEqual({
      kind: 'users',
      kindVersion: 1,
      users: [
        {
          username: 'jane.qa@acme.com',
          email: 'restore',
          active: null,
          frozen: false,
          profile: null,
          permissionSets: ['qa_tools'],
          permissionSetGroups: null,
          groups: ['qa_team'],
        },
        {
          username: 'paul.qa@acme.com',
          email: 'restore',
          active: true,
          frozen: false,
          profile: 'QA Tester',
          permissionSets: null,
          permissionSetGroups: null,
          groups: null,
        },
      ],
    });
    expect(usersWritten({ users: [{ username: 'A@x.io', email: 'keep', groups: [] }] })).toEqual(
      usersWritten({ users: [{ username: 'a@x.io' }] }),
    );
    // A user's own key replaces the defaults' whole, a list included.
    expect(
      usersWritten({
        defaults: { permissionSets: ['QA_Tools'] },
        users: [{ username: 'a@x.io', permissionSets: ['Other'] }],
      }),
    ).toMatchObject({ users: [{ permissionSets: ['other'] }] });
  });
});

describe('the lines of a users resource', () => {
  it('plans and runs with the config, the run it converges from and the emails the line accepts', () => {
    const line = { target: 'TGT', configFile: '/tmp/testers.json' };

    expect(usersDryRunLine(line)).toEqual([
      'plan',
      '--org',
      'TGT',
      '--config',
      '/tmp/testers.json',
      '--json',
    ]);
    expect(
      usersApplyLine({ ...line, replacesRun: 12, acceptUserEmails: true, acceptAutomation: true }),
    ).toEqual([
      'apply',
      '--org',
      'TGT',
      '--config',
      '/tmp/testers.json',
      '--replaces',
      '12',
      '--accept-user-emails',
      '--accept-automation',
      '--yes',
      '--json',
    ]);
    expect(() => usersDryRunLine({ ...line, target: '-o' })).toThrow(
      '--org cannot be "-o": a value that starts with "-" reads as a flag.',
    );
    expect(() => usersApplyLine({ ...line, replacesRun: 1.5 })).toThrow(
      '--replaces takes the number of a run of sandforge users, not 1.5.',
    );
  });

  it('writes lines sandforge users reads as they are meant: the verb, the org, the config, the run replaced, each acceptance', () => {
    const line = { target: 'TGT', configFile: '/tmp/testers.json' };

    expect(
      parseUsersLine(
        usersApplyLine({
          ...line,
          replacesRun: 12,
          acceptUserEmails: true,
          acceptAutomation: true,
        }),
      ),
    ).toEqual({
      verb: 'apply',
      org: 'TGT',
      config: '/tmp/testers.json',
      replaces: 12,
      dryRun: false,
      yes: true,
      json: true,
      acceptUserEmails: true,
      acceptEmails: false,
      acceptAutomation: true,
      includeChanged: false,
    });
    expect(parseUsersLine(usersDryRunLine(line))).toMatchObject({
      verb: 'plan',
      org: 'TGT',
      config: '/tmp/testers.json',
      yes: false,
      json: true,
      acceptUserEmails: false,
    });
    expect(
      parseUsersLine(
        usersRemoveLine({ target: 'TGT', run: 3, includeChanged: true, acceptAutomation: true }),
      ),
    ).toMatchObject({
      verb: 'remove',
      org: 'TGT',
      run: 3,
      yes: true,
      json: true,
      includeChanged: true,
      acceptAutomation: true,
    });
  });

  it('takes a run back by its number, a profile changed since only with --include-changed', () => {
    expect(usersRemoveLine({ target: 'TGT', run: 3 })).toEqual([
      'remove',
      '--org',
      'TGT',
      '--run',
      '3',
      '--yes',
      '--json',
    ]);
    expect(
      usersRemoveLine({ target: 'TGT', run: 3, includeChanged: true, acceptAutomation: true }),
    ).toEqual([
      'remove',
      '--org',
      'TGT',
      '--run',
      '3',
      '--include-changed',
      '--accept-automation',
      '--yes',
      '--json',
    ]);
    expect(() => usersRemoveLine({ target: 'TGT', run: 1_000_000 })).toThrow(
      '--run takes the number of a run of sandforge users, not 1000000.',
    );
  });

  it('reads the number of a run from the answer kept as its summary, or says it cannot', () => {
    expect(usersRunNumberOf(JSON.stringify(applied()))).toBe(3);
    expect(usersRunNumberOf('{"run":0}')).toBeUndefined();
    expect(usersRunNumberOf('not json')).toBeUndefined();
    const kept = join(folder, 'testers.1.summary.json');
    writeFileSync(kept, JSON.stringify(applied()));
    expect(usersRunOfSummaryFile(kept)).toBe(3);
    expect(() => usersRunOfSummaryFile(join(folder, 'none.json'))).toThrow(
      /none\.json cannot be read \(.*\): the run of sandforge users it names cannot be taken back from it\./,
    );
  });
});

describe('what the script answers', () => {
  it('reads a plan with the contract’s schema, told apart as the users script’s, and refuses an answer it does not hold', () => {
    expect(readUsersPlan(planOf())).toMatchObject({ tool: USERS_SCRIPT, emailsToPeople: 1 });
    // The contract holds no address: one in the answer refuses it.
    expect(() =>
      readUsersPlan(planOf({ users: [{ username: 'a@x.io', changes: [], email: 'a@x.io' }] })),
    ).toThrow(StepAnswerError);
  });

  it('counts the users a run would change, the requests, the emails to people and the licenses taken', () => {
    expect(usersDryRunCount(readUsersPlan(planOf()))).toEqual({
      objects: [{ object: 'User', wouldCreate: 1 }],
      total: 1,
      created: 0,
      apiRequests: 8,
      storageBytes: 0,
      emails: [],
      emailsToPeople: 1,
      notes: [
        'Salesforce Platform: 7 of 10 used, 1 more taken by the activations and the profiles',
      ],
    });
    const refused = usersDryRunCount(
      readUsersPlan(
        planOf({
          refusals: [
            {
              code: 'USERS_EMAILS_NOT_ACCEPTED',
              message: 'Salesforce would email 1 person: --accept-user-emails',
            },
            {
              code: 'USERS_NO_USER',
              message: 'no user is ghost@acme.com',
              username: 'ghost@acme.com',
            },
          ],
        }),
      ),
    );
    expect(refused.refusal).toBe(
      'Salesforce would email 1 person: --accept-user-emails no user is ghost@acme.com',
    );
    expect(refused.refusalCodes).toEqual(['USERS_EMAILS_NOT_ACCEPTED', 'USERS_NO_USER']);
  });

  it('keeps an applied resource whose users the org holds as the last run left them, and says drift for a user changed since', () => {
    const asLeft = readUsersPlan(
      planOf({
        users: [
          { username: 'jane.qa@acme.com.uat', userId: JANE, address: 'awaiting', changes: [] },
          { username: 'paul.qa@acme.com.uat', userId: PAUL, changes: [] },
        ],
        emailsToPeople: 0,
      }),
    );
    expect(usersHeldOf(asLeft)).toEqual({ objects: [{ object: 'User', present: 2 }], users: 2 });
    expect(usersKeptWhy(2)).toBe(
      'applied, and the org holds its 2 user(s) as the last run left them',
    );

    const moved = usersHeldOf(readUsersPlan(planOf()));
    expect(moved).toEqual({
      objects: [{ object: 'User', present: 1 }],
      users: 1,
      drift:
        'jane.qa@acme.com.uat would be unfrozen, permission set QA_Tools added, address asked ' +
        'back, awaiting its owner’s confirmation',
    });
    expect(usersDriftWhy('testers', moved.drift ?? '')).toBe(
      `its users changed since it was applied: ${moved.drift}. Left as they are: --replace ` +
        'testers or --replace-drifted sets them up again, converging from what the last run left',
    );
    expect(
      usersHeldOf(
        readUsersPlan(
          planOf({ refusals: [{ code: 'USERS_NO_RIGHT', message: 'no Manage Users' }] }),
        ),
      ),
    ).toEqual({ objects: [], users: 0, unread: 'no Manage Users' });
  });

  it('says every change in the words of a line', () => {
    expect(
      [
        { what: 'active', from: false, to: true },
        { what: 'active', from: true, to: false },
        { what: 'frozen', from: false, to: true },
        { what: 'profile', from: 'Standard User', to: 'QA Tester' },
        { what: 'permissionSet', name: 'QA_Tools', to: 'removed' },
        { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'added' },
        { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'removed' },
        { what: 'group', name: 'QA_Queue', type: 'Queue', to: 'removed' },
      ].map((change) => changeWords(change as Parameters<typeof changeWords>[0])),
    ).toEqual([
      'activated',
      'deactivated',
      'frozen',
      'profile QA Tester in place of Standard User',
      'permission set QA_Tools taken back',
      'permission set group Support_Bundle added',
      'permission set group Support_Bundle taken back',
      'queue QA_Queue left',
    ]);
  });

  it('reads a run as every kind’s run is: no user created, the accesses it created, each user the org refused named', () => {
    const answer = readUsersApply(JSON.stringify(applied()));
    expect(usersRunCount(answer)).toEqual({
      objects: [
        { object: 'User', created: 0, refused: 0, errors: [] },
        { object: 'PermissionSetAssignment', created: 1, refused: 0, errors: [] },
        { object: 'GroupMember', created: 1, refused: 0, errors: [] },
      ],
      created: 2,
    });
    expect(usersSetUpOf(answer)).toEqual([{ username: 'jane.qa@acme.com.uat', userId: JANE }]);

    const partial = applied({
      status: 'partial',
      users: [
        {
          ...applied().users[0]!,
          done: [],
          created: { permissionSetAssignments: [], groupMembers: [] },
          refused: [
            {
              change: { what: 'active', from: false, to: true },
              code: 'LICENSE_LIMIT_EXCEEDED',
              message: 'License Limit Exceeded',
            },
          ],
        },
      ],
    });
    expect(usersRunCount(partial).objects).toEqual([
      {
        object: 'User',
        created: 0,
        refused: 1,
        errors: [
          'jane.qa@acme.com.uat: activated refused, LICENSE_LIMIT_EXCEEDED: License Limit Exceeded',
        ],
      },
    ]);
    // Refused before its first write: why, in the script's words.
    expect(
      usersRunCount(
        applied({
          status: 'failure',
          users: [],
          refusals: [{ code: 'USERS_LICENSE', message: 'Salesforce Platform: 10 of 10 used' }],
        }),
      ),
    ).toEqual({
      objects: [{ object: 'User', created: 0, refused: 0, errors: [] }],
      created: 0,
      refusal: 'Salesforce Platform: 10 of 10 used',
    });
  });

  it('reads a removal as every kind’s is: the accesses deleted by id, what it kept and why', () => {
    const removed = readUsersRemoval(
      JSON.stringify({
        org: ORG,
        run: 3,
        status: 'partial',
        users: [
          {
            username: 'jane.qa@acme.com.uat',
            userId: JANE,
            undone: [
              { what: 'group', name: 'QA_Team', type: 'Regular', to: 'removed' },
              { what: 'frozen', from: false, to: true },
            ],
            kept: [
              {
                change: { what: 'permissionSet', name: 'QA_Tools', to: 'removed' },
                why: 'the org refused it: INSUFFICIENT_ACCESS',
              },
            ],
          },
        ],
        apiRequests: 5,
      }),
    );

    expect(removed.result).toEqual({
      status: 'partial',
      planned: 2,
      objects: [
        {
          objectApiName: 'GroupMember',
          planned: 1,
          deleted: 1,
          alreadyGone: 0,
          keptChanged: 0,
          keptDependents: 0,
          refused: 0,
          heldBy: [],
          reasons: [],
        },
        {
          objectApiName: 'PermissionSetAssignment',
          planned: 1,
          deleted: 0,
          alreadyGone: 0,
          keptChanged: 0,
          keptDependents: 0,
          refused: 1,
          heldBy: [],
          reasons: [
            'jane.qa@acme.com.uat: permission set QA_Tools taken back: the org refused it: ' +
              'INSUFFICIENT_ACCESS',
          ],
        },
      ],
    });
    expect(removed.undone).toBe(2);
    expect(removed.kept).toHaveLength(1);
  });
});
