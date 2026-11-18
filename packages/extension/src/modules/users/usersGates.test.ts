import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USERS_MAX, type OrgTypeAndEdition, type UsersConfigUser } from '@sandforge/shared';

/** What the org runs as users are written: nothing, unless a test says. */
const orgRuns = vi.hoisted(() => ({
  objects: [] as unknown[],
  unread: [] as unknown[],
  /** The objects each read was asked for, in order. */
  asked: [] as string[][],
  throws: undefined as Error | undefined,
}));

// What the org runs on the users a run writes, as Forge reads it.
vi.mock('../forge/TargetAutomationReader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../forge/TargetAutomationReader.js')>()),
  TargetAutomationReader: class {
    read(_org: string, objects: readonly string[]) {
      orgRuns.asked.push([...objects]);
      if (orgRuns.throws) return Promise.reject(orgRuns.throws);
      return Promise.resolve({
        objectsRead: [...objects],
        objects: orgRuns.objects,
        unread: orgRuns.unread,
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 2,
      });
    }
  },
}));

import type { Connection } from 'jsforce';
import { EMAIL_NOT_PERMITTED } from '../forge/targetDeliverability.js';
import { usersOrgOf } from './usersOrg.js';
import { usersPlanAnswerOf } from './usersPlan.js';
import {
  ACME,
  acmeSetup,
  usersTestOrg,
  type TestUser,
  type UsersTestOrg,
  type UsersTestOrgSetup,
} from './usersOrg.fixtures.js';
import {
  AUTOMATION_NOT_ACCEPTED,
  deliverabilityOf,
  gatedPlanAnswerOf,
  guardUsersOrg,
  planUsersGated,
  reachUsersOrg,
  usersAutomationRefusal,
  usersToRestoreOf,
  writtenByPlan,
} from './usersGates.js';

/*
 * What stands between a plan of `sandforge users` and the org, whoever asks
 * for it — the command line or the panel: the org typed live before anything
 * of its users is read, a production org refused; the deliverability read
 * when an address is asked back; what the org runs as users are written.
 * The org is the one in miniature, its Organization record and the
 * deliverability's line of Apex answered beside it.
 */

/** What the Organization record says of the org, or what reading it throws. */
type OrgKind = { IsSandbox: boolean; OrganizationType?: string } | Error;

const SANDBOX: OrgKind = { IsSandbox: true };
const PRODUCTION: OrgKind = { IsSandbox: false, OrganizationType: 'Enterprise Edition' };

/** The registry's word for each kind of org. */
const REGISTERED: Readonly<Record<string, OrgTypeAndEdition>> = {
  sandbox: { orgType: 'Sandbox' },
  scratch: { orgType: 'Scratch' },
  developer: { orgType: 'Developer', metadata: { edition: 'Developer Edition' } },
  production: { orgType: 'Production', metadata: { edition: 'Enterprise Edition' } },
};

interface Reached {
  org: UsersTestOrg;
  conn: Connection;
  /** Every call the connection was sent, by what it was. */
  calls: string[];
}

/** A connection to the org in miniature, its Organization record answered as `kind` says. */
function reach(
  setup: UsersTestOrgSetup = acmeSetup(),
  kind: OrgKind = SANDBOX,
  deliverability: 'open' | 'closed' = 'closed',
): Reached {
  const org = usersTestOrg(setup);
  const calls: string[] = [];
  const conn = {
    ...org.connection,
    identity: () => {
      calls.push('identity');
      return org.connection.identity();
    },
    query: (soql: string) => {
      calls.push(soql);
      if (/FROM Organization\b/.test(soql)) {
        if (kind instanceof Error) return Promise.reject(kind);
        const row = soql.includes('IsSandbox')
          ? { Id: org.organizationId, IsSandbox: kind.IsSandbox }
          : { OrganizationType: kind.OrganizationType };
        return Promise.resolve({ records: [row], done: true, totalSize: 1 });
      }
      return org.connection.query(soql);
    },
    request: ({ url }: { url: string }) => {
      calls.push(url);
      if (url.startsWith('/tooling/executeAnonymous')) {
        return Promise.resolve(
          deliverability === 'open'
            ? { compiled: true, success: true }
            : { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED },
        );
      }
      if (url.startsWith('/query?q=')) {
        return Promise.resolve({ records: [{ PermissionsEmailSingle: true }] });
      }
      return Promise.reject(new Error(`not a request of this test: ${url}`));
    },
  };
  return { org, conn: conn as unknown as Connection, calls };
}

/** Whether anything but the Organization record was read: a user, a login, who the session is. */
function readPastOrganization(calls: readonly string[]): string[] {
  return calls.filter((call) => !/FROM Organization\b/.test(call));
}

beforeEach(() => {
  orgRuns.objects = [];
  orgRuns.unread = [];
  orgRuns.asked = [];
  orgRuns.throws = undefined;
});

describe('an org whose users the panel sets up', () => {
  it('is refused before anything is read when the registry holds it for a production org', async () => {
    const { conn, calls } = reach(acmeSetup(), SANDBOX);
    const guarded = await guardUsersOrg(conn, {
      orgName: 'prod',
      registered: REGISTERED.production,
    });
    expect(guarded).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
    expect(calls).toEqual([]);
  });

  it('is refused before anything is read when the registry holds nothing of it', async () => {
    const { conn, calls } = reach();
    const guarded = await guardUsersOrg(conn, { orgName: 'stray', registered: undefined });
    expect(guarded).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
    expect(calls).toEqual([]);
  });

  it('is refused before any user is read when the org itself says it is a production org', async () => {
    // The registry says sandbox: an alias pointed at a production org since.
    const { conn, calls, org } = reach(acmeSetup(), PRODUCTION);
    const guarded = await guardUsersOrg(conn, { orgName: 'uat', registered: REGISTERED.sandbox });
    expect(guarded).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
    if (guarded.allowed) throw new Error('a production org was let through');
    expect(guarded.refusal.message).toContain('IsSandbox false, edition Enterprise Edition');
    expect(readPastOrganization(calls)).toEqual([]);
    expect(org.queries).toEqual([]);
    expect(org.writes).toEqual([]);
  });

  it('is refused, and said what lifts it, when its session was refused', async () => {
    const expired = Object.assign(new Error('Session expired or invalid'), {
      errorCode: 'INVALID_SESSION_ID',
    });
    const { conn, calls } = reach(acmeSetup(), expired);
    const guarded = await guardUsersOrg(conn, { orgName: 'uat', registered: REGISTERED.sandbox });
    expect(guarded).toMatchObject({
      allowed: false,
      refusal: { code: 'ORG_UNTYPED', cause: 'auth' },
    });
    expect(readPastOrganization(calls)).toEqual([]);
  });

  it('is taken for a production org when it says nothing of itself', async () => {
    const { conn } = reach(acmeSetup(), new Error('MALFORMED_QUERY: unexpected'));
    const guarded = await guardUsersOrg(conn, { orgName: 'uat', registered: REGISTERED.sandbox });
    expect(guarded).toMatchObject({ allowed: false, refusal: { code: 'PRODUCTION' } });
  });

  it('is refused when the session is of another org than its Organization record names', async () => {
    const setup = acmeSetup();
    const { conn, org } = reach(setup);
    const other = {
      ...conn,
      identity: () =>
        Promise.resolve({
          user_id: ACME.users.admin,
          organization_id: '00D000000000099EAA',
          username: 'admin@acme.com.uat',
        }),
    } as unknown as Connection;
    const guarded = await guardUsersOrg(other, { orgName: 'uat', registered: REGISTERED.sandbox });
    expect(guarded).toMatchObject({ allowed: false, refusal: { code: 'OTHER_SESSION' } });
    expect(org.queries).toEqual([]);
  });

  it('is reached when both say sandbox, scratch org or Developer Edition org, named as each', async () => {
    const sandbox = await guardUsersOrg(reach(acmeSetup(), SANDBOX).conn, {
      orgName: 'uat',
      registered: REGISTERED.sandbox,
    });
    const scratch = await guardUsersOrg(reach(acmeSetup(), SANDBOX).conn, {
      orgName: 'qa',
      registered: REGISTERED.scratch,
    });
    const developer = await guardUsersOrg(
      reach(acmeSetup(), { IsSandbox: false, OrganizationType: 'Developer Edition' }).conn,
      { orgName: 'de', registered: REGISTERED.developer },
    );
    if (!sandbox.allowed || !scratch.allowed || !developer.allowed) {
      throw new Error('a development org was refused');
    }
    expect(sandbox.organization).toEqual({
      organizationId: ACME.organizationId,
      kind: 'sandbox',
      alias: 'uat',
      username: 'admin@acme.com.uat',
    });
    expect(scratch.organization.kind).toBe('scratch');
    expect(developer.organization.kind).toBe('developer');
    // The Organization record twice at most, then who the session is.
    expect(sandbox.typingRequests).toBe(1);
    expect(developer.typingRequests).toBe(2);
  });
});

describe('an org the command line reaches', () => {
  it('is typed before anything else is read, and a production org stops there', async () => {
    const { conn, calls } = reach(acmeSetup(), PRODUCTION);
    const reached = await reachUsersOrg(conn, { alias: 'uat', scratch: false });
    expect(reached).toMatchObject({ kind: 'production', typed: { sandbox: false } });
    expect(readPastOrganization(calls)).toEqual([]);
  });

  it('is a scratch org when sf says so, whatever its Organization record says', async () => {
    const reached = await reachUsersOrg(reach().conn, { alias: 'qa', scratch: true });
    if (reached.kind !== 'reached') throw new Error(`not reached: ${reached.kind}`);
    expect(reached.organization.kind).toBe('scratch');
  });
});

/** The testers of the design's file, as the config gives them. */
const RESTORE: UsersConfigUser[] = [
  { username: 'jane.qa@acme.com', email: 'restore', frozen: false },
];
const NO_ADDRESS: UsersConfigUser[] = [{ username: 'paul.qa@acme.com', active: true }];

describe('a plan behind its gates', () => {
  it('reads the deliverability only when an address is asked back', async () => {
    const asked = reach();
    const gated = await planUsersGated({
      conn: asked.conn,
      org: usersOrgOf(asked.conn),
      orgName: 'uat',
      users: RESTORE,
      acceptUserEmails: true,
      acceptEmails: false,
      acceptAutomation: false,
    });
    expect(gated.deliverability?.reading).toEqual({ level: 'withheld' });
    expect(gated.options.deliverability).toBe('closed');
    expect(asked.calls.filter((call) => call.startsWith('/tooling/executeAnonymous'))).toHaveLength(
      1,
    );

    const none = reach();
    const plain = await planUsersGated({
      conn: none.conn,
      org: usersOrgOf(none.conn),
      orgName: 'uat',
      users: NO_ADDRESS,
      acceptUserEmails: false,
      acceptEmails: false,
      acceptAutomation: false,
    });
    expect(plain.deliverability).toBeUndefined();
    expect(none.calls.some((call) => call.startsWith('/tooling/'))).toBe(false);
  });

  it('refuses an address asked back in an org that delivers all email, unless accepted', async () => {
    const open = reach(acmeSetup(), SANDBOX, 'open');
    const gated = await planUsersGated({
      conn: open.conn,
      org: usersOrgOf(open.conn),
      orgName: 'uat',
      users: RESTORE,
      acceptUserEmails: true,
      acceptEmails: false,
      acceptAutomation: false,
    });
    expect(deliverabilityOf(gated.deliverability ?? { reading: { unread: '' }, requests: 0 })).toBe(
      'open',
    );
    const answer = gatedPlanAnswerOf(gated, organization(), 0);
    expect(answer.refusals?.map((one) => one.code)).toContain('USERS_EMAILS_OPEN');
  });

  it('reads what the org runs on the rows it writes, and refuses what fires unless accepted', async () => {
    orgRuns.objects = [
      {
        objectApiName: 'User',
        flows: [],
        triggers: [{ name: 'UserTrigger', events: ['afterUpdate'] }],
      },
    ];
    const fired = reach();
    const gated = await planUsersGated({
      conn: fired.conn,
      org: usersOrgOf(fired.conn),
      orgName: 'uat',
      users: NO_ADDRESS,
      acceptUserEmails: false,
      acceptEmails: false,
      acceptAutomation: false,
    });
    expect(orgRuns.asked).toEqual([['User']]);
    expect(writtenByPlan(gated.plan)).toEqual(['User']);
    expect(gated.automationRefusal?.code).toBe(AUTOMATION_NOT_ACCEPTED);
    expect(gated.automationRefusal?.message).toContain('User: Apex trigger UserTrigger');
    expect(gated.automationRefusal?.message).toContain('--accept-automation');
    // The deliverability not read, the automation's two requests alone.
    expect(gated.outsideRequests).toBe(2);
    const answer = gatedPlanAnswerOf(gated, organization(), 5);
    expect(answer.refusals?.map((one) => one.code)).toEqual([AUTOMATION_NOT_ACCEPTED]);
    // What was sent, then the users read again before the first write, then the writes.
    expect(answer.apiRequests).toBe(
      usersPlanAnswerOf(gated.plan, organization(), 5 + gated.state.requests).apiRequests,
    );

    const accepted = await planUsersGated({
      conn: reach().conn,
      org: usersOrgOf(reach().conn),
      orgName: 'uat',
      users: NO_ADDRESS,
      acceptUserEmails: false,
      acceptEmails: false,
      acceptAutomation: true,
    });
    expect(accepted.automationRefusal).toBeUndefined();
  });

  it('names what fires, and what could not be read, for a page to word it in its own language', () => {
    const fired = usersAutomationRefusal(
      {
        kind: 'read',
        automation: {
          objectsRead: ['User', 'UserLogin'],
          objects: [
            {
              objectApiName: 'User',
              flows: [
                {
                  label: 'Welcome a user',
                  apiName: 'Welcome_User',
                  timing: 'afterSave',
                  startsOn: 'createAndUpdate',
                  condition: 'read',
                  permissions: [],
                },
              ],
              triggers: [{ name: 'UserTrigger', events: ['beforeUpdate', 'afterUpdate'] }],
            },
          ],
          unread: [
            { part: 'workflowRules', reason: 'INSUFFICIENT_ACCESS' },
            // A start condition left unread hides nothing of what fires.
            { part: 'conditions', reason: 'too many' },
          ],
          conditionsNotRead: 0,
          conditionsBound: 0,
          requests: 3,
        },
      } as never,
      'uat',
      'users are written',
      false,
      'page',
    );
    expect(fired?.automation).toEqual({
      fired: [
        { kind: 'trigger', name: 'UserTrigger', objectApiName: 'User', when: 'beforeAndAfter' },
        { kind: 'flow', name: 'Welcome a user', objectApiName: 'User', when: 'after' },
      ],
      unread: ['workflowRules'],
    });
    // Its words stay, for the log and the command line.
    expect(fired?.message).toContain('User: Apex trigger UserTrigger (before and after save)');

    const unknown = usersAutomationRefusal(
      { kind: 'unread', reason: 'INVALID_SESSION_ID' },
      'uat',
      'users are written',
      false,
      'page',
    );
    expect(unknown?.automation).toEqual({ fired: [], notDeduced: true });
    expect(JSON.stringify(unknown?.automation)).not.toContain('INVALID_SESSION_ID');
  });

  it('says on the page what lifts the automation’s refusal, never a flag', () => {
    const refusal = usersAutomationRefusal(
      { kind: 'unread', reason: 'INSUFFICIENT_ACCESS' },
      'uat',
      'users are written',
      false,
      'page',
    );
    expect(refusal?.code).toBe(AUTOMATION_NOT_ACCEPTED);
    expect(refusal?.message).not.toContain('--accept-automation');
    expect(refusal?.message).toContain('Nothing was written.');
  });
});

/** The org a plan names. */
function organization() {
  return {
    organizationId: ACME.organizationId,
    kind: 'sandbox' as const,
    alias: 'uat',
    username: 'admin@acme.com.uat',
  };
}

/*
 * The users of a sandbox to hand back once it is copied: each address the
 * copy put under `.invalid`, each user frozen, each one inactive — read
 * through the port a run reads and writes by.
 */

describe('the users of a sandbox to hand back', () => {
  it('are those under .invalid, frozen or inactive, active ones first, the user connected left out', async () => {
    const org = usersTestOrg(acmeSetup());
    const read = await usersToRestoreOf(usersOrgOf(org.connection));
    expect(read.users).toEqual([
      {
        userId: ACME.users.erp,
        username: 'erp.integration@acme.com.uat',
        profile: 'Standard Platform User',
        address: 'invalid',
        active: true,
        frozen: false,
      },
      {
        userId: ACME.users.jane,
        username: 'jane.qa@acme.com.uat',
        profile: 'Standard Platform User',
        address: 'invalid',
        active: true,
        frozen: true,
      },
      {
        userId: ACME.users.paul,
        username: 'paul.qa@acme.com.uat',
        profile: 'Standard Platform User',
        address: 'invalid',
        active: false,
        frozen: false,
      },
    ]);
    expect(read.total).toBe(3);
  });

  it('carry no address and no person’s name: only whether the address is under .invalid', async () => {
    const org = usersTestOrg(acmeSetup());
    const said = JSON.stringify(await usersToRestoreOf(usersOrgOf(org.connection)));
    expect(said).not.toContain('acme.com.invalid');
    expect(said).not.toContain('Jane Tester');
    expect(said).not.toContain('Paul Tester');
  });

  it('take in a user frozen whose address was never under .invalid, read by its login', async () => {
    const setup = acmeSetup();
    const kept: TestUser = {
      id: '005000000000009AAA',
      username: 'creator@acme.com.uat',
      email: 'creator@acme.com',
      isActive: true,
      profileId: ACME.profiles.standard,
      frozen: true,
      loginId: '060000000000009AAA',
    };
    const org = usersTestOrg({ ...setup, users: [...setup.users, kept] });
    const read = await usersToRestoreOf(usersOrgOf(org.connection));
    expect(read.users.find((user) => user.username === 'creator@acme.com.uat')).toEqual({
      userId: kept.id,
      username: 'creator@acme.com.uat',
      profile: 'Standard User',
      address: 'valid',
      active: true,
      frozen: true,
    });
    expect(read.total).toBe(4);
  });

  it('leave out a user active, unfrozen and with an address of its own', async () => {
    const setup = acmeSetup();
    const org = usersTestOrg({
      ...setup,
      users: setup.users.map((user) =>
        user.id === ACME.users.erp ? { ...user, email: 'erp.integration@acme.com' } : user,
      ),
    });
    const read = await usersToRestoreOf(usersOrgOf(org.connection));
    expect(read.users.map((user) => user.username)).toEqual([
      'jane.qa@acme.com.uat',
      'paul.qa@acme.com.uat',
    ]);
  });

  it('leave out the org’s own users: an automated process, a site guest, a Chatter Free user', async () => {
    const setup = acmeSetup();
    const system = (id: string, username: string, userType: string): TestUser => ({
      id,
      username,
      email: `${username}.invalid`,
      isActive: false,
      profileId: ACME.profiles.standard,
      userType,
      loginId: null,
    });
    const org = usersTestOrg({
      ...setup,
      users: [
        ...setup.users,
        system('005000000000007AAA', 'autoproc@00d.example', 'AutomatedProcess'),
        system('005000000000008AAA', 'site-guest@acme.example', 'Guest'),
        system('00500000000000AAAA', 'chatter-expert@acme.example', 'CsnOnly'),
      ],
    });
    const read = await usersToRestoreOf(usersOrgOf(org.connection));
    expect(read.users.map((user) => user.username)).toEqual([
      'erp.integration@acme.com.uat',
      'jane.qa@acme.com.uat',
      'paul.qa@acme.com.uat',
    ]);
    expect(read.total).toBe(3);
  });

  it(`list ${USERS_MAX} at most, and count them all`, async () => {
    const setup = acmeSetup();
    const many: TestUser[] = Array.from({ length: USERS_MAX + 5 }, (_, at) => ({
      id: `005${String(100 + at).padStart(12, '0')}AAA`,
      username: `former.${String(at).padStart(3, '0')}@acme.com.uat`,
      email: `former.${at}@acme.com.invalid`,
      isActive: false,
      profileId: ACME.profiles.standard,
      loginId: null,
    }));
    const org = usersTestOrg({ ...setup, users: [...setup.users, ...many], pageSize: 100 });
    const read = await usersToRestoreOf(usersOrgOf(org.connection));
    expect(read.users).toHaveLength(USERS_MAX);
    expect(read.total).toBe(USERS_MAX + 5 + 3);
    // The active ones first: a tester is more often one of them than a former employee.
    expect(read.users.slice(0, 2).map((user) => user.username)).toEqual([
      'erp.integration@acme.com.uat',
      'jane.qa@acme.com.uat',
    ]);
  });

  it('read only, and count what they sent', async () => {
    const org = usersTestOrg(acmeSetup());
    const port = usersOrgOf(org.connection);
    const read = await usersToRestoreOf(port, { connectedUserId: ACME.users.admin });
    expect(org.writes).toEqual([]);
    expect(org.emailsSent()).toBe(0);
    expect(read.requests).toBe(port.requests());
    // The users, then the logins frozen: the user connected given, the org
    // is not asked who it is.
    expect(read.requests).toBe(2);
    expect(org.queries).toHaveLength(2);
  });
});
