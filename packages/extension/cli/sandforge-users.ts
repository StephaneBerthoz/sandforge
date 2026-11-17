#!/usr/bin/env tsx
/**
 * sandforge-users — set up the users of a sandbox handed back to its testers,
 * a scratch org or a Developer Edition org, without the editor: an address
 * the copy put under `.invalid` asked back, a user activated, frozen or
 * unfrozen, a profile, permission sets, their groups, groups and queues; and
 * take a run back.
 *
 * It is what `sandforge env` runs for a `kind: users` resource, with
 * `--json`, as it runs every other script; and it runs alone. The work is the
 * users module's (`src/modules/users/`): its plan, its run, its removal and
 * its run files. What this script adds is what a command line needs around
 * them, each the one the other scripts already have:
 *
 * - the org typed before anything of it is read, and a production org
 *   refused, whatever the verb: a plan answers of a scratch org, a Developer
 *   Edition org or a sandbox alone, and a production org's users are never
 *   read (`targetKind.ts`);
 * - the deliverability probe (`forge/targetDeliverability.ts`), read only
 *   when a run would ask an address back, its reading handed to the plan,
 *   which holds the gates of the emails: this script passes the line's
 *   acceptances and words none of them;
 * - what the org runs as a user or a login is written, read as Forge reads
 *   it (`TargetAutomationReader`): `AUTOMATION_NOT_ACCEPTED` unless the line
 *   accepts it, as every other module's command line refuses it;
 * - the question before a write, `--yes` in its place;
 * - the requests counted: a plan says what an apply then sends, its own
 *   reads included, and an apply says what it sent.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-users.ts plan --org uat --config testers.json
 *   pnpm exec tsx packages/extension/cli/sandforge-users.ts apply --org uat --config testers.json --accept-user-emails --yes
 *   pnpm exec tsx packages/extension/cli/sandforge-users.ts remove --org uat --run 1 --yes
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { readFileSync } from 'node:fs';
import type { Connection } from 'jsforce';
import {
  USERS_MAX,
  USERS_MAX_GROUPS,
  USERS_MAX_PERMISSION_SET_GROUPS,
  USERS_MAX_PERMISSION_SETS,
  firedOnWriteOf,
  usersConfigSchema,
  usersWithDefaults,
  type ForgeTargetAutomation,
  type UsersApplyAnswer,
  type UsersChange,
  type UsersConfigUser,
  type UsersPlanAnswer,
  type UsersRemoveAnswer,
} from '@sandforge/shared';
import { extractErrorMessage } from '../src/core/common/extractErrorMessage.js';
import { automationUnreadOf } from '../src/modules/forge/ForgeRunGate.js';
import {
  TargetAutomationReader,
  targetAutomationQueries,
} from '../src/modules/forge/TargetAutomationReader.js';
import {
  readEmailDeliverability,
  type DeliverabilityRead,
} from '../src/modules/forge/targetDeliverability.js';
import { applyUsers } from '../src/modules/users/usersApply.js';
import { usersOrgOf, type UsersOrg } from '../src/modules/users/usersOrg.js';
import {
  planUsers,
  usersPlanAnswerOf,
  type UsersOrgSummary,
  type UsersPlan,
  type UsersPlanOptions,
  type UsersRefusal,
} from '../src/modules/users/usersPlan.js';
import { removeUsersRun } from '../src/modules/users/usersRemoval.js';
import { ADDRESS_LINK_HOURS, idKey, readUsersState } from '../src/modules/users/usersResolve.js';
import {
  UsersRunStore,
  defaultUsersStoreRoot,
  type UsersRunRecord,
} from '../src/modules/users/usersRunStore.js';
import { SF_ALIAS_RE, unreadArgument, type CommandFlags } from './commandLine.js';
import { DONE_EXIT, FAILED_EXIT, PARTIAL_EXIT, endWith } from './exitCodes.js';
import { commandOf, nameOf } from './invocation.js';
import { confirm } from './prompt.js';
import { refusedLine, wouldBeRefusedLine } from './runRefused.js';
import { loadOrg, makeConn, type SfOrg } from './sfSession.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import {
  isProductionTarget,
  typeTarget,
  untypedTargetRefusal,
  type TypedTarget,
} from './targetKind.js';
import { holdOutputWhole } from './wholeOutput.js';

const TOOL = 'sandforge-users';

/** The code an automation the line did not accept refuses a run with, as every module's. */
export const AUTOMATION_NOT_ACCEPTED = 'AUTOMATION_NOT_ACCEPTED';

/** The code of a run to replace, or to take back, that this machine does not keep for the org. */
export const USERS_RUN_NOT_FOUND = 'USERS_RUN_NOT_FOUND';

/** The code of a run to replace that another run replaced already. */
export const USERS_RUN_REPLACED = 'USERS_RUN_REPLACED';

export const HELP = `sandforge users — set up the users of a sandbox handed back to its testers, a scratch org
or a Developer Edition org: an address the copy put under .invalid asked back, a user activated,
frozen or unfrozen, a profile, permission sets, permission set groups, groups and queues given;
and take a run back.

It is what sandforge env runs for a users resource of sandforge.yaml, which it applies before
every other resource and takes back after them all; it runs alone as well.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-users.ts plan --org <alias> --config <file.json> [options]
  pnpm exec tsx packages/extension/cli/sandforge-users.ts apply --org <alias> --config <file.json> (--dry-run | --yes) [options]
  pnpm exec tsx packages/extension/cli/sandforge-users.ts remove --org <alias> --run <n> [--yes] [options]

  Run from the repository root of a checkout, after pnpm install and
  pnpm build:shared.

Verbs:
  plan      read the org and say, user by user, what a run would change; the
            licenses it takes, the emails Salesforce would send to people, what
            the org runs as users are written, the requests an apply sends, and
            each refusal a run would meet. Nothing is written. Exit 1 when a
            run would be refused
  apply     the plan, then, when nothing refuses it, the writes in this order:
            profiles; deactivations, then activations; freezes and unfreezes;
            permission sets and their groups; groups and queues; the addresses
            last, so that a run stopped before has mailed nobody; then a read
            of what it wrote. The run is kept on this machine as run <n> before
            its first write, and again after each step
  remove    take run <n> back: the memberships and assignments it created,
            each by its id, then each freeze, activation and profile put back
            as it was before the run, where the org still holds what the run
            left. An assignment or a membership the user held before is never
            touched

Required:
  --org <alias>          sf CLI alias of the sandbox, scratch org or Developer
                         Edition org. A production org is refused before
                         anything of it is read, whatever the verb, and nothing
                         lifts it
  --config <file.json>   (plan, apply) the users to set up, as a users resource
                         of sandforge.yaml lists them (below)
  --run <n>              (remove) the run to take back, as apply named it

Options:
  --dry-run              (apply) the plan, nothing written: what the run would
                         change and the requests it would send
  --yes                  (apply, remove) do not ask; without it and with no
                         terminal, stop at the question, exit 2
  --replaces <n>         (plan, apply) the run this one replaces, which
                         sandforge env names: converge from what it held — add
                         what is missing, take back what it added that the
                         config no longer names, put a user it no longer lists
                         back as it was. Never all taken back then done again
  --accept-user-emails   (plan, apply) let Salesforce email the people whose
                         address is asked back: the confirmation link, a system
                         email, which leaves under System email only too.
                         USERS_EMAILS_NOT_ACCEPTED, exit 1, without it, as soon
                         as one address is asked
  --accept-emails        (plan, apply) ask addresses back in an org that
                         delivers all email (Setup > Deliverability, read with
                         one line of anonymous Apex that sends nothing), where
                         what runs there emails these people from then on.
                         USERS_EMAILS_OPEN, exit 1, without it; set the org to
                         System email only until the masking is done instead
  --accept-automation    (plan, apply, remove) write although the org runs
                         flows, Apex triggers, processes or workflow rules as a
                         user or a login is written, or could not say what it
                         runs: AUTOMATION_NOT_ACCEPTED, exit 1, nothing
                         written, without it. sandforge env gives it for a
                         resource that says accept: { automation: true }
  --include-changed      (remove) put back a profile someone changed since the
                         run all the same
  --json                 print the answer as JSON on stdout, every other line on
                         stderr
  -h, --help             show this help and exit

The config, JSON:
  {"defaults": {"email": "restore", "frozen": false},
   "users": [{"username": "jane.qa@acme.com", "permissionSets": ["QA_Tools"], "groups": ["QA_Team"]},
             {"username": "paul.qa@acme.com", "active": true, "profile": "QA Tester"}]}

  users                  1 to ${USERS_MAX}, each username once, whatever its case
  username               production's (jane.qa@acme.com) or the sandbox's whole
                         (jane.qa@acme.com.uat): read as given, then as given
                         followed by .<sandbox>, which must name exactly one user
  email                  restore asks back the address the copy put under
                         .invalid; keep (the default) leaves it
  active, frozen         true or false; absent, left as they are
  profile                Profile.Name, exact, in the org's language for a
                         standard profile
  permissionSets         API names, ${USERS_MAX_PERMISSION_SETS} at most
  permissionSetGroups    API names, ${USERS_MAX_PERMISSION_SET_GROUPS} at most
  groups                 DeveloperName of a public group or a queue, ${USERS_MAX_GROUPS} at most
  defaults               the same keys but username; a key a user gives
                         replaces the default's whole, a list included

What it never does: take away an assignment, a membership or a permission set
the config does not name; delete a user, which Salesforce does not do; reset a
password — once an address is restored, its owner asks for one with
"Forgot your password?" on the sandbox's login page; or put an address back
under .invalid. An address asked back is not restored at once: Salesforce
mails a link to it and keeps the old one until the link is clicked
(${ADDRESS_LINK_HOURS} h). The run says it awaits its owner; a later plan reads it restored.

Refused before its first write, exit 1, nothing written: a production org, or
one that will not say what it is; USERS_NO_USER, a username no user has;
USERS_TWO_USERS, one two users have; USERS_NO_RIGHT, a connection without
Manage Users; USERS_SELF, the user connected frozen, deactivated or given
another profile; USERS_LICENSE, more activations or profiles than the licenses
have free, counted on the whole plan; USERS_PROFILE_UNKNOWN,
USERS_PERMISSION_SET_UNKNOWN, USERS_GROUP_UNKNOWN, a name the org does not
hold, its close names listed; USERS_PERMISSION_SET_LICENSE, a permission set
whose license the user lacks; USERS_EMAILS_NOT_ACCEPTED, USERS_EMAILS_OPEN and
AUTOMATION_NOT_ACCEPTED, above; USERS_RUN_NOT_FOUND, a run this machine does
not keep for the org (a refreshed sandbox answers another Organization Id);
USERS_RUN_REPLACED, a run to replace that another run replaced already.

Each run is kept in <SANDFORGE_JOURNAL_DIR, or ~/.sandforge>/users/<Organization
Id>/run-<n>.json, its owner's alone and never inside a repository: ids,
usernames, booleans and the names of profiles, permission sets and groups;
never an address, never a person's name.

Exit codes:
  0  plan: a run would go; apply: every user set up, an address awaiting its
     owner included, said; remove: everything put back
  1  refused before its first write, every refusal said (the plan, the dry run
     and the apply alike), or the org could not be reached
  2  a bad command line or config, or a question with no terminal to answer it
     (give --yes)
  3  partial: the org refused a write the plan took for possible — a license
     taken since, a deactivation it will not do —, the user named in the org's
     code and words, the others set up; or a removal kept something, said why
  130  Ctrl-C (143 SIGTERM, 129 SIGHUP): the run ends after the step under
     way, its file saying what it holds, for remove to take back
`;

// ─── The line ────────────────────────────────────────────────────────────────

const VERBS = ['plan', 'apply', 'remove'] as const;
type Verb = (typeof VERBS)[number];

/** Every flag the command reads, each verb some of them. */
export const USERS_FLAGS: CommandFlags = {
  words: 1,
  switches: [
    '--dry-run',
    '--yes',
    '--json',
    '--accept-user-emails',
    '--accept-emails',
    '--accept-automation',
    '--include-changed',
  ],
  values: ['--org', '--config', '--run', '--replaces'],
};

const PLAN_FLAGS = [
  '--org',
  '--config',
  '--replaces',
  '--accept-user-emails',
  '--accept-emails',
  '--accept-automation',
  '--json',
] as const;

/** The flags each verb reads: any other of the command's is refused for it. */
const VERB_FLAGS: Readonly<Record<Verb, readonly string[]>> = {
  plan: PLAN_FLAGS,
  apply: [...PLAN_FLAGS, '--dry-run', '--yes'],
  remove: ['--org', '--run', '--include-changed', '--accept-automation', '--yes', '--json'],
};

/** What a line asks. */
export interface UsersArgs {
  verb: Verb;
  org: string;
  config?: string;
  run?: number;
  replaces?: number;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  acceptUserEmails: boolean;
  acceptEmails: boolean;
  acceptAutomation: boolean;
  includeChanged: boolean;
}

/** Stop the command, exit 2, before any org is reached. */
function refuseLine(reason: string): never {
  process.stderr.write(`${reason} Nothing was run. Run with --help.\n`);
  process.exit(2);
}

/** A run's number: a whole number from 1. */
function runNumber(flag: string, value: string): number {
  if (!/^[1-9]\d{0,5}$/.test(value)) {
    refuseLine(`${flag} takes a run's number, as apply named it: "${value}" is not one.`);
  }
  return Number(value);
}

/**
 * What the words after the command ask, or the line refused, exit 2: a verb
 * first, then the flags that verb reads, each value after its flag.
 */
export function parseArgs(words: readonly string[]): UsersArgs {
  const [verb] = words;
  if (verb === undefined) refuseLine('Name the verb: plan, apply or remove.');
  if (!(VERBS as readonly string[]).includes(verb)) {
    refuseLine(
      verb.startsWith('-')
        ? `"${verb}" comes before the verb: name plan, apply or remove first.`
        : `"${verb}" is not a verb of ${nameOf(TOOL)}: plan, apply or remove.`,
    );
  }
  const asked = verb as Verb;
  const unread = unreadArgument(words, USERS_FLAGS);
  if (unread !== undefined) refuseLine(unread.replace(/ Nothing was run\.$/, ''));
  const given = new Map<string, string>();
  const on = new Set<string>();
  for (let at = 1; at < words.length; at++) {
    const word = words[at];
    if (USERS_FLAGS.values.includes(word)) {
      if (given.has(word)) refuseLine(`${word} is given twice.`);
      given.set(word, words[at + 1]);
      at++;
    } else on.add(word);
  }
  for (const flag of [...given.keys(), ...on]) {
    if (!VERB_FLAGS[asked].includes(flag)) {
      refuseLine(`${flag} is not read by ${asked}: it reads ${VERB_FLAGS[asked].join(', ')}.`);
    }
  }
  const org = given.get('--org');
  if (org === undefined) refuseLine(`${asked} needs --org <alias>.`);
  if (!SF_ALIAS_RE.test(org)) {
    refuseLine(
      `--org takes an sf alias or a username: "${org}" is neither (letters, digits, _ . @ + ` +
        'and -, not first . @ + or -).',
    );
  }
  const config = given.get('--config');
  if (asked !== 'remove' && config === undefined)
    refuseLine(`${asked} needs --config <file.json>.`);
  const run = given.get('--run');
  if (asked === 'remove' && run === undefined) refuseLine('remove needs --run <n>.');
  const replaces = given.get('--replaces');
  if (asked === 'apply' && on.has('--dry-run') && on.has('--yes')) {
    refuseLine('--dry-run writes nothing and --yes writes: give one of them.');
  }
  return {
    verb: asked,
    org,
    ...(config !== undefined ? { config } : {}),
    ...(run !== undefined ? { run: runNumber('--run', run) } : {}),
    ...(replaces !== undefined ? { replaces: runNumber('--replaces', replaces) } : {}),
    dryRun: on.has('--dry-run'),
    yes: on.has('--yes'),
    json: on.has('--json'),
    acceptUserEmails: on.has('--accept-user-emails'),
    acceptEmails: on.has('--accept-emails'),
    acceptAutomation: on.has('--accept-automation'),
    includeChanged: on.has('--include-changed'),
  };
}

/**
 * The users of a config file, each with the defaults it does not override,
 * or the line refused, exit 2, with where the contract refuses it.
 */
export function readConfig(file: string): UsersConfigUser[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    refuseLine(`--config ${file} could not be read (${extractErrorMessage(err)}).`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (err: unknown) {
    refuseLine(`--config ${file} is not JSON (${extractErrorMessage(err)}).`);
  }
  const parsed = usersConfigSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path
        .map((part, at) =>
          typeof part === 'number' ? `[${part}]` : `${at === 0 ? '' : '.'}${String(part)}`,
        )
        .join('');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    });
    refuseLine(`--config ${file}: ${issues.join('; ')}.`);
  }
  return usersWithDefaults(parsed.data);
}

// ─── Words ───────────────────────────────────────────────────────────────────

const KIND_WORDS: Readonly<Record<UsersOrgSummary['kind'], string>> = {
  scratch: 'scratch org',
  developer: 'Developer Edition org',
  sandbox: 'sandbox',
};

/** One change of a user, as a line says it: the same words for a run and its removal. */
export function changeWords(change: UsersChange): string {
  const done = (to: 'added' | 'removed'): string => (to === 'added' ? 'added' : 'taken back');
  switch (change.what) {
    case 'email':
      return 'address asked back';
    case 'active':
      return change.to ? 'activated' : 'deactivated';
    case 'frozen':
      return change.to ? 'frozen' : 'unfrozen';
    case 'profile':
      return `profile ${change.to} in place of ${change.from}`;
    case 'permissionSet':
      return `permission set ${change.name} ${done(change.to)}`;
    case 'permissionSetGroup':
      return `permission set group ${change.name} ${done(change.to)}`;
    case 'group':
      return `${change.type === 'Queue' ? 'queue' : 'group'} ${change.name} ${done(change.to)}`;
  }
}

/** The line of an address asked back, which awaits its owner. */
const AWAITING =
  "address awaiting its owner's confirmation — Salesforce sent the link to it; until it is " +
  `clicked (${ADDRESS_LINK_HOURS} h), the address stays .invalid`;

/** The org a line names: its alias, its kind and its Organization Id. */
function orgWords(org: UsersOrgSummary): string {
  return `${org.alias ?? org.organizationId} (${KIND_WORDS[org.kind]}, ${org.organizationId})`;
}

/** Each refusal a run would meet, as the lines of a plan say it. */
function wouldBeRefusedLines(refusals: readonly UsersRefusal[]): string[] {
  return refusals.map((refusal) => wouldBeRefusedLine(refusal, 'a run now'));
}

// ─── The org ─────────────────────────────────────────────────────────────────

/**
 * Why the command reads nothing of the org: it is a production org. The rule
 * is the guard every command shares (`isProductionTarget`), its words those
 * of `productionTargetRefusal` but for the read-only way out that one names:
 * here no verb reads such an org, a plan included, since a plan answers of a
 * scratch org, a Developer Edition org or a sandbox alone.
 */
export function usersProductionRefusal(alias: string, org: TypedTarget): string {
  const said = org.edition
    ? `IsSandbox false, edition ${org.edition}`
    : 'IsSandbox false, and no edition';
  return (
    `${alias} is a production org (its Organization record says ${said}): ${nameOf(TOOL)} sets ` +
    'up the users of a sandbox, a scratch org or a Developer Edition org, and reads nothing of a ' +
    'production org. Nothing was read or written.'
  );
}

/** The org reached, typed, as the answers name it; and the requests its typing sent. */
interface Reached {
  conn: Connection;
  org: UsersOrg;
  organization: UsersOrgSummary;
  /** The requests sent outside the users module's port: the Organization record's. */
  typingRequests: number;
}

/**
 * Reach the org the alias names and type it before anything else is read:
 * a production org, or one that will not say what it is, stops the command,
 * exit 1. Then the user connected, whose username the answers carry.
 */
async function reachOrg(alias: string): Promise<Reached> {
  let sfOrg: SfOrg;
  try {
    sfOrg = await loadOrg(alias);
  } catch (err: unknown) {
    process.stderr.write(`${extractErrorMessage(err)}\n`);
    process.exit(FAILED_EXIT);
  }
  const conn = makeConn(sfOrg);
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
    process.stderr.write(
      `${untypedTargetRefusal(alias, err, { tool: nameOf(TOOL), action: 'write', readOnly: 'plan' })}\n`,
    );
    process.exit(FAILED_EXIT);
  }
  if (isProductionTarget(typed)) {
    process.stderr.write(`${usersProductionRefusal(alias, typed)}\n`);
    process.exit(FAILED_EXIT);
  }
  const org = usersOrgOf(conn);
  const connected = await org.identity();
  if (idKey(connected.organizationId) !== idKey(typed.id)) {
    process.stderr.write(
      `The session sf gave for ${alias} is of ${connected.organizationId}, and its Organization ` +
        `record says ${typed.id}: nothing was read or written. Sign in to ${alias} again with sf.\n`,
    );
    process.exit(FAILED_EXIT);
  }
  return {
    conn,
    org,
    organization: {
      organizationId: typed.id,
      kind: sfOrg.scratch === true ? 'scratch' : typed.sandbox ? 'sandbox' : 'developer',
      alias,
      username: connected.username,
    },
    typingRequests,
  };
}

/** The store of the runs, outside any repository; a store inside one stops the command, exit 1. */
function storeOf(): UsersRunStore {
  try {
    return new UsersRunStore({ root: defaultUsersStoreRoot() });
  } catch (err: unknown) {
    process.stderr.write(`${extractErrorMessage(err)} Nothing was read or written.\n`);
    process.exit(FAILED_EXIT);
  }
}

// ─── What the org runs as users are written ──────────────────────────────────

/** What the read of the org's automation came to: read, not read and why, or not asked. */
type AutomationRead =
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

/**
 * Read what the org runs on `objects` as their records are updated: a user's
 * profile, activation and address are `User` rows, a freeze a `UserLogin`
 * row. A permission set assignment and a group membership run nothing a
 * flow or a trigger can be written on. Never throws: what kept the read from
 * an answer is said.
 */
async function readAutomation(
  conn: Connection,
  alias: string,
  objects: readonly string[],
): Promise<AutomationRead> {
  if (objects.length === 0) return { kind: 'none' };
  try {
    const reader = new TargetAutomationReader(targetAutomationQueries(async () => conn));
    return { kind: 'read', automation: await reader.read(alias, objects) };
  } catch (err: unknown) {
    return { kind: 'unread', reason: extractErrorMessage(err) };
  }
}

/** What fires, per object, as `objects` are updated. */
function firedOf(read: AutomationRead) {
  return read.kind === 'read' ? firedOnWriteOf(read.automation, 'update') : [];
}

/** The lines a plan, or a removal, says of what the org runs as it writes. */
function automationLines(read: AutomationRead, alias: string, writes: string): string[] {
  if (read.kind === 'none') {
    return ['automation: none read: this run writes no user and no login'];
  }
  if (read.kind === 'unread') {
    return [`automation: what ${alias} runs as ${writes} could not be read (${read.reason})`];
  }
  const fired = firedOf(read);
  const unread = automationUnreadOf(read.automation);
  if (fired.length === 0 && unread.length === 0) {
    return [`automation: ${alias} runs nothing as ${writes}`];
  }
  return [
    ...(fired.length > 0 ? [`automation: ${alias} runs as ${writes}:`] : []),
    ...fired.map(
      (entry) =>
        `  ${entry.objectApiName}: ${firedWords(entry.kind, entry.name)} (${SAVE_WHEN[entry.when]})`,
    ),
    ...unread.map(
      ({ part, reason }) =>
        `  ${UNREAD_WORDS[part] ?? part} of ${alias} could not be read: ${reason}`,
    ),
  ];
}

/**
 * Why a run, or a removal, will not write without its automation accepted:
 * what fires, named, or what could not be read. Nothing when nothing fires
 * and everything was read, or when the line accepts it.
 */
function automationRefusal(
  read: AutomationRead,
  alias: string,
  writes: string,
  accepted: boolean,
): UsersRefusal | undefined {
  if (accepted || read.kind === 'none') return undefined;
  const lifted =
    'Nothing was written. Add --accept-automation to write all the same (accept: { automation: ' +
    `true } on the users resource of sandforge.yaml), or turn that automation off in ${alias} first.`;
  if (read.kind === 'unread') {
    return {
      code: AUTOMATION_NOT_ACCEPTED,
      message:
        `What ${alias} runs as ${writes} could not be read (${read.reason}), so what fires is ` +
        `not known. ${lifted}`,
    };
  }
  const fired = firedOf(read);
  const unread = automationUnreadOf(read.automation);
  if (fired.length === 0 && unread.length === 0) return undefined;
  const parts: string[] = [];
  if (fired.length > 0) {
    const named = fired.map(
      (entry) =>
        `${entry.objectApiName}: ${firedWords(entry.kind, entry.name)} (${SAVE_WHEN[entry.when]})`,
    );
    parts.push(`${alias} runs automation as ${writes}: ${named.join('; ')}.`);
  }
  for (const { part, reason } of unread) {
    parts.push(
      `${UNREAD_WORDS[part] ?? part} of ${alias} could not be read (${reason}), so what fires ` +
        `as ${writes} is not known.`,
    );
  }
  parts.push(lifted);
  return { code: AUTOMATION_NOT_ACCEPTED, message: parts.join(' ') };
}

/** The requests a read of the automation sent. */
function automationRequests(read: AutomationRead): number {
  return read.kind === 'read' ? read.automation.requests : 0;
}

/** The objects whose rows a run updates: `User` for a profile, an activation or an address; `UserLogin` for a freeze. */
function writtenByPlan(plan: UsersPlan): string[] {
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
function writtenByRemoval(record: UsersRunRecord): string[] {
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
function deliverabilityOf(
  read: DeliverabilityRead,
): NonNullable<UsersPlanOptions['deliverability']> {
  const { reading } = read;
  if ('unread' in reading) return 'unread';
  return reading.level === 'all' ? 'open' : 'closed';
}

/** The line a plan says of the probe's reading. */
function deliverabilityLine(read: DeliverabilityRead, alias: string): string {
  const { reading } = read;
  if ('unread' in reading) return `deliverability: not read (${reading.unread})`;
  return reading.level === 'all'
    ? `deliverability: All email — what runs in ${alias} emails the addresses its records hold`
    : 'deliverability: closed — System email only or No access: what runs there emails nobody. ' +
        'Which of the two, no API says.';
}

// ─── The verbs ───────────────────────────────────────────────────────────────

/** Say a line: on stdout, or on stderr under --json, where stdout carries the answer alone. */
function sayer(json: boolean): (line: string) => void {
  return (line) => (json ? process.stderr : process.stdout).write(`${line}\n`);
}

function printAnswer(answer: UsersPlanAnswer | UsersApplyAnswer | UsersRemoveAnswer): void {
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
}

/** A plan refused before anything of the users was read: no user, no request to come. */
function refusedPlan(
  organization: UsersOrgSummary,
  refusal: UsersRefusal,
  sent: number,
): UsersPlanAnswer {
  return {
    org: organization,
    users: [],
    emailsToPeople: 0,
    apiRequests: sent,
    refusals: [refusal],
  };
}

/** The run `--replaces` names, or why it cannot be replaced. */
async function replacedRun(
  store: UsersRunStore,
  organizationId: string,
  run: number,
): Promise<{ record: UsersRunRecord } | { refusal: UsersRefusal }> {
  const record = await store.read(organizationId, run);
  if (!record) {
    return {
      refusal: {
        code: USERS_RUN_NOT_FOUND,
        message:
          `--replaces ${run}: this machine keeps no run of that number for this org, whose ` +
          `Organization Id is ${organizationId}: a sandbox refreshed since answers another, and ` +
          'its runs went with the copy they set up. Plan without --replaces to set the users up anew',
      },
    };
  }
  const replacing = (await store.list(organizationId)).find((each) => each.replaces === run);
  if (replacing) {
    return {
      refusal: {
        code: USERS_RUN_REPLACED,
        message:
          `run ${run} was replaced by run ${replacing.run}, which holds what it set up: ` +
          `--replaces ${replacing.run}`,
      },
    };
  }
  return { record };
}

/** The lines of a plan. */
function planLines(
  answer: UsersPlanAnswer,
  extra: { deliverability?: DeliverabilityRead; automation: AutomationRead; sent: number },
  args: UsersArgs,
): string[] {
  const alias = args.org;
  const lines = [`plan of the users of ${orgWords(answer.org)}`];
  for (const user of answer.users) {
    const who =
      user.given !== undefined ? `${user.username} (${user.given} in the config)` : user.username;
    let what: string;
    if (user.userId === undefined) what = 'no single user has this username (below)';
    else if (user.changes.length > 0) what = user.changes.map(changeWords).join(', ');
    else if (user.address === 'awaiting') {
      what = "its address asked back by an earlier run, awaiting its owner's click";
    } else what = 'as the config says already: nothing to do';
    lines.push(`  ${who}: ${what}`);
  }
  if (answer.licenses !== undefined) {
    lines.push(
      `licenses: ${answer.licenses
        .map(
          (license) =>
            `${license.name} ${license.used} of ${license.total} used, ${license.toUse} more`,
        )
        .join('; ')}`,
    );
  }
  if (answer.emailsToPeople > 0) {
    lines.push(
      `emails to people: ${answer.emailsToPeople}, the confirmation of each address asked back, ` +
        'a system email, which leaves under System email only too' +
        (args.acceptUserEmails ? '; accepted (--accept-user-emails)' : ''),
    );
  }
  if (extra.deliverability !== undefined)
    lines.push(deliverabilityLine(extra.deliverability, alias));
  lines.push(...automationLines(extra.automation, alias, 'users are written'));
  lines.push(
    `API requests: ${extra.sent} sent by this plan; an apply sends about ${answer.apiRequests}`,
  );
  lines.push(...wouldBeRefusedLines(answer.refusals ?? []));
  return lines;
}

/** The lines of a run. */
function applyLines(answer: UsersApplyAnswer, alias: string): string[] {
  const lines = [`run ${answer.run} of the users of ${orgWords(answer.org)}: ${answer.status}`];
  for (const user of answer.users) {
    const done = user.done.filter((change) => change.what !== 'email');
    if (done.length > 0) lines.push(`  ${user.username}: ${done.map(changeWords).join(', ')}`);
    if (user.address === 'awaiting' && user.done.some((change) => change.what === 'email')) {
      lines.push(`  ${user.username}: ${AWAITING}`);
    }
    if (user.address === 'restored' && user.done.some((change) => change.what === 'email')) {
      lines.push(`  ${user.username}: address restored`);
    }
    for (const refused of user.refused ?? []) {
      lines.push(
        `  ${user.username}: refused ${changeWords(refused.change)}: ${refused.code} ${refused.message}`,
      );
    }
    if (user.done.length === 0 && (user.refused ?? []).length === 0) {
      lines.push(`  ${user.username}: nothing to do`);
    }
  }
  lines.push(
    `taken back by: ${commandOf('users')} remove --org ${alias} --run ${answer.run} --yes`,
  );
  lines.push(`API requests: ${answer.apiRequests}`);
  return lines;
}

/** The lines of a removal. */
function removeLines(answer: UsersRemoveAnswer, alias: string): string[] {
  const lines = [`removal of run ${answer.run} of the users of ${alias}: ${answer.status}`];
  for (const user of answer.users) {
    lines.push(
      `  ${user.username}: ${user.undone.length > 0 ? user.undone.map(changeWords).join(', ') : 'nothing put back'}`,
    );
    for (const kept of user.kept ?? []) {
      lines.push(`  ${user.username}: kept ${changeWords(kept.change)}: ${kept.why}`);
    }
  }
  for (const refusal of answer.refusals ?? []) lines.push(refusedLine(refusal));
  lines.push(`API requests: ${answer.apiRequests}`);
  return lines;
}

/** The exit code of a run or a removal, from how it ended. */
function statusExit(status: UsersApplyAnswer['status'], stopped: StopSignal | undefined): number {
  if (status === 'cancelled') return stopExitCode(stopped ?? 'SIGINT');
  if (status === 'partial') return PARTIAL_EXIT;
  if (status === 'failure') return FAILED_EXIT;
  return DONE_EXIT;
}

/** Hear Ctrl-C as a stop after the step under way, and say so. */
function stopAfterStep(): {
  signal: AbortSignal;
  stopped: () => StopSignal | undefined;
  release: () => void;
} {
  const controller = new AbortController();
  let stopped: StopSignal | undefined;
  const release = onStopSignal((signal) => {
    stopped = signal;
    process.stderr.write(
      '\ninterrupted: the run ends after the step under way, its file saying what it holds ' +
        '(Ctrl-C again ends it at once)\n',
    );
    controller.abort();
  });
  return { signal: controller.signal, stopped: () => stopped, release };
}

/** plan, and apply: see the verbs of {@link HELP}. */
async function planOrApply(args: UsersArgs, users: readonly UsersConfigUser[]): Promise<void> {
  const say = sayer(args.json);
  const reached = await reachOrg(args.org);
  const { conn, org, organization } = reached;
  const store = storeOf();

  const sentSoFar = (more: number): number => reached.typingRequests + org.requests() + more;
  let previous: UsersRunRecord | undefined;
  if (args.replaces !== undefined) {
    const replaced = await replacedRun(store, organization.organizationId, args.replaces);
    if ('refusal' in replaced) {
      const answer = refusedPlan(organization, replaced.refusal, sentSoFar(0));
      say(`plan of the users of ${orgWords(organization)}`);
      process.stderr.write(`${refusedLine(replaced.refusal)}\n`);
      if (args.json) printAnswer(answer);
      endWith(FAILED_EXIT);
      return;
    }
    previous = replaced.record;
  }

  const state = await readUsersState(org, users, {
    now: new Date(),
    ...(previous ? { previous } : {}),
  });
  const options: UsersPlanOptions = {
    ...(previous ? { previous } : {}),
    acceptUserEmails: args.acceptUserEmails,
    acceptEmails: args.acceptEmails,
  };
  let plan = planUsers(state, users, options);
  // Read only when an address is asked back: what the org delivers matters
  // to no other write of a run.
  let deliverability: DeliverabilityRead | undefined;
  if (plan.emailsToPeople > 0) {
    deliverability = await readEmailDeliverability(conn);
    plan = planUsers(state, users, {
      ...options,
      deliverability: deliverabilityOf(deliverability),
    });
  }
  const automation = await readAutomation(conn, args.org, writtenByPlan(plan));
  const refusedAutomation = automationRefusal(
    automation,
    args.org,
    'users are written',
    args.acceptAutomation,
  );
  const outside = (): number => (deliverability?.requests ?? 0) + automationRequests(automation);
  const sent = sentSoFar(outside());
  // An apply sends all this plan sent, then reads the users again before its
  // first write, then writes: what the plan's answer says it sends.
  const planned = usersPlanAnswerOf(plan, organization, sent + state.requests);
  const refusals = [...(planned.refusals ?? []), ...(refusedAutomation ? [refusedAutomation] : [])];
  const answer: UsersPlanAnswer = { ...planned, ...(refusals.length > 0 ? { refusals } : {}) };

  for (const line of planLines(
    answer,
    { ...(deliverability ? { deliverability } : {}), automation, sent },
    args,
  )) {
    say(line);
  }

  if (args.verb === 'plan' || args.dryRun) {
    if (args.dryRun) say('a dry run: nothing was written');
    if (args.json) printAnswer(answer);
    endWith(refusals.length > 0 ? FAILED_EXIT : DONE_EXIT);
    return;
  }

  if (refusals.length > 0) {
    for (const refusal of refusals) process.stderr.write(`${refusedLine(refusal)}\n`);
    process.stderr.write('Nothing was written.\n');
    if (args.json) printAnswer(answer);
    endWith(FAILED_EXIT);
    return;
  }

  const changing = answer.users.filter((user) => user.changes.length > 0).length;
  if (!args.yes) {
    const question =
      `Set up ${changing} user${changing === 1 ? '' : 's'} of ${args.org} as above` +
      (answer.emailsToPeople > 0
        ? `, Salesforce emailing ${answer.emailsToPeople} ${answer.emailsToPeople === 1 ? 'person' : 'people'}?`
        : '?');
    if (!(await confirm(question))) {
      say('Nothing was written.');
      return;
    }
  }

  const stop = stopAfterStep();
  let outcome: Awaited<ReturnType<typeof applyUsers>>;
  try {
    outcome = await applyUsers({
      org,
      organization,
      users,
      store,
      signal: stop.signal,
      ...options,
      ...(deliverability ? { deliverability: deliverabilityOf(deliverability) } : {}),
    });
  } finally {
    stop.release();
  }

  if (outcome.kind === 'refused') {
    // The org changed between the plan's read and the run's: refused as the plan refuses.
    const again = outcome.plan;
    for (const refusal of again.refusals ?? []) process.stderr.write(`${refusedLine(refusal)}\n`);
    process.stderr.write('The org changed since the plan read it. Nothing was written.\n');
    if (args.json) printAnswer(again);
    endWith(FAILED_EXIT);
    return;
  }
  const applied: UsersApplyAnswer = { ...outcome.answer, apiRequests: sentSoFar(outside()) };
  for (const line of applyLines(applied, args.org)) say(line);
  if (args.json) printAnswer(applied);
  endWith(statusExit(applied.status, stop.stopped()));
}

/** remove: see the verbs of {@link HELP}. */
async function remove(args: UsersArgs): Promise<void> {
  const say = sayer(args.json);
  const run = args.run ?? 0;
  const reached = await reachOrg(args.org);
  const { conn, org, organization } = reached;
  const store = storeOf();
  let automation: AutomationRead = { kind: 'none' };

  // A run this machine keeps, and none has replaced: the question is asked,
  // and what the org runs as it is put back is read. Any other is refused by
  // the removal itself, before it reads a user, with nothing asked.
  const record = await store.read(organization.organizationId, run);
  const replaced =
    record !== undefined &&
    (await store.list(organization.organizationId)).some((each) => each.replaces === run);
  if (record !== undefined && !replaced) {
    automation = await readAutomation(conn, args.org, writtenByRemoval(record));
    const refused = automationRefusal(
      automation,
      args.org,
      'users are put back',
      args.acceptAutomation,
    );
    if (automation.kind !== 'none') {
      for (const line of automationLines(automation, args.org, 'users are put back')) say(line);
    }
    if (refused !== undefined) {
      const answer: UsersRemoveAnswer = {
        org: organization,
        run,
        status: 'failure',
        users: [],
        apiRequests: reached.typingRequests + org.requests() + automationRequests(automation),
        refusals: [refused],
      };
      process.stderr.write(`${refusedLine(refused)}\n`);
      if (args.json) printAnswer(answer);
      endWith(FAILED_EXIT);
      return;
    }
    if (!args.yes && !(await confirm(`Take back run ${run} of the users of ${args.org}?`))) {
      say('Nothing was written.');
      return;
    }
  }

  const stop = stopAfterStep();
  let removed: UsersRemoveAnswer;
  try {
    removed = await removeUsersRun({
      org,
      organization,
      store,
      run,
      includeChanged: args.includeChanged,
      signal: stop.signal,
    });
  } finally {
    stop.release();
  }
  const answer: UsersRemoveAnswer = {
    ...removed,
    apiRequests: reached.typingRequests + org.requests() + automationRequests(automation),
  };
  for (const line of removeLines(answer, args.org)) say(line);
  if (args.json) printAnswer(answer);
  endWith(statusExit(answer.status, stop.stopped()));
}

/**
 * Run what the line asks: its help, a plan, a run or a removal.
 *
 * @param argv - The whole line, runtime and this file first.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const words = argv.slice(2);
  if (words.includes('--help') || words.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const args = parseArgs(words);
  if (args.verb === 'remove') {
    await remove(args);
    return;
  }
  await planOrApply(args, readConfig(args.config ?? ''));
}

// Only when run as a script: importing the module must start nothing.
if (/sandforge-users\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  holdOutputWhole();
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(FAILED_EXIT);
    });
}
