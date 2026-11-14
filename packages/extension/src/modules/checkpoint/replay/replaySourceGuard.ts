/**
 * What a replay of a checkpoint into another org is refused for before it
 * writes anything, judged on the checkpoint alone and on what the other org
 * is: the checkpoint's own org is never asked, and may be gone — a sandbox
 * refreshed, a scratch org expired, a teammate's org this machine never
 * reached.
 *
 * - `REPLAY_CHECKPOINT_UNUSABLE`: a take still under way, one that failed,
 *   or a file that does not read: its snapshot does not hold what its file
 *   counts.
 * - `REPLAY_SAME_ORG`: the other org answers with the checkpoint's own
 *   Organization Id. A replay creates copies with new Ids beside what the org
 *   holds; bringing the org back to that moment is a rewind's work.
 * - `REPLAY_REAL_DATA`: the checkpoint is of a sandbox marked Staging, or of
 *   a Partial Copy or Full one, told by its data storage as Salesforce
 *   documents it (200 MB for a Developer sandbox, 1 GB for a Developer Pro,
 *   5 GB for a Partial Copy, production's own for a Full): it may hold
 *   production's records, which go into another org masked only. A file a
 *   teammate sent says the same in its header, before any key.
 * - `REPLAY_COPY_UNKNOWN`: a sandbox's checkpoint that does not say its data
 *   storage — taken before 1.81, or the org did not answer it. Masked, or
 *   declared to hold no real data, a declaration the audit trail keeps.
 * - `REPLAY_NOTHING`: every object left out, or held empty.
 * - `REPLAY_TOO_MANY`: more records than a replay sets up at once
 *   (`REPLAY_MAX_RECORDS`): fewer objects.
 *
 * A Partial Copy or Full sandbox replayed into the sandbox it became once
 * refreshed puts nothing anywhere it was not: the data was that org's. The
 * other org is taken for it when it was the checkpoint's org before a
 * refresh the panel saw, or when it answers to the same username or the same
 * My Domain host, which a refresh keeps. A scratch org's and a Developer
 * Edition org's checkpoints hold no production data, and go anywhere a
 * replay goes.
 */

import {
  REPLAY_MAX_RECORDS,
  type CheckpointObject,
  type CheckpointOrg,
  type CheckpointReplayChoices,
  type CheckpointReplayNotReplayedReason,
  type CheckpointReplayRefusal,
  type CheckpointReplayRefusalCode,
  type OrgCheckpoint,
} from '@sandforge/shared';
import { DEVELOPER_PRO_DATA_STORAGE_MB } from '../../dataops/empty/emptyCopySandbox.js';
import { ATTACHMENT_OBJECT, FILE_OBJECT, FILE_VERSION_OBJECT } from '../checkpointScope.js';

/** What a refusal ends on: the guard asks before anything is read of either org, or written. */
export const NOTHING_REPLAYED = 'Nothing was read or written.';

/**
 * The objects whose records hold a file's content, which no checkpoint
 * keeps (`checkpointFields.ts`): a file, its versions, an attachment, a
 * document. A replay never sets one up: it would be a file with nothing in
 * it.
 */
export const FILE_CONTENT_OBJECTS: ReadonlySet<string> = new Set(
  [FILE_OBJECT, FILE_VERSION_OBJECT, ATTACHMENT_OBJECT, 'Document'].map((name) =>
    name.toLowerCase(),
  ),
);

/** Whether `objectApiName`'s records hold a file's content, which a checkpoint does not keep. */
export function holdsFileContent(objectApiName: string): boolean {
  return FILE_CONTENT_OBJECTS.has(objectApiName.toLowerCase());
}

// ─── Which objects a replay sets up ──────────────────────────────────────────

/** An object of the checkpoint a replay leaves out before reading anything, and why. */
export interface ObjectLeftOut {
  objectApiName: string;
  records: number;
  reason: Extract<CheckpointReplayNotReplayedReason, 'fileContentNotKept' | 'excluded'>;
}

/** The objects of a checkpoint a replay goes on with, by its choices, and those it leaves out. */
export interface ReplayableObjects {
  /** In the checkpoint's order. */
  replayed: CheckpointObject[];
  leftOut: ObjectLeftOut[];
  /** Objects the choices name that the checkpoint does not hold, as they were named. */
  unknown: string[];
  /** Records of the objects replayed, every object together. */
  records: number;
}

/**
 * The objects of `checkpoint` a replay asked `choices` goes on with: those it
 * names, or every one it holds, but those it leaves out; never a file's
 * content, and a custom setting only when asked. Names are matched without
 * regard to case, as Salesforce reads an API name.
 */
export function replayableObjectsOf(
  checkpoint: Pick<OrgCheckpoint, 'objects'>,
  choices: Pick<CheckpointReplayChoices, 'objects' | 'excluded' | 'customSettings'>,
): ReplayableObjects {
  const held = new Map(
    checkpoint.objects.map((object) => [object.objectApiName.toLowerCase(), object]),
  );
  const named = new Set(choices.objects.map((name) => name.toLowerCase()));
  const excluded = new Set(choices.excluded.map((name) => name.toLowerCase()));
  const unknown = [...choices.objects, ...choices.excluded].filter(
    (name) => !held.has(name.toLowerCase()),
  );
  const replayed: CheckpointObject[] = [];
  const leftOut: ObjectLeftOut[] = [];
  for (const object of checkpoint.objects) {
    const key = object.objectApiName.toLowerCase();
    const leave = (reason: ObjectLeftOut['reason']): void => {
      leftOut.push({ objectApiName: object.objectApiName, records: object.records, reason });
    };
    if (holdsFileContent(object.objectApiName)) leave('fileContentNotKept');
    else if (named.size > 0 && !named.has(key)) leave('excluded');
    else if (excluded.has(key)) leave('excluded');
    else if (object.customSetting !== undefined && !choices.customSettings) leave('excluded');
    else replayed.push(object);
  }
  return {
    replayed,
    leftOut,
    unknown: [...new Set(unknown)],
    records: replayed.reduce((sum, object) => sum + object.records, 0),
  };
}

// ─── Whether the checkpoint may hold real data ───────────────────────────────

/**
 * What a checkpoint's org says of the data it holds, read from what the take
 * kept, never from the org: free of production's records (a scratch org, a
 * Developer Edition org, a Developer or Developer Pro sandbox), possibly
 * holding them (Staging, Partial Copy, Full), or a sandbox that does not say.
 */
export type ReplaySourceData =
  | { kind: 'free'; why: 'scratch' | 'developer' | 'developerSandbox'; dataStorageMaxMB?: number }
  | { kind: 'real'; why: 'staging' | 'storage'; dataStorageMaxMB?: number }
  | { kind: 'unknown' };

/** See {@link ReplaySourceData}. */
export function sourceDataOf(
  org: Pick<CheckpointOrg, 'tier' | 'dataStorageMaxMB' | 'staging'>,
): ReplaySourceData {
  const mb = org.dataStorageMaxMB !== undefined ? { dataStorageMaxMB: org.dataStorageMaxMB } : {};
  // A mark the file says is believed whatever the tier: a header another
  // machine wrote is no proof the org was a scratch org.
  if (org.staging === true) return { kind: 'real', why: 'staging', ...mb };
  if (org.tier === 'scratch') return { kind: 'free', why: 'scratch', ...mb };
  if (org.tier === 'developer') return { kind: 'free', why: 'developer', ...mb };
  if (org.dataStorageMaxMB === undefined) return { kind: 'unknown' };
  return org.dataStorageMaxMB > DEVELOPER_PRO_DATA_STORAGE_MB
    ? { kind: 'real', why: 'storage', dataStorageMaxMB: org.dataStorageMaxMB }
    : { kind: 'free', why: 'developerSandbox', dataStorageMaxMB: org.dataStorageMaxMB };
}

/** The other org of a replay, as the guard knows it once connected. */
export interface ReplayGuardTarget {
  /** What it is named by in a refusal: its alias, else its username. */
  name: string;
  /** Its Organization Id, as it answered once connected; absent before. */
  organizationId?: string;
  /** The user the replay connects to it as. */
  username?: string;
  /** Its instance URL: a My Domain host, which a refresh keeps. */
  instanceUrl?: string;
  /** The Organization Ids it had before the refreshes the panel saw of it. */
  formerOrganizationIds?: readonly string[];
}

/** Why the other org is taken for the sandbox the checkpoint was of, refreshed since. */
export type SameSandboxBy = 'formerOrganizationId' | 'username' | 'myDomain';

/** Whether two Organization Ids name one org: their first fifteen characters. */
function sameOrganization(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.slice(0, 15) === b.slice(0, 15);
}

/** A host of My Domain, which names one org: never a pod's, which many share. */
const MY_DOMAIN_HOST = /\.my\.salesforce\.com$/;

/** The My Domain host of an instance URL; undefined for a pod's host, or no URL. */
function myDomainOf(instanceUrl: string | undefined): string | undefined {
  if (instanceUrl === undefined) return undefined;
  try {
    const host = new URL(instanceUrl).hostname.toLowerCase();
    return MY_DOMAIN_HOST.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the other org is the sandbox the checkpoint was taken of, refreshed
 * since — and by what it is told so — or undefined. A sandbox's alone: a
 * scratch org or a Developer Edition org is never refreshed into another.
 */
export function sameSandboxRefreshed(
  org: Pick<CheckpointOrg, 'tier' | 'organizationId' | 'username' | 'instanceUrl'>,
  target: ReplayGuardTarget,
): SameSandboxBy | undefined {
  if (org.tier !== 'sandbox') return undefined;
  if ((target.formerOrganizationIds ?? []).some((id) => sameOrganization(id, org.organizationId))) {
    return 'formerOrganizationId';
  }
  if (
    target.username !== undefined &&
    target.username.trim().toLowerCase() === org.username.trim().toLowerCase()
  ) {
    return 'username';
  }
  const host = myDomainOf(target.instanceUrl);
  if (host !== undefined && host === myDomainOf(org.instanceUrl)) return 'myDomain';
  return undefined;
}

// ─── The refusals ────────────────────────────────────────────────────────────

/**
 * How a refusal tells the person what lifts it, in the words of where they
 * replay: the command line's flags unless a page gives its own.
 */
export interface ReplayRefusalWords {
  /** How masking is asked. */
  mask: string;
  /** How the checkpoint is declared to hold no real data. */
  noRealData: string;
  /** How fewer objects are replayed. */
  fewerObjects: string;
  /** How the checkpoint's own org is brought back to its moment instead. */
  rewind: string;
}

/** The command line's words. */
export const COMMAND_LINE_REPLAY_WORDS: ReplayRefusalWords = {
  mask: 'replay it masked (--mask)',
  noRealData: 'declare that it holds no real data (--no-real-data), which the audit trail keeps',
  fewerObjects: 'name the objects to replay (--objects A,B) or leave some out (--exclude-object X)',
  rewind: 'rewind that org to the checkpoint instead',
};

/** A replay refused, with what the refusal names, for a page that words it in its own language. */
export interface ReplayRefusal extends CheckpointReplayRefusal {
  params: Readonly<Record<string, string | number>>;
}

function refusal(
  code: CheckpointReplayRefusalCode,
  message: string,
  params: Record<string, string | number>,
): ReplayRefusal {
  return { code, message: `${message} ${NOTHING_REPLAYED}`, params };
}

/** A count as the command line writes it. */
function counted(n: number): string {
  return n.toLocaleString('en-US');
}

/** What the guard is asked. */
export interface ReplaySourceGuardInput {
  /** The checkpoint as its file reads; undefined when it does not. */
  checkpoint: OrgCheckpoint | undefined;
  /** Its id, for a checkpoint whose file does not read. */
  checkpointId: string;
  choices: CheckpointReplayChoices;
  target: ReplayGuardTarget;
  /** The most records a replay sets up at once: `REPLAY_MAX_RECORDS` unless a test names another. */
  maxRecords?: number;
  words?: Partial<ReplayRefusalWords>;
}

/**
 * The refusal of a replay, or undefined when it may go on to read the other
 * org: in the order a person lifts them — the checkpoint, the org, the data,
 * then the objects.
 */
export function replaySourceRefusal(input: ReplaySourceGuardInput): ReplayRefusal | undefined {
  const words = { ...COMMAND_LINE_REPLAY_WORDS, ...input.words };
  const { checkpoint, target } = input;
  if (checkpoint === undefined) {
    return refusal(
      'REPLAY_CHECKPOINT_UNUSABLE',
      `Checkpoint ${input.checkpointId} does not read: its file is damaged, and what it holds ` +
        'cannot be told.',
      { checkpoint: input.checkpointId, why: 'damaged' },
    );
  }
  const name = checkpoint.name;
  if (checkpoint.status !== 'ready') {
    return refusal(
      'REPLAY_CHECKPOINT_UNUSABLE',
      checkpoint.status === 'taking'
        ? `Checkpoint '${name}' is still being taken, or its take stopped before its end: ` +
            'it holds part of its org at most.'
        : `The take of checkpoint '${name}' failed: it holds part of its org at most.`,
      { checkpoint: name, why: checkpoint.status },
    );
  }
  const sameOrg = replaySameOrgRefusal(checkpoint, target, words);
  if (sameOrg !== undefined) return sameOrg;

  const data = replayDataRefusal(checkpoint, input.choices, target, words);
  if (data !== undefined) return data;

  const objects = replayableObjectsOf(checkpoint, input.choices);
  if (objects.records === 0) {
    const why =
      objects.replayed.length === 0
        ? 'every object it holds is left out'
        : 'the objects replayed hold no record';
    return refusal(
      'REPLAY_NOTHING',
      `Nothing of checkpoint '${name}' is left to replay into ${target.name}: ${why}` +
        `${filesOnly(objects) ? ', and a checkpoint keeps no file’s content' : ''}.`,
      { checkpoint: name, target: target.name },
    );
  }
  const max = input.maxRecords ?? REPLAY_MAX_RECORDS;
  if (objects.records > max) {
    return refusal(
      'REPLAY_TOO_MANY',
      `Checkpoint '${name}' would replay ${counted(objects.records)} records into ` +
        `${target.name}, past the ${counted(max)} a replay sets up at once: ` +
        `${words.fewerObjects}.`,
      { checkpoint: name, target: target.name, records: objects.records, max },
    );
  }
  return undefined;
}

/** Whether what is left out is files alone: the reason a checkpoint of files replays nothing. */
function filesOnly(objects: ReplayableObjects): boolean {
  return (
    objects.leftOut.length > 0 &&
    objects.leftOut.every((left) => left.reason === 'fileContentNotKept')
  );
}

/**
 * The refusal of a replay into the checkpoint's own org, told by the
 * Organization Id it answers with: undefined while it has not answered.
 */
export function replaySameOrgRefusal(
  checkpoint: Pick<OrgCheckpoint, 'name' | 'org'>,
  target: ReplayGuardTarget,
  words: Partial<ReplayRefusalWords> = {},
): ReplayRefusal | undefined {
  if (!sameOrganization(target.organizationId, checkpoint.org.organizationId)) return undefined;
  const rewind = words.rewind ?? COMMAND_LINE_REPLAY_WORDS.rewind;
  return refusal(
    'REPLAY_SAME_ORG',
    `${target.name} is the org checkpoint '${checkpoint.name}' was taken of: a replay creates ` +
      `copies of its records in another org, beside what that org holds. To bring ${target.name} ` +
      `back to that moment, ${rewind}.`,
    { checkpoint: checkpoint.name, target: target.name },
  );
}

/**
 * The refusal of a replay of data that may be real into another org without
 * masking: undefined when the checkpoint holds none, when the replay masks,
 * when the other org is the sandbox it was of, or — for a sandbox's that does
 * not say its license — when the person declared it holds no real data.
 */
export function replayDataRefusal(
  checkpoint: Pick<OrgCheckpoint, 'name' | 'org'>,
  choices: Pick<CheckpointReplayChoices, 'mask' | 'noRealData'>,
  target: ReplayGuardTarget,
  words: Partial<ReplayRefusalWords> = {},
): ReplayRefusal | undefined {
  const said = { ...COMMAND_LINE_REPLAY_WORDS, ...words };
  const data = sourceDataOf(checkpoint.org);
  if (data.kind === 'free' || choices.mask) return undefined;
  if (sameSandboxRefreshed(checkpoint.org, target) !== undefined) return undefined;
  const name = checkpoint.name;
  if (data.kind === 'unknown') {
    if (choices.noRealData === true) return undefined;
    return refusal(
      'REPLAY_COPY_UNKNOWN',
      `Checkpoint '${name}' is of a sandbox and does not say which: taken before SandForge 1.81, ` +
        'it keeps no data storage, and a Partial Copy or a Full sandbox holds production’s ' +
        `records. To replay it into ${target.name}, ${said.mask}, or ${said.noRealData}.`,
      { checkpoint: name, target: target.name },
    );
  }
  const what =
    data.why === 'staging'
      ? 'a sandbox marked Staging, which holds real data'
      : `a Partial Copy or Full sandbox, by its data storage (${counted(data.dataStorageMaxMB ?? 0)} ` +
        `MB, past the ${counted(DEVELOPER_PRO_DATA_STORAGE_MB)} MB of a Developer Pro), which ` +
        'may hold real data';
  return refusal(
    'REPLAY_REAL_DATA',
    `Checkpoint '${name}' is of ${what}: it goes into another org masked only. To replay it ` +
      `into ${target.name}, ${said.mask}.`,
    {
      checkpoint: name,
      target: target.name,
      why: data.why,
      ...(data.dataStorageMaxMB !== undefined ? { mb: data.dataStorageMaxMB } : {}),
    },
  );
}

// ─── What the audit trail keeps of it ────────────────────────────────────────

/**
 * What a replay's entry in the audit trail says of the data it set up, beside
 * its counts (`WriteRun.details`): what the checkpoint's org was, whether the
 * replay masked, and the person's declaration that a sandbox's checkpoint
 * that does not say its license holds no real data — kept, because it lifted
 * the refusal on their word alone. Words and flags only, never a value.
 */
export function replayAuditDetails(
  checkpoint: Pick<OrgCheckpoint, 'org'>,
  choices: Pick<CheckpointReplayChoices, 'mask' | 'noRealData' | 'contactPoints'>,
  target: ReplayGuardTarget,
): Record<string, string | boolean | number> {
  const data = sourceDataOf(checkpoint.org);
  const sameSandbox = sameSandboxRefreshed(checkpoint.org, target);
  const declared = data.kind === 'unknown' && !choices.mask && choices.noRealData === true;
  return {
    replaySource: data.kind === 'free' ? data.why : data.kind === 'real' ? data.why : 'unknown',
    ...(data.kind !== 'unknown' && data.dataStorageMaxMB !== undefined
      ? { replaySourceStorageMB: data.dataStorageMaxMB }
      : {}),
    replayMasked: choices.mask,
    replayContactPoints: choices.contactPoints,
    ...(declared ? { replayNoRealDataDeclared: true } : {}),
    ...(sameSandbox !== undefined && !choices.mask && data.kind !== 'free'
      ? { replayIntoSameSandbox: sameSandbox }
      : {}),
  };
}
