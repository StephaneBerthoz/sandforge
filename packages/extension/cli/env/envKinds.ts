/**
 * The kinds of resource an environment applies, each reached through here:
 * what a resource converts into, what of it a fingerprint is of, the lines
 * of its script and the readers of what that script answers.
 *
 * Each kind is one module of `kinds/` — `seed.ts`, `forge.ts` — and this one
 * picks the kind's own for what the file, the plan, the apply and the
 * destroy ask. A kind added later is one module more and one case more in
 * each function here; nothing else of the environment reads a kind.
 */

import type { EnvForgeRun, EnvResource, EnvResourceKind, EnvSeedRun } from '@sandforge/shared';
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
  seedWritten,
  type SeedDryRunAnswer,
  type SeedPreviewAnswer,
  type SeedRemovalAnswer,
} from './kinds/seed.js';

/** The kinds of resource this SandForge applies. */
export type EnvAppliedKind = 'seed' | 'forge';

/** The scripts those kinds run: each one a runner starts, and a state names. */
export type EnvKindScript = typeof SEED_SCRIPT | typeof FORGE_SCRIPT;

/** What a resource of the file runs, converted and checked, with its kind. */
export type EnvKindRun = ({ kind: 'seed' } & EnvSeedRun) | ({ kind: 'forge' } & EnvForgeRun);

/** A dry run's answer, as its kind's script printed it. */
export type EnvDryRunAnswer = SeedDryRunAnswer | ForgeDryRunAnswer;

/** A removal preview's answer, as its kind's script printed it. */
export type EnvPreviewAnswer = SeedPreviewAnswer | ForgePreviewAnswer;

/** A removal's answer, as its kind's script printed it. */
export type EnvRemovalAnswer = SeedRemovalAnswer | ForgeRemovalAnswer;

/** The script each kind is applied, refreshed and taken back by. */
const SCRIPTS: Readonly<Record<EnvAppliedKind, EnvKindScript>> = {
  seed: SEED_SCRIPT,
  forge: FORGE_SCRIPT,
};

/** Whether this SandForge applies resources of `kind`. */
export function isAppliedKind(kind: EnvResourceKind): kind is EnvAppliedKind {
  return kind === 'seed' || kind === 'forge';
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
        'applies seed and forge resources, and takes back nothing of another kind.',
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
  }
}

/** What a resource writes, and nothing else: what its fingerprint is of, before what it depends on. */
export function writtenOf(resource: EnvFileResource): Record<string, unknown> {
  switch (resource.kind) {
    case 'seed':
      return seedWritten(resource.run);
    case 'forge':
      return forgeWritten(resource.run, resource.source.read);
  }
}

/** The objects a resource writes, with the file's count of each where it gives one: what `validate` lists. */
export function objectsOfRun(run: EnvKindRun): Array<{ object: string; count?: number }> {
  switch (run.kind) {
    case 'seed':
      return seedObjectsOf(run);
    case 'forge':
      return forgeObjectsOf(run);
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
  return kind === 'seed' ? readSeedDryRun(stdout) : readForgeDryRun(stdout);
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
  return answer.tool === SEED_SCRIPT ? seedDryRunCount(answer, drawn) : forgeDryRunCount(answer);
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** What a run's line is given beside its resource. */
export interface EnvRunContext extends EnvDryRunContext {
  /** The draws a seed's run is seeded with: its dry run's, when the file pins none. */
  seed?: number;
  /** Where a forge run writes its summary as it goes. */
  summaryFile: string;
  /** The most a forge run may write: its dry run's count. */
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
  }
}

// ─── The removal and its preview ─────────────────────────────────────────────

/** What a removal of a run, or its preview, is given, whichever kind's. */
export interface EnvRemovalContext {
  target: string;
  /** What the removal takes the run back from: its summary, or a seed's run file or run id. */
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
  return { script, args: kind === 'seed' ? seedPreviewLine(input) : forgePreviewLine(input) };
}

/** A removal preview's answer, read by its kind's reader. */
export function readPreviewOf(kind: EnvResourceKind, stdout: string): EnvPreviewAnswer {
  return scriptOfKind(kind) === SEED_SCRIPT ? readSeedPreview(stdout) : readForgePreview(stdout);
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
  return { script, args: kind === 'seed' ? seedRemoveLine(input) : forgeRemoveLine(input) };
}

/** A removal's answer, read by its kind's reader. */
export function readRemovalOf(kind: EnvResourceKind, stdout: string): EnvRemovalAnswer {
  return scriptOfKind(kind) === SEED_SCRIPT ? readSeedRemoval(stdout) : readForgeRemoval(stdout);
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
