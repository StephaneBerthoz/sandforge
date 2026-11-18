/**
 * The `users` kind of resource: the users of a sandbox handed back to its
 * testers — an address the copy put under `.invalid` asked back, a user
 * activated, frozen or unfrozen, a profile, permission sets, groups of them,
 * groups and queues — set up by `sandforge users`, which the environment runs
 * as it runs every other script, with `--json`.
 *
 * The file's users and their defaults are given to the script as they are
 * written, in a config file (`--config`): the script resolves each username,
 * reads the org and refuses what it refuses before its first write. What a
 * users resource writes, and its fingerprint is of, is each user with the
 * defaults it does not override, by its username whatever its case, the
 * names it is given in any order: a key moved from the defaults onto every
 * user keeps the fingerprint, a permission set taken off the file moves it.
 *
 * Its steps are the script's: a plan (`plan --json`), which says per user
 * what a run would change — the plan's count, and its refresh of a resource
 * applied: a user the org holds as the last run left it has nothing to
 * change, and one someone froze again, or took an assignment from, is drift
 * —; a run (`apply --yes --json`); and the removal of a run (`remove --run
 * <n>`), by the number the script gave it, which its answer, kept as the
 * run's summary, says. What fires as a user or a login is written refuses
 * each of them unless the file or the line accepts it (`--accept-automation`).
 *
 * A replace converges, in one run: the run before it is named to the script
 * (`--replaces <n>`), which adds what is missing, takes back what the
 * environment added and the file no longer names, and puts a user taken out
 * of the file back as it was. It never takes everything back to set it up
 * again: frozen then unfrozen in the middle of a test campaign, a tester is
 * locked out for nothing. The run that converged holds what the one before
 * held: that one is taken back by it.
 *
 * Never undone: an address asked back, which its owner confirms by a link
 * Salesforce mails, and which nothing puts under `.invalid` again; nor the
 * user itself, which Salesforce does not delete. The emails Salesforce sends
 * to people as an address is asked back are the line's to accept
 * (`--accept-user-emails`), never the file's.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  usernameKey,
  usersApplyAnswerSchema,
  usersPlanAnswerSchema,
  usersRemoveAnswerSchema,
  usersWithDefaults,
  type EnvPlanObject,
  type EnvUser,
  type EnvUserSettings,
  type EnvUsersResource,
  type UsersApplyAnswer,
  type UsersChange,
  type UsersConfig,
  type UsersPlanAnswer,
  type UsersRemoveAnswer,
} from '@sandforge/shared';
import type { RunnableScript } from '../../scriptRunner.js';
import {
  readAnswer,
  valueOf,
  type EnvDryRunCount,
  type EnvFileRefusal,
  type EnvRemovalObject,
  type EnvRunCount,
} from './common.js';

/** The script a `users` resource runs. */
export const USERS_SCRIPT = 'sandforge-users' satisfies RunnableScript;

/** The most a run's number is, as the script numbers its runs. */
const RUN_MAX = 999_999;

// ─── The resource, converted ─────────────────────────────────────────────────

/** What a users resource runs: its users and their defaults, as the file writes them. */
export interface EnvUsersRun {
  defaults?: EnvUserSettings;
  users: EnvUser[];
  /** What fires as a user or a login is written is accepted in the file. */
  acceptAutomation?: true;
}

/**
 * What a users resource runs, as the file writes it: the file's schema has
 * checked each user, its names and its bounds already, and the script checks
 * the config again before any org is reached.
 */
export function usersRunOfResource(resource: EnvUsersResource): {
  run: EnvUsersRun;
  warnings: EnvFileRefusal[];
} {
  return {
    run: {
      ...(resource.defaults !== undefined ? { defaults: resource.defaults } : {}),
      users: resource.users,
      // What fires as the users are written refuses the run unless the file
      // accepts it, as it does a seed's, a clone's and a masking's.
      ...(resource.accept?.automation === true ? { acceptAutomation: true } : {}),
    },
    warnings: [],
  };
}

/** Names compared as Salesforce compares them, whatever their case, in one order; none as none. */
function namesOf(names: readonly string[] | undefined): string[] | null {
  if (names === undefined || names.length === 0) return null;
  return [...new Set(names.map((name) => name.toLowerCase()))].sort();
}

/**
 * What a users resource writes, and nothing else: the fingerprint of a
 * resource is of this. Each user with the defaults it does not override, by
 * its username whatever its case, in one order; an address kept as written
 * as one not named; the names it is given in any order and case. Not what it
 * accepts, which changes no user.
 */
export function usersWritten(run: EnvUsersRun): Record<string, unknown> {
  const users = usersWithDefaults(usersConfigOf(run))
    .map((user) => ({
      username: usernameKey(user.username),
      email: user.email ?? 'keep',
      active: user.active ?? null,
      frozen: user.frozen ?? null,
      profile: user.profile ?? null,
      permissionSets: namesOf(user.permissionSets),
      permissionSetGroups: namesOf(user.permissionSetGroups),
      groups: namesOf(user.groups),
    }))
    .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
  return { kind: 'users', kindVersion: 1, users };
}

/** What a users resource sets up: its users, which `validate` counts. */
export function usersObjectsOf(run: EnvUsersRun): Array<{ object: string; count: number }> {
  return [{ object: 'User', count: run.users.length }];
}

/** The config a run is given, as `sandforge users --config` reads it: the file's users and defaults. */
export function usersConfigOf(run: EnvUsersRun): UsersConfig {
  return {
    ...(run.defaults !== undefined ? { defaults: run.defaults } : {}),
    users: run.users,
  };
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** A run's number, as the script takes it: the number it gave the run. */
function runNumberOf(flag: string, run: number): string {
  if (!Number.isInteger(run) || run < 1 || run > RUN_MAX) {
    throw new Error(`${flag} takes the number of a run of sandforge users, not ${run}.`);
  }
  return String(run);
}

/** What a plan, or a run, of a users resource is given. */
export interface UsersLine {
  /** sf CLI alias of the org the environment is applied to. */
  target: string;
  /** The config, written: the file's users and defaults. */
  configFile: string;
  /**
   * Of a replace, the number the script gave the run it replaces: the run
   * converges from what that one held (`--replaces`).
   */
  replacesRun?: number;
  /** The line's `--accept-user-emails`: Salesforce may email the people whose address is asked back. */
  acceptUserEmails?: boolean;
  /** What fires as a user or a login is written is accepted: the line's, or the file's. */
  acceptAutomation?: boolean;
}

/** The switches a plan and a run share. */
function usersSwitches(verb: 'plan' | 'apply', input: UsersLine): string[] {
  return [
    verb,
    '--org',
    valueOf('--org', input.target),
    '--config',
    valueOf('--config', input.configFile),
    ...(input.replacesRun !== undefined
      ? ['--replaces', runNumberOf('--replaces', input.replacesRun)]
      : []),
    ...(input.acceptUserEmails === true ? ['--accept-user-emails'] : []),
    ...(input.acceptAutomation === true ? ['--accept-automation'] : []),
  ];
}

/** The line of a users resource's plan: what a run would change, per user, nothing written. */
export function usersDryRunLine(input: UsersLine): string[] {
  return [...usersSwitches('plan', input), '--json'];
}

/** The line of a users resource's run, unasked. */
export function usersApplyLine(input: UsersLine): string[] {
  return [...usersSwitches('apply', input), '--yes', '--json'];
}

/**
 * The line of the removal of a run, by its number: what the run created
 * deleted by id, each user put back as it was where the org still holds it
 * as the run left it; a profile changed since put back too with
 * `--include-changed`. Nothing written while what fires as a user or a
 * login is written is not accepted.
 */
export function usersRemoveLine(input: {
  target: string;
  run: number;
  includeChanged?: boolean;
  acceptAutomation?: boolean;
}): string[] {
  return [
    'remove',
    '--org',
    valueOf('--org', input.target),
    '--run',
    runNumberOf('--run', input.run),
    ...(input.includeChanged === true ? ['--include-changed'] : []),
    ...(input.acceptAutomation === true ? ['--accept-automation'] : []),
    '--yes',
    '--json',
  ];
}

/** What of a run's summary names it: the number the script gave it. */
const summaryRunSchema = z.object({ run: z.number().int().positive().max(RUN_MAX) }).loose();

/**
 * The number the script gave a run, from the answer it printed, which the
 * environment keeps as the run's summary; undefined when it does not say.
 */
export function usersRunNumberOf(summary: string): number | undefined {
  try {
    const parsed = summaryRunSchema.safeParse(JSON.parse(summary));
    return parsed.success ? parsed.data.run : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The number of the run a summary file names, or why the removal cannot be
 * made: a run's removal names it by that number alone.
 */
export function usersRunOfSummaryFile(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    throw new Error(
      `${file} cannot be read (${err instanceof Error ? err.message : String(err)}): the run of ` +
        'sandforge users it names cannot be taken back from it.',
    );
  }
  const run = usersRunNumberOf(text);
  if (run === undefined) {
    throw new Error(
      `${file} names no run of sandforge users: the run it is the summary of cannot be taken ` +
        'back from it.',
    );
  }
  return run;
}

// ─── The answers ─────────────────────────────────────────────────────────────

/**
 * A plan's answer as the environment reads it: the script's own, which names
 * no tool, told apart from every other kind's by the script that printed it.
 */
export type UsersDryRunAnswer = UsersPlanAnswer & { tool: typeof USERS_SCRIPT };

/** What a users resource's plan printed, read: `usersPlanAnswerSchema`. */
export function readUsersPlan(stdout: string): UsersDryRunAnswer {
  const answer = readAnswer(USERS_SCRIPT, 'the answer of a plan', usersPlanAnswerSchema, stdout);
  return { tool: USERS_SCRIPT, ...answer };
}

/** What a users resource's run printed, read as the script printed it: `usersApplyAnswerSchema`. */
export function readUsersApply(stdout: string): UsersApplyAnswer {
  return readAnswer(USERS_SCRIPT, 'the answer of a run', usersApplyAnswerSchema, stdout);
}

/**
 * What a removal of a users run did, as every kind's removal is read: per
 * object, the assignments and the memberships it deleted, by id, and those
 * the org refused; and, of the users, every change it put back and each it
 * kept, with why.
 */
export interface UsersRemovalAnswer {
  tool: typeof USERS_SCRIPT;
  result: {
    status: UsersRemoveAnswer['status'];
    planned: number;
    objects: EnvRemovalObject[];
  };
  /** The changes put back, every user together: the records deleted among them. */
  undone: number;
  /** What it kept, per user, with why. */
  kept: Array<{ username: string; change: UsersChange; why: string }>;
  answer: UsersRemoveAnswer;
}

/** The object a change of an access is a record of; none for a change of the user itself. */
function accessObjectOf(
  change: UsersChange,
): 'PermissionSetAssignment' | 'GroupMember' | undefined {
  if (change.what === 'permissionSet' || change.what === 'permissionSetGroup') {
    return 'PermissionSetAssignment';
  }
  return change.what === 'group' ? 'GroupMember' : undefined;
}

/** What a users run's removal printed, read: see {@link UsersRemovalAnswer}. */
export function readUsersRemoval(stdout: string): UsersRemovalAnswer {
  const answer = readAnswer(
    USERS_SCRIPT,
    'the outcome of a removal',
    usersRemoveAnswerSchema,
    stdout,
  );
  const counts = new Map<string, { deleted: number; refused: number; reasons: string[] }>();
  const of = (object: string) => {
    const at = counts.get(object) ?? { deleted: 0, refused: 0, reasons: [] };
    counts.set(object, at);
    return at;
  };
  const kept: UsersRemovalAnswer['kept'] = [];
  for (const user of answer.users) {
    for (const change of user.undone) {
      const object = accessObjectOf(change);
      if (object !== undefined) of(object).deleted += 1;
    }
    for (const each of user.kept ?? []) {
      kept.push({ username: user.username, change: each.change, why: each.why });
      const object = accessObjectOf(each.change);
      if (object === undefined) continue;
      const at = of(object);
      at.refused += 1;
      at.reasons.push(`${user.username}: ${changeWords(each.change)}: ${each.why}`);
    }
  }
  const objects: EnvRemovalObject[] = [...counts].map(([objectApiName, at]) => ({
    objectApiName,
    planned: at.deleted + at.refused,
    deleted: at.deleted,
    alreadyGone: 0,
    keptChanged: 0,
    keptDependents: 0,
    refused: at.refused,
    heldBy: [],
    reasons: at.reasons,
  }));
  return {
    tool: USERS_SCRIPT,
    result: {
      status: answer.status,
      planned: objects.reduce((sum, object) => sum + object.planned, 0),
      objects,
    },
    undone: answer.users.reduce((sum, user) => sum + user.undone.length, 0),
    kept,
    answer,
  };
}

// ─── The answers, as the plan and the apply read every kind's ────────────────

/** A change, in the words of a line: what a run does, or would do. */
export function changeWords(change: UsersChange): string {
  switch (change.what) {
    case 'email':
      return 'address asked back, awaiting its owner’s confirmation';
    case 'active':
      return change.to ? 'activated' : 'deactivated';
    case 'frozen':
      return change.to ? 'frozen' : 'unfrozen';
    case 'profile':
      return `profile ${change.to} in place of ${change.from}`;
    case 'permissionSet':
      return `permission set ${change.name} ${change.to === 'added' ? 'added' : 'taken back'}`;
    case 'permissionSetGroup':
      return `permission set group ${change.name} ${change.to === 'added' ? 'added' : 'taken back'}`;
    case 'group':
      return (
        `${change.type === 'Queue' ? 'queue' : 'group'} ${change.name} ` +
        (change.to === 'added' ? 'joined' : 'left')
      );
  }
}

/** The users of a plan that a run would change: one with no change is as the file says. */
function toSetUp(answer: Pick<UsersPlanAnswer, 'users'>): UsersPlanAnswer['users'] {
  return answer.users.filter((user) => user.changes.length > 0);
}

/**
 * What a users plan counted, read as every kind's is: the users a run would
 * change, as the records it writes — a users run creates no record of its
 * own beside the assignments and memberships it adds, and takes no data
 * storage —, the requests it would send, and the emails Salesforce would send
 * to people. What it would be refused for is the script's own words, with
 * their codes. The licenses it takes are said beside.
 */
export function usersDryRunCount(answer: UsersDryRunAnswer): EnvDryRunCount {
  const changing = toSetUp(answer).length;
  const refusals = answer.refusals ?? [];
  const refusal = refusals.length > 0 ? refusals.map((r) => r.message).join(' ') : undefined;
  const codes = [...new Set(refusals.map((r) => r.code))];
  const notes = (answer.licenses ?? [])
    .filter((license) => license.toUse > 0)
    .map(
      (license) =>
        `${license.name}: ${license.used} of ${license.total} used, ${license.toUse} more taken ` +
        'by the activations and the profiles',
    );
  return {
    objects: [{ object: 'User', wouldCreate: changing }],
    total: changing,
    created: 0,
    apiRequests: answer.apiRequests,
    storageBytes: 0,
    emails: [],
    emailsToPeople: answer.emailsToPeople,
    ...(refusal !== undefined ? { refusal } : {}),
    ...(refusal !== undefined && codes.length > 0 ? { refusalCodes: codes } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * What the org holds of a users resource applied, read by its plan now with
 * the last run named (`--previous`): a user the org holds as that run left
 * it has nothing to change, and is kept; one a run would change again —
 * frozen again, an assignment taken away, a profile changed back — is
 * drift, named with what a run would do. A plan refused leaves it unread.
 */
export function usersHeldOf(answer: UsersDryRunAnswer): {
  objects: EnvPlanObject[];
  users: number;
  drift?: string;
  unread?: string;
} {
  const refusals = answer.refusals ?? [];
  if (refusals.length > 0) {
    return { objects: [], users: 0, unread: refusals.map((r) => r.message).join(' ') };
  }
  const changing = toSetUp(answer);
  const held = answer.users.length - changing.length;
  const drift = changing.map(
    (user) => `${user.username} would be ${user.changes.map(changeWords).join(', ')}`,
  );
  return {
    objects: [{ object: 'User', present: held }],
    users: held,
    ...(drift.length > 0 ? { drift: drift.join('; ') } : {}),
  };
}

/** Why a users resource kept as applied is: the org holds its users as the last run left them. */
export function usersKeptWhy(users: number): string {
  return `applied, and the org holds its ${users} user(s) as the last run left them`;
}

/** Why a users resource whose users moved since is drifted, and how to set them up again. */
export function usersDriftWhy(resource: string, drift: string): string {
  return (
    `its users changed since it was applied: ${drift}. Left as they are: --replace ${resource} ` +
    'or --replace-drifted sets them up again, converging from what the last run left'
  );
}

/**
 * What a users run did, read as every kind's run is: no `User` created —
 * the users are set up, never made —, those the org refused a change of,
 * each named with the org's code and words, and the assignments and
 * memberships it created, which a removal deletes by id. A run refused
 * before its first write says why.
 */
export function usersRunCount(answer: UsersApplyAnswer): EnvRunCount {
  const refusedUsers = answer.users.filter((user) => (user.refused ?? []).length > 0);
  const assignments = answer.users.reduce(
    (sum, user) => sum + user.created.permissionSetAssignments.length,
    0,
  );
  const memberships = answer.users.reduce((sum, user) => sum + user.created.groupMembers.length, 0);
  const objects: EnvRunCount['objects'] = [
    {
      object: 'User',
      created: 0,
      refused: refusedUsers.length,
      errors: refusedUsers.flatMap((user) =>
        (user.refused ?? []).map(
          (each) =>
            `${user.username}: ${changeWords(each.change)} refused, ${each.code}: ${each.message}`,
        ),
      ),
    },
    ...(assignments > 0
      ? [{ object: 'PermissionSetAssignment', created: assignments, refused: 0, errors: [] }]
      : []),
    ...(memberships > 0
      ? [{ object: 'GroupMember', created: memberships, refused: 0, errors: [] }]
      : []),
  ];
  const wrote = answer.users.some((user) => user.done.length > 0);
  const refusals = answer.refusals ?? [];
  return {
    objects,
    created: assignments + memberships,
    ...(!wrote && refusals.length > 0
      ? { refusal: refusals.map((refusal) => refusal.message).join(' ') }
      : {}),
  };
}

/** The users a run set up, by username and id alone: what `output` names. */
export function usersSetUpOf(
  answer: UsersApplyAnswer,
): Array<{ username: string; userId: string }> {
  return answer.users.map((user) => ({ username: user.username, userId: user.userId }));
}
