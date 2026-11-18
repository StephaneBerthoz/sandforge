import type {
  EnvAuditResult,
  RecoveryReason,
  RecoveryStatus,
  RecoveryStepId,
  RecoveryUser,
  UsersConfig,
  UsersConfigUser,
  UsersPlanAnswer,
} from '@sandforge/shared';
import { dateTimeFormat } from '../../utils/formatters';

/*
 * What the Back into service page reads of a sandbox's status, as plain
 * functions. The step lists below repeat those of the contract
 * (`schemas/recovery.schema.ts`), which is built beside zod's schemas: the
 * page parses no zod before it paints, and its test holds each copy to the
 * contract's.
 */

/**
 * An instant of the status — a refresh noticed, a checkpoint taken, a list
 * kept — written in the interface language, or as given when it is no date.
 */
export function instantWords(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * The key a username is compared by, as the contract's `usernameKey`:
 * Salesforce reads a username whatever its case.
 */
export function usernameKey(username: string): string {
  return username.toLowerCase();
}

/** The steps a person may skip: all but the refresh. */
export const SKIPPABLE_STEPS: ReadonlySet<RecoveryStepId> = new Set<RecoveryStepId>([
  'users',
  'masking',
  'replay',
  'frozen',
  'testersCheckpoint',
  'deliverability',
  'scheduledJobs',
  'endpoints',
  'handoff',
]);

/** The steps a person marks done, after checking them by eye in Setup. */
export const MARKABLE_STEPS: ReadonlySet<RecoveryStepId> = new Set<RecoveryStepId>([
  'deliverability',
  'endpoints',
]);

/**
 * The pipeline template "Automate after each refresh…" opens Automation on:
 * Sandbox Refresh Post-Processing, by the id the marketplace ships it under.
 */
export const SANDBOX_REFRESH_TEMPLATE_ID = 'tpl-sandbox-refresh';

// ─── The line of each step ───────────────────────────────────────────────────

/** What a step's line says when its status has no sentence of its own. */
const REASON_LINE: Record<RecoveryReason, string> = {
  refreshDetected: 'recovery.reason.refreshDetected',
  ranAfterRefresh: 'recovery.reason.ranAfterRefresh',
  markedDone: 'recovery.reason.markedDone',
  ready: 'recovery.reason.ready',
  toDo: 'recovery.reason.toDo',
  skipped: 'recovery.reason.skipped',
  noRefreshDetected: 'recovery.reason.noRefreshDetected',
  nothingCopied: 'recovery.reason.nothingCopied',
  noCheckpointBefore: 'recovery.reason.noCheckpointBefore',
  noManifest: 'recovery.reason.noManifest',
  noInventoryBefore: 'recovery.reason.noInventoryBefore',
  noUserToBringBack: 'recovery.reason.noUserToBringBack',
  stagingSandbox: 'recovery.reason.stagingSandbox',
};

/**
 * A step's own sentence for a reason: what it will do while it is to do, what
 * it did once it ran, and why it does not apply. A reason a step has no
 * sentence for reads {@link REASON_LINE}'s.
 */
const STEP_LINE: Partial<Record<RecoveryStepId, Partial<Record<RecoveryReason, string>>>> = {
  refresh: {
    refreshDetected: 'recovery.line.refresh.refreshDetected',
    noRefreshDetected: 'recovery.line.refresh.noRefreshDetected',
  },
  users: {
    toDo: 'recovery.line.users.toDo',
    ranAfterRefresh: 'recovery.line.users.ranAfterRefresh',
    noUserToBringBack: 'recovery.line.users.noUserToBringBack',
  },
  masking: {
    toDo: 'recovery.line.masking.toDo',
    ranAfterRefresh: 'recovery.line.masking.ranAfterRefresh',
    nothingCopied: 'recovery.line.masking.nothingCopied',
  },
  replay: {
    toDo: 'recovery.line.replay.toDo',
    ranAfterRefresh: 'recovery.line.replay.ranAfterRefresh',
    noCheckpointBefore: 'recovery.line.replay.noCheckpointBefore',
    stagingSandbox: 'recovery.line.replay.stagingSandbox',
  },
  frozen: {
    toDo: 'recovery.line.frozen.toDo',
    ranAfterRefresh: 'recovery.line.frozen.ranAfterRefresh',
    noManifest: 'recovery.line.frozen.noManifest',
    stagingSandbox: 'recovery.line.frozen.stagingSandbox',
  },
  testersCheckpoint: {
    toDo: 'recovery.line.testersCheckpoint.toDo',
    ranAfterRefresh: 'recovery.line.testersCheckpoint.ranAfterRefresh',
  },
  deliverability: { toDo: 'recovery.line.deliverability.toDo' },
  scheduledJobs: {
    toDo: 'recovery.line.scheduledJobs.toDo',
    ranAfterRefresh: 'recovery.line.scheduledJobs.ranAfterRefresh',
    noInventoryBefore: 'recovery.line.scheduledJobs.noInventoryBefore',
  },
  endpoints: { toDo: 'recovery.line.endpoints.toDo' },
  handoff: {
    toDo: 'recovery.line.handoff.toDo',
    ranAfterRefresh: 'recovery.line.handoff.ranAfterRefresh',
  },
};

/** The key of the sentence a step's line says for its reason. */
export function lineKeyOf(step: RecoveryStepId, reason: RecoveryReason): string {
  return STEP_LINE[step]?.[reason] ?? REASON_LINE[reason];
}

/** A step's line: its sentence's key, and what the sentence names. */
export interface StepLine {
  key: string;
  params: Record<string, string>;
}

/** How the page writes a date and a count in the interface language. */
export interface LineWords {
  alias: string;
  date: (iso: string) => string;
  count: (value: number) => string;
}

/**
 * The facts a step's own sentence names, read from the status: the checkpoint
 * a replay opens, the frozen dataset a load writes, the inventory the jobs
 * are compared with, the users run that ran. Undefined when the status lacks
 * the fact: the line then says the reason's sentence, which names none.
 */
function factsOf(
  step: RecoveryStepId,
  reason: RecoveryReason,
  status: RecoveryStatus,
  words: LineWords,
): Record<string, string> | undefined {
  if (step === 'replay' && reason === 'toDo') {
    const before = status.checkpointBefore;
    return before ? { name: before.name, date: words.date(before.takenAt) } : undefined;
  }
  if (step === 'frozen' && reason === 'toDo') {
    const manifest = status.frozenManifest;
    return manifest
      ? {
          records: words.count(manifest.records),
          objects: words.count(manifest.objects),
          date: words.date(manifest.frozenAt),
        }
      : undefined;
  }
  if (step === 'scheduledJobs' && reason === 'toDo') {
    const inventory = status.inventoryBefore;
    return inventory ? { date: words.date(inventory.savedAt) } : undefined;
  }
  if (step === 'users' && reason === 'ranAfterRefresh') {
    const run = status.lastUsersRun;
    return run ? { run: String(run.run) } : undefined;
  }
  return {};
}

/** What a step's line says for its reason, with the facts its sentence names. */
export function lineOf(
  step: RecoveryStepId,
  reason: RecoveryReason,
  status: RecoveryStatus,
  words: LineWords,
): StepLine {
  const facts = factsOf(step, reason, status, words);
  return facts === undefined
    ? { key: REASON_LINE[reason], params: { alias: words.alias } }
    : { key: lineKeyOf(step, reason), params: { alias: words.alias, ...facts } };
}

/**
 * Whether the replay a step 4 opens will ask for the org's name typed: a
 * sandbox marked Staging takes a checkpoint's replay once its name is typed
 * under the simulation, as a rewind is confirmed.
 */
export function replayAsksName(status: Pick<RecoveryStatus, 'tier' | 'steps'>): boolean {
  const replay = status.steps.find((step) => step.id === 'replay');
  return status.tier === 'staging' && replay?.status === 'todo';
}

// ─── Setup ───────────────────────────────────────────────────────────────────

/**
 * The Lightning Setup pages a step sends its person to, by the node Setup
 * names them with. Not checked against a real org: a node that lands
 * elsewhere is fixed here, and the test pins each address.
 */
const SETUP_PATHS = {
  deliverability: '/lightning/setup/OrgEmailSettings/home',
  scheduledJobs: '/lightning/setup/ScheduledJobs/home',
  namedCredential: '/lightning/setup/NamedCredential/home',
  remoteSite: '/lightning/setup/SecurityRemoteProxy/home',
  customMetadata: '/lightning/setup/CustomMetadata/home',
  customSettings: '/lightning/setup/CustomSettings/home',
} as const;

export type SetupPage = keyof typeof SETUP_PATHS;

/**
 * The address of a Setup page of the org, on the HTTPS origin it is reached
 * at — its My Domain host, which a refresh keeps, or its instance — and
 * nothing of the stored address beside: no path, no query, no credentials.
 * Undefined when neither is an HTTPS host.
 */
export function setupUrlOf(
  page: SetupPage,
  where: { myDomainHost?: string; instanceUrl?: string },
): string | undefined {
  const candidates = [
    where.myDomainHost ? `https://${where.myDomainHost}` : undefined,
    where.instanceUrl,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:') continue;
      return new URL(SETUP_PATHS[page], url.origin).toString();
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The Setup page an endpoint the audit found is changed on. */
export function setupPageOfEndpoint(
  found: NonNullable<EnvAuditResult['endpoints']>['found'][number],
): SetupPage {
  if (found.source === 'namedCredential') return 'namedCredential';
  if (found.source === 'remoteSite') return 'remoteSite';
  const object = found.name.split('.')[0] ?? '';
  return object.toLowerCase().endsWith('__mdt') ? 'customMetadata' : 'customSettings';
}

// ─── The users ───────────────────────────────────────────────────────────────

/**
 * One row of the users to bring back: a user read in the sandbox, or one a
 * users.json names that the reading did not list — a tester whose address
 * the copy left alone, given a profile or groups.
 */
export interface UserRow {
  key: string;
  username: string;
  /** What the sandbox says of the user; absent for a user only the file names. */
  read?: RecoveryUser;
  /** The entry the file gives the user, kept whole: its profile, permission sets and groups. */
  given?: UsersConfigUser;
}

/**
 * The rows of the list: the users read, in the order the sandbox listed them,
 * then those only the file names, in its order.
 */
export function userRowsOf(users: readonly RecoveryUser[], given?: UsersConfig): UserRow[] {
  const entries = new Map(given?.users.map((user) => [usernameKey(user.username), user]));
  const rows: UserRow[] = users.map((user) => {
    const key = usernameKey(user.username);
    const entry = entries.get(key);
    return { key, username: user.username, read: user, ...(entry ? { given: entry } : {}) };
  });
  const listed = new Set(rows.map((row) => row.key));
  for (const [key, entry] of entries) {
    if (!listed.has(key)) rows.push({ key, username: entry.username, given: entry });
  }
  return rows;
}

/**
 * What a user read in the sandbox is set up with when no file says otherwise:
 * its address asked back while it is under the copy's `.invalid`, activated
 * if inactive, unfrozen if frozen. Its profile, permission sets and groups
 * stay as copied.
 */
export function entryOfRead(user: RecoveryUser): UsersConfigUser {
  return {
    username: user.username,
    ...(user.address === 'invalid' ? { email: 'restore' as const } : {}),
    ...(user.active ? {} : { active: true }),
    ...(user.frozen ? { frozen: false } : {}),
  };
}

/**
 * The list a run is asked with, as `sandforge users --config` reads it: the
 * rows chosen, in the order of the list, each with the file's entry when it
 * gives one, and the file's defaults. Undefined when no row is chosen: a list
 * names one user at least.
 */
export function usersConfigOf(
  rows: readonly UserRow[],
  chosen: ReadonlySet<string>,
  given?: UsersConfig,
): UsersConfig | undefined {
  const users = rows
    .filter((row) => chosen.has(row.key))
    .map((row) => row.given ?? (row.read ? entryOfRead(row.read) : { username: row.username }));
  if (users.length === 0) return undefined;
  return { ...(given?.defaults ? { defaults: given.defaults } : {}), users };
}

/**
 * The choices a simulation was asked with, as one string: an apply waits for
 * the simulation of the very list it would run.
 */
export function choiceKeyOf(config: UsersConfig | undefined): string {
  return config === undefined ? '' : JSON.stringify(config);
}

/** The acceptances a run is asked with, each said at every run and kept nowhere. */
export interface UsersAcceptances {
  acceptUserEmails: boolean;
  acceptEmails: boolean;
  acceptAutomation: boolean;
}

/** The acceptance each refusal a person may lift asks for. */
const ACCEPTANCE_OF_CODE: Record<string, keyof UsersAcceptances> = {
  USERS_EMAILS_NOT_ACCEPTED: 'acceptUserEmails',
  USERS_EMAILS_OPEN: 'acceptEmails',
  AUTOMATION_NOT_ACCEPTED: 'acceptAutomation',
};

/** What a simulation says of a run: what it asks the person to accept, and what refuses it. */
export interface UsersPlanVerdict {
  /** The acceptances the run needs, in the order the page asks them. */
  asked: Array<keyof UsersAcceptances>;
  /** The refusals no acceptance lifts: the run is closed until the list or the org changes. */
  blocking: NonNullable<UsersPlanAnswer['refusals']>;
  /** Whether the run would change anything. */
  changes: boolean;
}

/**
 * What a simulation asked with no acceptance says: each acceptance its
 * refusals ask for, and those no acceptance lifts.
 */
export function planVerdictOf(plan: UsersPlanAnswer): UsersPlanVerdict {
  const asked = new Set<keyof UsersAcceptances>();
  const blocking: NonNullable<UsersPlanAnswer['refusals']> = [];
  for (const refusal of plan.refusals ?? []) {
    const acceptance = ACCEPTANCE_OF_CODE[refusal.code];
    if (acceptance) asked.add(acceptance);
    else blocking.push(refusal);
  }
  const order: Array<keyof UsersAcceptances> = [
    'acceptUserEmails',
    'acceptEmails',
    'acceptAutomation',
  ];
  return {
    asked: order.filter((acceptance) => asked.has(acceptance)),
    blocking,
    changes: plan.users.some((user) => user.changes.length > 0),
  };
}

/** The refusal codes the page words; any other is named by its code. */
export const USERS_REFUSAL_KEYS: Record<string, string> = {
  USERS_LICENSE: 'recovery.users.refusal.USERS_LICENSE',
  USERS_PERMISSION_SET_LICENSE: 'recovery.users.refusal.USERS_PERMISSION_SET_LICENSE',
  USERS_SELF: 'recovery.users.refusal.USERS_SELF',
  USERS_NO_RIGHT: 'recovery.users.refusal.USERS_NO_RIGHT',
  USERS_NO_USER: 'recovery.users.refusal.USERS_NO_USER',
  USERS_TWO_USERS: 'recovery.users.refusal.USERS_TWO_USERS',
  USERS_SAME_USER: 'recovery.users.refusal.USERS_SAME_USER',
  USERS_PROFILE_UNKNOWN: 'recovery.users.refusal.USERS_PROFILE_UNKNOWN',
  USERS_PERMISSION_SET_UNKNOWN: 'recovery.users.refusal.USERS_PERMISSION_SET_UNKNOWN',
  USERS_GROUP_UNKNOWN: 'recovery.users.refusal.USERS_GROUP_UNKNOWN',
  USERS_NO_LOGIN: 'recovery.users.refusal.USERS_NO_LOGIN',
  USERS_RUN_NOT_FOUND: 'recovery.users.refusal.USERS_RUN_NOT_FOUND',
  USERS_RUN_REPLACED: 'recovery.users.refusal.USERS_RUN_REPLACED',
};

/** The key a refusal of the users is worded by. */
export function usersRefusalKeyOf(code: string): string {
  return USERS_REFUSAL_KEYS[code] ?? 'recovery.users.refusal.other';
}
