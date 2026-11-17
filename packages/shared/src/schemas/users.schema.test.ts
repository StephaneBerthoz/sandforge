import { describe, it, expect } from 'vitest';

import {
  USERS_MAX,
  usersApplyAnswerSchema,
  usersChangeSchema,
  usersConfigSchema,
  usersPlanAnswerSchema,
  usersRemoveAnswerSchema,
  usersWithDefaults,
} from './users.schema.js';

/** The config `sandforge env` hands `sandforge users` for the testers of the uat sandbox. */
function config(): Record<string, unknown> {
  return {
    defaults: { email: 'restore', frozen: false },
    users: [
      { username: 'jane.qa@acme.example', permissionSets: ['QA_Tools'], groups: ['QA_Team'] },
      {
        username: 'paul.qa@acme.example',
        active: true,
        profile: 'QA Tester',
        permissionSetGroups: ['Support_Bundle'],
      },
      { username: 'erp.integration@acme.example', email: 'keep', frozen: true },
    ],
  };
}

/** The messages a parse of the config refused with, each after the path it names. */
function refusalsOf(document: unknown): string[] {
  const parsed = usersConfigSchema.safeParse(document);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

const ORG = {
  organizationId: '00Dxx0000002AbCEAU',
  kind: 'sandbox',
  alias: 'uat',
  username: 'admin@acme.example.uat',
};

describe('the config of sandforge users', () => {
  it('reads the users a users resource lists, with its defaults', () => {
    expect(usersConfigSchema.safeParse(config()).success).toBe(true);
  });

  it('gives each user the defaults’ keys it does not give itself, a list of its own replacing theirs', () => {
    const parsed = usersConfigSchema.parse({
      defaults: { email: 'restore', frozen: false, permissionSets: ['QA_Tools'] },
      users: [
        { username: 'jane.qa@acme.example' },
        { username: 'paul.qa@acme.example', permissionSets: [], frozen: true },
      ],
    });

    expect(usersWithDefaults(parsed)).toEqual([
      {
        username: 'jane.qa@acme.example',
        email: 'restore',
        frozen: false,
        permissionSets: ['QA_Tools'],
      },
      { username: 'paul.qa@acme.example', email: 'restore', frozen: true, permissionSets: [] },
    ]);
    // Without defaults, each user as given.
    expect(usersWithDefaults({ users: [{ username: 'jane.qa@acme.example' }] })).toEqual([
      { username: 'jane.qa@acme.example' },
    ]);
  });

  it(`holds 1 to ${USERS_MAX} users, each once whatever its case`, () => {
    const many = Array.from({ length: USERS_MAX + 1 }, (_, i) => ({
      username: `tester${i}@acme.example`,
    }));
    expect(refusalsOf({ users: many })).toEqual([
      `users: ${USERS_MAX + 1} users: a users resource holds ${USERS_MAX} at most: split it in two`,
    ]);
    expect(refusalsOf({ users: [] })).toEqual([
      'users: A users resource lists one user at least: username, then what to set up',
    ]);
    expect(
      refusalsOf({
        users: [{ username: 'jane.qa@acme.example' }, { username: 'Jane.QA@acme.example' }],
      }),
    ).toEqual([
      'users.1.username: Jane.QA@acme.example is listed twice (also users[0]): one entry per user',
    ]);
  });

  it('refuses a key no user takes, a password above all, and a username that is no username', () => {
    expect(
      refusalsOf({ users: [{ username: 'jane.qa@acme.example', resetPassword: true }] }),
    ).toEqual([expect.stringContaining('"resetPassword" is not a key of a user')]);
    expect(refusalsOf({ users: [{ username: 'jane.qa' }] })).toEqual([
      expect.stringContaining('users.0.username: jane.qa is not a username'),
    ]);
    expect(refusalsOf({ ...config(), defaults: { username: 'x@acme.example' } })).toEqual([
      expect.stringContaining('"username" is not a key of the defaults'),
    ]);
  });
});

describe('what a plan of sandforge users answers', () => {
  const plan = {
    org: ORG,
    users: [
      {
        username: 'jane.qa@acme.example.uat',
        given: 'jane.qa@acme.example',
        userId: '005000000000001AAA',
        address: 'invalid',
        changes: [
          { what: 'email', to: 'awaiting' },
          { what: 'frozen', from: true, to: false },
          { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
          { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
        ],
        emailsToPeople: 1,
      },
      {
        username: 'paul.qa@acme.example.uat',
        userId: '005000000000002AAA',
        changes: [
          { what: 'active', from: false, to: true },
          { what: 'profile', from: 'Standard Platform User', to: 'QA Tester' },
          { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'added' },
        ],
      },
      {
        username: 'erp.integration@acme.example.uat',
        userId: '005000000000003AAA',
        address: 'kept',
        changes: [],
      },
    ],
    licenses: [{ name: 'Salesforce Platform', total: 10, used: 6, toUse: 1 }],
    emailsToPeople: 1,
    apiRequests: 9,
  };

  it('reads what changes for each user, and nothing for a user already as asked', () => {
    expect(usersPlanAnswerSchema.parse(plan).users[2]?.changes).toEqual([]);
  });

  it('reads an address as the org holds it: under .invalid, awaiting its owner’s click, restored, or kept', () => {
    for (const address of ['invalid', 'awaiting', 'restored', 'kept']) {
      const user = { ...plan.users[0], address, changes: [] };
      expect(usersPlanAnswerSchema.safeParse({ ...plan, users: [user] }).success, address).toBe(
        true,
      );
    }
    // The API restores no address at once: a change asked awaits its owner's
    // confirmation, the address under .invalid until the link is clicked.
    expect(usersChangeSchema.safeParse({ what: 'email', to: 'awaiting' }).success).toBe(true);
    expect(usersChangeSchema.safeParse({ what: 'email', to: 'restored' }).success).toBe(false);
  });

  it('reads a user the org does not have by the username given, refused by its code', () => {
    const refused = {
      ...plan,
      users: [{ username: 'jane.qa@acme.example', changes: [] }],
      refusals: [
        {
          code: 'USERS_NO_USER',
          username: 'jane.qa@acme.example',
          message: 'no user has the username jane.qa@acme.example, nor it followed by .<sandbox>',
        },
      ],
    };
    expect(usersPlanAnswerSchema.safeParse(refused).success).toBe(true);
    expect(
      usersPlanAnswerSchema.safeParse({ ...refused, refusals: [{ code: 'no', message: 'x' }] })
        .success,
    ).toBe(false);
  });

  it('never carries an address, a password or a value of the user beside what changes', () => {
    for (const change of [
      { what: 'email', to: 'jane.qa@acme.example' },
      { what: 'email', to: 'awaiting', address: 'jane.qa@acme.example' },
      { what: 'password', to: 'reset' },
      { what: 'permissionSet', name: 'QA Tools', to: 'added' },
      { what: 'group', name: 'QA_Team', type: 'Role', to: 'added' },
    ]) {
      expect(usersChangeSchema.safeParse(change).success, JSON.stringify(change)).toBe(false);
    }
    const user = plan.users[0];
    expect(
      usersPlanAnswerSchema.safeParse({
        ...plan,
        users: [{ ...user, email: 'jane.qa@acme.example' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a production org: sandforge users plans for a scratch, a Developer Edition or a sandbox', () => {
    expect(
      usersPlanAnswerSchema.safeParse({ ...plan, org: { ...ORG, kind: 'production' } }).success,
    ).toBe(false);
  });
});

describe('what an apply of sandforge users answers, and its removal', () => {
  const applied = {
    org: ORG,
    run: 1,
    status: 'success',
    users: [
      {
        username: 'jane.qa@acme.example.uat',
        userId: '005000000000001AAA',
        before: { isActive: true, isFrozen: true, profileId: '00e000000000001AAA' },
        done: [
          { what: 'frozen', from: true, to: false },
          { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
          { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
          { what: 'email', to: 'awaiting' },
        ],
        created: {
          permissionSetAssignments: ['0Pa000000000001AAA'],
          groupMembers: ['011000000000001AAA'],
        },
        found: { permissionSetAssignments: [], groupMembers: ['011000000000002AAA'] },
        address: 'awaiting',
      },
    ],
    emailsToPeople: 1,
    apiRequests: 7,
  };

  it('reads what it did to each user, what it was before and the ids of what it created', () => {
    const parsed = usersApplyAnswerSchema.parse(applied);
    expect(parsed.users[0]?.before.isFrozen).toBe(true);
    expect(parsed.users[0]?.created.groupMembers).toEqual(['011000000000001AAA']);
  });

  it('tells what it created from what its read found there before, which a removal never takes', () => {
    // A membership inserted twice is answered with the id of the one there
    // already: only the read before the write tells the two apart.
    const user = applied.users[0];
    const both = {
      ...applied,
      users: [
        {
          ...user,
          found: { permissionSetAssignments: [], groupMembers: ['011000000000001AAA'] },
        },
      ],
    };
    expect(usersApplyAnswerSchema.safeParse(both).error?.issues.map((i) => i.message)).toEqual([
      '011000000000001AAA is both created and found there before: an id is one or the other',
    ]);
  });

  it('reads a write the org refused, by its code and its words, the run partial', () => {
    const partial = {
      ...applied,
      status: 'partial',
      users: [
        {
          ...applied.users[0],
          refused: [
            {
              change: { what: 'active', from: false, to: true },
              code: 'LICENSE_LIMIT_EXCEEDED',
              message: 'License Limit Exceeded',
            },
          ],
        },
      ],
    };
    expect(usersApplyAnswerSchema.safeParse(partial).success).toBe(true);
    expect(usersApplyAnswerSchema.safeParse({ ...partial, status: 'done' }).success).toBe(false);
  });

  it('keeps ids and booleans of a user, never an address nor an id of another kind', () => {
    const user = applied.users[0];
    expect(
      usersApplyAnswerSchema.safeParse({
        ...applied,
        users: [{ ...user, before: { ...user?.before, email: 'jane.qa@acme.example.invalid' } }],
      }).success,
    ).toBe(false);
    expect(
      usersApplyAnswerSchema.safeParse({
        ...applied,
        users: [
          {
            ...user,
            created: { permissionSetAssignments: ['005000000000001AAA'], groupMembers: [] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      usersApplyAnswerSchema.safeParse({ ...applied, users: [{ ...user, address: 'restore' }] })
        .success,
    ).toBe(false);
  });

  it('reads what a removal undid of each user, and what it kept with why', () => {
    const removed = {
      org: ORG,
      run: 1,
      status: 'partial',
      users: [
        {
          username: 'jane.qa@acme.example.uat',
          userId: '005000000000001AAA',
          undone: [
            { what: 'permissionSet', name: 'QA_Tools', to: 'removed' },
            { what: 'frozen', from: false, to: true },
          ],
          kept: [
            {
              change: { what: 'group', name: 'QA_Team', type: 'Regular', to: 'removed' },
              why: 'removed by someone since: nothing to take back',
            },
          ],
        },
      ],
      apiRequests: 4,
    };
    expect(usersRemoveAnswerSchema.safeParse(removed).success).toBe(true);
    expect(
      usersRemoveAnswerSchema.safeParse({
        ...removed,
        users: [{ ...removed.users[0], kept: [{}] }],
      }).success,
    ).toBe(false);
  });
});
