/**
 * The `replay` kind of resource: a checkpoint's records set up again in the
 * org by `sandforge checkpoint replay` — what a sandbox held before its
 * refresh, or another org's checkpoint —, with new Ids, parents first,
 * nothing the org holds changed or deleted. Its removal is the replay's own
 * (`replay --remove`).
 *
 * The file names the checkpoint by one of three forms: its `id`, kept on
 * this machine; its `name`, the newest of that name taken of this sandbox
 * before its refresh — the same username, or the same My Domain host —, or
 * of the org its role `from` names; or an exported `file`, opened with the
 * key the variable `keyEnv` holds. The plan resolves each to the checkpoint
 * it means, by id, from this machine's files alone: no org is reached, and
 * no key is read. The fingerprint is of that id and of the replay's choices:
 * a newer checkpoint of the same name is another replay, which replaces the
 * one before; a file moved, or a key under another variable, is the same.
 *
 * Its lines name the checkpoint by the id the plan resolved, with the org it
 * was taken of: the replay writes what the plan read, never a checkpoint
 * taken in between under the same name. A file is named by its path and the
 * variable that holds its key (`--key-env`), never by the key. Each choice
 * of the file is its flag, one by one: `--objects`, `--exclude-object`,
 * `--owners`, `--custom-settings`, `--mask`, `--keep-contact-points`,
 * `--max-records`.
 *
 * Its steps are the replay's: a dry run (`--dry-run --json`), whose counts
 * the plan shows; a run (`--yes --json`) held to what that dry run counted
 * to create (`--max-records`); a replace that is a replay again (`--again`),
 * whose purge takes back what the replays before it created there first;
 * the removal (`--remove`) and its preview (`--remove --preview`), named by
 * the checkpoint the run's answer, kept as its summary, says. Every line
 * names the store the environment keeps its checkpoints in (`--store`),
 * which keeps their replays too.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  checkpointReplayChoicesSchema,
  type CheckpointListEntry,
  type CheckpointReplayChoices,
  type EnvDocumentPath,
  type EnvRef,
  type EnvReplayCheckpoint,
  type EnvReplayResource,
} from '@sandforge/shared';
import {
  readArchiveHeader,
  receivedStoreRootOf,
} from '../../../src/modules/checkpoint/checkpointArchive.js';
import {
  openCheckpointStore,
  storeRefusalWords,
} from '../../../src/modules/checkpoint/OrgCheckpointStore.js';
import {
  sameSandboxRefreshed,
  type ReplayGuardTarget,
} from '../../../src/modules/checkpoint/replay/replaySourceGuard.js';
import { countedStorageBytes } from '../../../src/modules/forge/ForgeRunGate.js';
import { replayRefusedWords } from '../../checkpointReplay.js';
import { commandOf } from '../../invocation.js';
import type { RunnableScript } from '../../scriptRunner.js';
import {
  codesSaidIn,
  countSchema,
  readAnswer,
  refusalAt,
  removalObjectSchema,
  removalPreviewSchema,
  sweepSwitches,
  valueOf,
  type EnvDryRunCount,
  type EnvFileRefusal,
  type EnvRunCount,
  type EnvSweepAsk,
} from './common.js';

/** The script a `replay` resource runs: the checkpoint script, which replays and takes a replay back. */
export const REPLAY_SCRIPT = 'sandforge-checkpoint' satisfies RunnableScript;

/** The code of a checkpoint the plan finds nowhere on this machine. */
export const REPLAY_CHECKPOINT_NOT_FOUND = 'REPLAY_CHECKPOINT_NOT_FOUND';

/** The codes of a removal, or its preview, that has nothing to take: no failure. */
const NOTHING_TO_REMOVE = new Set(['NO_LOAD', 'ALREADY_REMOVED', 'NOTHING_TO_REMOVE']);

// ─── The resource, converted ─────────────────────────────────────────────────

/** What a replay resource runs: the checkpoint it names and its choices, as the file writes them. */
export interface EnvReplayRun {
  checkpoint: EnvReplayCheckpoint;
  /** With `checkpoint.name`: the org role the checkpoint of that name was taken of. */
  from?: string;
  objects?: string[];
  excludeObjects?: string[];
  owners?: 'same' | 'me';
  customSettings?: boolean;
  mask?: boolean;
  keepContactPoints?: boolean;
  maxRecords?: number;
  /** What fires as the replay writes, or as `--again` purges, is accepted in the file. */
  acceptAutomation?: true;
}

/** The choices of a replay, as the replay's own line makes them of its flags. */
export function replayChoicesOf(run: EnvReplayRun): CheckpointReplayChoices {
  return {
    owners: run.owners ?? 'same',
    customSettings: run.customSettings === true,
    mask: run.mask === true,
    contactPoints: run.keepContactPoints === true ? 'kept' : 'neutralized',
    objects: run.objects ?? [],
    excluded: run.excludeObjects ?? [],
    link: [],
  };
}

/** The key of the file each field of the replay's choices comes from, as a refusal names it. */
const KEY_OF_CHOICE: Readonly<Record<string, string>> = {
  owners: 'owners',
  customSettings: 'customSettings',
  mask: 'mask',
  contactPoints: 'keepContactPoints',
  objects: 'objects',
  excluded: 'excludeObjects',
};

/**
 * What a replay resource runs, checked by the schema the replay holds its
 * choices to, refused where the file wrote what it refuses.
 */
export function replayRunOfResource(
  name: string,
  resource: EnvReplayResource,
): { run: EnvReplayRun; warnings: EnvFileRefusal[] } | { refusals: EnvFileRefusal[] } {
  const run: EnvReplayRun = {
    checkpoint: resource.checkpoint,
    ...(resource.from !== undefined ? { from: resource.from } : {}),
    ...(resource.objects !== undefined ? { objects: resource.objects } : {}),
    ...(resource.excludeObjects !== undefined ? { excludeObjects: resource.excludeObjects } : {}),
    ...(resource.owners !== undefined ? { owners: resource.owners } : {}),
    ...(resource.customSettings !== undefined ? { customSettings: resource.customSettings } : {}),
    ...(resource.mask !== undefined ? { mask: resource.mask } : {}),
    ...(resource.keepContactPoints !== undefined
      ? { keepContactPoints: resource.keepContactPoints }
      : {}),
    ...(resource.maxRecords !== undefined ? { maxRecords: resource.maxRecords } : {}),
    ...(resource.accept?.automation === true ? { acceptAutomation: true } : {}),
  };
  const checked = checkpointReplayChoicesSchema.safeParse(replayChoicesOf(run));
  if (!checked.success) {
    return {
      refusals: checked.error.issues.map((issue) => {
        const [field, ...rest] = issue.path;
        const key = KEY_OF_CHOICE[String(field)] ?? String(field);
        return refusalAt(
          ['resources', name, key, ...(rest as EnvDocumentPath)],
          `refused by the choices a replay takes: ${issue.message}`,
        );
      }),
    };
  }
  return { run, warnings: [] };
}

/** Objects named as Salesforce names them, whatever their case, in one order; none as none. */
function objectsOf(objects: readonly string[] | undefined): string[] | null {
  if (objects === undefined || objects.length === 0) return null;
  return [...new Set(objects.map((object) => object.toLowerCase()))].sort();
}

/** The objects a replay names, which `validate` lists: those its dry run counts otherwise. */
export function replayObjectsOf(run: EnvReplayRun): Array<{ object: string }> {
  return (run.objects ?? []).map((object) => ({ object }));
}

// ─── The checkpoint, resolved at each plan ───────────────────────────────────

/**
 * The checkpoint the plan resolved a replay resource to, from this machine's
 * files: its id and the org it was taken of; or why there is none to replay,
 * which blocks the resource.
 */
export type EnvReplayCheckpointRead =
  | { checkpointId: string; organizationId: string; name?: string; takenAt?: string }
  | { refusal: string; code: string };

/** Where a replay resource's checkpoint is, beside the file: what resolving the file gave. */
export interface EnvReplayPlace {
  /** With `checkpoint.name` and `from`: the alias the role resolves to. */
  from?: string;
  /** With `checkpoint.file`: its path from the root, the variable's when it is one. */
  file?: string;
  /** What the plan resolved the checkpoint to; absent until it did, and for a destroy. */
  read?: EnvReplayCheckpointRead;
}

/**
 * The path of a replay resource's checkpoint file: the file's, or the
 * variable's; or why it may not be read. Unset, or not from the root, it is
 * refused where the file names it.
 */
export function replayFileOf(
  name: string,
  file: string | EnvRef,
  env: NodeJS.ProcessEnv,
): { file: string } | { refusal: EnvFileRefusal } {
  if (typeof file === 'string') return { file };
  const at: EnvDocumentPath = ['resources', name, 'checkpoint', 'file'];
  const value = (env[file.env] ?? '').trim();
  if (value === '') {
    return {
      refusal: refusalAt(
        at,
        `the variable ${file.env} is not set: set it in the job's environment to the path of the ` +
          `checkpoint file ${name} replays`,
      ),
    };
  }
  if (!isAbsolute(value)) {
    return {
      refusal: refusalAt(
        at,
        `the variable ${file.env} holds ${value}, which is not a path from the root: give the ` +
          'checkpoint file from the root',
      ),
    };
  }
  return { file: value };
}

/** The org a replay goes into, as the plan reached it. */
export interface ReplayTargetOrg {
  /** sf CLI alias, as a line names it. */
  alias: string;
  organizationId: string;
  /** The user SandForge connects as: a refresh keeps it. */
  username?: string;
  /** Its instance URL: a sandbox's My Domain host, which a refresh keeps. */
  instanceUrl?: string;
}

/** Whether a checkpoint listed can be replayed: one of an org refreshed or expired since can. */
function replayable(entry: CheckpointListEntry): boolean {
  return (
    entry.checkpoint !== undefined &&
    (entry.valid || entry.why === 'refreshed' || entry.why === 'scratchExpired')
  );
}

/** Whether two Organization Ids name one org. */
function sameOrg(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/** The newest of the checkpoints given, by when each was taken. */
function newestOf(entries: readonly CheckpointListEntry[]): CheckpointListEntry | undefined {
  return [...entries].sort((a, b) =>
    (b.checkpoint?.takenAt ?? '').localeCompare(a.checkpoint?.takenAt ?? ''),
  )[0];
}

/** A checkpoint listed, as the plan resolved it. */
function readOf(entry: CheckpointListEntry): EnvReplayCheckpointRead {
  return {
    checkpointId: entry.checkpointId,
    organizationId: entry.organizationId,
    ...(entry.checkpoint !== undefined
      ? { name: entry.checkpoint.name, takenAt: entry.checkpoint.takenAt }
      : {}),
  };
}

/** Where a checkpoint the plan did not find may come from, in a refusal's words. */
function notFoundWays(name: string, alias: string): string {
  return (
    `take one before the next refresh: ${commandOf('checkpoint')} take --org ${alias} --name ` +
    `${name}; or name an exported file: checkpoint: { file: …, keyEnv: … }`
  );
}

/**
 * The checkpoint a replay resource of `id` or `name` means, among those this
 * machine keeps (`entries`, as the store lists them):
 *
 * - by `id`, the one of that id, the org's of the line when two orgs keep it;
 * - by `name` with `from`, the newest of that name taken under the alias the
 *   role resolves to, or under the username of a checkpoint so taken, or
 *   filed under the same Organization Id, as `--from` reads them;
 * - by `name` alone, the newest of that name of this sandbox before its
 *   refresh: of another Organization Id, a sandbox's, taken as the same user
 *   or on the same My Domain host (`sameSandboxRefreshed`).
 *
 * None refuses the resource, naming where one comes from.
 */
export function resolveReplayCheckpoint(
  run: EnvReplayRun,
  place: Pick<EnvReplayPlace, 'from'>,
  entries: readonly CheckpointListEntry[],
  target: ReplayTargetOrg,
): EnvReplayCheckpointRead {
  const { checkpoint } = run;
  const usable = entries.filter(replayable);
  if (checkpoint.id !== undefined) {
    const kept = usable.filter((entry) => entry.checkpointId === checkpoint.id);
    const orgs = [...new Set(kept.map((entry) => entry.organizationId.slice(0, 15)))];
    const one = kept[0];
    if (one !== undefined && orgs.length === 1) return readOf(one);
    if (orgs.length > 1) {
      return {
        code: 'AMBIGUOUS',
        refusal:
          `checkpoints of ${orgs.length} orgs have the id ${checkpoint.id} on this machine: ` +
          `name it by name with from, the org role it was taken of`,
      };
    }
    return {
      code: REPLAY_CHECKPOINT_NOT_FOUND,
      refusal:
        `no checkpoint ${checkpoint.id} is kept on this machine: ` +
        `"${commandOf('checkpoint')} list" names those it keeps`,
    };
  }
  const name = checkpoint.name ?? '';
  let ofOrg: CheckpointListEntry[];
  let whose: string;
  if (place.from !== undefined) {
    const from = place.from;
    const orgs = usable
      .filter((entry) => {
        const org = entry.checkpoint?.org;
        return (
          org !== undefined &&
          (org.alias === from || org.username.toLowerCase() === from.toLowerCase())
        );
      })
      .map((entry) => entry.organizationId);
    ofOrg = usable.filter((entry) => orgs.some((id) => sameOrg(id, entry.organizationId)));
    whose = `of ${from}`;
  } else {
    const guard: ReplayGuardTarget = {
      name: target.alias,
      organizationId: target.organizationId,
      ...(target.username !== undefined ? { username: target.username } : {}),
      ...(target.instanceUrl !== undefined ? { instanceUrl: target.instanceUrl } : {}),
    };
    ofOrg = usable.filter(
      (entry) =>
        entry.checkpoint !== undefined &&
        !sameOrg(entry.organizationId, target.organizationId) &&
        sameSandboxRefreshed(entry.checkpoint.org, guard) !== undefined,
    );
    whose = `of ${target.alias} before its refresh`;
  }
  const newest = newestOf(ofOrg.filter((entry) => entry.checkpoint?.name === name));
  if (newest !== undefined) return readOf(newest);
  return {
    code: REPLAY_CHECKPOINT_NOT_FOUND,
    refusal:
      `no checkpoint ${whose} named '${name}' is kept on this machine: ` +
      notFoundWays(name, place.from ?? target.alias),
  };
}

/** What reading a replay resource's checkpoint takes beside it. */
export interface ReplayCheckpointPlace {
  /** The folder the environment keeps its checkpoints in, files received among them. */
  storeRoot: string;
  /** The folder of the checkpoints' locks. */
  locksDir?: string;
  /** Reads a checkpoint file's header, before any key; a test names another. */
  readHeader?: typeof readArchiveHeader;
}

/**
 * The checkpoint a replay resource means, resolved from this machine's files:
 * a file's from its header, read before any key and without it; the others'
 * from the checkpoints the store keeps, those of the files received among
 * them (see {@link resolveReplayCheckpoint}).
 */
export async function readReplayCheckpoint(
  run: EnvReplayRun,
  place: EnvReplayPlace,
  target: ReplayTargetOrg,
  where: ReplayCheckpointPlace,
): Promise<EnvReplayCheckpointRead> {
  if (run.checkpoint.file !== undefined) {
    if (place.file === undefined) {
      return { code: REPLAY_CHECKPOINT_NOT_FOUND, refusal: 'its checkpoint file was not resolved' };
    }
    const read = await (where.readHeader ?? readArchiveHeader)(place.file);
    if ('refusal' in read) {
      return { code: read.refusal.code, refusal: read.refusal.message };
    }
    const { header } = read.read;
    return {
      checkpointId: header.checkpointId,
      organizationId: header.organizationId,
      takenAt: header.takenAt,
    };
  }
  const entries: CheckpointListEntry[] = [];
  for (const root of [where.storeRoot, receivedStoreRootOf(where.storeRoot)]) {
    if (!existsSync(root)) continue;
    const opened = openCheckpointStore({
      root,
      ...(where.locksDir !== undefined ? { locksDir: where.locksDir } : {}),
    });
    if ('refusal' in opened) {
      return {
        code: 'STORE_REFUSED',
        refusal:
          `the checkpoints kept in ${root} cannot be read: ` +
          storeRefusalWords(opened.refusal, root, 'SANDFORGE_JOURNAL_DIR'),
      };
    }
    entries.push(...(await opened.store.list()));
  }
  return resolveReplayCheckpoint(run, place, entries, target);
}

/**
 * What a replay writes, and nothing else: the fingerprint of a resource is
 * of this. Its checkpoint by the id and the org the plan resolved it to,
 * never by the name or the file it was found by, nor the variable its key is
 * in; its choices, those the file leaves out as the replay defaults them.
 * Not the most it may create, nor what it accepts, which change no record.
 */
export function replayWritten(
  run: EnvReplayRun,
  read: EnvReplayCheckpointRead | undefined,
): Record<string, unknown> {
  const resolved = read !== undefined && 'checkpointId' in read ? read : undefined;
  const choices = replayChoicesOf(run);
  return {
    kind: 'replay',
    kindVersion: 1,
    checkpoint:
      resolved !== undefined
        ? { id: resolved.checkpointId, organizationId: resolved.organizationId.slice(0, 15) }
        : {
            unread:
              run.checkpoint.id ??
              (run.checkpoint.name !== undefined
                ? { name: run.checkpoint.name, from: run.from ?? null }
                : 'file'),
          },
    owners: choices.owners,
    customSettings: choices.customSettings,
    mask: choices.mask,
    contactPoints: choices.contactPoints,
    objects: objectsOf(run.objects),
    excludeObjects: objectsOf(run.excludeObjects),
  };
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** What every line of a replay resource is given. */
export interface ReplayLine {
  /** The name of the resource, as an error names it. */
  name: string;
  run: EnvReplayRun;
  place: EnvReplayPlace;
  /** sf CLI alias of the org the environment is applied to. */
  target: string;
  /** The folder the environment keeps its checkpoints in, and the replays of them: `--store`. */
  store: string;
  /** What fires as it writes, or as `--again` purges, is accepted: the line's, or the file's. */
  acceptAutomation?: boolean;
}

/**
 * How a replay's line names its checkpoint: a file by its path and the
 * variable its key is in; any other by the id the plan resolved it to, with
 * the org it was taken of; one named by id and not resolved, by that id.
 */
function checkpointSwitches(input: ReplayLine): string[] {
  const { run, place } = input;
  if (run.checkpoint.file !== undefined) {
    if (place.file === undefined || run.checkpoint.keyEnv === undefined) {
      throw new Error(`${input.name} names a checkpoint file that was not resolved: plan again.`);
    }
    return [
      '--file',
      valueOf('--file', place.file),
      '--key-env',
      valueOf('--key-env', run.checkpoint.keyEnv),
    ];
  }
  const read = place.read;
  if (read !== undefined && 'checkpointId' in read) {
    return [
      '--checkpoint',
      valueOf('--checkpoint', read.checkpointId),
      '--from',
      valueOf('--from', read.organizationId),
    ];
  }
  if (run.checkpoint.id !== undefined) {
    return ['--checkpoint', valueOf('--checkpoint', run.checkpoint.id)];
  }
  throw new Error(
    `${input.name} names its checkpoint by a name this plan has not resolved: plan again.`,
  );
}

/** The flags of the file's choices, one by one, each as the replay's own line takes it. */
function choiceSwitches(run: EnvReplayRun): string[] {
  return [
    ...(run.objects !== undefined && run.objects.length > 0
      ? ['--objects', valueOf('--objects', run.objects.join(','))]
      : []),
    ...(run.excludeObjects ?? []).flatMap((object) => [
      '--exclude-object',
      valueOf('--exclude-object', object),
    ]),
    ...(run.owners !== undefined ? ['--owners', run.owners] : []),
    ...(run.customSettings === true ? ['--custom-settings'] : []),
    ...(run.mask === true ? ['--mask'] : []),
    ...(run.keepContactPoints === true ? ['--keep-contact-points'] : []),
  ];
}

/** The switches a replay and its dry run share. */
function replaySwitches(input: ReplayLine & { again: boolean }): string[] {
  return [
    'replay',
    ...checkpointSwitches(input),
    '--target',
    valueOf('--target', input.target),
    '--store',
    valueOf('--store', input.store),
    ...choiceSwitches(input.run),
    ...(input.again ? ['--again'] : []),
    ...(input.acceptAutomation === true || input.run.acceptAutomation === true
      ? ['--accept-automation']
      : []),
  ];
}

/**
 * The line of a replay resource's dry run: what a replay would create,
 * nothing written. A replace's is a replay again (`--again`), its purge of
 * what the replays before created counted first. Held to the file's bound,
 * so that it says what a replay past it would meet.
 */
export function replayDryRunLine(input: ReplayLine & { again: boolean }): string[] {
  return [
    ...replaySwitches(input),
    ...(input.run.maxRecords !== undefined ? ['--max-records', String(input.run.maxRecords)] : []),
    '--dry-run',
    '--json',
  ];
}

/** The line of a replay resource's run: held to the records its dry run counted to create. */
export function replayApplyLine(
  input: ReplayLine & { again: boolean; maxRecords: number },
): string[] {
  if (!Number.isInteger(input.maxRecords) || input.maxRecords < 1) {
    throw new Error(`${input.name} has no count from its dry run to be held to: plan again.`);
  }
  return [...replaySwitches(input), '--max-records', String(input.maxRecords), '--yes', '--json'];
}

/** The checkpoint a replay's run wrote from, and the org it went into, as its answer says them. */
export interface ReplayOfRun {
  checkpointId: string;
  organizationId: string;
}

/** What a removal of a replay, or its preview, is given. */
export interface ReplayRemovalLine extends EnvSweepAsk {
  /** The checkpoint the run replayed, from its summary. */
  replayed: ReplayOfRun;
  target: string;
  store: string;
  includeChanged?: boolean;
  acceptAutomation?: boolean;
}

/** The switches a removal and its preview share: the checkpoint by its id and its org, never by a file. */
function removalSwitches(input: ReplayRemovalLine): string[] {
  return [
    'replay',
    '--checkpoint',
    valueOf('--checkpoint', input.replayed.checkpointId),
    '--from',
    valueOf('--from', input.replayed.organizationId),
    '--target',
    valueOf('--target', input.target),
    '--store',
    valueOf('--store', input.store),
    '--remove',
    ...(input.includeChanged === true ? ['--include-changed'] : []),
  ];
}

/**
 * The line of the removal of a replay: what it created deleted, what changed
 * since kept unless `--include-changed`; nothing deleted while the org runs
 * automation as the records go, unless accepted.
 */
export function replayRemoveLine(input: ReplayRemovalLine): string[] {
  return [
    ...removalSwitches(input),
    ...sweepSwitches(input),
    ...(input.acceptAutomation === true ? ['--accept-automation'] : []),
    '--yes',
    '--json',
  ];
}

/** The line of that removal's preview: what it would do, nothing written. */
export function replayPreviewLine(input: ReplayRemovalLine): string[] {
  return [
    ...removalSwitches(input),
    '--preview',
    ...sweepSwitches(input),
    ...(input.acceptAutomation === true ? ['--accept-automation'] : []),
    '--json',
  ];
}

/** What of a replay's answer names the checkpoint it replayed. */
const replayedSchema = z
  .object({
    command: z.literal('replay'),
    checkpoint: z.object({ id: z.string().min(1), organizationId: z.string().min(1) }).loose(),
  })
  .loose();

/**
 * The checkpoint a replay's run replayed, from the answer it printed, which
 * the environment keeps as the run's summary: what its removal names. The
 * file the resource names may have changed since, or left the file.
 */
export function replayOfSummaryFile(file: string): ReplayOfRun {
  let parsed: z.infer<typeof replayedSchema> | undefined;
  try {
    const read = replayedSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    parsed = read.success ? read.data : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    throw new Error(
      `${file} names no checkpoint a replay wrote from: the replay it is the summary of cannot ` +
        'be taken back from it.',
    );
  }
  return {
    checkpointId: parsed.checkpoint.id,
    organizationId: parsed.checkpoint.organizationId,
  };
}

// ─── The answers ─────────────────────────────────────────────────────────────

/** A refusal, as the replay names one. */
const refusedSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).loose();

/** What every `--json` answer of a replay carries. */
const answerBase = {
  command: z.literal('replay'),
  checkpoint: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      organizationId: z.string().min(1),
      takenAt: z.string().optional(),
    })
    .loose(),
  target: z.object({ alias: z.string().min(1), organizationId: z.string().optional() }).loose(),
  refusals: z.array(z.string()).optional(),
  /** The code of each of `refusals`, in their order, given only when each has one. */
  refusalCodes: z.array(z.string()).optional(),
  refused: refusedSchema.optional(),
  ended: z.literal(true).optional(),
  exit: z.number().int(),
};

/** What a replay's dry run reads of the checkpoint and the org, beside the load's counts. */
const replaySummarySchema = z
  .object({
    records: z.object({ toCreate: countSchema }).loose(),
    owners: z.object({ kept: countSchema, toRunningUser: countSchema }).loose().optional(),
    filesLeft: z.array(z.object({ objectApiName: z.string() }).loose()),
    /** Per object and reason, the records it refuses before anything is written, and the way out. */
    refused: z
      .array(
        z
          .object({
            object: z.string().min(1),
            records: countSchema,
            reason: z.string().min(1),
            path: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
    requests: countSchema,
  })
  .loose();

/** The requests a load's gate estimated, its reads of the org among them, as its plan carries them. */
const planApiRequestsSchema = z
  .object({ apiRequests: z.object({ estimate: countSchema }).loose() })
  .loose();

/**
 * What `sandforge checkpoint replay --dry-run --json` prints: per object what
 * a replay would create, link, not send and purge, as the load it runs
 * counts them; and what it would be refused for.
 */
export const replayDryRunAnswerSchema = z.object({
  ...answerBase,
  action: z.literal('dryRun'),
  objects: z
    .array(
      z
        .object({
          objectApiName: z.string().min(1),
          fromFiles: countSchema,
          toInsert: countSchema,
          toLink: countSchema,
          notSent: countSchema,
          toPurge: countSchema,
        })
        .loose(),
    )
    .optional(),
  plan: z.record(z.string(), z.unknown()).optional(),
  replay: replaySummarySchema.optional(),
});

/** What `sandforge checkpoint replay --yes --json` prints of a replay that ran. */
export const replayRunAnswerSchema = z.object({
  ...answerBase,
  action: z.literal('replay'),
  status: z.string().optional(),
  objects: z
    .array(
      z
        .object({
          objectApiName: z.string().min(1),
          fromFiles: countSchema,
          inserted: countSchema,
          failed: countSchema,
        })
        .loose(),
    )
    .optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  replay: replaySummarySchema.optional(),
});

/** What `replay --remove` prints, with `--preview` or not. */
const replayRemovalBaseSchema = z.object({
  ...answerBase,
  action: z.literal('remove'),
  preview: z.literal(true).optional(),
  objects: z.array(z.record(z.string(), z.unknown())).optional(),
  removal: z.record(z.string(), z.unknown()).optional(),
});

/** One object of a replay's removal preview, as the load's preview counts it. */
const previewCountsSchema = z
  .object({
    objectApiName: z.string().min(1),
    planned: countSchema,
    toDelete: countSchema,
    alreadyGone: countSchema,
    changedSince: countSchema,
    keptChanged: countSchema,
    undeletable: countSchema,
    notVisible: countSchema,
    unread: countSchema,
  })
  .loose();

/**
 * A removal preview's answer, as every kind's is read: what a removal would
 * do, what it would be refused for, with their codes where each has one.
 */
interface ReplayPreviewRead {
  tool: typeof REPLAY_SCRIPT;
  preview: z.infer<typeof removalPreviewSchema>;
  refusals: string[];
  refusalCodes?: string[];
  /** What the replay's removal alone refuses, apart from its preview: none it tells apart. */
  removalAlone: string[];
}

/**
 * What `replay --remove --preview --json` prints, read as every kind's
 * preview is: per object what a removal would delete, keep and find gone,
 * and what it would be refused for. A replay with nothing left to take has
 * nothing to delete.
 */
export const replayPreviewAnswerSchema = replayRemovalBaseSchema.transform(
  (answer, ctx): ReplayPreviewRead => {
    const empty: ReplayPreviewRead['preview'] = { planned: 0, objects: [], userNames: {} };
    const refused = answer.refused;
    if (refused !== undefined && NOTHING_TO_REMOVE.has(refused.code)) {
      return { tool: REPLAY_SCRIPT, preview: empty, refusals: [], removalAlone: [] };
    }
    const refusals = [
      ...(refused !== undefined ? [refused.message] : []),
      ...(answer.refusals ?? []),
    ];
    const given = answer.refusalCodes ?? [];
    const codes = [
      ...(refused !== undefined ? [refused.code] : []),
      ...(given.length === (answer.refusals ?? []).length ? given : []),
    ];
    const read = z.array(previewCountsSchema).safeParse(answer.objects ?? []);
    if (!read.success) {
      ctx.addIssue({ code: 'custom', message: `its preview: ${read.error.issues[0]?.message}` });
      return z.NEVER;
    }
    const objects = read.data.map((object) => ({
      objectApiName: object.objectApiName,
      planned: object.planned,
      toDelete: object.toDelete,
      alreadyGone: object.alreadyGone,
      changedSince: object.changedSince,
      keptChanged: object.keptChanged,
      // Who changed a record since is said by the replay's own lines, not by
      // its answer: none named here.
      changedBy: {},
      undeletable: object.undeletable,
      notVisible: object.notVisible,
      unread: object.unread,
      reasons: [],
    }));
    return {
      tool: REPLAY_SCRIPT,
      preview: {
        planned: objects.reduce((sum, object) => sum + object.planned, 0),
        objects,
        userNames: {},
      },
      refusals,
      ...(codes.length === refusals.length && codes.length > 0 ? { refusalCodes: codes } : {}),
      removalAlone: [],
    };
  },
);

/**
 * What `replay --remove --json` prints once a removal ran, read as every
 * kind's removal is: how it ended, and per object what it deleted, found gone
 * and kept. With nothing left to take, it took nothing, whole.
 */
export const replayRemovalAnswerSchema = replayRemovalBaseSchema.transform((answer, ctx) => {
  const nothing = {
    tool: REPLAY_SCRIPT,
    result: { status: 'success' as const, planned: 0, objects: [] },
  };
  const refused = answer.refused;
  if (answer.removal === undefined) {
    if (refused === undefined || NOTHING_TO_REMOVE.has(refused.code)) return nothing;
    ctx.addIssue({ code: 'custom', message: `the removal was refused: ${refused.message}` });
    return z.NEVER;
  }
  const read = z
    .object({
      status: z.enum(['success', 'partial', 'failure', 'cancelled']),
      objects: z.array(removalObjectSchema.loose()),
    })
    .loose()
    .safeParse(answer.removal);
  if (!read.success) {
    ctx.addIssue({ code: 'custom', message: `its result: ${read.error.issues[0]?.message}` });
    return z.NEVER;
  }
  return {
    tool: REPLAY_SCRIPT,
    result: {
      status: read.data.status,
      planned: read.data.objects.reduce((sum, object) => sum + object.planned, 0),
      objects: read.data.objects,
    },
  };
});

/** A dry run's answer as the environment reads it, told apart by the script that printed it. */
export type ReplayDryRunAnswer = z.infer<typeof replayDryRunAnswerSchema> & {
  tool: typeof REPLAY_SCRIPT;
};
export type ReplayRunAnswer = z.infer<typeof replayRunAnswerSchema>;
export type ReplayPreviewAnswer = z.output<typeof replayPreviewAnswerSchema>;
export type ReplayRemovalAnswer = z.output<typeof replayRemovalAnswerSchema>;

/** What a replay resource's dry run printed, read: see {@link replayDryRunAnswerSchema}. */
export function readReplayDryRun(stdout: string): ReplayDryRunAnswer {
  const answer = readAnswer(
    REPLAY_SCRIPT,
    'the answer of a replay’s dry run',
    replayDryRunAnswerSchema,
    stdout,
  );
  return { tool: REPLAY_SCRIPT, ...answer };
}

/** What a replay resource's run printed, read: see {@link replayRunAnswerSchema}. */
export function readReplayRun(stdout: string): ReplayRunAnswer {
  return readAnswer(REPLAY_SCRIPT, 'the answer of a replay', replayRunAnswerSchema, stdout);
}

/** What the preview of a replay's removal printed, read: see {@link replayPreviewAnswerSchema}. */
export function readReplayPreview(stdout: string): ReplayPreviewAnswer {
  return readAnswer(REPLAY_SCRIPT, 'the preview of a removal', replayPreviewAnswerSchema, stdout);
}

/** What the removal of a replay printed, read: see {@link replayRemovalAnswerSchema}. */
export function readReplayRemoval(stdout: string): ReplayRemovalAnswer {
  return readAnswer(REPLAY_SCRIPT, 'the outcome of a removal', replayRemovalAnswerSchema, stdout);
}

// ─── The answers, as the plan and the apply read every kind's ────────────────

/** The emails the load's gate counted per daily limit, as the dry run's plan carries them. */
function replayEmailsOf(plan: Record<string, unknown> | undefined): EnvDryRunCount['emails'] {
  const counted = (plan?.['emails'] as { counted?: unknown } | undefined)?.counted;
  if (!Array.isArray(counted)) return [];
  return counted.flatMap((each) => {
    const { limit, emails } = (each ?? {}) as Record<string, unknown>;
    return (limit === 'SingleEmail' || limit === 'DailyWorkflowEmails') &&
      typeof emails === 'number'
      ? [{ limit, emails }]
      : [];
  });
}

/**
 * What a replay dry run counted: per object the records a replay would
 * create, and in all what `--max-records` holds the run to. Its refusal is
 * the replay's own words, with their codes. One that would create nothing is
 * refused: a run held to no count is held to nothing. What it leaves out
 * without refusing — the files a checkpoint keeps no content of, the records
 * that go to the user connected — is said beside; so are, per object, the
 * records it refuses before anything is written, with its way out, which
 * leave a run of the others partial (exit 3). Its API requests are those
 * its gate estimated, its reads of the org among them.
 *
 * Live, a dry run that refused 4 accounts in a currency the org had not
 * activated and estimated 40 requests was planned "Account 113 to write",
 * "0 blocked", nothing said of the 4, and its requests "not counted".
 */
export function replayDryRunCount(answer: ReplayDryRunAnswer): EnvDryRunCount {
  const said = [
    ...(answer.refused !== undefined ? [answer.refused.message] : []),
    ...(answer.refusals ?? []),
  ];
  const objects = answer.objects ?? [];
  const total = objects.reduce((sum, object) => sum + object.toInsert, 0);
  const refusal =
    said.length > 0
      ? said.join(' ')
      : answer.objects === undefined
        ? 'the replay never came to say what it would create, and a run held to no count is ' +
          'held to nothing'
        : total === 0
          ? 'it would create nothing: every record of the checkpoint is one the org holds ' +
            'already, linked, or one the replay leaves out'
          : undefined;
  const refusals = answer.refusals ?? [];
  const codes =
    refusal !== undefined
      ? codesSaidIn(refusal, said, [
          ...(answer.refused !== undefined ? [answer.refused.code] : []),
          ...(answer.refusalCodes?.length === refusals.length
            ? answer.refusalCodes
            : refusals.map(() => '')),
        ])
      : [];
  const summary = answer.replay;
  const notes = [
    ...(summary !== undefined && summary.filesLeft.length > 0
      ? [
          `${summary.filesLeft.length} file(s) of the checkpoint are not replayed: a checkpoint ` +
            'keeps no file’s content',
        ]
      : []),
    ...(summary?.owners !== undefined && summary.owners.toRunningUser > 0
      ? [
          `${summary.owners.toRunningUser} record(s) go to the user connected: their owner is ` +
            'not an active user of the org',
        ]
      : []),
    ...refusedBeforeWrite(summary).map(
      (refused) =>
        `${refused.object}: ${refused.records} record(s) refused before anything is written, ` +
        `which leave a run partial — ${replayRefusedWords(refused)}`,
    ),
  ];
  const estimated = planApiRequestsSchema.safeParse(answer.plan);
  return {
    objects: objects.map((object) => ({
      object: object.objectApiName,
      wouldCreate: object.toInsert,
    })),
    total,
    created: total,
    ...(estimated.success ? { apiRequests: estimated.data.apiRequests.estimate } : {}),
    storageBytes: objects.reduce(
      (sum, object) => sum + countedStorageBytes(object.objectApiName, { rows: object.toInsert }),
      0,
    ),
    emails: replayEmailsOf(answer.plan),
    ...(refusal !== undefined ? { refusal } : {}),
    ...(codes.length > 0 ? { refusalCodes: codes } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** The records a replay refuses before anything is written, per object and reason, as it counts them. */
function refusedBeforeWrite(
  summary: z.infer<typeof replaySummarySchema> | undefined,
): NonNullable<z.infer<typeof replaySummarySchema>['refused']> {
  return (summary?.refused ?? []).filter((refused) => refused.records > 0);
}

/**
 * What a replay wrote, per object, from its answer: the records it created,
 * and those refused — by the org as they were written, and by the replay
 * before anything was, each with its way out. The replay ends partial for
 * the latter (exit 3), its load whole.
 */
export function replayRunCount(answer: ReplayRunAnswer): EnvRunCount {
  const objects = (answer.objects ?? []).map((object) => ({
    object: object.objectApiName,
    created: object.inserted,
    refused: object.failed,
    errors: object.failed > 0 ? [`${object.failed} refused by the org`] : [],
  }));
  if (objects.length === 0 && answer.refused !== undefined) {
    return { objects: [], created: 0, refusal: answer.refused.message };
  }
  for (const refused of refusedBeforeWrite(answer.replay)) {
    const said = `${refused.records} refused before anything is written — ${replayRefusedWords(refused)}`;
    const at = objects.find((object) => object.object === refused.object);
    if (at !== undefined) {
      at.refused += refused.records;
      at.errors.push(said);
    } else {
      objects.push({
        object: refused.object,
        created: 0,
        refused: refused.records,
        errors: [said],
      });
    }
  }
  return { objects, created: objects.reduce((sum, object) => sum + object.created, 0) };
}

/**
 * Whether a replay again took the replays before it whole: its report says
 * its purge failed on nothing, and left nothing it could not tell. Those runs
 * are then taken back, and no removal looks for them again.
 */
export function replayPurgedWhole(answer: ReplayRunAnswer): boolean {
  const purge = answer.result?.['purge'] as
    { failures?: unknown[]; leftUnrecorded?: Record<string, number> } | undefined;
  if (purge === undefined) return false;
  const left = Object.values(purge.leftUnrecorded ?? {}).reduce((sum, n) => sum + n, 0);
  return (purge.failures ?? []).length === 0 && left === 0;
}
