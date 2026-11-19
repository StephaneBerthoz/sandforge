/**
 * `sandforge checkpoint replay` and `sandforge checkpoint replays`: a
 * checkpoint's records set up again in another org, without its own org.
 *
 * A checkpoint rewinds the org it was taken of and no other. Once that org is
 * gone — a sandbox refreshed, a scratch org expired, a teammate's org this
 * machine never reached — its checkpoint still holds the records, and a
 * replay creates copies of them in another org, parents first, with new Ids,
 * changing and deleting nothing the other org holds.
 *
 * The replay is a load of the Frozen Dataset handler (`sandforge-frozen.ts`,
 * `runFrozen`), the checkpoint converted in memory in place of a dataset: its
 * dry run, its gates on what the other org runs, its emails, its requests and
 * its storage, its mute, its checkpoint first, its verification and its
 * removal are the load's own. What this file adds is the line, the checkpoint
 * found on this machine or decrypted from a file received, and the words: a
 * replay is said as one, never as a load of a dataset its reader never made.
 *
 * Its own org is never reached. A file received with its key is replayed
 * offline, the key standing for its sender's consent; the file's header says
 * before any key is read whether its records may be real (a Partial Copy, a
 * Full, a Staging sandbox), and those go across masked only.
 *
 * What a replay wrote is kept in the folder of the checkpoint's replays
 * (`ReplayStore`), outside the checkpoint's own: deleted or expired, the
 * checkpoint takes nothing of it, and `--remove` still takes the replay back.
 * `replays` lists them from this machine's files, no org reached.
 */

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkpointIdSchema,
  checkpointReplayChoicesSchema,
  type CheckpointArchiveHeader,
  type CheckpointListEntry,
  type CheckpointReplayChoices,
  type CheckpointReplayNotReplayedReason,
  type CheckpointReplayLookupEmptiedReason,
  type CheckpointReplayRefusedReason,
  type CheckpointReplaySummary,
  type FrozenLoadPlanInfo,
  type FrozenLoadReportInfo,
  type FrozenReplayInfo,
  type FrozenReplayLoadConfig,
  type RunCheckpointRequest,
} from '@sandforge/shared';
import type { FrozenReplayStores } from '../src/bridge/handlers/FrozenDatasetHandler.js';
import { frozenLoadPayloadSchema } from '../src/bridge/validatePayload.js';
import {
  importReceivedArchive,
  parseArchiveKey,
  readArchiveHeader,
  receivedStoreRootOf,
} from '../src/modules/checkpoint/checkpointArchive.js';
import {
  DEFAULT_KEEP_DAYS,
  makePrivateDir,
  openCheckpointStore,
  organizationKey,
  type OrgCheckpointStore,
} from '../src/modules/checkpoint/OrgCheckpointStore.js';
import {
  COMMAND_LINE_REPLAY_WORDS,
  sourceDataOf,
} from '../src/modules/checkpoint/replay/replaySourceGuard.js';
import {
  ReplayStore,
  defaultReplayStoreRoot,
  replaysInPlace,
  replaysInPlaceWords,
  type ReplayEntry,
} from '../src/modules/checkpoint/replay/replayStore.js';
import { formatMB } from '../src/modules/forge/ForgeRunGate.js';
import { CHECKPOINT_FIRST_FLAGS, checkpointFirstArgs } from './beforeRunCheckpoint.js';
import { commandOf, typedWord } from './invocation.js';
import { hidden } from './prompt.js';
import type { RunRefusal } from './runRefused.js';
import { SWEEP_CLASS_FLAGS, sweepClassArgsOf } from './sandforge-clone.js';
import {
  runFrozen,
  type FrozenAnswer,
  type FrozenCliArgs,
  type FrozenPosted,
  type FrozenReplayRun,
  type FrozenWords,
} from './sandforge-frozen.js';

// ─── The line ────────────────────────────────────────────────────────────────

/** The choices of a replay, which its verification and its removal do not take. */
const CHOICE_SWITCHES = [
  '--custom-settings',
  '--mask',
  '--keep-contact-points',
  '--no-real-data',
] as const;
const CHOICE_VALUES = [
  '--objects',
  '--exclude-object',
  '--owners',
  '--owner-map',
  '--link',
  '--replay-config',
] as const;

/** What a replay and its dry run take alone: they write, or say what writing would do. */
const REPLAY_ALONE = [
  '--again',
  '--accept-emails',
  '--max-records',
  ...CHECKPOINT_FIRST_FLAGS.switches,
  ...CHECKPOINT_FIRST_FLAGS.values,
] as const;

/**
 * What a removal alone takes: its sweep's own among them, as a Frozen
 * removal takes them. Its lines name them — "(--sweep-late takes them)", "run
 * --sweep-list to see what" — and read by no line of a replay, the one a
 * preview gave was refused, exit 2.
 */
const REMOVAL_ALONE = [
  '--preview',
  '--sweep',
  '--sweep-list',
  ...SWEEP_CLASS_FLAGS,
  '--include-changed',
] as const;

/** What a replay's line asks: the replay, its dry run, its verification, or its removal. */
export type ReplayAction = 'replay' | 'dryRun' | 'verify' | 'remove';

/** Everything the line of a replay settled. */
export interface ReplayAsked {
  action: ReplayAction;
  /** `--checkpoint`: its id, its name with `--from`, or `latest` with `--from`. */
  checkpoint?: string;
  /** `--from`: the alias, the username or the Organization Id of the org it was taken of. */
  from?: string;
  /** `--file`: a `.sfcheckpoint` file received, absolute. */
  file?: string;
  /** `--key-env`: the variable that holds the file's key; it is asked on the terminal without it. */
  keyEnv?: string;
  /** Days the checkpoint of a file received is kept on this machine; 0 until deleted. */
  keepDays: number;
  /** The other org, by its `sf` alias or username. */
  target: string;
  choices: CheckpointReplayChoices;
  /** The file `--owner-map` named, absolute: the line a dry run hands on names it again. */
  ownerMapFile?: string;
  /** `--replay-config`: the load's part of a Frozen project's configuration. */
  config?: FrozenReplayLoadConfig;
  /** The file `--replay-config` named, absolute: the line a dry run hands on names it again. */
  configFile?: string;
  /** `--again`: replay over what the replays before created there, which goes first. */
  again: boolean;
  muteAutomation: boolean;
  acceptAutomation: boolean;
  acceptEmails: boolean;
  checkpointFirst?: RunCheckpointRequest;
  /** The most records it may create: its dry run's count unless given. */
  maxRecords?: number;
  /** With `--remove`: say what it would do, and delete nothing. */
  preview: boolean;
  sweep: boolean;
  /** With `--remove`: list what `--sweep` would take, and delete nothing. */
  sweepList: boolean;
  /** With the sweep: take too what it lists as made late (`--sweep-late`). */
  sweepLate?: true;
  /** With the sweep: take too what it lists as tied to nothing of the replay (`--sweep-untied`). */
  sweepUntied?: true;
  includeChanged: boolean;
  yes: boolean;
}

/** An object's API name, as `--objects` and `--exclude-object` take one. */
const OBJECT_API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** An Organization Id as `--from` may name one. */
const ORGANIZATION_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** A checkpoint's id, as the store names its folder. */
const isCheckpointId = (text: string): boolean => checkpointIdSchema.safeParse(text).success;

/** The flag that gave each field of the choices, as a refusal of them names it. */
const FLAG_OF_CHOICE: Readonly<Record<string, string>> = {
  ownerMap: '--owner-map',
  objects: '--objects',
  excluded: '--exclude-object',
  link: '--link',
};

/**
 * Read the line of `replay`, or stop it, exit 2, through `refuse`: what it
 * cannot run is said before any org is reached.
 *
 * @param args - The line after the program and the script, its command first.
 */
export function parseReplay(args: readonly string[], refuse: (line: string) => never): ReplayAsked {
  const has = (flag: string): boolean => args.includes(flag);
  const values = (flag: string): string[] => {
    const out: string[] = [];
    for (let at = 1; at < args.length; at++) {
      if (args[at] !== flag) continue;
      const value = args[at + 1];
      if (value === undefined || value.startsWith('--')) return refuse(`${flag} wants a value.`);
      out.push(value);
      at++;
    }
    return out;
  };
  const single = (flag: string): string | undefined => {
    const given = values(flag);
    if (given.length > 1) refuse(`${flag} is given ${given.length} times: give it once.`);
    return given[0];
  };
  const wholeNumber = (flag: string): number | undefined => {
    const value = single(flag);
    if (value === undefined) return undefined;
    if (!/^\d{1,15}$/.test(value)) refuse(`${flag} takes a whole number, not "${value}".`);
    return Number(value);
  };

  const actions = ['--dry-run', '--verify', '--remove'].filter(has);
  if (actions.length > 1) {
    refuse(
      `Give one of --dry-run, --verify and --remove, not ${actions.join(' and ')}. Nothing was run.`,
    );
  }
  const action: ReplayAction = has('--dry-run')
    ? 'dryRun'
    : has('--verify')
      ? 'verify'
      : has('--remove')
        ? 'remove'
        : 'replay';
  const flagsGiven = (flags: readonly string[]): string[] => flags.filter(has);
  if (action === 'verify' || action === 'remove') {
    const choices = flagsGiven([...CHOICE_SWITCHES, ...CHOICE_VALUES]);
    if (choices.length > 0) {
      refuse(
        `${choices.join(', ')} ${choices.length === 1 ? 'is a choice' : 'are choices'} of a ` +
          'replay and its dry run: --verify reads the choices its last replay was made with, and ' +
          '--remove takes back what it wrote. Nothing was run.',
      );
    }
    const writing = flagsGiven(REPLAY_ALONE);
    if (writing.length > 0) {
      refuse(
        `${writing.join(', ')} goes with a replay or its dry run, not with --${action}. Nothing was run.`,
      );
    }
  }
  if (action !== 'remove') {
    const removal = flagsGiven(REMOVAL_ALONE);
    if (removal.length > 0) {
      refuse(`${removal.join(', ')} goes with --remove. Nothing was run.`);
    }
  }
  // As a Frozen removal reads them: a sweep deletes, its list only lists, and
  // a preview lists what the sweep would take with --sweep.
  if (has('--sweep') && has('--sweep-list')) {
    refuse('--sweep deletes and --sweep-list only lists: give one of them. Nothing was run.');
  }
  if (has('--preview') && has('--sweep-list')) {
    refuse(
      '--preview deletes nothing, and --sweep-list lists what a sweep would take: give ' +
        '--preview without it, or with --sweep. Nothing was run.',
    );
  }
  const classes = sweepClassArgsOf(args);
  if ('refusal' in classes) refuse(`${classes.refusal} Nothing was run.`);
  if (action === 'verify') {
    const muting = flagsGiven(['--mute-automation', '--accept-automation']);
    if (muting.length > 0) {
      refuse(
        `${muting.join(', ')} goes with a replay or its removal: a verification only reads. Nothing was run.`,
      );
    }
  }

  const checkpoint = single('--checkpoint');
  const file = single('--file');
  if (checkpoint === undefined && file === undefined) {
    return refuse(
      'replay needs --checkpoint <id|name> (list names them) or --file <.sfcheckpoint>. Run with ' +
        '--help.',
    );
  }
  if (checkpoint !== undefined && file !== undefined) {
    refuse('Give --checkpoint or --file, not both. Nothing was run.');
  }
  const from = single('--from');
  if (from !== undefined && checkpoint === undefined) {
    refuse('--from goes with --checkpoint <name>: it names the org the checkpoint was taken of.');
  }
  if (checkpoint !== undefined && !isCheckpointId(checkpoint) && from === undefined) {
    refuse(
      `--checkpoint '${checkpoint}' is not a checkpoint's id: a name names one of an org's ` +
        'checkpoints, so give --from <alias|username|00D…>, the org it was taken of, or its id ' +
        `("${commandOf('checkpoint')} list" names them). Nothing was run.`,
    );
  }
  if (file === undefined) {
    const fileOnly = flagsGiven(['--key-env', '--keep-days']);
    if (fileOnly.length > 0) refuse(`${fileOnly.join(' and ')} goes with --file. Nothing was run.`);
  }
  const target =
    single('--target') ??
    refuse(
      `replay needs --target <alias>, the org the checkpoint's records go into. Run with --help.`,
    );

  const objects = values('--objects').flatMap((list) =>
    list
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );
  const excluded = values('--exclude-object');
  for (const [flag, names] of [
    ['--objects', objects],
    ['--exclude-object', excluded],
  ] as const) {
    const bad = names.find((name) => !OBJECT_API_NAME.test(name));
    if (bad !== undefined) refuse(`${flag} takes objects' API names, not "${bad}".`);
  }
  const once = (names: readonly string[]): string[] =>
    names.filter(
      (name, at) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === at,
    );
  const owners = single('--owners') ?? 'same';
  if (owners !== 'same' && owners !== 'me') {
    refuse(`--owners takes same or me, not "${owners}".`);
  }
  const link = values('--link').map((given) => {
    const parts = /^([A-Za-z][A-Za-z0-9_]*)=([A-Za-z0-9_,]+)$/.exec(given);
    if (!parts) {
      return refuse(
        `--link takes Object=Field or Object=Field,Field — the fields a record of the other org ` +
          `is found by —, not "${given}".`,
      );
    }
    return { objectApiName: parts[1], fields: parts[2].split(',').filter((f) => f !== '') };
  });
  const ownerMapFile = single('--owner-map');
  const ownerMap =
    ownerMapFile !== undefined ? jsonFileOf('--owner-map', ownerMapFile, refuse) : undefined;
  const asked = {
    owners,
    ...(ownerMap !== undefined ? { ownerMap } : {}),
    customSettings: has('--custom-settings'),
    mask: has('--mask'),
    contactPoints: has('--keep-contact-points') ? 'kept' : 'neutralized',
    objects: once(objects),
    excluded: once(excluded),
    link,
    ...(has('--no-real-data') ? { noRealData: true } : {}),
  };
  const checked = checkpointReplayChoicesSchema.safeParse(asked);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    return refuse(
      `${FLAG_OF_CHOICE[field] ?? field}: ${issue?.message ?? 'not read'}. Nothing was run.`,
    );
  }
  const choices = checked.data;
  const configFile = single('--replay-config');
  const config = configFile !== undefined ? replayConfigOf(configFile, choices, refuse) : undefined;
  const maxRecords = wholeNumber('--max-records');
  if (maxRecords === 0) {
    refuse('--max-records takes a whole number of 1 or more, not "0". Nothing was run.');
  }
  const keyEnv = keyVariable(single('--key-env'), refuse);
  const checkpointFirst = checkpointFirstArgs(args);
  return {
    action,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(file !== undefined ? { file: resolve(file) } : {}),
    ...(keyEnv !== undefined ? { keyEnv } : {}),
    keepDays: wholeNumber('--keep-days') ?? DEFAULT_KEEP_DAYS,
    target,
    choices,
    ...(ownerMapFile !== undefined ? { ownerMapFile: resolve(ownerMapFile) } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(configFile !== undefined ? { configFile: resolve(configFile) } : {}),
    again: has('--again'),
    muteAutomation: has('--mute-automation'),
    acceptAutomation: has('--accept-automation'),
    acceptEmails: has('--accept-emails'),
    ...(checkpointFirst !== undefined ? { checkpointFirst } : {}),
    ...(maxRecords !== undefined ? { maxRecords } : {}),
    preview: has('--preview'),
    sweep: has('--sweep'),
    sweepList: has('--sweep-list'),
    ...classes,
    includeChanged: has('--include-changed'),
    yes: has('--yes'),
  };
}

/** Read the line of `replays`: the other org to list the replays into, if any. */
export function parseReplays(
  args: readonly string[],
  refuse: (line: string) => never,
): {
  target?: string;
} {
  const given = args.flatMap((arg, at) => (arg === '--target' ? [args[at + 1]] : []));
  if (given.length > 1) refuse(`--target is given ${given.length} times: give it once.`);
  const target = given[0];
  return target !== undefined ? { target } : {};
}

/** A JSON file a flag names, read whole, or the stop of the line. */
function jsonFileOf(flag: string, file: string, refuse: (line: string) => never): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (err: unknown) {
    return refuse(
      `${flag}: ${file} does not read as JSON (${err instanceof Error ? err.message : String(err)}). ` +
        'Nothing was run.',
    );
  }
}

/**
 * The load's part of a Frozen project's configuration `--replay-config`
 * gives, held to the schema the handler holds the request to: a key it does
 * not take is said here, exit 2, rather than once the other org is reached.
 */
function replayConfigOf(
  file: string,
  choices: CheckpointReplayChoices,
  refuse: (line: string) => never,
): FrozenReplayLoadConfig {
  const config = jsonFileOf('--replay-config', file, refuse);
  const checked = frozenLoadPayloadSchema.safeParse({
    targetOrgId: 'command-line',
    replay: {
      organizationId: '00D000000000000AAA',
      checkpointId: 'ck-20000101-000000-0000',
      choices,
      config,
    },
  });
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = (issue?.path ?? []).slice(2).join('.');
    return refuse(
      `--replay-config: ${where !== '' ? `${where}: ` : ''}${issue?.message ?? 'not read'}. It ` +
        'takes the load’s part of a Frozen project’s configuration: requiredFieldDefaults, ' +
        'requiredLookupPlaceholders, picklistRules, defaultPicklistRule, identityKeys, ' +
        'undeletableObjects, duplicateErrorPatterns, mockDetection, protectedOrgIds. Nothing was run.',
    );
  }
  return config as FrozenReplayLoadConfig;
}

/**
 * The name of the variable `--key-env` gives, or the stop of the line: it
 * names a variable, never holds the key, which a shell's history and the list
 * of processes would keep. What was given is never repeated.
 */
function keyVariable(
  name: string | undefined,
  refuse: (line: string) => never,
): string | undefined {
  if (name === undefined) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || parseArchiveKey(name) !== undefined) {
    return refuse(
      '--key-env takes the name of an environment variable that holds the key, never the key: ' +
        'a key on the command line stays in the shell’s history and the list of processes. ' +
        'Nothing was run.',
    );
  }
  return name;
}

// ─── Where replays are kept ──────────────────────────────────────────────────

/** The file, in the store of replays, the audit trail of the replays run from the command line is kept in. */
export const REPLAY_AUDIT_FILE = 'cli-store.json';

/**
 * Where the replays of the checkpoints of a store are kept: the editor's own,
 * beside `checkpoints/`, unless `--store` named another store — then inside
 * it, with everything a run of that store keeps, as the checkpoints of the
 * files it received are.
 */
export function replayStoreRootOf(storeRoot: string, storeNamed: boolean): string {
  return storeNamed ? join(storeRoot, '.replays') : defaultReplayStoreRoot();
}

/** A refusal of the command, with the exit it ends on. */
export class ReplayStop extends Error {
  constructor(
    readonly refusal: { code: string; message: string },
    readonly code: number = 1,
  ) {
    super(refusal.message);
    this.name = 'ReplayStop';
  }
}

/** The store of replays, or the stop of the command when it cannot be used: inside a repository. */
function replayStoreAt(root: string): ReplayStore {
  try {
    return new ReplayStore({ root });
  } catch (err: unknown) {
    throw new ReplayStop({
      code: 'STORE_REFUSED',
      message:
        `The replays cannot be kept in ${root}: ${err instanceof Error ? err.message : String(err)} ` +
        'Name a store outside any repository with --store <folder>. Nothing was read or written.',
    });
  }
}

/** The store of the checkpoints of files received, when there is one. */
function receivedStoreOf(storeRoot: string, locksDir?: string): OrgCheckpointStore | undefined {
  const root = receivedStoreRootOf(storeRoot);
  if (!existsSync(root)) return undefined;
  const opened = openCheckpointStore({ root, ...(locksDir !== undefined ? { locksDir } : {}) });
  return 'store' in opened ? opened.store : undefined;
}

/**
 * The command that replays a `.sfcheckpoint` file into an org, as a line
 * gives it to be run: what a file of another org is imported as nowhere else.
 */
export function replayFileCommandOf(file: string, target: string): string {
  return `${commandOf('checkpoint')} replay --file ${typedWord(file)} --target ${target}`;
}

/**
 * The command that replays a checkpoint into an org, as a line gives it to
 * be run: by its id, which names it wherever it is kept, with the store when
 * one was named.
 */
export function replayCommandOf(checkpointId: string, target: string, store?: string): string {
  return (
    `${commandOf('checkpoint')} replay --checkpoint ${checkpointId} --target ${target}` +
    (store !== undefined ? ` --store ${typedWord(store)}` : '')
  );
}

// ─── Words ───────────────────────────────────────────────────────────────────

const count = (n: number): string => n.toLocaleString('en-US');

/** An instant as the lines say it: `2026-10-22 14:05 UTC`. */
function when(iso: string): string {
  const at = new Date(Date.parse(iso)).toISOString();
  return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}

/** At most `max` names, and how many more. */
function someOf(names: readonly string[], max = 8): string {
  return names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')} and ${count(names.length - max)} more`;
}

/** The words a replay's steps are said in. */
function replayWordsOf(name: string): FrozenWords {
  return {
    run: 'replay',
    done: 'replayed',
    source: name,
    recordedIn: 'for this checkpoint on this machine',
    remove: '--remove',
    module: 'replay',
    again: 'again',
    againSubject: { purge: 'replayAgain', sweep: 'replayAgainSweep' },
    maybeMasks:
      'the checkpoint does not say whether its take read them unmasked, so they may hold the ' +
      'masks a user without View Encrypted Data reads, such as ****1234',
  };
}

const NOT_REPLAYED_WORDS: Readonly<
  Record<CheckpointReplayNotReplayedReason, (object: string, target: string) => string>
> = {
  fileContentNotKept: () => "a checkpoint keeps no file's content",
  notInTarget: (object, target) =>
    `${target} has no such object: deploy it there, or leave it out (--exclude-object ${object})`,
  notCreateable: (_object, target) => `${target} lets no one create its records`,
  excluded: () => 'left out as asked',
};

const EMPTIED_WORDS: Readonly<
  Record<CheckpointReplayLookupEmptiedReason, (field: string, target: string) => string>
> = {
  objectNotReplayed: (field) =>
    `the checkpoint holds the records it names and does not replay them: add ${field.split('.')[0]}'s target with --objects`,
  objectNotHeld: (_field, target) =>
    `the checkpoint does not hold what it names, and ${target} has no record of that Id`,
  userNotInTarget: (_field, target) => `${target} has no active standard user for it`,
};

const REFUSED_WORDS: Readonly<Record<CheckpointReplayRefusedReason, string>> = {
  requiredLookupMissing: 'a required lookup names a record neither replayed nor in the other org',
  parentRefused: 'a parent of theirs is refused, and no orphan is written',
  personAccountsUnsupported: 'the other org has not turned person accounts on',
  inactiveCurrency: 'their currency is not active in the other org',
  recordTypeUnavailable: 'their record type is one the user who replays may not create',
};

/**
 * Why records of a replay are refused before anything is written, and the
 * way out the replay names, in its words: what an environment says of them
 * too. A reason it does not know is said by its code.
 */
export function replayRefusedWords(refused: { reason: string; path?: string }): string {
  const words = Object.hasOwn(REFUSED_WORDS, refused.reason)
    ? REFUSED_WORDS[refused.reason as CheckpointReplayRefusedReason]
    : refused.reason;
  return `${words}${refused.path ? `: ${refused.path}` : ''}`;
}

const RECORD_TYPE_WORDS: Readonly<
  Record<CheckpointReplaySummary['recordTypes'][number]['outcome'], string>
> = {
  byName: 'found by its name',
  byId: 'found by its Id',
  default: "the other org's default for the user who replays",
};

/**
 * What a replay says beside its plan: every record that does not go across
 * as it was, with why and what changes it, so that a success hides nothing.
 */
export function replayDetailLines(info: FrozenReplayInfo): string[] {
  const { summary } = info;
  const target = info.target.name;
  const lines: string[] = [];
  const { records } = summary;
  if (records.linkedById > 0) {
    lines.push(
      `${count(records.linkedById)} record(s) ${target} holds under the same Id — a sandbox ` +
        'copied from the same production —: linked, not changed',
    );
  }
  if (records.linkedByKey > 0) {
    lines.push(
      `${count(records.linkedByKey)} record(s) found in ${target} by the fields --link names: linked, not created`,
    );
  }
  const owners = summary.owners;
  const reasons = [
    owners.reasons.notInTarget > 0
      ? `their user is not in ${target}: ${count(owners.reasons.notInTarget)}`
      : '',
    owners.reasons.inactive > 0
      ? `their user is inactive in ${target}: ${count(owners.reasons.inactive)}`
      : '',
    owners.reasons.queueMissing > 0
      ? `their queue is not in ${target}: ${count(owners.reasons.queueMissing)}`
      : '',
  ].filter(Boolean);
  lines.push(
    `owners: ${count(owners.kept)} kept, ${count(owners.toRunningUser)} to the user who replays` +
      (reasons.length > 0 ? ` — ${reasons.join('; ')}` : ''),
  );
  for (const type of summary.recordTypes) {
    lines.push(
      `record type ${type.object}.${type.recordType}: ${RECORD_TYPE_WORDS[type.outcome]} — ` +
        `${count(type.records)} record(s)`,
    );
  }
  for (const refused of summary.refused) {
    lines.push(
      `refused before anything is written: ${refused.object} ${count(refused.records)} — ` +
        replayRefusedWords(refused),
    );
  }
  for (const left of summary.notReplayed) {
    lines.push(
      `not replayed: ${left.object} ${count(left.records)} — ` +
        NOT_REPLAYED_WORDS[left.reason](left.object, target),
    );
  }
  // Each named, however many: a file the replay does not bring is one the
  // person looks for in the other org.
  if (info.filesLeft.length > 0) {
    lines.push(
      `${count(info.filesLeft.length)} file(s) left where they were, a checkpoint keeping no ` +
        "file's content:",
      ...info.filesLeft.map(
        (file) => `  ${file.objectApiName}${file.name !== undefined ? ` '${file.name}'` : ''}`,
      ),
    );
  }
  for (const emptied of summary.lookupsEmptied) {
    lines.push(
      `${emptied.field}: emptied on ${count(emptied.records)} record(s) — ` +
        EMPTIED_WORDS[emptied.reason](emptied.field, target),
    );
  }
  for (const missing of summary.fieldsNotInTarget) {
    lines.push(
      `${missing.object}: ${someOf(missing.fields)} left out — ${target} does not have them`,
    );
  }
  if (summary.customSettings) {
    lines.push(
      `custom settings: ${count(summary.customSettings.inserted)} row(s) set up, ` +
        `${count(summary.customSettings.alreadyThere)} already in ${target}, kept as they are`,
    );
  }
  for (const currency of summary.currencies.refused) {
    lines.push(
      `${currency.code}: ${count(currency.records)} record(s) refused — the currency is not ` +
        `active in ${target}: activate it there, or leave those records out`,
    );
  }
  if (summary.currencies.singleCurrencyTarget) {
    lines.push(`${target} has one currency: amounts are kept as they are, in its currency`);
  }
  if (summary.standardPricebook === 'deduced') {
    lines.push('standard price book: told from the price book entries, the checkpoint naming none');
  } else if (summary.standardPricebook === 'ambiguous') {
    lines.push(
      'standard price book: the price book entries do not tell which it was, and those that need ' +
        'it are refused',
    );
  }
  if (summary.masked.fields.length > 0) lines.push(`masked: ${someOf(summary.masked.fields)}`);
  if ((summary.masked.unmaskedFreeText ?? []).length > 0) {
    lines.push(
      `not masked, free text the masking does not read: ${someOf(summary.masked.unmaskedFreeText ?? [])}`,
    );
  }
  lines.push(
    summary.contactPoints === 'neutralized'
      ? 'emails and phone numbers made unreachable (.invalid, numbers that ring nobody); ' +
          '--keep-contact-points keeps them'
      : 'emails and phone numbers kept as they are: they reach the people they name',
  );
  if ((summary.archivedActivities ?? 0) > 0) {
    lines.push(
      `${count(summary.archivedActivities ?? 0)} archived task(s) and event(s) replayed, which ${target} holds live`,
    );
  }
  if (summary.degraded.length > 0) {
    lines.push(
      (info.checkpoint.annex
        ? `its take could not read ${summary.degraded.join(', ')}`
        : 'taken before SandForge 1.81, it keeps no record types, users, queues nor standard ' +
          'price book') + `: the records they name get what ${target} gives them, each said above`,
    );
  }
  lines.push("created and modified dates and users are the replay's own: the platform sets them");
  if (info.storage) {
    const { storage } = info;
    lines.push(
      `data storage: about ${formatMB(storage.estimateMB)} MB of the ${formatMB(storage.remainingMB)} ` +
        `MB ${target} has left of ${formatMB(storage.maxMB)} MB`,
    );
  }
  return lines;
}

// ─── A replay's refusals, in its words ───────────────────────────────────────

/**
 * The codes a replay is refused under before it reads or writes — its
 * checkpoint, the other org, the data it holds, its owners — and those a
 * verification of it cannot run for: each said on its `refused (CODE)` line,
 * and answered as the step's refusal.
 */
const REPLAY_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'REPLAY_SAME_ORG',
  'REPLAY_REAL_DATA',
  'REPLAY_COPY_UNKNOWN',
  'REPLAY_TOO_MANY',
  'REPLAY_NOTHING',
  'REPLAY_CHECKPOINT_UNUSABLE',
  'REPLAY_NO_PILOT',
  'CHECKPOINT_NOT_FOUND',
  'OWNER_MAP_INACTIVE',
  'OWNER_MAP_UNKNOWN',
  'GUARD_REFUSED',
  'NO_LOAD',
  'TARGET_REFRESHED',
  'LOAD_REMOVED',
  'LOAD_STOPPED',
]);

/** The refusal a message of the handler says of a replay, with its code; undefined for any other. */
export function replayRefusalOf(message: FrozenPosted): RunRefusal | undefined {
  const type = String(message.type ?? '');
  const code = message.payload?.code;
  if (!type.endsWith(':error') || typeof code !== 'string') return undefined;
  if (!REPLAY_REFUSAL_CODES.has(code)) return undefined;
  return { code, message: String(message.payload?.message ?? '') };
}

/**
 * A message of the Frozen handler in a replay's words: those it words for a
 * load of the project's dataset, told by their code — a refresh, a removal or
 * a stop since the last replay, a count past its dry run's, a reload that
 * would leave records, the target's tier. What no code tells keeps its words,
 * but for the dataset it names.
 *
 * @param target - The other org, as the line names it.
 */
export function replayWords(
  code: string | undefined,
  message: string,
  target: string,
  payload: Record<string, unknown> = {},
): string {
  switch (code) {
    case 'TARGET_REFRESHED':
      if (/dataset/i.test(message)) {
        return (
          `${target} was refreshed after the last replay: the records it created went with the ` +
          'refresh. Replay the checkpoint again, then verify.'
        );
      }
      break;
    case 'LOAD_REMOVED': {
      const part = /removal of (\S+) took part/.exec(message);
      if (part) {
        return (
          `The removal of ${part[1]} took part of the records the last replay created and left ` +
          `${count(Number(payload.left ?? 0))} in ${target}: a verification would read the ones it ` +
          'took as missing. Remove what is left (--remove), or replay again (--again), which ' +
          'purges or finds it again; then verify.'
        );
      }
      const all = /removed on (\S+?)\.(?:\s|$)/.exec(message);
      return (
        `The records the last replay created were removed${all ? ` on ${all[1]}` : ''}. Replay ` +
        'the checkpoint again, then verify.'
      );
    }
    case 'LOAD_STOPPED':
      return (
        'The last replay stopped part way — it was cancelled, or failed once it had written — and ' +
        'wrote no counting contract: a verification would judge it by the one before. Replay it ' +
        'again (--again), which purges or finds again what the stopped replay wrote, or take it ' +
        'back (--remove); then verify.'
      );
    case 'NO_LOAD':
      if (/dataset|\bsas\b/i.test(message)) {
        return (
          `No replay of this checkpoint into ${target} is recorded on this machine: nothing ` +
          'names the records to verify. Replay it there, then verify.'
        );
      }
      break;
    case 'MAX_RECORDS': {
      const counts = /insert (\d+) record\(s\), more than the (\d+)/.exec(message);
      if (counts) {
        return (
          `This replay would create ${count(Number(counts[1]))} record(s), more than the ` +
          `${count(Number(counts[2]))} it may: nothing was written. The checkpoint's records ` +
          `or ${target} changed since that count was taken: run its dry run again, and replay ` +
          'with the count it gives (--max-records).'
        );
      }
      break;
    }
    case 'REPLACE_LEAVES_RECORDS': {
      const left = /would leave (\d+) of their records in the org — (.*?): loaded again/.exec(
        message,
      );
      if (left) {
        return (
          `Taking back what the replays before created in ${target} would leave ${left[1]} of ` +
          `their records there — ${left[2]}: replayed again, the checkpoint's records would ` +
          'stand beside them. Nothing was written. Take the replay back first (--remove; ' +
          '--include-changed takes too what was changed since, and what was added under it ' +
          'since), then replay it again.'
        );
      }
      break;
    }
    case 'GUARD_REFUSED':
      if (payload.guard === 'non-sandbox') {
        return (
          `A replay goes into a sandbox, a scratch org or a Developer Edition org, never into a ` +
          `production org nor a sandbox marked Staging, which hold real data: ${target} is ` +
          `${payload.tier === 'staging' ? 'a sandbox marked Staging' : 'a production org'}. ` +
          'Nothing was read or written.'
        );
      }
      break;
  }
  return /dataset/i.test(message)
    ? message
        .replace(/frozen-dataset load/gi, 'replay')
        .replace(/the frozen dataset/gi, 'the checkpoint')
        .replace(/the dataset/gi, 'the checkpoint')
        .replace(/datasets?/gi, 'checkpoint')
    : message;
}

// ─── Running it ──────────────────────────────────────────────────────────────

/** What a replay runs with, beside its line. */
export interface ReplayContext {
  /** Where the checkpoints live, absolute. */
  storeRoot: string;
  /** Whether `--store` named it: the replays are then kept inside it, and the lines name it. */
  storeNamed: boolean;
  store: OrgCheckpointStore;
  locksDir?: string;
  /** Every checkpoint of the store, as the list reads them. */
  listAll(): Promise<CheckpointListEntry[]>;
  /** The checkpoints of an org, as `list --org` reads them (`checkpointsOf`). */
  checkpointsOf(
    entries: readonly CheckpointListEntry[],
    org: string,
    organizationId?: string,
  ): CheckpointListEntry[];
  /** Which checkpoint a name or `latest` means among an org's (`resolveCheckpoint`). */
  resolve(
    all: readonly CheckpointListEntry[],
    ofOrg: readonly CheckpointListEntry[],
    asked: string,
    orgName: string,
  ): { entry: CheckpointListEntry } | { none: string } | { ambiguous: string };
  say(line: string): void;
  json: boolean;
}

/** The checkpoint a replay goes on with, as this machine names it. */
interface Chosen {
  organizationId: string;
  checkpointId: string;
  /** Its name, where its file or its replays' file says it. */
  name?: string;
  /** Its org, as the lines name it: by its alias, before a refresh, expired. */
  of?: string;
  /** The file it was read from, received. */
  file?: { path: string; header: CheckpointArchiveHeader };
}

/**
 * `replay`: the checkpoint found — kept on this machine, or decrypted from a
 * file received into a store of its own —, then the Frozen handler's load of
 * it, its dry run first, through `runFrozen`, in a replay's words.
 */
export async function runReplay(asked: ReplayAsked, context: ReplayContext): Promise<void> {
  const replays = replayStoreAt(replayStoreRootOf(context.storeRoot, context.storeNamed));
  const received = receivedStoreOf(context.storeRoot, context.locksDir);
  if (received !== undefined) await sweepReceived(received, context.say);
  const chosen =
    asked.file !== undefined
      ? await fromFile(asked, context)
      : await fromStore(asked, context, replays);
  const folder = replays.folderOf(chosen.organizationId, chosen.checkpointId);
  // The audit trail of the replays, beside their folders, its owner's alone.
  await makePrivateDir(replays.root);
  const stores: FrozenReplayStores = {
    checkpoints: () => [
      context.store,
      ...[receivedStoreOf(context.storeRoot, context.locksDir)].filter(
        (store): store is OrgCheckpointStore => store !== undefined,
      ),
    ],
    replays,
  };
  const store = context.storeNamed ? context.storeRoot : undefined;
  const again = replayCommandOf(chosen.checkpointId, asked.target, store);
  const name =
    chosen.name !== undefined ? `checkpoint '${chosen.name}'` : `checkpoint ${chosen.checkpointId}`;
  const run: FrozenReplayRun = {
    request: {
      organizationId: chosen.organizationId,
      checkpointId: chosen.checkpointId,
      choices: asked.choices,
      ...(asked.config !== undefined ? { config: asked.config } : {}),
    },
    stores,
    folder,
    auditStore: join(replays.root, REPLAY_AUDIT_FILE),
    words: replayWordsOf(name),
    refusalOf: replayRefusalOf,
    reword: (code, message, payload) => replayWords(code, message, asked.target, payload),
    lines: (message, lines) => replayLinesOf(message, lines, { asked, chosen, again }),
    question: (plan) =>
      `Replay ${name} into ${asked.target}, creating ${count(plannedRecords(plan))} record(s) there` +
      `${asked.again ? ' once what its replays before created there is purged' : ''}?`,
    // Once every refusal is said, and only when none was: what refuses it
    // names its own way out, and the line typed as it stood met it again.
    dryRunEnd: (refused) =>
      refused.length > 0 ? [] : [`To replay it: ${again}${replayFlagsOf(asked)}`],
    answer: (answer, ending) => replayAnswer(answer, ending, { asked, chosen, again }),
  };
  await runFrozen(frozenArgsOf(asked, context.json), run);
}

/** The records a load's plan inserts. */
function plannedRecords(plan: Pick<FrozenLoadPlanInfo, 'perObject'>): number {
  return plan.perObject.reduce((sum, object) => sum + object.toInsert, 0);
}

/** The Frozen step a replay's line runs. */
function frozenArgsOf(asked: ReplayAsked, json: boolean): FrozenCliArgs {
  return {
    step: asked.action === 'verify' ? 'verify' : asked.action === 'remove' ? 'remove' : 'load',
    target: asked.target,
    pilot: false,
    reload: asked.again,
    dryRun: asked.action === 'dryRun',
    writeEncrypted: false,
    muteAutomation: asked.muteAutomation,
    acceptAutomation: asked.acceptAutomation,
    ...(asked.checkpointFirst !== undefined ? { checkpointFirst: asked.checkpointFirst } : {}),
    includeChanged: asked.includeChanged,
    acceptEmails: asked.acceptEmails,
    sweep: asked.sweep,
    sweepList: asked.sweepList,
    ...(asked.sweepLate ? { sweepLate: true } : {}),
    ...(asked.sweepUntied ? { sweepUntied: true } : {}),
    preview: asked.preview,
    ...(asked.maxRecords !== undefined ? { maxTotal: asked.maxRecords } : {}),
    yes: asked.yes,
    json,
  };
}

/** Delete the checkpoints of files received whose day has come, each named. */
async function sweepReceived(
  store: OrgCheckpointStore,
  say: (line: string) => void,
): Promise<void> {
  const swept = await store.sweep().catch(() => undefined);
  for (const expired of swept?.checkpoints ?? []) {
    say(
      `deleted the checkpoint '${expired.name}' (${expired.checkpointId}) of a file received, ` +
        `kept until ${when(expired.expiresAt)}: its replays stay, and still take back with --remove`,
    );
  }
}

/** The checkpoint `--checkpoint` names: kept here, received, or known only by its replays. */
async function fromStore(
  asked: ReplayAsked,
  context: ReplayContext,
  replays: ReplayStore,
): Promise<Chosen> {
  const asking = asked.checkpoint ?? '';
  const received = receivedStoreOf(context.storeRoot, context.locksDir);
  // A checkpoint kept here and received too — its own export, sent back —
  // is one checkpoint: the store this machine keeps first, which a replay
  // reads first too.
  const seen = new Set<string>();
  const all = [...(await context.listAll()), ...((await received?.list()) ?? [])].filter(
    (entry) => {
      const key = `${entry.organizationId.slice(0, 15)}/${entry.checkpointId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  );
  const chosenOf = (entry: CheckpointListEntry): Chosen => ({
    organizationId: entry.organizationId,
    checkpointId: entry.checkpointId,
    ...(entry.checkpoint ? { name: entry.checkpoint.name } : {}),
    of: originOf(entry),
  });
  const from = asked.from;
  if (isCheckpointId(asking)) {
    const kept = all.filter(
      (entry) =>
        entry.checkpointId === asking &&
        (from === undefined || !ORGANIZATION_ID.test(from) || sameOrg(entry.organizationId, from)),
    );
    if (kept.length === 1) return chosenOf(kept[0]);
    // Deleted or expired since: its replays name it still, which a removal takes back.
    const known = (await replays.list({ checkpointId: asking })).filter(
      (entry) =>
        from === undefined ||
        !ORGANIZATION_ID.test(from) ||
        sameOrg(entry.sourceOrganizationId, from),
    );
    const sources = [...new Set(known.map((entry) => entry.sourceOrganizationId))];
    if (kept.length === 0 && sources.length === 1) {
      const entry = known[0];
      return {
        organizationId: entry.sourceOrganizationId,
        checkpointId: asking,
        ...(entry.checkpointName !== undefined ? { name: entry.checkpointName } : {}),
      };
    }
    if (kept.length + sources.length > 1) {
      const orgs = [...new Set([...kept.map((entry) => entry.organizationId), ...sources])];
      throw new ReplayStop(
        {
          code: 'AMBIGUOUS',
          message:
            `Checkpoints of ${orgs.length} orgs have the id ${asking}: name the org it was taken ` +
            `of with --from (${orgs.join(', ')}). Nothing was run.`,
        },
        2,
      );
    }
    throw new ReplayStop({
      code: 'NOT_FOUND',
      message:
        `No checkpoint ${asking} is kept on this machine, nor a replay of it. ` +
        notKeptWords(context.storeNamed),
    });
  }
  const org = from ?? '';
  const ofOrg = context.checkpointsOf(all, org, ORGANIZATION_ID.test(org) ? org : undefined);
  const resolution = context.resolve(all, ofOrg, asking, org);
  if ('entry' in resolution) return chosenOf(resolution.entry);
  if ('ambiguous' in resolution) {
    throw new ReplayStop({ code: 'AMBIGUOUS', message: resolution.ambiguous }, 2);
  }
  throw new ReplayStop({ code: 'NOT_FOUND', message: resolution.none });
}

/** Whether two Organization Ids name one org. */
function sameOrg(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/** Where a checkpoint this command did not find may be. */
function notKeptWords(storeNamed: boolean): string {
  return (
    `"${commandOf('checkpoint')} list" names the checkpoints kept, and "${commandOf('checkpoint')} ` +
    `replays" the replays.${storeNamed ? '' : ' One kept in another folder is read with --store <folder>.'} ` +
    'A file a teammate sent replays with --file <.sfcheckpoint>.'
  );
}

/** A checkpoint's org, as a replay's lines name it: what it was when it was taken, and since. */
function originOf(entry: CheckpointListEntry): string | undefined {
  const org = entry.checkpoint?.org;
  if (org === undefined) return undefined;
  const name = org.alias ?? org.username;
  if (entry.why === 'refreshed') {
    return `${name} before its refresh${entry.refreshedAt ? ` on ${entry.refreshedAt.slice(0, 10)}` : ''}`;
  }
  if (entry.why === 'scratchExpired') return `${name}, a scratch org expired since`;
  return name;
}

/**
 * The checkpoint of a file received: its header said, then, before any key,
 * the masking its records need; then the key, and the checkpoint kept in the
 * store of files received, apart from those this machine rewinds. A removal
 * reads the replay's own folder, named by the header: no key is asked.
 */
async function fromFile(asked: ReplayAsked, context: ReplayContext): Promise<Chosen> {
  const file = asked.file ?? '';
  const read = await readArchiveHeader(file);
  if ('refusal' in read) throw new ReplayStop(read.refusal);
  const { header } = read.read;
  context.say(
    `the file holds checkpoint ${header.checkpointId} of org ${header.organizationId}, taken ` +
      `${when(header.takenAt)}: ${count(header.records)} record(s) of ${count(header.objects)} ` +
      `object(s), exported by SandForge ${header.sandforgeVersion}`,
  );
  const fromHeader: Chosen = {
    organizationId: header.organizationId,
    checkpointId: header.checkpointId,
    file: { path: file, header },
  };
  if (asked.action === 'remove') return fromHeader;
  if (asked.action !== 'verify') {
    const refused = maskingRefusal(header, asked);
    if (refused !== undefined) throw new ReplayStop(refused);
  }
  const key = asked.keyEnv !== undefined ? keyFromEnvironment(asked.keyEnv) : await typedKey();
  const imported = await importReceivedArchive({
    storeRoot: context.storeRoot,
    ...(context.locksDir !== undefined ? { locksDir: context.locksDir } : {}),
    file,
    key,
    keepDays: asked.keepDays,
    takenOn: { host: hostname(), pid: process.pid },
  });
  if (!imported.imported) throw new ReplayStop(imported.refusal);
  const { checkpoint } = imported;
  context.say(
    imported.outcome === 'imported'
      ? `kept checkpoint '${checkpoint.name}' of the file on this machine, apart from those it ` +
          `rewinds, to replay it: ${receivedStoreRootOf(context.storeRoot)}, ` +
          (checkpoint.expiresAt === null
            ? 'until it is deleted'
            : `until ${when(checkpoint.expiresAt)} (--keep-days)`)
      : `checkpoint '${checkpoint.name}' of the file is kept on this machine already, the same`,
  );
  return {
    ...fromHeader,
    name: checkpoint.name,
    of: checkpoint.org.alias ?? checkpoint.org.username,
  };
}

/**
 * The refusal of a file received whose records may be real, said from its
 * header before any key is read: a Partial Copy's, a Full's or a Staging
 * sandbox's goes into another org masked only; a sandbox's that does not
 * say which, masked or declared to hold no real data.
 */
function maskingRefusal(
  header: CheckpointArchiveHeader,
  asked: Pick<ReplayAsked, 'choices' | 'target'>,
): { code: string; message: string } | undefined {
  if (asked.choices.mask) return undefined;
  const data = sourceDataOf({
    tier: header.orgTier,
    ...(header.dataStorageMaxMB !== undefined ? { dataStorageMaxMB: header.dataStorageMaxMB } : {}),
    ...(header.staging ? { staging: true } : {}),
  });
  const of = `The file holds checkpoint ${header.checkpointId}`;
  if (data.kind === 'real') {
    return {
      code: 'REPLAY_REAL_DATA',
      message:
        `${of} of ${data.why === 'staging' ? 'a sandbox marked Staging' : `a Partial Copy or Full sandbox, by its data storage (${count(data.dataStorageMaxMB ?? 0)} MB)`}, ` +
        `which may hold real data: it goes into another org masked only. To replay it into ` +
        `${asked.target}, ${COMMAND_LINE_REPLAY_WORDS.mask}. Its key was not read, and nothing ` +
        'was kept, read or written.',
    };
  }
  if (data.kind === 'unknown' && asked.choices.noRealData !== true) {
    return {
      code: 'REPLAY_COPY_UNKNOWN',
      message:
        `${of} of a sandbox, and does not say which: made before SandForge 1.81, it keeps no ` +
        'data storage, and a Partial Copy or a Full sandbox holds production’s records. To ' +
        `replay it into ${asked.target}, ${COMMAND_LINE_REPLAY_WORDS.mask}, or ` +
        `${COMMAND_LINE_REPLAY_WORDS.noRealData}. Its key was not read, and nothing was kept, ` +
        'read or written.',
    };
  }
  return undefined;
}

/** The key `name` holds, or the stop of the line, exit 2; what it holds is never repeated. */
function keyFromEnvironment(name: string): Buffer {
  const text = process.env[name];
  if (text === undefined || text.trim() === '') {
    throw new ReplayStop(
      { code: 'NO_KEY', message: `${name} is not set: it holds no key. Nothing was run.` },
      2,
    );
  }
  const key = parseArchiveKey(text);
  if (key === undefined) {
    throw new ReplayStop(
      {
        code: 'NO_KEY',
        message:
          `${name} holds no key SandForge reads: 52 letters and digits, in groups of four as an ` +
          'export shows one. Nothing was run.',
      },
      2,
    );
  }
  return key;
}

/** The key typed on the terminal, never echoed, or the stop of the replay. */
async function typedKey(): Promise<Buffer> {
  const text = await hidden(
    'Key of the file (not shown as you type it):',
    'give --key-env VAR, the name of an environment variable that holds the key',
  );
  if (text === undefined || text.trim() === '') {
    throw new ReplayStop({ code: 'DECLINED', message: 'No key was typed. Nothing was run.' });
  }
  const key = parseArchiveKey(text);
  if (key === undefined) {
    throw new ReplayStop({
      code: 'IMPORT_KEY',
      message:
        'That is not a key SandForge draws: 52 letters and digits, in groups of four as the ' +
        'export showed it. Nothing was run.',
    });
  }
  return key;
}

// ─── What it says ────────────────────────────────────────────────────────────

/** What the lines and the answer of one replay are made with. */
interface Said {
  asked: ReplayAsked;
  chosen: Chosen;
  /** The command that replays the checkpoint into the other org again. */
  again: string;
}

/** The replay's part of a message of the handler, the first one that has it. */
function replayInfoIn(message: FrozenPosted): FrozenReplayInfo | undefined {
  const info = message.payload?.replay;
  return typeof info === 'object' && info !== null ? (info as FrozenReplayInfo) : undefined;
}

/**
 * What a replay prints of a message, around the lines the load says of it:
 * before its plan, what it would set up and where; after it, every record
 * that does not go across as it was; after it ran, how to take it back.
 */
function replayLinesOf(message: FrozenPosted, lines: string[], said: Said): string[] {
  const info = replayInfoIn(message);
  if (info === undefined) return lines;
  const { again } = said;
  const target = info.target.name;
  const files =
    info.filesLeft.length > 0
      ? ` ${count(info.filesLeft.length)} file(s) are not replayed: a checkpoint keeps no file's content.`
      : '';
  if (message.type === 'frozen:load:preview:response') {
    const of = said.chosen.of ?? info.checkpoint.alias ?? info.checkpoint.organizationId;
    return [
      `A replay of checkpoint '${info.checkpoint.name}' (of ${of}, taken ` +
        `${when(info.checkpoint.takenAt)}) into ${target} would create copies of ` +
        `${count(info.summary.records.toCreate)} of its records there, parents first, with new ` +
        `Ids; nothing ${target} holds is changed or deleted.${files}`,
      ...lines,
      ...replayDetailLines(info),
    ];
  }
  if (message.type === 'frozen:load:response') {
    return [...lines, `To take it back: ${again} --remove`];
  }
  return lines;
}

/**
 * The flags of a dry run's line that change what its replay does, as the
 * replay is typed again: its choices, the files it read them from, its
 * gates' answers, its checkpoint first and its bound. Without the
 * configuration's file, the line a dry run gave failed on the required field
 * the configuration covered (`LOAD_CONFIG`); without what the org runs
 * accepted, it was refused for what the dry run had been told to accept.
 * Exported so it can be tested.
 */
export function replayFlagsOf(asked: ReplayAsked): string {
  const { choices } = asked;
  const first = asked.checkpointFirst;
  return [
    choices.objects.length > 0 ? ` --objects ${choices.objects.join(',')}` : '',
    ...choices.excluded.map((name) => ` --exclude-object ${name}`),
    choices.owners !== 'same' ? ` --owners ${choices.owners}` : '',
    asked.ownerMapFile !== undefined ? ` --owner-map ${typedWord(asked.ownerMapFile)}` : '',
    ...choices.link.map((link) => ` --link ${link.objectApiName}=${link.fields.join(',')}`),
    choices.customSettings ? ' --custom-settings' : '',
    choices.mask ? ' --mask' : '',
    choices.contactPoints === 'kept' ? ' --keep-contact-points' : '',
    choices.noRealData ? ' --no-real-data' : '',
    asked.configFile !== undefined ? ` --replay-config ${typedWord(asked.configFile)}` : '',
    asked.again ? ' --again' : '',
    asked.muteAutomation ? ' --mute-automation' : '',
    asked.acceptAutomation ? ' --accept-automation' : '',
    asked.acceptEmails ? ' --accept-emails' : '',
    first !== undefined ? ' --checkpoint-first' : '',
    first?.keepDays !== undefined ? ` --checkpoint-keep-days ${first.keepDays}` : '',
    ...(first?.excluded ?? []).map((name) => ` --checkpoint-exclude-object ${name}`),
    asked.maxRecords !== undefined ? ` --max-records ${asked.maxRecords}` : '',
  ].join('');
}

/** The last message of a type among those posted. */
function lastOf(
  posted: readonly FrozenPosted[],
  type: string,
): Record<string, unknown> | undefined {
  return posted.filter((message) => message.type === type).at(-1)?.payload;
}

/**
 * The keys of a Frozen step's answer a replay's leaves out: its tool and
 * step, the messages it posted, the dataset it loaded, and the checkpoint it
 * took first, which a replay's answer names `checkpointFirst`.
 */
const FROZEN_ANSWER_OWN: ReadonlySet<string> = new Set([
  'tool',
  'step',
  'posted',
  'dataset',
  'checkpoint',
]);

/**
 * What `replay --json` prints: the replay's own answer — its checkpoint, the
 * other org, its choices, what its dry run read and what it did — with the
 * load's counts, verdict and refusals as the Frozen step gives them, and
 * never the messages of the handler, which name the records of the
 * checkpoint's org by their keys.
 */
function replayAnswer(
  answer: FrozenAnswer,
  ending: { exit: number; ended?: true; refused?: RunRefusal; targetOrgId?: string },
  said: Said,
): Record<string, unknown> {
  const { asked, chosen, again } = said;
  const preview = lastOf(answer.posted, 'frozen:load:preview:response');
  const loaded = lastOf(answer.posted, 'frozen:load:response');
  const info = (loaded?.replay ?? preview?.replay) as FrozenReplayInfo | undefined;
  const plan = preview?.plan as FrozenLoadPlanInfo | undefined;
  const report = loaded?.report as FrozenLoadReportInfo | undefined;
  const removal = lastOf(answer.posted, 'frozen:remove:response')?.result;
  // What the Frozen step counted, read and refused, without its own keys:
  // the step it ran, the messages posted, a dataset the replay never read.
  const counted = Object.fromEntries(
    Object.entries(answer).filter(([key]) => !FROZEN_ANSWER_OWN.has(key)),
  );
  const first = answer.checkpoint;
  const organizationId = info?.target.organizationId ?? ending.targetOrgId;
  return {
    command: 'replay',
    action: asked.action,
    dryRun: asked.action === 'dryRun',
    checkpoint: info
      ? {
          id: info.checkpoint.checkpointId,
          name: info.checkpoint.name,
          organizationId: info.checkpoint.organizationId,
          takenAt: info.checkpoint.takenAt,
          tier: info.checkpoint.tier,
          annex: info.checkpoint.annex,
        }
      : {
          id: chosen.checkpointId,
          ...(chosen.name !== undefined ? { name: chosen.name } : {}),
          organizationId: chosen.organizationId,
        },
    target: {
      alias: asked.target,
      ...(organizationId !== undefined ? { organizationId: organizationKey(organizationId) } : {}),
    },
    ...(asked.action === 'replay' || asked.action === 'dryRun'
      ? { choices: info?.choices ?? asked.choices }
      : {}),
    ...(chosen.file ? { file: chosen.file.path } : {}),
    ...(plan ? { plan } : {}),
    ...(info
      ? {
          replay: {
            ...info.summary,
            filesLeft: info.filesLeft,
            ...(info.storage ? { storage: info.storage } : {}),
            requests: info.requests,
          },
        }
      : {}),
    ...(report ? { result: report } : {}),
    ...(removal !== undefined ? { removal } : {}),
    ...counted,
    ...(first ? { checkpointFirst: first } : {}),
    removeWith: `${again} --remove`,
    ...(ending.refused ? { refused: ending.refused } : {}),
    ...(ending.ended ? { ended: ending.ended } : {}),
    exit: ending.exit,
  };
}

// ─── replays ─────────────────────────────────────────────────────────────────

/** What `replays --json` prints of one replay. */
export function replayEntryJson(entry: ReplayEntry, store?: string): Record<string, unknown> {
  return {
    checkpointId: entry.checkpointId,
    ...(entry.checkpointName !== undefined ? { checkpointName: entry.checkpointName } : {}),
    sourceOrganizationId: entry.sourceOrganizationId,
    ...(entry.takenAt !== undefined ? { takenAt: entry.takenAt } : {}),
    target: entry.target,
    ...(entry.choices !== undefined ? { choices: entry.choices } : {}),
    ...(entry.replayedAt !== undefined ? { replayedAt: entry.replayedAt } : {}),
    inPlace: entry.inPlace,
    inPlaceByObject: entry.inPlaceByObject,
    ...(entry.removed ? { removed: true } : {}),
    removeWith: `${replayCommandOf(entry.checkpointId, entry.target.name ?? '<alias>', store)} --remove`,
  };
}

/** The lines `replays` prints, newest first. */
export function replaysLines(
  entries: readonly ReplayEntry[],
  root: string,
  target?: string,
  store?: string,
): string[] {
  if (entries.length === 0) {
    return [`No replay${target !== undefined ? ` into ${target}` : ''} is kept in ${root}.`];
  }
  return entries.flatMap((entry) => {
    const into = entry.target.name ?? entry.target.organizationId;
    const objects = entry.inPlaceByObject
      .map((object) => `${object.objectApiName} ${count(object.records)}`)
      .join(', ');
    return [
      `${entry.checkpointId}  ${entry.checkpointName !== undefined ? `'${entry.checkpointName}' ` : ''}` +
        `of ${entry.sourceOrganizationId}${entry.takenAt !== undefined ? `, taken ${when(entry.takenAt)}` : ''}` +
        `  into ${into} (${entry.target.organizationId})` +
        (entry.replayedAt !== undefined ? `  replayed ${when(entry.replayedAt)}` : ''),
      entry.inPlace > 0
        ? `  ${count(entry.inPlace)} record(s) in place: ${objects}`
        : entry.removed
          ? '  removed: none of its records is left there'
          : '  none of its records is left there',
      ...(entry.inPlace > 0
        ? [
            `  to take it back: ${replayCommandOf(entry.checkpointId, entry.target.name ?? '<alias>', store)} --remove`,
          ]
        : []),
    ];
  });
}

/** `replays`: the replays this machine keeps, read from its files alone, no org reached. */
export async function runReplays(
  target: string | undefined,
  context: Pick<ReplayContext, 'storeRoot' | 'storeNamed' | 'say'> & {
    answerJson(value: unknown): void;
  },
): Promise<void> {
  const replays = replayStoreAt(replayStoreRootOf(context.storeRoot, context.storeNamed));
  const all = await replays.list(
    target !== undefined && ORGANIZATION_ID.test(target) ? { targetOrganizationId: target } : {},
  );
  const entries =
    target !== undefined && !ORGANIZATION_ID.test(target)
      ? all.filter((entry) => entry.target.name === target)
      : all;
  const store = context.storeNamed ? context.storeRoot : undefined;
  for (const line of replaysLines(entries, replays.root, target, store)) context.say(line);
  context.answerJson(entries.map((entry) => replayEntryJson(entry, store)));
}

/**
 * What a deletion of checkpoints says of their replays still in place: each
 * stays in its org, and is still taken back from its own folder.
 */
export async function replaysLeftBy(
  deleted: readonly CheckpointListEntry[],
  context: Pick<ReplayContext, 'storeRoot' | 'storeNamed'>,
): Promise<{ lines: string[]; entries: ReplayEntry[] }> {
  let replays: ReplayStore;
  try {
    replays = new ReplayStore({ root: replayStoreRootOf(context.storeRoot, context.storeNamed) });
  } catch {
    return { lines: [], entries: [] };
  }
  const store = context.storeNamed ? context.storeRoot : undefined;
  const lines: string[] = [];
  const entries: ReplayEntry[] = [];
  for (const entry of deleted) {
    const of = await replays
      .replaysOf(entry.organizationId, entry.checkpointId)
      .catch((): ReplayEntry[] => []);
    const words = replaysInPlaceWords(of);
    if (words === undefined) continue;
    lines.push(`  ${words}`);
    for (const left of replaysInPlace(of)) {
      lines.push(
        `  to take it back: ${replayCommandOf(left.checkpointId, left.target.name ?? '<alias>', store)} --remove`,
      );
      entries.push(left);
    }
  }
  return { lines, entries };
}
