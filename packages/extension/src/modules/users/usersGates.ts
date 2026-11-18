/**
 * What stands between a plan of `sandforge users` and the org, whoever asks
 * for it — the command line or the panel:
 *
 * - **the org typed before anything of its users is read**, live
 *   (`typeTarget`), and a production org refused, or one that will not say
 *   what it is: a plan answers of a scratch org, a Developer Edition org or a
 *   sandbox alone, and a production org's users are never read. The panel
 *   asks the registry first ({@link guardUsersOrg}), as a checkpoint and an
 *   emptying do: an org it holds for a production one is asked nothing, and
 *   one it holds for a sandbox must say so itself, an alias pointed at
 *   another org since. Production Guard asks before an update in production
 *   and lets it through once answered: it is not asked here, and nothing
 *   lifts the refusal;
 * - **the deliverability**, read only when a run would ask an address back
 *   (`forge/targetDeliverability.ts`), its reading handed to the plan, which
 *   holds the gates of the emails: the caller passes its acceptances;
 * - **what the org runs as a user or a login is written**, read as Forge
 *   reads it (`TargetAutomationReader`): `AUTOMATION_NOT_ACCEPTED` unless
 *   accepted, as every other module refuses it.
 *
 * And, before any plan, the users a sandbox has to hand back
 * ({@link usersToRestoreOf}), which a page lists for its user to pick.
 *
 * The question before a write, the words of a terminal and how a command
 * ends stay with the script (`cli/sandforge-users.ts`); the refusals here
 * carry their code, which a page words in its own language.
 */

import type { Connection } from 'jsforce';
import {
  USERS_MAX,
  firedOnWriteOf,
  isDevelopmentOrg,
  type ForgeFiredOnWrite,
  type ForgeTargetAutomation,
  type OrgTypeAndEdition,
  type UsersConfigUser,
  type UsersPlanAnswer,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  isProductionTarget,
  typeTarget,
  untypedCauseOf,
  untypedWords,
  type TypedTarget,
  type UntypedCause,
} from '../../core/precheck/orgKindLive.js';
import { automationUnreadOf } from '../forge/ForgeRunGate.js';
import {
  TargetAutomationReader,
  targetAutomationQueries,
} from '../forge/TargetAutomationReader.js';
import { readEmailDeliverability, type DeliverabilityRead } from '../forge/targetDeliverability.js';
import {
  inChunks,
  soqlList,
  usersOrgOf,
  type UsersConnection,
  type UsersOrg,
  type UsersRow,
} from './usersOrg.js';
import {
  planUsers,
  usersPlanAnswerOf,
  type UsersOrgSummary,
  type UsersPlan,
  type UsersPlanOptions,
  type UsersRefusal,
} from './usersPlan.js';
import { addressRestoredOf, idKey, readUsersState, type UsersOrgState } from './usersResolve.js';
import type { UsersRunRecord } from './usersRunStore.js';

/** The code an automation not accepted refuses a run with, as every module's. */
export const AUTOMATION_NOT_ACCEPTED = 'AUTOMATION_NOT_ACCEPTED';

// ─── The org ─────────────────────────────────────────────────────────────────

/** What reaching the org came to, before anything of its users was read. */
export type UsersOrgReach =
  | {
      kind: 'reached';
      org: UsersOrg;
      organization: UsersOrgSummary;
      typed: TypedTarget;
      /** The requests sent outside the users module's port: the Organization record's. */
      typingRequests: number;
    }
  /** The org could not be typed: nothing else was read. */
  | { kind: 'untyped'; err: unknown; typingRequests: number }
  /** A production org: nothing else was read. */
  | { kind: 'production'; typed: TypedTarget; typingRequests: number }
  /** The session is of another org than its Organization record names: nothing of the users was read. */
  | {
      kind: 'otherSession';
      sessionOrganizationId: string;
      typed: TypedTarget;
      typingRequests: number;
    };

/**
 * Reach an org and type it before anything else is read: a production org,
 * or one that will not say what it is, stops there. Then the user connected,
 * whose username the answers carry, and whose session must be of the org
 * typed.
 *
 * @param options.scratch - The org is a scratch org, which says `IsSandbox`
 *   true as a sandbox does: `sf` tells it apart, and the registry.
 */
export async function reachUsersOrg(
  conn: UsersConnection,
  options: { alias?: string; scratch: boolean },
): Promise<UsersOrgReach> {
  let typingRequests = 0;
  let typed: TypedTarget;
  try {
    typed = await typeTarget({
      query: ((soql: string) => {
        typingRequests += 1;
        return conn.query(soql);
      }) as Connection['query'],
    });
  } catch (err: unknown) {
    return { kind: 'untyped', err, typingRequests };
  }
  if (isProductionTarget(typed)) return { kind: 'production', typed, typingRequests };
  const org = usersOrgOf(conn);
  const connected = await org.identity();
  if (idKey(connected.organizationId) !== idKey(typed.id)) {
    return {
      kind: 'otherSession',
      sessionOrganizationId: connected.organizationId,
      typed,
      typingRequests,
    };
  }
  return {
    kind: 'reached',
    org,
    organization: {
      organizationId: typed.id,
      kind: options.scratch ? 'scratch' : typed.sandbox ? 'sandbox' : 'developer',
      ...(options.alias !== undefined ? { alias: options.alias } : {}),
      username: connected.username,
    },
    typed,
    typingRequests,
  };
}

/** Why the panel sets up no user of an org: see {@link guardUsersOrg}. */
export interface UsersGuardRefusal {
  /**
   * `PRODUCTION`: a production org, or one that cannot be told from one;
   * `ORG_UNTYPED`: it could not be typed, for a cause something lifts;
   * `OTHER_SESSION`: the session is of another org than it says it is.
   */
  code: 'PRODUCTION' | 'ORG_UNTYPED' | 'OTHER_SESSION';
  /** What lifts an `ORG_UNTYPED`: a session to renew, an org to wait for, a permission to give. */
  cause?: UntypedCause;
  message: string;
}

/** The guard's answer: the org reached, or why nothing of its users may be read or written. */
export type UsersGuardResult =
  | {
      allowed: true;
      org: UsersOrg;
      organization: UsersOrgSummary;
      typingRequests: number;
    }
  | { allowed: false; refusal: UsersGuardRefusal };

/** What a refusal of the guard says it left. */
const NOTHING_READ = 'No user was read or written.';

/** The production refusal, `evidence` saying what showed it is one or cannot be told from one. */
function productionRefusal(orgName: string, evidence: string): UsersGuardResult {
  return {
    allowed: false,
    refusal: {
      code: 'PRODUCTION',
      message:
        `${orgName} is a production org, or cannot be told from one: ${evidence}. SandForge sets ` +
        'up the users of a sandbox, a scratch org or a Developer Edition org, and reads nothing ' +
        `of a production org's: nothing lifts this. ${NOTHING_READ}`,
    },
  };
}

/**
 * Ask, before anything of its users is read, whether the panel may set up
 * the users of an org: the registry first — an org it holds for a
 * production one, or holds nothing of, is asked nothing —, then the org
 * itself ({@link reachUsersOrg}). Both must say sandbox, scratch org or
 * Developer Edition org.
 *
 * @param request.orgName - How the user knows the org: its alias, else its username.
 * @param request.registered - The org as the registry holds it.
 */
export async function guardUsersOrg(
  conn: UsersConnection,
  request: { orgName: string; registered: OrgTypeAndEdition | undefined },
): Promise<UsersGuardResult> {
  const { orgName, registered } = request;
  if (registered === undefined) {
    return productionRefusal(orgName, 'SandForge has no record of what kind of org it is');
  }
  if (!isDevelopmentOrg(registered)) {
    return productionRefusal(orgName, 'SandForge has it registered as a production org');
  }
  const reached = await reachUsersOrg(conn, {
    alias: orgName,
    scratch: registered.orgType === 'Scratch',
  });
  switch (reached.kind) {
    case 'untyped': {
      const cause = untypedCauseOf(reached.err);
      if (cause === undefined) {
        return productionRefusal(
          orgName,
          `it did not say what org it is (${extractErrorMessage(reached.err)})`,
        );
      }
      return {
        allowed: false,
        refusal: {
          code: 'ORG_UNTYPED',
          cause,
          message:
            `${untypedWords(orgName, reached.err, cause)} SandForge sets up the users of no org ` +
            `it cannot tell from a production one. ${NOTHING_READ}`,
        },
      };
    }
    case 'production':
      return productionRefusal(
        orgName,
        reached.typed.edition
          ? `its Organization record says IsSandbox false, edition ${reached.typed.edition}`
          : 'its Organization record says IsSandbox false, and no edition',
      );
    case 'otherSession':
      return {
        allowed: false,
        refusal: {
          code: 'OTHER_SESSION',
          message:
            `The session SandForge holds for ${orgName} is of ${reached.sessionOrganizationId}, ` +
            `and its Organization record says ${reached.typed.id}: reconnect it on the ` +
            `Organizations page. ${NOTHING_READ}`,
        },
      };
    case 'reached':
      return {
        allowed: true,
        org: reached.org,
        organization: reached.organization,
        typingRequests: reached.typingRequests,
      };
  }
}

// ─── What the org runs as users are written ──────────────────────────────────

/** What the read of the org's automation came to: read, not read and why, or not asked. */
export type UsersAutomationRead =
  | { kind: 'read'; automation: ForgeTargetAutomation }
  | { kind: 'unread'; reason: string }
  | { kind: 'none' };

/** When what fires on a save runs. */
const SAVE_WHEN: Readonly<Record<'before' | 'after' | 'beforeAndAfter', string>> = {
  before: 'before save',
  after: 'after save',
  beforeAndAfter: 'before and after save',
};

const UNREAD_WORDS: Readonly<Record<string, string>> = {
  flows: 'the flows',
  triggers: 'the Apex triggers',
  processes: 'the Process Builder processes',
  workflowRules: 'the workflow rules',
};

function firedWords(kind: string, name: string): string {
  if (kind === 'flow') return `flow "${name}"`;
  if (kind === 'process') return `process "${name}"`;
  if (kind === 'workflowRule') return `workflow rule "${name}"`;
  return `Apex trigger ${name}`;
}

/** What fires, in words: `User: Apex trigger UserTrigger (after save)`. */
export function firedEntryWords(entry: ForgeFiredOnWrite): string {
  return `${entry.objectApiName}: ${firedWords(entry.kind, entry.name)} (${SAVE_WHEN[entry.when]})`;
}

/** A part of the automation that could not be read, in words: `the Apex triggers`. */
export function unreadPartWords(part: string): string {
  return UNREAD_WORDS[part] ?? part;
}

/**
 * Read what the org runs on `objects` as their records are updated: a user's
 * profile, activation and address are `User` rows, a freeze a `UserLogin`
 * row. A permission set assignment and a group membership run nothing a
 * flow or a trigger can be written on. Never throws: what kept the read from
 * an answer is said.
 */
export async function readUsersAutomation(
  conn: Connection,
  orgName: string,
  objects: readonly string[],
): Promise<UsersAutomationRead> {
  if (objects.length === 0) return { kind: 'none' };
  try {
    const reader = new TargetAutomationReader(targetAutomationQueries(async () => conn));
    return { kind: 'read', automation: await reader.read(orgName, objects) };
  } catch (err: unknown) {
    return { kind: 'unread', reason: extractErrorMessage(err) };
  }
}

/** What fires, per object, as `objects` are updated. */
export function firedOf(read: UsersAutomationRead): ForgeFiredOnWrite[] {
  return read.kind === 'read' ? firedOnWriteOf(read.automation, 'update') : [];
}

/** Whose words a refusal of the automation names what lifts it in: a command line's, or a page's. */
export type UsersAutomationVoice = 'flags' | 'page';

/**
 * Why a run, or a removal, will not write without its automation accepted:
 * what fires, named, or what could not be read. Nothing when nothing fires
 * and everything was read, or when it is accepted.
 */
export function usersAutomationRefusal(
  read: UsersAutomationRead,
  orgName: string,
  writes: string,
  accepted: boolean,
  voice: UsersAutomationVoice = 'flags',
): UsersRefusal | undefined {
  if (accepted || read.kind === 'none') return undefined;
  const lifted =
    voice === 'page'
      ? 'Nothing was written. Accept it on the page to write all the same, or turn that ' +
        `automation off in ${orgName} first.`
      : 'Nothing was written. Add --accept-automation to write all the same (accept: { automation: ' +
        `true } on the users resource of sandforge.yaml), or turn that automation off in ${orgName} first.`;
  if (read.kind === 'unread') {
    return {
      code: AUTOMATION_NOT_ACCEPTED,
      message:
        `What ${orgName} runs as ${writes} could not be read (${read.reason}), so what fires is ` +
        `not known. ${lifted}`,
    };
  }
  const fired = firedOf(read);
  const unread = automationUnreadOf(read.automation);
  if (fired.length === 0 && unread.length === 0) return undefined;
  const parts: string[] = [];
  if (fired.length > 0) {
    parts.push(
      `${orgName} runs automation as ${writes}: ${fired.map(firedEntryWords).join('; ')}.`,
    );
  }
  for (const { part, reason } of unread) {
    parts.push(
      `${unreadPartWords(part)} of ${orgName} could not be read (${reason}), so what fires ` +
        `as ${writes} is not known.`,
    );
  }
  parts.push(lifted);
  return { code: AUTOMATION_NOT_ACCEPTED, message: parts.join(' ') };
}

/** The requests a read of the automation sent. */
export function automationRequestsOf(read: UsersAutomationRead): number {
  return read.kind === 'read' ? read.automation.requests : 0;
}

/** The objects whose rows a run updates: `User` for a profile, an activation or an address; `UserLogin` for a freeze. */
export function writtenByPlan(plan: UsersPlan): string[] {
  const users = plan.users.some(
    (one) =>
      one.writes.profileId !== undefined ||
      one.writes.isActive !== undefined ||
      one.writes.email !== undefined,
  );
  const logins = plan.users.some((one) => one.writes.isFrozen !== undefined);
  return [...(users ? ['User'] : []), ...(logins ? ['UserLogin'] : [])];
}

/** The objects whose rows a removal of `record` may update. */
export function writtenByRemoval(record: UsersRunRecord): string[] {
  const users = record.users.some(
    (user) =>
      user.after.isActive !== user.applied.before.isActive ||
      idKey(user.after.profileId) !== idKey(user.applied.before.profileId),
  );
  const logins = record.users.some((user) => user.after.isFrozen !== user.applied.before.isFrozen);
  return [...(users ? ['User'] : []), ...(logins ? ['UserLogin'] : [])];
}

// ─── The deliverability ──────────────────────────────────────────────────────

/** What the plan is told of the probe's reading. */
export function deliverabilityOf(
  read: DeliverabilityRead,
): NonNullable<UsersPlanOptions['deliverability']> {
  const { reading } = read;
  if ('unread' in reading) return 'unread';
  return reading.level === 'all' ? 'open' : 'closed';
}

// ─── The plan ────────────────────────────────────────────────────────────────

/** What a plan behind its gates is given. */
export interface UsersGatedPlanInput {
  /** The connection the deliverability and the automation are read through. */
  conn: Connection;
  /** The port of the same connection, which reads the users. */
  org: UsersOrg;
  /** How the refusals name the org: its alias. */
  orgName: string;
  /** The config's users, each with the defaults it does not override. */
  users: readonly UsersConfigUser[];
  /** The run this one replaces: converge from what it held. */
  previous?: UsersRunRecord;
  /** Asked at each run, never kept. */
  acceptUserEmails: boolean;
  acceptEmails: boolean;
  acceptAutomation: boolean;
  voice?: UsersAutomationVoice;
  now?: Date;
}

/** A plan behind its gates: what a run would change, and what the gates read and refused. */
export interface UsersGatedPlan {
  state: UsersOrgState;
  plan: UsersPlan;
  /**
   * What a run of this plan is given beside the org and the users: the
   * previous run, the acceptances, and the deliverability when read.
   */
  options: UsersPlanOptions;
  /** Read only when an address is asked back. */
  deliverability?: DeliverabilityRead;
  automation: UsersAutomationRead;
  automationRefusal?: UsersRefusal;
  /** The requests sent outside the users port: the deliverability's and the automation's. */
  outsideRequests: number;
}

/**
 * Plan the users of a config, then read what its writes need read: the
 * deliverability when an address is asked back, which the plan reads again
 * with it — what the org delivers matters to no other write —, and what
 * the org runs on the rows the plan writes.
 */
export async function planUsersGated(input: UsersGatedPlanInput): Promise<UsersGatedPlan> {
  const state = await readUsersState(input.org, input.users, {
    now: input.now ?? new Date(),
    ...(input.previous ? { previous: input.previous } : {}),
  });
  let options: UsersPlanOptions = {
    ...(input.previous ? { previous: input.previous } : {}),
    acceptUserEmails: input.acceptUserEmails,
    acceptEmails: input.acceptEmails,
  };
  let plan = planUsers(state, input.users, options);
  let deliverability: DeliverabilityRead | undefined;
  if (plan.emailsToPeople > 0) {
    deliverability = await readEmailDeliverability(input.conn);
    options = { ...options, deliverability: deliverabilityOf(deliverability) };
    plan = planUsers(state, input.users, options);
  }
  const automation = await readUsersAutomation(input.conn, input.orgName, writtenByPlan(plan));
  const refusal = usersAutomationRefusal(
    automation,
    input.orgName,
    'users are written',
    input.acceptAutomation,
    input.voice,
  );
  return {
    state,
    plan,
    options,
    ...(deliverability ? { deliverability } : {}),
    automation,
    ...(refusal ? { automationRefusal: refusal } : {}),
    outsideRequests: (deliverability?.requests ?? 0) + automationRequestsOf(automation),
  };
}

/**
 * What a plan behind its gates answers: the plan's refusals and the
 * automation's together. An apply sends all the plan sent (`sent`), then
 * reads the users again before its first write, then writes: what the
 * answer says it sends.
 */
export function gatedPlanAnswerOf(
  gated: UsersGatedPlan,
  organization: UsersOrgSummary,
  sent: number,
): UsersPlanAnswer {
  const planned = usersPlanAnswerOf(gated.plan, organization, sent + gated.state.requests);
  const refusals = [
    ...(planned.refusals ?? []),
    ...(gated.automationRefusal ? [gated.automationRefusal] : []),
  ];
  return { ...planned, ...(refusals.length > 0 ? { refusals } : {}) };
}

// ─── The users to hand back ──────────────────────────────────────────────────
//
// The users of a sandbox to hand back once it is copied: those whose address
// the copy put under `.invalid`, those frozen (`UserLogin.IsFrozen`), and
// those inactive — what a page lists for its user to tick, before a plan
// says what a run would change.
//
// Only people who sign in are listed: a user whose `UserType` is not
// `Standard` is the org's own — the automated process, a site's guest, a
// Chatter Free user —, as Forge's owner list reads them (`orgUsers.ts`). The
// user connected is left out: a run refuses to lock it out (`USERS_SELF`).
//
// Reads only, through the port a run reads and writes by (`usersOrg.ts`): the
// users under `.invalid` or inactive, then the logins frozen, then the frozen
// users the first read did not hold. An address is read to tell whether it is
// under `.invalid`, and goes no further: no answer carries an address or a
// person's name, as no run file does.
//
// Listed `USERS_MAX` at most, as a users resource holds: the active ones
// first, a tester being more often one of them than a former employee, then
// by username; the count says how many there are in all.

/** A user to hand back, as the org answered it. */
export interface UserToRestore {
  userId: string;
  /** The org's username, the sandbox's suffix included. */
  username: string;
  /** Its profile's name, when the org gave it. */
  profile?: string;
  /** Whether its address is under the copy's `.invalid`: never the address itself. */
  address: 'invalid' | 'valid';
  active: boolean;
  frozen: boolean;
}

/** The users to hand back, and what reading them cost. */
export interface UsersToRestore {
  /** {@link USERS_MAX} at most, in the order of the section's comment. */
  users: UserToRestore[];
  /** Every user to hand back, those past the bound included. */
  total: number;
  /** The requests the read sent. */
  requests: number;
}

/** The columns read of a user. */
const COLUMNS = 'Id, Username, Email, IsActive, Profile.Name';

/** People who sign in: the org's own users have another type. */
const PEOPLE = "UserType = 'Standard'";

/** Ids of an `IN` in one statement. */
const IDS_PER_READ = 200;

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A user as a row reads, frozen or not; undefined for a row that names no user. */
function userOf(row: UsersRow, frozen: ReadonlySet<string>): UserToRestore | undefined {
  const userId = textOf(row['Id']);
  const username = textOf(row['Username']);
  if (userId === undefined || username === undefined) return undefined;
  const profile = textOf((row['Profile'] as UsersRow | null | undefined)?.['Name']);
  const email = textOf(row['Email']);
  return {
    userId,
    username,
    ...(profile !== undefined ? { profile } : {}),
    address: email !== undefined && addressRestoredOf(email) !== undefined ? 'invalid' : 'valid',
    active: row['IsActive'] === true,
    frozen: frozen.has(idKey(userId)),
  };
}

/** Active users first, then by username whatever its case. */
function inListOrder(a: UserToRestore, b: UserToRestore): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  const left = a.username.toLowerCase();
  const right = b.username.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Read the users of the org to hand back: see the section's comment. What the
 * org refuses is thrown, never taken for a sandbox with nobody to hand back.
 *
 * @param options.connectedUserId - The user connected, when the caller read
 *   it already: the org is not asked again.
 */
export async function usersToRestoreOf(
  org: UsersOrg,
  options: { connectedUserId?: string } = {},
): Promise<UsersToRestore> {
  const before = org.requests();
  const connected = idKey(options.connectedUserId ?? (await org.identity()).userId);

  const marked = await org.query(
    `SELECT ${COLUMNS} FROM User WHERE ${PEOPLE} AND (IsActive = false OR Email LIKE '%.invalid')`,
  );
  const frozen = new Set(
    (await org.query('SELECT UserId FROM UserLogin WHERE IsFrozen = true')).flatMap((row) => {
      const userId = textOf(row['UserId']);
      return userId !== undefined ? [idKey(userId)] : [];
    }),
  );

  const byId = new Map<string, UserToRestore>();
  for (const row of marked) {
    const user = userOf(row, frozen);
    if (user !== undefined) byId.set(idKey(user.userId), user);
  }
  const frozenOnly = [...frozen].filter((key) => !byId.has(key) && key !== connected);
  for (const part of inChunks(frozenOnly, IDS_PER_READ)) {
    const rows = await org.query(
      `SELECT ${COLUMNS} FROM User WHERE ${PEOPLE} AND Id IN ${soqlList(part)}`,
    );
    for (const row of rows) {
      const user = userOf(row, frozen);
      if (user !== undefined) byId.set(idKey(user.userId), user);
    }
  }
  byId.delete(connected);

  const users = [...byId.values()].sort(inListOrder);
  return {
    users: users.slice(0, USERS_MAX),
    total: users.length,
    requests: org.requests() - before,
  };
}
