/**
 * The kinds of resource an environment applies, each reached through here:
 * what a resource converts into, what of it a fingerprint is of, the lines
 * of its script and the readers of what that script answers.
 *
 * Each kind is one module of `kinds/` — `seed.ts`, `forge.ts`, `frozen.ts`,
 * `mask.ts`, `users.ts`, `replay.ts` —
 * and this one picks the kind's own for what the file, the plan, the apply
 * and the destroy ask. A kind added later is one module more and one case
 * more in each function here; nothing else of the environment reads a kind.
 */

import type {
  EnvForgeRun,
  EnvFrozenRun,
  EnvMaskRun,
  EnvResource,
  EnvResourceKind,
  EnvSeedRun,
} from '@sandforge/shared';
import type { EnvFileResource } from './envFile.js';
import {
  type EnvDryRunCount,
  type EnvFileRefusal,
  type EnvRemovalObject,
  type EnvSweepAsk,
} from './kinds/common.js';
import {
  FORGE_DEFAULT_MAX_TOTAL,
  FORGE_SCRIPT,
  forgeApplyLine,
  forgeDryRunCount,
  forgeTargetRefusal,
  forgeDryRunLine,
  forgeObjectsOf,
  forgePreviewLine,
  forgeRemoveLine,
  forgeRunOfResource,
  forgeWritten,
  readForgeDryRun,
  readForgePreview,
  readForgeRemoval,
  realDataNotes,
  type ForgeDryRunAnswer,
  type ForgePreviewAnswer,
  type ForgeRemovalAnswer,
} from './kinds/forge.js';
import {
  FROZEN_SCRIPT,
  derivedConfigOf,
  frozenApplyLine,
  frozenDryRunCount,
  frozenDryRunLine,
  frozenPreviewLine,
  frozenRefreshOf,
  frozenRemoveLine,
  frozenRunOfResource,
  frozenVerifyLine,
  frozenWritten,
  readFrozenDryRun,
  readFrozenPreview,
  readFrozenRemoval,
  readFrozenVerify,
  type FrozenDryRunAnswer,
  type FrozenPreviewAnswer,
  type FrozenRemovalAnswer,
} from './kinds/frozen.js';
import {
  DATAOPS_SCRIPT,
  maskApplyLine,
  maskDryRunCount,
  maskDryRunLine,
  maskNotes,
  maskObjectsOf,
  maskRulesFileOf,
  maskRunOfResource,
  maskWritten,
  readMaskDryRun,
  type EnvMaskRules,
  type MaskDryRunAnswer,
  type MaskPlace,
} from './kinds/mask.js';
import {
  REPLAY_SCRIPT,
  readReplayDryRun,
  readReplayPreview,
  readReplayRemoval,
  replayApplyLine,
  replayDryRunCount,
  replayDryRunLine,
  replayObjectsOf,
  replayOfSummaryFile,
  replayPreviewLine,
  replayRemoveLine,
  replayRunOfResource,
  replayWritten,
  type EnvReplayRun,
  type ReplayDryRunAnswer,
  type ReplayPreviewAnswer,
  type ReplayRemovalAnswer,
} from './kinds/replay.js';
import {
  SEED_SCRIPT,
  readSeedDryRun,
  readSeedPreview,
  readSeedRemoval,
  seedApplyLine,
  seedDrawnCounts,
  seedDryRunCount,
  seedDryRunLine,
  seedObjectsOf,
  seedPreviewLine,
  seedRemoveLine,
  seedRunOfResource,
  seedTemplateOf,
  seedWritten,
  type SeedDryRunAnswer,
  type SeedPreviewAnswer,
  type SeedRemovalAnswer,
} from './kinds/seed.js';
import {
  USERS_SCRIPT,
  readUsersPlan,
  readUsersRemoval,
  usersApplyLine,
  usersConfigOf,
  usersDryRunCount,
  usersDryRunLine,
  usersObjectsOf,
  usersRemoveLine,
  usersRunOfResource,
  usersRunOfSummaryFile,
  usersWritten,
  type EnvUsersRun,
  type UsersDryRunAnswer,
  type UsersRemovalAnswer,
} from './kinds/users.js';
import { nameOf } from '../invocation.js';

/** The kinds of resource this SandForge applies. */
export type EnvAppliedKind = 'seed' | 'forge' | 'frozen' | 'mask' | 'users' | 'replay';

/** The scripts those kinds run: each one a runner starts, and a state names. */
export type EnvKindScript =
  | typeof SEED_SCRIPT
  | typeof FORGE_SCRIPT
  | typeof FROZEN_SCRIPT
  | typeof DATAOPS_SCRIPT
  | typeof USERS_SCRIPT
  | typeof REPLAY_SCRIPT;

/** What a resource of the file runs, converted and checked, with its kind. */
export type EnvKindRun =
  | ({ kind: 'seed' } & EnvSeedRun)
  | ({ kind: 'forge' } & EnvForgeRun)
  | ({ kind: 'frozen' } & EnvFrozenRun)
  | ({ kind: 'mask' } & EnvMaskRun)
  | ({ kind: 'users' } & EnvUsersRun)
  | ({ kind: 'replay' } & EnvReplayRun);

/** A dry run's answer, as its kind's script printed it. */
export type EnvDryRunAnswer =
  | SeedDryRunAnswer
  | ForgeDryRunAnswer
  | FrozenDryRunAnswer
  | MaskDryRunAnswer
  | UsersDryRunAnswer
  | ReplayDryRunAnswer;

/** A removal preview's answer, as its kind's script printed it. */
export type EnvPreviewAnswer =
  SeedPreviewAnswer | ForgePreviewAnswer | FrozenPreviewAnswer | ReplayPreviewAnswer;

/** A removal's answer, as its kind's script printed it. */
export type EnvRemovalAnswer =
  | SeedRemovalAnswer
  | ForgeRemovalAnswer
  | FrozenRemovalAnswer
  | UsersRemovalAnswer
  | ReplayRemovalAnswer;

/** The script each kind is applied, refreshed and taken back by: a replay's, the checkpoint script. */
const SCRIPTS: Readonly<Record<EnvAppliedKind, EnvKindScript>> = {
  seed: SEED_SCRIPT,
  forge: FORGE_SCRIPT,
  frozen: FROZEN_SCRIPT,
  mask: DATAOPS_SCRIPT,
  users: USERS_SCRIPT,
  replay: REPLAY_SCRIPT,
};

/** Whether this SandForge applies resources of `kind`. */
export function isAppliedKind(kind: EnvResourceKind): kind is EnvAppliedKind {
  return Object.prototype.hasOwnProperty.call(SCRIPTS, kind);
}

/**
 * The script a kind of resource is applied, refreshed and taken back by. A
 * state may name a kind this SandForge does not apply — written by a later
 * one — which is refused, never guessed.
 */
export function scriptOfKind(kind: EnvResourceKind): EnvKindScript {
  if (!isAppliedKind(kind)) {
    throw new Error(
      `The state holds a resource of kind ${kind}, which a later SandForge applies: this one ` +
        'applies seed, forge, frozen, mask, users and replay resources, and takes back nothing ' +
        'of another kind.',
    );
  }
  return SCRIPTS[kind];
}

// ─── The file ────────────────────────────────────────────────────────────────

/**
 * What a resource of the file runs, converted into its module's payload and
 * checked by that module's schema and rules; or why the file is refused.
 *
 * @param folder - The folder of the file, which the paths a resource names are of.
 * @param masking - The file's masking sets, checked: what a mask resource names.
 */
export function convertResource(
  env: string,
  name: string,
  resource: EnvResource,
  folder: string,
  now: Date,
  masking: Readonly<Record<string, EnvMaskRules>> = {},
): { run: EnvKindRun; warnings: EnvFileRefusal[] } | { refusals: EnvFileRefusal[] } {
  switch (resource.kind) {
    case 'seed': {
      const converted = seedRunOfResource(env, name, resource, now);
      if ('refusals' in converted) return converted;
      return { run: { kind: 'seed', ...converted.run }, warnings: converted.warnings };
    }
    case 'forge': {
      const converted = forgeRunOfResource(env, name, resource, folder, now);
      if ('refusals' in converted) return converted;
      return { run: { kind: 'forge', ...converted.run }, warnings: converted.warnings };
    }
    case 'frozen': {
      const converted = frozenRunOfResource(name, resource, folder);
      if ('refusals' in converted) return converted;
      return { run: { kind: 'frozen', ...converted.run }, warnings: converted.warnings };
    }
    case 'mask': {
      const converted = maskRunOfResource(name, resource, masking);
      if ('refusals' in converted) return converted;
      return { run: { kind: 'mask', ...converted.run }, warnings: converted.warnings };
    }
    case 'users': {
      const converted = usersRunOfResource(resource);
      return { run: { kind: 'users', ...converted.run }, warnings: converted.warnings };
    }
    case 'replay': {
      const converted = replayRunOfResource(name, resource);
      if ('refusals' in converted) return converted;
      return { run: { kind: 'replay', ...converted.run }, warnings: converted.warnings };
    }
  }
}

/** What a resource writes, and nothing else: what its fingerprint is of, before what it depends on. */
export function writtenOf(resource: EnvFileResource): Record<string, unknown> {
  switch (resource.kind) {
    case 'seed':
      return seedWritten(resource.run);
    case 'forge':
      return forgeWritten(resource.run, resource.source.read);
    case 'frozen':
      return frozenWritten(resource.run);
    case 'mask':
      return maskWritten(resource.run);
    case 'users':
      return usersWritten(resource.run);
    case 'replay':
      return replayWritten(resource.run, resource.checkpoint.read);
  }
}

/**
 * The objects a resource writes, with the file's count of each where it gives
 * one: what `validate` lists. A frozen resource's are its dataset's, which
 * its dry run counts; a mask resource's, those its rules mask, the records of
 * which its dry run counts; a users resource's, its users; a replay's, the
 * objects it names, its checkpoint's otherwise, which its dry run counts.
 */
export function objectsOfRun(run: EnvKindRun): Array<{ object: string; count?: number }> {
  switch (run.kind) {
    case 'seed':
      return seedObjectsOf(run);
    case 'forge':
      return forgeObjectsOf(run);
    case 'frozen':
      return [];
    case 'mask':
      return maskObjectsOf(run);
    case 'users':
      return usersObjectsOf(run);
    case 'replay':
      return replayObjectsOf(run);
  }
}

/**
 * Whether a kind's replace is one run of its script, nothing taken back
 * first: a frozen resource's, a reload, whose purge takes back what the runs
 * before it wrote as it goes, refused before anything is written when it
 * would leave records; a mask resource's, a masking again, over what the
 * runs before it masked, which nothing takes back; a users resource's, a run
 * that converges from the one before it (`--previous`), adding what is
 * missing and taking back what the file no longer names, never every user
 * taken back to be set up again; a replay's, a replay again (`--again`),
 * whose purge takes back what the replays before it created there first.
 * Every other kind's runs are taken back first, then it runs again.
 */
export function replacesInOneRun(kind: EnvResourceKind): boolean {
  return kind === 'frozen' || kind === 'mask' || kind === 'users' || kind === 'replay';
}

// ─── What a run is given ─────────────────────────────────────────────────────

/** What a resource's payload is made with beside the resource. */
export interface EnvPayloadContext {
  /** The ids of the parents of each relation of a seed resource that draws them, by its place. */
  drawn?: ReadonlyMap<number, readonly string[]>;
  /**
   * Whether a draw whose ids are not known stands in with what the org holds
   * of its parent object: a dry run's, before the resource it draws from has
   * run. A run is never given one.
   */
  standIns?: boolean;
  /** The sas of a frozen resource: where its loads are kept. */
  sasDir?: string;
}

/**
 * The payload a resource's dry run or run is given, written to a file: a
 * seed's template with the parents its draws name, a forge resource's
 * exported template, a frozen resource's derived configuration, a mask
 * resource's rules, as `sandforge-dataops --rules` reads them, a users
 * resource's config, as `sandforge users --config` reads it. A replay takes
 * every choice on its line: its payload is empty.
 *
 * @throws For a seed whose draw names no ids and may not stand in, and for a
 *   frozen resource given no sas.
 */
export function payloadOf(resource: EnvFileResource, context: EnvPayloadContext): unknown {
  switch (resource.kind) {
    case 'seed':
      return seedTemplateOf(resource.run, context.drawn, { standIns: context.standIns === true });
    case 'forge':
      // A clone of the whole org takes its choices from --config, none of a
      // template: the file gives none of them yet.
      return resource.run.template ?? {};
    case 'frozen': {
      if (context.sasDir === undefined) {
        throw new Error(`${resource.name} is given no folder to keep its loads in: plan again.`);
      }
      return derivedConfigOf(resource.run, {
        sasDir: context.sasDir,
        datasetDir: resource.dataset.dir,
      });
    }
    case 'mask':
      return maskRulesFileOf(resource.run);
    case 'users':
      return usersConfigOf(resource.run);
    case 'replay':
      return {};
  }
}

// ─── The dry run ─────────────────────────────────────────────────────────────

/** What a dry run's line is given beside its resource. */
export interface EnvDryRunContext {
  /** sf CLI alias of the org the environment is applied to. */
  target: string;
  /** The payload the resource converts into, written to a file. */
  templateFile: string;
  /** The run id a seed's dry run is planned under. */
  runId: string;
  /** Whether the run replaces runs before it: a frozen resource's is a reload. */
  replace?: boolean;
  /** Whether what fires as a reload's purge deletes is accepted: the line's, or the file's. */
  acceptAutomation?: boolean;
  /** The store a frozen dry run keeps the script's own state in, apart from the sas. */
  storeFile?: string;
  /**
   * The file of the ids the apply takes back before any run, handed to the
   * dry run of a frozen replace: hanging from the loads' records, they hold
   * nothing by the time the reload runs.
   */
  goneFirstFile?: string;
  /** The DataOps store a mask resource's script keeps its snapshots and its template in. */
  store?: string;
  /**
   * The draws a seed's dry run is seeded with when the file pins none: a
   * saved plan's, so that its dry run draws again what the plan counted.
   */
  seed?: number;
  /**
   * Of a forge resource of `records`, the plan of the roots its dry run keeps
   * and its run takes (`--roots-plan`): the run writes the records the dry
   * run chose, and none the query chooses after.
   */
  rootsPlanFile?: string;
  /**
   * Of a users resource replaced, the number its script gave the run it
   * replaces, which its last run's summary names: the run converges from
   * what that one held (`--replaces`). None for a run that replaces none,
   * or one whose run before wrote nothing.
   */
  replacesRun?: number;
  /** The line's `--accept-user-emails`: Salesforce may email the people whose address a users resource asks back. */
  acceptUserEmails?: boolean;
  /**
   * The folder the environment keeps its checkpoints in, where a replay
   * finds its checkpoint and keeps what it wrote (`--store`).
   */
  checkpointStore?: string;
}

/**
 * The script and line of a resource's dry run. A forge resource's source
 * must have been read: the record its query names is what the line clones.
 */
export function dryRunLineOf(
  resource: EnvFileResource,
  context: EnvDryRunContext,
): { script: EnvKindScript; args: string[] } {
  switch (resource.kind) {
    case 'seed': {
      const seed = resource.run.seed ?? context.seed;
      return {
        script: SEED_SCRIPT,
        args: seedDryRunLine({
          target: context.target,
          templateFile: context.templateFile,
          runId: context.runId,
          ...(seed !== undefined ? { seed } : {}),
          ...(resource.run.locale !== undefined ? { locale: resource.run.locale } : {}),
          ...(resource.run.recordTypes !== undefined
            ? { recordTypes: resource.run.recordTypes }
            : {}),
          ...(resource.run.fit !== undefined ? { fit: resource.run.fit } : {}),
        }),
      };
    }
    case 'forge':
      return {
        script: FORGE_SCRIPT,
        args: forgeDryRunLine({
          ...forgeLineOf(resource),
          target: context.target,
          templateFile: context.templateFile,
          ...(context.rootsPlanFile !== undefined ? { rootsPlanFile: context.rootsPlanFile } : {}),
          // Its own ceiling, so the dry run says what a run past it would meet.
          maxTotal: resource.run.maxTotal ?? FORGE_DEFAULT_MAX_TOTAL,
        }),
      };
    case 'frozen':
      return {
        script: FROZEN_SCRIPT,
        args: frozenDryRunLine({
          configFile: context.templateFile,
          target: context.target,
          reload: context.replace === true,
          acceptAutomation: context.acceptAutomation === true,
          ...(context.storeFile !== undefined ? { store: context.storeFile } : {}),
          ...(context.goneFirstFile !== undefined ? { goneFirst: context.goneFirstFile } : {}),
        }),
      };
    case 'mask':
      return {
        script: DATAOPS_SCRIPT,
        args: maskDryRunLine({
          target: context.target,
          run: resource.run,
          rulesFile: context.templateFile,
          store: storeOf(resource, context),
        }),
      };
    case 'users':
      return { script: USERS_SCRIPT, args: usersDryRunLine(usersLineOf(resource, context)) };
    case 'replay':
      return {
        script: REPLAY_SCRIPT,
        args: replayDryRunLine({
          ...replayLineOf(resource, context),
          again: context.replace === true,
        }),
      };
  }
}

/**
 * What a users resource's plan and run are given: the config, the run it
 * converges from, the emails the line accepts, what fires as its users are
 * written accepted by the line or the file.
 */
function usersLineOf(
  resource: Extract<EnvFileResource, { kind: 'users' }>,
  context: EnvDryRunContext,
): Parameters<typeof usersDryRunLine>[0] {
  return {
    target: context.target,
    configFile: context.templateFile,
    ...(context.replacesRun !== undefined ? { replacesRun: context.replacesRun } : {}),
    ...(context.acceptUserEmails === true ? { acceptUserEmails: true } : {}),
    ...(context.acceptAutomation === true || resource.run.acceptAutomation === true
      ? { acceptAutomation: true }
      : {}),
  };
}

/** What a replay's dry run and run share: its resource, the store of checkpoints, what is accepted. */
function replayLineOf(
  resource: Extract<EnvFileResource, { kind: 'replay' }>,
  context: EnvDryRunContext,
): Parameters<typeof replayDryRunLine>[0] {
  if (context.checkpointStore === undefined) {
    throw new Error(
      `${resource.name} is given no store of checkpoints to replay from: plan again.`,
    );
  }
  return {
    name: resource.name,
    run: resource.run,
    place: resource.checkpoint,
    target: context.target,
    store: context.checkpointStore,
    again: false,
    ...(context.acceptAutomation === true ? { acceptAutomation: true } : {}),
  };
}

/** The DataOps store a mask resource's line names, or why it cannot run. */
function storeOf(resource: EnvFileResource, context: { store?: string }): string {
  if (context.store === undefined) {
    throw new Error(`${resource.name} is given no store to keep its snapshots in: plan again.`);
  }
  return context.store;
}

/**
 * What a forge resource's lines share: its source's alias, and the record,
 * the records a query chooses, the tables or the whole org it clones.
 */
function forgeLineOf(resource: Extract<EnvFileResource, { kind: 'forge' }>): {
  source: string;
  recordId?: string;
  records?: EnvForgeRun['records'];
  tables?: EnvForgeRun['tables'];
  wholeOrg?: EnvForgeRun['wholeOrg'];
  acceptAutomation: boolean;
} {
  const { run, source } = resource;
  if (run.wholeOrg) {
    return { source: source.alias, wholeOrg: run.wholeOrg, acceptAutomation: run.acceptAutomation };
  }
  if (run.tables !== undefined) {
    return { source: source.alias, tables: run.tables, acceptAutomation: run.acceptAutomation };
  }
  if (run.records !== undefined) {
    return { source: source.alias, records: run.records, acceptAutomation: run.acceptAutomation };
  }
  const read = source.read;
  const recordId =
    run.record?.id ?? (read !== undefined && 'recordId' in read ? read.recordId : undefined);
  if (recordId === undefined) {
    throw new Error(
      `${resource.name} names its record by a query its source has not answered: plan again.`,
    );
  }
  return { source: source.alias, recordId, acceptAutomation: run.acceptAutomation };
}

/** A dry run's answer, read by its kind's reader. */
export function readDryRunOf(kind: EnvAppliedKind, stdout: string): EnvDryRunAnswer {
  switch (kind) {
    case 'seed':
      return readSeedDryRun(stdout);
    case 'forge':
      return readForgeDryRun(stdout);
    case 'frozen':
      return readFrozenDryRun(stdout);
    case 'mask':
      return readMaskDryRun(stdout);
    case 'users':
      return readUsersPlan(stdout);
    case 'replay':
      return readReplayDryRun(stdout);
  }
}

/** The objects a seed resource writes under records written first in the same apply; none for another kind. */
export function drawnCountsOf(resource: EnvFileResource): Map<string, number> | undefined {
  return resource.kind === 'seed' ? seedDrawnCounts(resource.run) : undefined;
}

/**
 * What the org to fill would refuse every row of a resource for, beside what
 * its own dry run refuses: a forge resource's blocking target gaps, which do
 * not stop the clone. Undefined for another kind, or when nothing does.
 */
export function targetRefusalOf(
  resource: EnvFileResource,
  answer: EnvDryRunAnswer,
): string | undefined {
  return resource.kind === 'forge' && answer.tool === FORGE_SCRIPT
    ? forgeTargetRefusal(answer, resource.run.template)
    : undefined;
}

/** What a dry run counted, as every kind's is read. */
export function dryRunCountOf(
  answer: EnvDryRunAnswer,
  drawn?: ReadonlyMap<string, number>,
): EnvDryRunCount {
  switch (answer.tool) {
    case SEED_SCRIPT:
      return seedDryRunCount(answer, drawn);
    case FORGE_SCRIPT:
      return forgeDryRunCount(answer);
    case FROZEN_SCRIPT:
      return frozenDryRunCount(answer);
    case DATAOPS_SCRIPT:
      return maskDryRunCount(answer);
    case USERS_SCRIPT:
      return usersDryRunCount(answer);
    case REPLAY_SCRIPT:
      return replayDryRunCount(answer);
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** What a run's line is given beside its resource. */
export interface EnvRunContext extends EnvDryRunContext {
  /** The draws a seed's run is seeded with: its dry run's, when the file pins none. */
  seed?: number;
  /** Where a forge run writes its summary as it goes. */
  summaryFile: string;
  /** The most a forge, a frozen or a replay run may write: its dry run's count. */
  maxTotal?: number;
}

/** The script and line of a resource's run. */
export function applyLineOf(
  resource: EnvFileResource,
  context: EnvRunContext,
): { script: EnvKindScript; args: string[] } {
  switch (resource.kind) {
    case 'seed':
      return {
        script: SEED_SCRIPT,
        args: seedApplyLine({
          target: context.target,
          templateFile: context.templateFile,
          runId: context.runId,
          ...(context.seed !== undefined ? { seed: context.seed } : {}),
          ...(resource.run.locale !== undefined ? { locale: resource.run.locale } : {}),
          ...(resource.run.recordTypes !== undefined
            ? { recordTypes: resource.run.recordTypes }
            : {}),
          ...(resource.run.fit !== undefined ? { fit: resource.run.fit } : {}),
        }),
      };
    case 'forge': {
      if (context.maxTotal === undefined) {
        throw new Error(
          `${resource.name} has no count from its dry run to be held to: plan again.`,
        );
      }
      return {
        script: FORGE_SCRIPT,
        args: forgeApplyLine({
          ...forgeLineOf(resource),
          target: context.target,
          templateFile: context.templateFile,
          ...(context.rootsPlanFile !== undefined ? { rootsPlanFile: context.rootsPlanFile } : {}),
          maxTotal: context.maxTotal,
          summary: context.summaryFile,
        }),
      };
    }
    case 'frozen': {
      if (context.maxTotal === undefined) {
        throw new Error(
          `${resource.name} has no count from its dry run to be held to: plan again.`,
        );
      }
      return {
        script: FROZEN_SCRIPT,
        args: frozenApplyLine({
          configFile: context.templateFile,
          target: context.target,
          reload: context.replace === true,
          acceptAutomation: context.acceptAutomation === true,
          maxTotal: context.maxTotal,
        }),
      };
    }
    case 'mask':
      return {
        script: DATAOPS_SCRIPT,
        args: maskApplyLine({
          target: context.target,
          run: resource.run,
          rulesFile: context.templateFile,
          store: storeOf(resource, context),
        }),
      };
    case 'users':
      return { script: USERS_SCRIPT, args: usersApplyLine(usersLineOf(resource, context)) };
    case 'replay': {
      if (context.maxTotal === undefined) {
        throw new Error(
          `${resource.name} has no count from its dry run to be held to: plan again.`,
        );
      }
      return {
        script: REPLAY_SCRIPT,
        args: replayApplyLine({
          ...replayLineOf(resource, context),
          again: context.replace === true,
          maxRecords: context.maxTotal,
        }),
      };
    }
  }
}

/**
 * A kind whose runs no removal takes back: a masking is never undone, its
 * store deleted instead (`kinds/mask.ts`).
 */
function noRemoval(script: EnvKindScript): never {
  throw new Error(
    `${nameOf(script)} takes no run back: a masking is never undone, and its destroy deletes its store`,
  );
}

// ─── The removal and its preview ─────────────────────────────────────────────

/** What a removal of a run, or its preview, is given, whichever kind's. */
export interface EnvRemovalContext {
  target: string;
  /**
   * What the removal takes the run back from: its summary, a seed's run file
   * or run id, or the configuration a frozen run was given. A users run's
   * and a replay's summary is the answer the script printed, which names the
   * run by its number, and the checkpoint the replay wrote from.
   */
  subject: string;
  includeChanged: boolean;
  acceptAutomation: boolean;
  /** The folder the environment keeps its checkpoints in: a replay's removal is named in it. */
  checkpointStore?: string;
}

/**
 * The checkpoint a replay's run wrote from, its summary read, with the store
 * its removal is named in.
 */
function replayRemovalOf(
  context: EnvRemovalContext & EnvSweepAsk,
): Parameters<typeof replayRemoveLine>[0] {
  if (context.checkpointStore === undefined) {
    throw new Error('a replay is given no store of checkpoints to take it back from: plan again.');
  }
  return {
    replayed: replayOfSummaryFile(context.subject),
    target: context.target,
    store: context.checkpointStore,
    includeChanged: context.includeChanged,
    acceptAutomation: context.acceptAutomation,
    ...(context.sweep === true ? { sweep: true } : {}),
  };
}

/**
 * A users run's removal has no preview: its plan, with the run named, reads
 * what the org holds of its users, and a destroy says what it puts back.
 */
function noUsersPreview(script: EnvKindScript): never {
  throw new Error(
    `${nameOf(script)} previews no removal: its plan reads what the org holds of its users`,
  );
}

/**
 * The script and line of a removal's preview: with the sweep a destroy asks,
 * what that sweep would take and what fires on it are read too.
 */
export function previewLineOf(
  kind: EnvResourceKind,
  context: EnvRemovalContext & EnvSweepAsk,
): { script: EnvKindScript; args: string[] } {
  const script = scriptOfKind(kind);
  const sweep = context.sweep === true ? { sweep: true } : {};
  const input = {
    target: context.target,
    summary: context.subject,
    includeChanged: context.includeChanged,
    acceptAutomation: context.acceptAutomation,
    ...sweep,
  };
  switch (script) {
    case SEED_SCRIPT:
      return { script, args: seedPreviewLine(input) };
    case FORGE_SCRIPT:
      return { script, args: forgePreviewLine(input) };
    case FROZEN_SCRIPT:
      return {
        script,
        args: frozenPreviewLine({
          configFile: context.subject,
          target: context.target,
          includeChanged: context.includeChanged,
          acceptAutomation: context.acceptAutomation,
          ...sweep,
        }),
      };
    case DATAOPS_SCRIPT:
      return noRemoval(script);
    case USERS_SCRIPT:
      return noUsersPreview(script);
    case REPLAY_SCRIPT:
      return { script, args: replayPreviewLine(replayRemovalOf(context)) };
  }
}

/** A removal preview's answer, read by its kind's reader. */
export function readPreviewOf(kind: EnvResourceKind, stdout: string): EnvPreviewAnswer {
  const script = scriptOfKind(kind);
  switch (script) {
    case SEED_SCRIPT:
      return readSeedPreview(stdout);
    case FORGE_SCRIPT:
      return readForgePreview(stdout);
    case FROZEN_SCRIPT:
      return readFrozenPreview(stdout);
    case DATAOPS_SCRIPT:
      return noRemoval(script);
    case USERS_SCRIPT:
      return noUsersPreview(script);
    case REPLAY_SCRIPT:
      return readReplayPreview(stdout);
  }
}

/**
 * Of a resource's runs, the last first, those a plan previews the removal
 * of: each, but for a frozen resource, whose removal takes the next load of
 * its sas whichever run asks — its last run not taken back alone, previewed
 * once, or the same load would be counted once per run —, and a replay,
 * whose removal takes the replay of its checkpoint into the org whichever
 * run asks, the same; and for a mask resource, none: a masking has no
 * removal, and its dry run reads what the org holds of it; nor for a users
 * resource, whose plan reads its users, the last run named.
 */
export function previewedRunsOf<R extends { takenBack?: true }>(
  kind: EnvResourceKind,
  runs: readonly R[],
): R[] {
  if (kind === 'mask' || kind === 'users') return [];
  const live = [...runs].reverse().filter((run) => run.takenBack !== true);
  return kind === 'frozen' || kind === 'replay' ? live.slice(0, 1) : live;
}

/**
 * The script and line of a plan's refresh of an applied resource, where its
 * kind's script reads the org back otherwise than through its removal's
 * preview: a frozen resource's verification. Undefined for the other kinds.
 */
export function refreshLineOf(
  kind: EnvResourceKind,
  context: { target: string; subject: string },
): { script: EnvKindScript; args: string[] } | undefined {
  if (kind !== 'frozen') return undefined;
  return {
    script: FROZEN_SCRIPT,
    args: frozenVerifyLine({ configFile: context.subject, target: context.target }),
  };
}

/** What a refresh found of a resource's last run: the objects it FAILED, named; or why it could not say. */
export function readRefreshOf(stdout: string): { failed: string[] } | { unread: string } {
  return frozenRefreshOf(readFrozenVerify(stdout));
}

/** The script and line of a removal. */
export function removeLineOf(
  kind: EnvResourceKind,
  context: EnvRemovalContext & { sweep: boolean },
): { script: EnvKindScript; args: string[] } {
  const script = scriptOfKind(kind);
  const input = {
    target: context.target,
    summary: context.subject,
    includeChanged: context.includeChanged,
    acceptAutomation: context.acceptAutomation,
    sweep: context.sweep,
  };
  switch (script) {
    case SEED_SCRIPT:
      return { script, args: seedRemoveLine(input) };
    case FORGE_SCRIPT:
      return { script, args: forgeRemoveLine(input) };
    case FROZEN_SCRIPT:
      return {
        script,
        args: frozenRemoveLine({
          configFile: context.subject,
          target: context.target,
          includeChanged: context.includeChanged,
          sweep: context.sweep,
          acceptAutomation: context.acceptAutomation,
        }),
      };
    case DATAOPS_SCRIPT:
      return noRemoval(script);
    case USERS_SCRIPT:
      return {
        script,
        args: usersRemoveLine({
          target: context.target,
          run: usersRunOfSummaryFile(context.subject),
          includeChanged: context.includeChanged,
          acceptAutomation: context.acceptAutomation,
        }),
      };
    case REPLAY_SCRIPT:
      return { script, args: replayRemoveLine(replayRemovalOf(context)) };
  }
}

/** A removal's answer, read by its kind's reader. */
export function readRemovalOf(kind: EnvResourceKind, stdout: string): EnvRemovalAnswer {
  const script = scriptOfKind(kind);
  switch (script) {
    case SEED_SCRIPT:
      return readSeedRemoval(stdout);
    case FORGE_SCRIPT:
      return readForgeRemoval(stdout);
    case FROZEN_SCRIPT:
      return readFrozenRemoval(stdout);
    case DATAOPS_SCRIPT:
      return noRemoval(script);
    case USERS_SCRIPT:
      return readUsersRemoval(stdout);
    case REPLAY_SCRIPT:
      return readReplayRemoval(stdout);
  }
}

/** A removal's answer, per object. */
export function removalObjectsOf(answer: EnvRemovalAnswer | undefined): EnvRemovalObject[] {
  return answer?.result.objects ?? [];
}

/**
 * What a plan says of a resource it runs, beside why: a forge resource whose
 * source is a production org, what is done to its real data and to its
 * contact points; a mask resource, that masking is one-way, and who puts the
 * values back, how. Nothing for a kind that does neither.
 *
 * @param place - The org the environment is applied to, by its alias, and,
 *   for a mask resource, its store.
 */
export function notesOf(resource: EnvFileResource, place: MaskPlace): string[] {
  if (resource.kind === 'mask') return maskNotes(resource.name, place);
  return resource.kind === 'forge' ? realDataNotes(resource.run, resource.source) : [];
}
