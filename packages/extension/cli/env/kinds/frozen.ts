/**
 * The `frozen` kind of resource: a Frozen Dataset a person froze beforehand,
 * loaded into the org by `sandforge-frozen`, which drives the Load tab's own
 * handler.
 *
 * The file names the dataset by its path — from the root, or in a `{ env }`
 * variable a pipeline sets where it downloaded it — and pins it by the
 * version its manifest stamps and by its digest, over the files a load reads.
 * A dataset whose digest or version is not the file's refuses the resource,
 * naming both: what was reviewed is what is loaded. The fingerprint of the
 * resource is of the digest, never of the path: a dataset moved keeps it, a
 * dataset changed replaces what the one before loaded.
 *
 * Its configuration is the project's Frozen configuration, committed beside
 * the file and checked by Frozen's own schema, held strict: a misspelt key is
 * refused, not dropped. The environment derives from it the configuration a
 * load is given: `sasDir`, the folder of the state that keeps this
 * resource's loads — the mapping of what each created, its counting contract,
 * the script's own store (`cli-store.json`) — and `datasetDir`, the pinned
 * dataset. Written per run beside the state, it is what that run's removal,
 * its preview and its verification are given again.
 *
 * Its steps are the script's: a dry run (`load --dry-run --json`), whose
 * counts the plan shows; a run (`load --json`) held to what that dry run
 * counted to insert (`--max-total`), the verification the load chains after
 * it read as its own; a replace that is a reload (`load --reload`), refused
 * before anything is written when the removal of the loads before it would
 * leave records; the refresh of a plan, a verification (`verify`), a FAILED
 * object of which makes the resource drifted, named; the removal
 * (`remove`), and its preview (`remove --preview`).
 *
 * What a load refuses — an org its entry guards turn away, a required field
 * the dataset leaves empty with no default, the loads a reload replaces
 * leaving records — the dry run refuses first, and the plan blocks the
 * resource with the script's own words. What it leaves out without refusing
 * — a field the target encrypts that may hold masks, a picklist value a
 * restricted picklist would refuse and its rule rewrites — the plan says
 * beside its counts. A load never reads the salt the dataset was drawn with.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  secretKeysIn,
  type EnvDocumentPath,
  type EnvFrozenResource,
  type EnvFrozenRun,
} from '@sandforge/shared';
import { frozenProjectConfigPayloadSchema } from '../../../src/bridge/validatePayload.js';
import { countedStorageBytes } from '../../../src/modules/forge/ForgeRunGate.js';
import { frozenDatasetDigest } from '../../../src/modules/frozendataset/datasetDigest.js';
import type { RunnableScript } from '../../scriptRunner.js';
import {
  countSchema,
  readAnswer,
  refusalAt,
  removalObjectSchema,
  removalPreviewSchema,
  valueOf,
  type EnvDryRunCount,
  type EnvFileRefusal,
  type EnvRunCount,
} from './common.js';

/** The script a `frozen` resource runs. */
export const FROZEN_SCRIPT = 'sandforge-frozen' satisfies RunnableScript;

/** The largest configuration read: a configuration holds rules and keys, no record. */
const CONFIG_FILE_MAX_BYTES = 1_000_000;

/** The folders of the configuration the environment sets: where the loads are kept, and the dataset. */
const SET_BY_THE_ENVIRONMENT = ['sasDir', 'datasetDir'] as const;

/**
 * What of the configuration a load writes by, as the handler gives it to the
 * loader: the rest is the selection's and the extraction's, or what a
 * verification checks, and changes no record a load writes.
 */
const LOAD_KEYS = [
  'rootObject',
  'excludedObjects',
  'identityKeys',
  'undeletableObjects',
  'requiredLookupPlaceholders',
  'requiredFieldDefaults',
  'picklistRules',
  'defaultPicklistRule',
  'duplicateErrorPatterns',
] as const;

/** The codes of a removal, or its preview, that has nothing to take: no failure. */
const NOTHING_TO_REMOVE = new Set(['NO_LOAD', 'ALREADY_REMOVED', 'NOTHING_TO_REMOVE']);

// ─── The resource, converted ─────────────────────────────────────────────────

/**
 * What a frozen resource loads, checked: the committed configuration, read
 * from the folder of the file and held to Frozen's own schema, strict; and
 * the dataset as the file pins it.
 *
 * @param folder - The folder of the file: the configuration is named from it.
 */
export function frozenRunOfResource(
  name: string,
  resource: EnvFrozenResource,
  folder: string,
): { run: EnvFrozenRun; warnings: EnvFileRefusal[] } | { refusals: EnvFileRefusal[] } {
  const at: EnvDocumentPath = ['resources', name, 'config'];
  const refused = (message: string) => ({ refusals: [refusalAt(at, message)] });
  let text: string;
  try {
    text = readFileSync(join(folder, resource.config), 'utf8');
  } catch (err: unknown) {
    return refused(
      `${resource.config} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (text.length > CONFIG_FILE_MAX_BYTES) {
    return refused(`${resource.config} is larger than ${CONFIG_FILE_MAX_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return refused(
      `${resource.config} is not JSON: a Frozen configuration is the panel's, as JSON`,
    );
  }
  // Committed beside the file, it is held to the file's rule: no secret.
  const secrets = secretKeysIn(raw);
  if (secrets.length > 0) {
    return {
      refusals: secrets.map(({ path, secret }) =>
        refusalAt(
          at,
          `${resource.config} holds a key shaped like a secret (${secret}) at ` +
            `${path.join('.')}: a load never reads the salt, and the configuration holds no ` +
            'secret. Take it out.',
        ),
      ),
    };
  }
  const checked = frozenProjectConfigPayloadSchema.strict().safeParse(raw);
  if (!checked.success) {
    return {
      refusals: checked.error.issues.map((issue) =>
        refusalAt(
          at,
          `${resource.config} is refused by Frozen's configuration schema at ` +
            `${issue.path.map(String).join('.') || 'its top'}: ${issue.message}`,
        ),
      ),
    };
  }
  const warnings: EnvFileRefusal[] = [];
  const config: Record<string, unknown> = { ...checked.data };
  const set = SET_BY_THE_ENVIRONMENT.filter((key) => config[key] !== undefined);
  for (const key of set) delete config[key];
  if (set.length > 0) {
    warnings.push(
      refusalAt(
        at,
        `${resource.config} gives ${set.join(' and ')}, which the environment sets: the loads ` +
          'are kept beside the state, and the dataset is the one the file pins',
      ),
    );
  }
  if (resource.accept?.automation === true) {
    warnings.push(
      refusalAt(
        ['resources', name, 'accept', 'automation'],
        'a Frozen load and its removal take no acceptance of automation: what the org runs as ' +
          'the records go in, they run unasked',
      ),
    );
  }
  return {
    run: { configFile: resource.config, config, dataset: { ...resource.dataset } },
    warnings,
  };
}

/**
 * What a frozen run writes, and nothing else: the fingerprint of a resource
 * is of this. The dataset by its digest and its version, never its path; of
 * the configuration, what the load writes by.
 */
export function frozenWritten(run: EnvFrozenRun): Record<string, unknown> {
  return {
    kind: 'frozen',
    kindVersion: 1,
    dataset: { digest: run.dataset.digest, version: run.dataset.version },
    load: Object.fromEntries(LOAD_KEYS.map((key) => [key, run.config[key] ?? null])),
  };
}

/**
 * The configuration a load is given: the committed one, its sas the folder of
 * the state that keeps the resource's loads, its dataset the one pinned.
 */
export function derivedConfigOf(
  run: EnvFrozenRun,
  places: { sasDir: string; datasetDir: string },
): Record<string, unknown> {
  return { ...run.config, sasDir: places.sasDir, datasetDir: places.datasetDir };
}

// ─── The dataset, read at each plan ──────────────────────────────────────────

/**
 * What the plan read of a frozen resource's dataset: its digest and version,
 * the file's; or why it is not the dataset the file pins, which blocks it.
 */
export type EnvDatasetRead = { digest: string; version: string } | { refusal: string };

/**
 * The dataset in `dir`, read and held to what the file pins: a digest or a
 * version that is not the file's refuses it, naming both — a dataset frozen
 * again, or another one put at its path, is not the one reviewed.
 */
export async function readFrozenDataset(
  dir: string,
  pinned: EnvFrozenRun['dataset'],
): Promise<EnvDatasetRead> {
  let digest: string;
  let version: unknown;
  try {
    digest = await frozenDatasetDigest(dir);
    version = (
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: unknown }
    ).version;
  } catch (err: unknown) {
    return {
      refusal: `its dataset at ${dir} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (digest !== pinned.digest) {
    return {
      refusal:
        `its dataset at ${dir} has the digest ${digest}, and the file pins ${pinned.digest}: ` +
        'it is not the dataset the file was reviewed with. Point the path at that one, or pin ' +
        'this digest once this dataset is reviewed',
    };
  }
  if (version !== pinned.version) {
    return {
      refusal:
        `its dataset at ${dir} is version ${String(version)}, and the file pins version ` +
        `${pinned.version}: pin the version its manifest says`,
    };
  }
  return { digest, version: pinned.version };
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** What every line of a frozen resource is given. */
export interface FrozenLine {
  /** The configuration the environment derived, written to a file. */
  configFile: string;
  /** sf CLI alias of the org the environment is applied to. */
  target: string;
}

/** The switches every line starts with. */
function frozenSwitches(step: string, input: FrozenLine): string[] {
  return [
    step,
    '--config',
    valueOf('--config', input.configFile),
    '--target',
    valueOf('--target', input.target),
  ];
}

/**
 * The line of a frozen resource's dry run: what a load would insert, link and
 * purge, nothing written. A replace's is a reload's. Its own store, when the
 * sas is one loads keep: a dry run writes nothing there.
 */
export function frozenDryRunLine(
  input: FrozenLine & { reload: boolean; store?: string },
): string[] {
  return [
    ...frozenSwitches('load', input),
    ...(input.reload ? ['--reload'] : []),
    ...(input.store !== undefined ? ['--store', valueOf('--store', input.store)] : []),
    '--dry-run',
    '--json',
  ];
}

/**
 * The line of a frozen resource's run: held to the records its dry run
 * counted to insert; a replace's is a reload, refused when it would leave
 * records of the loads before it.
 */
export function frozenApplyLine(
  input: FrozenLine & { reload: boolean; maxTotal: number },
): string[] {
  return [
    ...frozenSwitches('load', input),
    ...(input.reload ? ['--reload'] : []),
    '--max-total',
    String(input.maxTotal),
    '--yes',
    '--json',
  ];
}

/** The line of the verification of the last load: what the target holds of it. */
export function frozenVerifyLine(input: FrozenLine): string[] {
  return [...frozenSwitches('verify', input), '--json'];
}

/** The line of the removal of the next load a removal takes, the last first. */
export function frozenRemoveLine(
  input: FrozenLine & { includeChanged?: boolean; sweep?: boolean },
): string[] {
  return [
    ...frozenSwitches('remove', input),
    ...(input.includeChanged === true ? ['--include-changed'] : []),
    ...(input.sweep === true ? ['--sweep'] : []),
    '--yes',
    '--json',
  ];
}

/** The line of the preview of that removal: what it would do, nothing written. */
export function frozenPreviewLine(input: FrozenLine & { includeChanged?: boolean }): string[] {
  return [
    ...frozenSwitches('remove', input),
    ...(input.includeChanged === true ? ['--include-changed'] : []),
    '--preview',
    '--json',
  ];
}

// ─── The answers ─────────────────────────────────────────────────────────────

/** A message the handler posted, as the script prints it beside its answer. */
const postedSchema = z
  .object({ type: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional() })
  .loose();

/** What every step's `--json` answer carries. */
const answerBase = {
  tool: z.literal(FROZEN_SCRIPT),
  posted: z.array(postedSchema),
  dataset: z
    .object({ dir: z.string().min(1), digest: z.string().min(1), version: z.string().optional() })
    .optional(),
  mapping: z.string().min(1).optional(),
  refusals: z.array(z.string()).optional(),
  ended: z.literal(true).optional(),
};

/** A verdict as the script answers it, per object. */
const verdictSchema = z.object({
  status: z.enum(['PASSED', 'PARTIAL', 'FAILED', 'UNSTABLE']),
  objects: z.array(
    z.object({
      objectApiName: z.string().min(1),
      verdict: z.enum(['PASSED', 'FAILED']),
      expected: countSchema,
      found: countSchema,
      notLoaded: countSchema,
      orphans: countSchema,
      missingKeys: countSchema,
    }),
  ),
});

/**
 * What `sandforge-frozen load --dry-run --json` prints: per object what a
 * load would insert, link, not send and purge, and what it would be refused
 * for — the handler's refusal among what it posted, or the count gate's.
 */
export const frozenDryRunAnswerSchema = z.object({
  ...answerBase,
  step: z.literal('load'),
  objects: z
    .array(
      z.object({
        objectApiName: z.string().min(1),
        fromFiles: countSchema,
        toInsert: countSchema,
        toLink: countSchema,
        notSent: countSchema,
        toPurge: countSchema,
        toDeactivate: countSchema,
      }),
    )
    .optional(),
});

/**
 * What `sandforge-frozen load --json` prints of a load that ran: per object
 * what it inserted, reused and failed, and the verdict of the verification it
 * chains after it.
 */
export const frozenRunAnswerSchema = z.object({
  ...answerBase,
  step: z.literal('load'),
  objects: z
    .array(
      z.object({
        objectApiName: z.string().min(1),
        fromFiles: countSchema,
        inserted: countSchema,
        reused: countSchema,
        duplicates: countSchema,
        failed: countSchema,
      }),
    )
    .optional(),
  verdict: verdictSchema.optional(),
});

/** What `sandforge-frozen verify --json` prints: the verdict, per object. */
export const frozenVerifyAnswerSchema = z.object({
  ...answerBase,
  step: z.literal('verify'),
  verdict: verdictSchema.optional(),
});

/** The posted message of `type`, the last of them. */
function postedOf(
  posted: ReadonlyArray<z.infer<typeof postedSchema>>,
  type: string,
): Record<string, unknown> | undefined {
  return posted.filter((message) => message.type === type).at(-1)?.payload;
}

/** The refusal the handler posted, in its own words, or undefined. */
function postedError(
  posted: ReadonlyArray<z.infer<typeof postedSchema>>,
): { message: string; code?: string } | undefined {
  const error = posted.find((message) => message.type.endsWith(':error'))?.payload;
  if (error === undefined) return undefined;
  const message = typeof error['message'] === 'string' ? error['message'] : 'refused';
  const code = typeof error['code'] === 'string' ? error['code'] : undefined;
  return { message, ...(code !== undefined ? { code } : {}) };
}

/**
 * What `sandforge-frozen remove --preview --json` prints, read as every
 * kind's preview is: per object what a removal would delete, keep and find
 * gone, and what it would be refused for. With no load recorded, or nothing
 * left to take, nothing is to delete.
 */
export const frozenPreviewAnswerSchema = z
  .object({ ...answerBase, step: z.literal('remove') })
  .transform((answer, ctx) => {
    const error = postedError(answer.posted);
    const empty: z.infer<typeof removalPreviewSchema> = { planned: 0, objects: [], userNames: {} };
    if (error !== undefined && !NOTHING_TO_REMOVE.has(error.code ?? '')) {
      return { tool: answer.tool, preview: empty, refusals: [error.message] };
    }
    const raw = postedOf(answer.posted, 'frozen:remove:preview:response')?.['preview'];
    if (raw === undefined) return { tool: answer.tool, preview: empty, refusals: [] };
    const read = removalPreviewSchema
      .extend({ refusals: z.array(z.string()) })
      .loose()
      .safeParse(raw);
    if (!read.success) {
      ctx.addIssue({ code: 'custom', message: `its preview: ${read.error.issues[0]?.message}` });
      return z.NEVER;
    }
    const { refusals, ...preview } = read.data;
    return { tool: answer.tool, preview, refusals };
  });

/**
 * What `sandforge-frozen remove --json` prints once a removal ran, read as
 * every kind's removal is: how it ended, and per object what it deleted,
 * found gone and kept. With nothing to take, it took nothing, whole.
 */
export const frozenRemovalAnswerSchema = z
  .object({ ...answerBase, step: z.literal('remove'), status: z.string().optional() })
  .transform((answer, ctx) => {
    const error = postedError(answer.posted);
    const nothing = {
      tool: answer.tool,
      result: { status: 'success' as const, planned: 0, objects: [] },
    };
    if (error !== undefined) {
      if (NOTHING_TO_REMOVE.has(error.code ?? '')) return nothing;
      ctx.addIssue({ code: 'custom', message: `the removal was refused: ${error.message}` });
      return z.NEVER;
    }
    const raw = postedOf(answer.posted, 'frozen:remove:response')?.['result'];
    if (raw === undefined) return nothing;
    const read = z
      .object({
        status: z.enum(['success', 'partial', 'failure', 'cancelled']),
        objects: z.array(removalObjectSchema.loose()),
      })
      .loose()
      .safeParse(raw);
    if (!read.success) {
      ctx.addIssue({ code: 'custom', message: `its result: ${read.error.issues[0]?.message}` });
      return z.NEVER;
    }
    return {
      tool: answer.tool,
      result: {
        status: read.data.status,
        planned: read.data.objects.reduce((sum, object) => sum + object.planned, 0),
        objects: read.data.objects,
      },
    };
  });

export type FrozenDryRunAnswer = z.infer<typeof frozenDryRunAnswerSchema>;
export type FrozenRunAnswer = z.infer<typeof frozenRunAnswerSchema>;
export type FrozenVerifyAnswer = z.infer<typeof frozenVerifyAnswerSchema>;
export type FrozenPreviewAnswer = z.output<typeof frozenPreviewAnswerSchema>;
export type FrozenRemovalAnswer = z.output<typeof frozenRemovalAnswerSchema>;

/** What a frozen resource's dry run printed, read: see {@link frozenDryRunAnswerSchema}. */
export function readFrozenDryRun(stdout: string): FrozenDryRunAnswer {
  return readAnswer(FROZEN_SCRIPT, 'the answer of a dry run', frozenDryRunAnswerSchema, stdout);
}

/** What a frozen resource's run printed, read: see {@link frozenRunAnswerSchema}. */
export function readFrozenRun(stdout: string): FrozenRunAnswer {
  return readAnswer(FROZEN_SCRIPT, 'the answer of a load', frozenRunAnswerSchema, stdout);
}

/** What the verification of a frozen resource's load printed, read. */
export function readFrozenVerify(stdout: string): FrozenVerifyAnswer {
  return readAnswer(FROZEN_SCRIPT, 'a verification', frozenVerifyAnswerSchema, stdout);
}

/** What the preview of a frozen resource's removal printed, read: see {@link frozenPreviewAnswerSchema}. */
export function readFrozenPreview(stdout: string): FrozenPreviewAnswer {
  return readAnswer(FROZEN_SCRIPT, 'the preview of a removal', frozenPreviewAnswerSchema, stdout);
}

/** What the removal of a frozen resource's load printed, read: see {@link frozenRemovalAnswerSchema}. */
export function readFrozenRemoval(stdout: string): FrozenRemovalAnswer {
  return readAnswer(FROZEN_SCRIPT, 'the outcome of a removal', frozenRemovalAnswerSchema, stdout);
}

// ─── The answers, as the plan and the apply read every kind's ────────────────

/** The fields a load would leave out, encrypted in the target, that may hold masks: in words. */
function maskNotes(plan: Record<string, unknown> | undefined): string[] {
  const removals = Array.isArray(plan?.['removals']) ? (plan['removals'] as unknown[]) : [];
  const masked = removals.flatMap((removal) => {
    const r = removal as Record<string, unknown>;
    return r['reason'] === 'may-hold-masks'
      ? [
          `${String(r['objectApiName'])}.${String(r['field'])} (${Number(r['affectedRecords'] ?? 0)})`,
        ]
      : [];
  });
  return masked.length > 0
    ? [
        `it would leave out, encrypted in the target, ${masked.join(', ')}: the dataset's ` +
          'manifest does not say its extraction left out what it read masked, so they may hold ' +
          'masks such as ****1234',
      ]
    : [];
}

/** The picklist values a load would rewrite, and the fields it would drop, in words. */
function alignmentNotes(plan: Record<string, unknown> | undefined): string[] {
  const perObject = Array.isArray(plan?.['perObject']) ? (plan['perObject'] as unknown[]) : [];
  return perObject.flatMap((each) => {
    const o = each as Record<string, unknown>;
    const rewritten = Number(o['picklistsRewritten'] ?? 0);
    const dropped = Number(o['fieldsDropped'] ?? 0);
    const parts = [
      rewritten > 0
        ? `${rewritten} picklist value(s) a restricted picklist of the target refuses, rewritten by their rule`
        : '',
      dropped > 0 ? `${dropped} field(s) the target lacks or takes no value of, dropped` : '',
    ].filter(Boolean);
    return parts.length > 0 ? [`${String(o['objectApiName'])}: ${parts.join(', ')}`] : [];
  });
}

/**
 * What a frozen dry run counted: per object the records a load would insert,
 * exactly, and in all what `--max-total` holds the run to. Its refusal is the
 * script's own words: the handler's, or the count gate's. A dry run that
 * would insert nothing is refused: a run held to no count is held to
 * nothing, and `--max-total` takes no nought. The storage is the documented
 * size of a record; the script estimates no request.
 */
export function frozenDryRunCount(answer: FrozenDryRunAnswer): EnvDryRunCount {
  const error = postedError(answer.posted);
  const said = [...(error !== undefined ? [error.message] : []), ...(answer.refusals ?? [])];
  const objects = answer.objects ?? [];
  const total = objects.reduce((sum, object) => sum + object.toInsert, 0);
  const plan = postedOf(answer.posted, 'frozen:load:preview:response')?.['plan'] as
    Record<string, unknown> | undefined;
  const refusal =
    said.length > 0
      ? said.join(' ')
      : answer.objects === undefined
        ? 'the load never came to say what it would write, and a run held to no count is held to nothing'
        : total === 0
          ? 'it would insert nothing: every record of the dataset is one the org holds already, ' +
            'linked by its identity keys, or one the load does not send'
          : undefined;
  const notes = [...maskNotes(plan), ...alignmentNotes(plan)];
  return {
    objects: objects.map((object) => ({
      object: object.objectApiName,
      wouldCreate: object.toInsert,
    })),
    total,
    created: total,
    storageBytes: objects.reduce(
      (sum, object) => sum + countedStorageBytes(object.objectApiName, { rows: object.toInsert }),
      0,
    ),
    emails: [],
    ...(refusal !== undefined ? { refusal } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** What a frozen run wrote, per object, from its answer: the records it inserted, and those refused. */
export function frozenRunCount(answer: FrozenRunAnswer): EnvRunCount {
  const error = postedError(answer.posted);
  const objects = (answer.objects ?? []).map((object) => ({
    object: object.objectApiName,
    created: object.inserted,
    refused: object.failed,
    errors: object.failed > 0 ? [`${object.failed} refused by the org`] : [],
  }));
  if (objects.length === 0 && error !== undefined) {
    return { objects: [], created: 0, refusal: error.message };
  }
  return { objects, created: objects.reduce((sum, object) => sum + object.created, 0) };
}

/**
 * Whether a reload's purge took the loads before it whole: its report says
 * it deleted, deactivated or kept what they created, and failed on none, nor
 * left any it could not tell. Those loads are then taken back, and no removal
 * looks for them again.
 */
export function reloadPurgedWhole(answer: FrozenRunAnswer): boolean {
  const report = postedOf(answer.posted, 'frozen:load:response')?.['report'] as
    { purge?: { failures?: unknown[]; leftUnrecorded?: Record<string, number> } } | undefined;
  const purge = report?.purge;
  if (purge === undefined) return false;
  const left = Object.values(purge.leftUnrecorded ?? {}).reduce((sum, n) => sum + n, 0);
  return (purge.failures ?? []).length === 0 && left === 0;
}

/** Whether a load deleted records of the loads before it: a reload's purge writes. */
export function reloadDeleted(answer: FrozenRunAnswer): boolean {
  const report = postedOf(answer.posted, 'frozen:load:response')?.['report'] as
    | { purge?: { deleted?: Record<string, number>; deactivated?: Record<string, number> } }
    | undefined;
  const counts = [
    ...Object.values(report?.purge?.deleted ?? {}),
    ...Object.values(report?.purge?.deactivated ?? {}),
  ];
  return counts.some((n) => n > 0);
}

/**
 * What a verification found the load's records short of, per object, in
 * words; nothing when it PASSED. UNSTABLE says no two readings agreed.
 */
export function frozenVerdictShortOf(verdict: NonNullable<FrozenRunAnswer['verdict']>): {
  short?: string;
  unstable: boolean;
} {
  if (verdict.status === 'UNSTABLE') {
    return {
      unstable: true,
      short:
        'no two readings of the org agreed: something still writes to the load’s records; ' +
        'verify again once it is done',
    };
  }
  const failed = verdict.objects
    .filter((object) => object.verdict === 'FAILED')
    .map((object) => {
      const parts = [
        `${object.found} of ${object.expected} found`,
        object.orphans > 0 ? `${object.orphans} orphan(s)` : '',
        object.missingKeys > 0 ? `${object.missingKeys} key(s) missing` : '',
        object.notLoaded > 0 ? `${object.notLoaded} not loaded` : '',
      ].filter(Boolean);
      return `${object.objectApiName} FAILED (${parts.join(', ')})`;
    });
  if (failed.length > 0) return { unstable: false, short: failed.join('; ') };
  if (verdict.status !== 'PASSED')
    return { unstable: false, short: `its verdict is ${verdict.status}` };
  return { unstable: false };
}

/**
 * What a plan's verification of a frozen resource's last load found: the
 * objects it FAILED, each named; or why it could not say.
 */
export function frozenRefreshOf(
  answer: FrozenVerifyAnswer,
): { failed: string[] } | { unread: string } {
  const error = postedError(answer.posted);
  if (answer.verdict === undefined) {
    return { unread: error?.message ?? 'the verification gave no verdict' };
  }
  const { short, unstable } = frozenVerdictShortOf(answer.verdict);
  if (unstable) return { unread: short ?? 'no two readings agreed' };
  return { failed: short !== undefined ? [short] : [] };
}

/** The sas of a frozen resource, from the state's folder: `frozen/<resource>`. */
export function frozenSasOf(resource: string): string {
  return `frozen/${resource}`;
}

/** The resource a frozen run's sas is of, or undefined for a run of another kind. */
export function resourceOfSas(sas: string | undefined): string | undefined {
  return sas !== undefined && /^frozen\/[a-z][a-z0-9-]{0,62}$/.test(sas)
    ? sas.slice('frozen/'.length)
    : undefined;
}
