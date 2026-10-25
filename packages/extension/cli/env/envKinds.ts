/**
 * The kinds of resource an environment applies, each reached through here:
 * what a resource converts into, what of it a fingerprint is of, the lines
 * of its script and the readers of what that script answers.
 *
 * Each kind is one module of `kinds/` — `seed.ts`, `forge.ts`, `frozen.ts` —
 * and this one picks the kind's own for what the file, the plan, the apply
 * and the destroy ask. A kind added later is one module more and one case
 * more in each function here; nothing else of the environment reads a kind.
 */

import type {
  EnvForgeRun,
  EnvFrozenRun,
  EnvResource,
  EnvResourceKind,
  EnvSeedRun,
} from '@sandforge/shared';
import type { EnvFileResource } from './envFile.js';
import type { EnvDryRunCount, EnvFileRefusal, EnvRemovalObject } from './kinds/common.js';
import {
  FORGE_DEFAULT_MAX_TOTAL,
  FORGE_SCRIPT,
  forgeApplyLine,
  forgeDryRunCount,
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

/** The kinds of resource this SandForge applies. */
export type EnvAppliedKind = 'seed' | 'forge' | 'frozen';

/** The scripts those kinds run: each one a runner starts, and a state names. */
export type EnvKindScript = typeof SEED_SCRIPT | typeof FORGE_SCRIPT | typeof FROZEN_SCRIPT;

/** What a resource of the file runs, converted and checked, with its kind. */
export type EnvKindRun =
  | ({ kind: 'seed' } & EnvSeedRun)
  | ({ kind: 'forge' } & EnvForgeRun)
  | ({ kind: 'frozen' } & EnvFrozenRun);

/** A dry run's answer, as its kind's script printed it. */
export type EnvDryRunAnswer = SeedDryRunAnswer | ForgeDryRunAnswer | FrozenDryRunAnswer;

/** A removal preview's answer, as its kind's script printed it. */
export type EnvPreviewAnswer = SeedPreviewAnswer | ForgePreviewAnswer | FrozenPreviewAnswer;

/** A removal's answer, as its kind's script printed it. */
export type EnvRemovalAnswer = SeedRemovalAnswer | ForgeRemovalAnswer | FrozenRemovalAnswer;

/** The script each kind is applied, refreshed and taken back by. */
const SCRIPTS: Readonly<Record<EnvAppliedKind, EnvKindScript>> = {
  seed: SEED_SCRIPT,
  forge: FORGE_SCRIPT,
  frozen: FROZEN_SCRIPT,
};

/** Whether this SandForge applies resources of `kind`. */
export function isAppliedKind(kind: EnvResourceKind): kind is EnvAppliedKind {
  return kind === 'seed' || kind === 'forge' || kind === 'frozen';
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
        'applies seed, forge and frozen resources, and takes back nothing of another kind.',
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
 */
export function convertResource(
  env: string,
  name: string,
  resource: EnvResource,
  folder: string,
  now: Date,
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
  }
}

/**
 * The objects a resource writes, with the file's count of each where it gives
 * one: what `validate` lists. A frozen resource's are its dataset's, which
 * its dry run counts.
 */
export function objectsOfRun(run: EnvKindRun): Array<{ object: string; count?: number }> {
  switch (run.kind) {
    case 'seed':
      return seedObjectsOf(run);
    case 'forge':
      return forgeObjectsOf(run);
    case 'frozen':
      return [];
  }
}

/**
 * Whether a kind's replace is one run of its script, which takes back what
 * the runs before it wrote as it goes: a frozen resource's, a reload, whose
 * purge is refused before anything is written when it would leave records.
 * Every other kind's runs are taken back first, then it runs again.
 */
export function replacesInOneRun(kind: EnvResourceKind): boolean {
  return kind === 'frozen';
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
 * exported template, a frozen resource's derived configuration.
 *
 * @throws For a seed whose draw names no ids and may not stand in, and for a
 *   frozen resource given no sas.
 */
export function payloadOf(resource: EnvFileResource, context: EnvPayloadContext): unknown {
  switch (resource.kind) {
    case 'seed':
      return seedTemplateOf(resource.run, context.drawn, { standIns: context.standIns === true });
    case 'forge':
      return resource.run.template;
    case 'frozen': {
      if (context.sasDir === undefined) {
        throw new Error(`${resource.name} is given no folder to keep its loads in: plan again.`);
      }
      return derivedConfigOf(resource.run, {
        sasDir: context.sasDir,
        datasetDir: resource.dataset.dir,
      });
    }
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
  /** The store a frozen dry run keeps the script's own state in, apart from the sas. */
  storeFile?: string;
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
    case 'seed':
      return {
        script: SEED_SCRIPT,
        args: seedDryRunLine({
          target: context.target,
          templateFile: context.templateFile,
          runId: context.runId,
          ...(resource.run.seed !== undefined ? { seed: resource.run.seed } : {}),
          ...(resource.run.locale !== undefined ? { locale: resource.run.locale } : {}),
          ...(resource.run.recordTypes !== undefined
            ? { recordTypes: resource.run.recordTypes }
            : {}),
        }),
      };
    case 'forge':
      return {
        script: FORGE_SCRIPT,
        args: forgeDryRunLine({
          ...forgeLineOf(resource),
          target: context.target,
          templateFile: context.templateFile,
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
          ...(context.storeFile !== undefined ? { store: context.storeFile } : {}),
        }),
      };
  }
}

/** What a forge resource's lines share: its source's alias, and the record or the tables it clones. */
function forgeLineOf(resource: Extract<EnvFileResource, { kind: 'forge' }>): {
  source: string;
  recordId?: string;
  tables?: EnvForgeRun['tables'];
  acceptAutomation: boolean;
} {
  const { run, source } = resource;
  if (run.tables !== undefined) {
    return { source: source.alias, tables: run.tables, acceptAutomation: run.acceptAutomation };
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
  }
}

/** The objects a seed resource writes under records written first in the same apply; none for another kind. */
export function drawnCountsOf(resource: EnvFileResource): Map<string, number> | undefined {
  return resource.kind === 'seed' ? seedDrawnCounts(resource.run) : undefined;
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
  }
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** What a run's line is given beside its resource. */
export interface EnvRunContext extends EnvDryRunContext {
  /** The draws a seed's run is seeded with: its dry run's, when the file pins none. */
  seed?: number;
  /** Where a forge run writes its summary as it goes. */
  summaryFile: string;
  /** The most a forge or a frozen run may write: its dry run's count. */
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
          maxTotal: context.maxTotal,
        }),
      };
    }
  }
}

// ─── The removal and its preview ─────────────────────────────────────────────

/** What a removal of a run, or its preview, is given, whichever kind's. */
export interface EnvRemovalContext {
  target: string;
  /**
   * What the removal takes the run back from: its summary, a seed's run file
   * or run id, or the configuration a frozen run was given.
   */
  subject: string;
  includeChanged: boolean;
  acceptAutomation: boolean;
}

/** The script and line of a removal's preview. */
export function previewLineOf(
  kind: EnvResourceKind,
  context: EnvRemovalContext,
): { script: EnvKindScript; args: string[] } {
  const script = scriptOfKind(kind);
  const input = {
    target: context.target,
    summary: context.subject,
    includeChanged: context.includeChanged,
    acceptAutomation: context.acceptAutomation,
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
        }),
      };
  }
}

/** A removal preview's answer, read by its kind's reader. */
export function readPreviewOf(kind: EnvResourceKind, stdout: string): EnvPreviewAnswer {
  switch (scriptOfKind(kind)) {
    case SEED_SCRIPT:
      return readSeedPreview(stdout);
    case FORGE_SCRIPT:
      return readForgePreview(stdout);
    case FROZEN_SCRIPT:
      return readFrozenPreview(stdout);
  }
}

/**
 * Of a resource's runs, the last first, those a plan previews the removal
 * of: each, but for a frozen resource, whose removal takes the next load of
 * its sas whichever run asks — its last run not taken back alone, previewed
 * once, or the same load would be counted once per run.
 */
export function previewedRunsOf<R extends { takenBack?: true }>(
  kind: EnvResourceKind,
  runs: readonly R[],
): R[] {
  const live = [...runs].reverse().filter((run) => run.takenBack !== true);
  return kind === 'frozen' ? live.slice(0, 1) : live;
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
      // A Frozen removal takes no acceptance of automation: it reads none.
      return {
        script,
        args: frozenRemoveLine({
          configFile: context.subject,
          target: context.target,
          includeChanged: context.includeChanged,
          sweep: context.sweep,
        }),
      };
  }
}

/** A removal's answer, read by its kind's reader. */
export function readRemovalOf(kind: EnvResourceKind, stdout: string): EnvRemovalAnswer {
  switch (scriptOfKind(kind)) {
    case SEED_SCRIPT:
      return readSeedRemoval(stdout);
    case FORGE_SCRIPT:
      return readForgeRemoval(stdout);
    case FROZEN_SCRIPT:
      return readFrozenRemoval(stdout);
  }
}

/** A removal's answer, per object. */
export function removalObjectsOf(answer: EnvRemovalAnswer | undefined): EnvRemovalObject[] {
  return answer?.result.objects ?? [];
}

/**
 * What a plan says of a resource beside why it acts: a forge resource whose
 * source is a production org, what is done to its real data and to its
 * contact points. Nothing for a kind that clones no org.
 */
export function notesOf(resource: EnvFileResource): string[] {
  return resource.kind === 'forge' ? realDataNotes(resource.run, resource.source) : [];
}
