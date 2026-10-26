/**
 * The `mask` kind of resource: records the org already holds — a sandbox
 * copied from production — masked by DataOps, through `sandforge-dataops`,
 * which drives the DataOps panel's own handler.
 *
 * The rules are DataOps rules: a set of the file's `masking:`, held to the
 * schema the panel's save goes through (`anonymizationTemplateSavePayloadSchema`)
 * and given to the script as a rules file, which it saves in its store as a
 * template; or a template that ships, by its id. A resource names one object
 * and the condition its records are selected by, as the script masks one
 * object a run; or no object, and every object its rules mask, Account's
 * person accounts among them where the org has them, as the panel's Apply
 * masks them. A rule set with no rule for its object is refused before any
 * org is reached: a run would mask nothing there.
 *
 * The snapshot comes first. The script takes a snapshot of the records it
 * masks — their masked fields as they are — before its first write, and
 * writes nothing unless the snapshot holds every one of them. The state keeps
 * the snapshot's id. Each resource's store is its own folder of the state's,
 * `dataops/<resource>`: its snapshots, the template its rules were saved as,
 * the audit trail of its runs.
 *
 * Its steps are the script's: a dry run (`anonymize --dry-run --json`), which
 * counts the records each object's condition selects and reads the first of
 * them masked — the plan's count, and its refresh of a masking already
 * applied: the same rules and the same records are kept —; and a run
 * (`anonymize --yes --json`). A field the rules name that the org does not
 * show the user blocks the resource, in the script's own words: a run would
 * leave its values in every record. A replace is a run again, over what the
 * runs before it masked: nothing is taken back first, and the values the
 * records held before the first masking stay only in that run's snapshot.
 *
 * Masking is one-way. `destroy` never puts personal data back into an org: it
 * deletes the resource's store — its snapshots, the only place the original
 * values were — and marks the resource destroyed. `sandforge-dataops
 * anonymize --restore <snapshot>` stays the person's own act, before a
 * destroy. A pipeline that tore an environment down and, in doing so,
 * unmasked a sandbox copied from production would be the worst thing this
 * kind could do.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  isSavedTemplateMethod,
  type EnvDocumentPath,
  type EnvMaskResource,
  type EnvMaskRun,
  type EnvMaskingRule,
  type EnvMaskingSet,
  type EnvPlanObject,
  type EnvResourceState,
} from '@sandforge/shared';
import { anonymizationTemplateSavePayloadSchema } from '../../../src/bridge/validatePayload.js';
import { ANONYMIZATION_TEMPLATES } from '../../../src/bridge/templates/anonymizationTemplates.js';
import { fileConfigStore } from '../../fileConfigStore.js';
import { masksObject, missingFieldLine } from '../../sandforge-dataops.js';
import type { RunnableScript } from '../../scriptRunner.js';
import {
  canonicalJson,
  readAnswer,
  refusalAt,
  valueOf,
  type EnvDryRunCount,
  type EnvFileRefusal,
} from './common.js';

/** The script a `mask` resource runs. */
export const DATAOPS_SCRIPT = 'sandforge-dataops' satisfies RunnableScript;

/** The file of a DataOps store its snapshots are listed in, as the script keeps it. */
const SNAPSHOTS_FILE = 'snapshots.json';

// ─── The masking sets ────────────────────────────────────────────────────────

/** A set's rules, named as the store saves them: what a run of a mask resource is given. */
export type EnvMaskRules = EnvMaskRun['rules'];

/**
 * The masking sets of the file, each held to the schema the DataOps panel's
 * save goes through, under its name: a setting a method does not take, a
 * Constant with no value, a field given two rules are refused where the
 * file wrote them.
 */
export function maskingSetsOf(
  masking: Readonly<Record<string, EnvMaskingSet>>,
): { sets: Record<string, EnvMaskRules> } | { refusals: EnvFileRefusal[] } {
  const sets: Record<string, EnvMaskRules> = {};
  const refusals: EnvFileRefusal[] = [];
  for (const [name, set] of Object.entries(masking)) {
    const checked = anonymizationTemplateSavePayloadSchema.safeParse({ name, rules: set.rules });
    if (!checked.success) {
      refusals.push(
        ...checked.error.issues.map((issue) =>
          refusalAt(
            ['masking', name, ...(issue.path as EnvDocumentPath)],
            `refused by the rules the DataOps panel saves: ${issue.message}`,
          ),
        ),
      );
      continue;
    }
    sets[name] = { name, rules: set.rules };
  }
  return refusals.length > 0 ? { refusals } : { sets };
}

/** A template that ships, by its id, its rules as a set's: what a run masks with. */
function shippedRules(id: string): EnvMaskRules | undefined {
  const template = ANONYMIZATION_TEMPLATES.find((each) => each.id === id);
  if (template === undefined) return undefined;
  const rules: EnvMaskingRule[] = template.rules.flatMap((rule) => {
    if (!isSavedTemplateMethod(rule.ruleType)) return [];
    const config = 'config' in rule ? rule.config : undefined;
    return [
      {
        fieldPattern: rule.fieldPattern,
        ruleType: rule.ruleType,
        ...(config !== undefined ? { config: { ...config } } : {}),
      },
    ];
  });
  return { name: template.name, rules };
}

// ─── The resource, converted ─────────────────────────────────────────────────

/**
 * What a mask resource runs, checked: the rules of the set it names, or of
 * the template that ships; and, when it names one, the object they mask,
 * which a rule of theirs must name — on Account, a Contact rule masks its
 * person accounts — or a run would mask nothing.
 */
export function maskRunOfResource(
  name: string,
  resource: EnvMaskResource,
  sets: Readonly<Record<string, EnvMaskRules>>,
): { run: EnvMaskRun; warnings: EnvFileRefusal[] } | { refusals: EnvFileRefusal[] } {
  const at: EnvDocumentPath = ['resources', name, 'rules'];
  let rules: EnvMaskRules | undefined;
  let source: EnvMaskRun['source'];
  if (typeof resource.rules === 'string') {
    rules = sets[resource.rules];
    source = { set: resource.rules };
    if (rules === undefined) {
      return {
        refusals: [refusalAt(at, `the rule set ${resource.rules} is refused: see masking`)],
      };
    }
  } else {
    const id = resource.rules.template;
    rules = shippedRules(id);
    source = { template: id };
    if (rules === undefined) {
      return {
        refusals: [
          refusalAt(
            [...at, 'template'],
            `there is no DataOps template "${id}" that ships: there is ` +
              ANONYMIZATION_TEMPLATES.map((each) => each.id).join(', '),
          ),
        ],
      };
    }
  }
  const object = resource.object;
  if (
    object !== undefined &&
    !masksObject({ id: rules.name, name: rules.name, rules: rules.rules }, object)
  ) {
    return {
      refusals: [
        refusalAt(
          ['resources', name, 'object'],
          `${'set' in source ? `the rule set ${source.set}` : `the template ${source.template}`} ` +
            `has no rule for ${object}: a run would mask nothing. Name an object its rules ` +
            'mask, or give it a rule for this one',
        ),
      ],
    };
  }
  const warnings: EnvFileRefusal[] = [];
  // A masking writes nothing into an empty field, and fills a filled one but
  // with nullify: asking whether a field is empty selects the same records after.
  const prefix = `${(object ?? '').toLowerCase()}.`;
  const written = new Map(
    rules.rules
      .filter((rule) => object !== undefined && rule.fieldPattern.toLowerCase().startsWith(prefix))
      .map((rule) => [(rule.fieldPattern.split('.')[1] ?? '').toLowerCase(), rule.ruleType]),
  );
  const overwritten = fieldsOfCondition(resource.where)
    .filter(({ field, empty }) => {
      const method = written.get(field.toLowerCase());
      return method !== undefined && (!empty || method === 'nullify');
    })
    .map(({ field }) => field);
  if (overwritten.length > 0) {
    warnings.push(
      refusalAt(
        ['resources', name, 'where'],
        `its condition reads ${overwritten.join(', ')}, which its rules write over: once masked, ` +
          'its records may no longer be those it selects, and a plan after reads them as gone. ' +
          'Select them by a field its rules leave as it is',
      ),
    );
  }
  if (resource.accept?.automation === true) {
    warnings.push(
      refusalAt(
        ['resources', name, 'accept', 'automation'],
        'a DataOps masking takes no acceptance of automation: what the org runs as the records ' +
          'are written over, it runs unasked',
      ),
    );
  }
  return {
    run: {
      source,
      rules,
      ...(object !== undefined ? { object } : {}),
      ...(resource.where !== undefined ? { where: resource.where } : {}),
    },
    warnings,
  };
}

/**
 * The fields a SOQL condition compares, each once, and whether it only asks
 * whether one is empty: the name before each of its operators. Its text
 * values are left out first, so a field named in a value is none.
 */
function fieldsOfCondition(where: string | undefined): Array<{ field: string; empty: boolean }> {
  if (where === undefined) return [];
  const bare = where.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const found = new Map<string, boolean>();
  for (const match of bare.matchAll(
    /\b([A-Za-z][A-Za-z0-9_]*)\s*(=|!=|<>|<=|>=|<|>|\s(?:NOT\s+)?(?:LIKE|IN|INCLUDES|EXCLUDES)\b)\s*(null\b)?/gi,
  )) {
    const field = match[1] ?? '';
    if (/^(?:AND|OR|NOT)$/i.test(field)) continue;
    const empty = /^(?:=|!=|<>)$/.test(match[2] ?? '') && match[3] !== undefined;
    found.set(field, (found.get(field) ?? true) && empty);
  }
  return [...found].map(([field, empty]) => ({ field, empty }));
}

/**
 * What a masking writes, and nothing else: the fingerprint of a resource is
 * of this. Its rules by their content — a template that ships, as a set
 * holding the same rules — in any order, and what they mask; never the name
 * the store saves them under.
 */
export function maskWritten(run: EnvMaskRun): Record<string, unknown> {
  return {
    kind: 'mask',
    kindVersion: 1,
    rules: [...run.rules.rules]
      .map((rule) => ({ ...rule, fieldPattern: rule.fieldPattern.toLowerCase() }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    object: run.object ?? null,
    where: run.where ?? null,
  };
}

/** The objects a masking writes over: its object, or every one its rules name. */
export function maskObjectsOf(run: EnvMaskRun): Array<{ object: string }> {
  if (run.object !== undefined) return [{ object: run.object }];
  const objects: string[] = [];
  for (const rule of run.rules.rules) {
    const object = rule.fieldPattern.split('.')[0] ?? '';
    if (!objects.includes(object)) objects.push(object);
  }
  return objects.map((object) => ({ object }));
}

/** The rules file a run is given, as `sandforge-dataops --rules` reads it: `{name, rules}`. */
export function maskRulesFileOf(run: EnvMaskRun): EnvMaskRules {
  return { name: run.rules.name, rules: run.rules.rules };
}

/** A resource's DataOps store, from the state's folder: `dataops/<resource>`. */
export function maskStoreOf(resource: string): string {
  return `dataops/${resource}`;
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** What every line of a mask resource is given. */
export interface MaskLine {
  /** sf CLI alias of the org the environment is applied to. */
  target: string;
  run: EnvMaskRun;
  /** The rules file, written: given with --rules for a set's rules. */
  rulesFile: string;
  /** The DataOps store the script keeps its snapshots and its template in. */
  store: string;
}

/** The switches every line of a mask resource starts with. */
function maskSwitches(input: MaskLine): string[] {
  const { run } = input;
  return [
    'anonymize',
    '--org',
    valueOf('--org', input.target),
    ...(run.object !== undefined ? ['--object', valueOf('--object', run.object)] : []),
    ...(run.where !== undefined ? ['--where', valueOf('--where', run.where)] : []),
    ...('template' in run.source
      ? ['--template', valueOf('--template', run.source.template)]
      : ['--rules', valueOf('--rules', input.rulesFile)]),
    '--store',
    valueOf('--store', input.store),
  ];
}

/** The line of a mask resource's dry run: what a run would mask, nothing written. */
export function maskDryRunLine(input: MaskLine): string[] {
  return [...maskSwitches(input), '--dry-run', '--json'];
}

/** The line of a mask resource's run: a snapshot, then the masking, unasked. */
export function maskApplyLine(input: MaskLine): string[] {
  return [...maskSwitches(input), '--yes', '--json'];
}

// ─── The answers ─────────────────────────────────────────────────────────────

/** A message the handler posted, as the script prints it with --json. */
const postedSchema = z
  .object({ type: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional() })
  .loose();

const countSchema = z.number().int().nonnegative();

/** What every `--json` answer of the script carries: the messages the panel would have received. */
const answerBase = {
  tool: z.literal(DATAOPS_SCRIPT),
  org: z.string().min(1),
  posted: z.array(postedSchema),
};

/** What `sandforge-dataops anonymize --dry-run --json` prints. */
export const maskDryRunAnswerSchema = z.object({ ...answerBase, command: z.literal('dry-run') });

/** What `sandforge-dataops anonymize --yes --json` prints of a run. */
export const maskRunAnswerSchema = z.object({ ...answerBase, command: z.literal('run') });

export type MaskDryRunAnswer = z.infer<typeof maskDryRunAnswerSchema>;
export type MaskRunAnswer = z.infer<typeof maskRunAnswerSchema>;

/** What a mask resource's dry run printed, read: see {@link maskDryRunAnswerSchema}. */
export function readMaskDryRun(stdout: string): MaskDryRunAnswer {
  return readAnswer(DATAOPS_SCRIPT, 'the answer of a dry run', maskDryRunAnswerSchema, stdout);
}

/** What a mask resource's run printed, read: see {@link maskRunAnswerSchema}. */
export function readMaskRun(stdout: string): MaskRunAnswer {
  return readAnswer(DATAOPS_SCRIPT, 'the answer of a masking', maskRunAnswerSchema, stdout);
}

/** The payload of the last message of `type` the handler posted. */
function postedOf(
  posted: ReadonlyArray<z.infer<typeof postedSchema>>,
  type: string,
): Record<string, unknown> | undefined {
  return posted.filter((message) => message.type === type).at(-1)?.payload;
}

/** What the handler refused, in its words, or undefined. */
function postedError(posted: ReadonlyArray<z.infer<typeof postedSchema>>): string | undefined {
  const error = postedOf(posted, 'dataops:error');
  if (error === undefined) return undefined;
  return typeof error['message'] === 'string' ? error['message'] : 'refused';
}

const coverageSchema = z.object({
  objects: z.array(
    z.object({ objectApiName: z.string().min(1), count: countSchema.nullable() }).loose(),
  ),
});

const previewSchema = z.object({
  objects: z.array(
    z
      .object({
        objectApiName: z.string().min(1),
        fields: z.array(z.string()),
        error: z.string().optional(),
      })
      .loose(),
  ),
  fieldsNotFound: z.array(z.object({ objectApiName: z.string(), fieldApiName: z.string() })),
});

/** What a dry run counted per object, and what it says a run would be refused for. */
export interface MaskDryRead {
  objects: Array<{ object: string; count: number | null }>;
  refusals: string[];
}

/**
 * What a dry run says: per object, the records its condition selects; and
 * what refuses a run now, in the script's words — the handler's refusal, an
 * object the org would not count or read, a field the rules name that the
 * org does not show the user, an object of which they mask no field.
 */
export function maskDryRead(answer: MaskDryRunAnswer): MaskDryRead {
  const refusals: string[] = [];
  const error = postedError(answer.posted);
  if (error !== undefined) refusals.push(error);
  const coverage = coverageSchema.safeParse(
    postedOf(answer.posted, 'dataops:anonymize:coverage:response'),
  );
  const preview = previewSchema.safeParse(
    postedOf(answer.posted, 'dataops:anonymize:preview:response'),
  );
  if (!coverage.success || !preview.success) {
    if (error === undefined) {
      refusals.push(
        'the masking never came to say what it would mask, and a run nobody counted is masked ' +
          'blind',
      );
    }
    return { objects: [], refusals };
  }
  const objects = coverage.data.objects.map((object) => ({
    object: object.objectApiName,
    count: object.count,
  }));
  for (const object of objects) {
    if (object.count === null) {
      refusals.push(`${object.object}: the org did not count the records it would mask`);
    }
  }
  for (const object of preview.data.objects) {
    if (object.error !== undefined) {
      refusals.push(`${object.objectApiName}: not read: ${object.error}`);
    } else if (object.fields.length === 0) {
      refusals.push(
        `${object.objectApiName}: its rules mask no field the org shows this user: a run would ` +
          'mask nothing there',
      );
    }
  }
  for (const missing of preview.data.fieldsNotFound) {
    refusals.push(missingFieldLine(missing.objectApiName, missing.fieldApiName));
  }
  return { objects, refusals };
}

/**
 * What a mask dry run counted, read as every kind's is: per object the
 * records a run would write over, and in all. A masking creates no record:
 * what a whole run creates is none, and it takes no data storage. The
 * script estimates no request, nor what the org sends as the records are
 * written over.
 */
export function maskDryRunCount(answer: MaskDryRunAnswer): EnvDryRunCount {
  const read = maskDryRead(answer);
  const objects = read.objects.map((object) => ({
    object: object.object,
    wouldCreate: object.count ?? 0,
  }));
  return {
    objects,
    total: objects.reduce((sum, object) => sum + object.wouldCreate, 0),
    created: 0,
    storageBytes: 0,
    emails: [],
    ...(read.refusals.length > 0 ? { refusal: read.refusals.join(' ') } : {}),
  };
}

const resultSchema = z
  .object({
    status: z.string().optional(),
    objects: z
      .array(
        z
          .object({
            objectApiName: z.string().min(1),
            total: countSchema,
            processed: countSchema,
            failed: countSchema,
            notMasked: countSchema,
          })
          .loose(),
      )
      .optional(),
    fieldsNotFound: z
      .array(z.object({ objectApiName: z.string(), fieldApiName: z.string() }))
      .optional(),
    snapshot: z
      .object({ operationId: z.string().min(1).max(200) })
      .loose()
      .optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ objectApiName: z.string(), message: z.string() })).optional(),
  })
  .loose();

/** What a masking run did, per object, and the snapshot it took first. */
export interface MaskRunCount {
  objects: Array<{ object: string; masked: number; refused: number; notMasked: number }>;
  /** The snapshot of their values before, taken before the first write. */
  snapshotId?: string;
  /** What refused or stopped it, in the handler's words. */
  refusal?: string;
  /** Why a run that ended 0 still left values as they were: fields the org lacks. */
  short?: string;
}

/**
 * What a masking run did, from its answer: per object the records it went
 * through — masked, or holding nothing to mask —, refused, and left with
 * their values; the snapshot it took first, which a failure names too. A run
 * that found nothing to mask posts no result, and masked nothing.
 */
export function maskRunCount(answer: MaskRunAnswer): MaskRunCount {
  const result = resultSchema.safeParse(
    postedOf(answer.posted, 'dataops:anonymize:response') ??
      postedOf(answer.posted, 'dataops:error') ??
      {},
  );
  const data = result.success ? result.data : {};
  const objects = (data.objects ?? []).map((object) => ({
    object: object.objectApiName,
    masked: object.processed,
    refused: object.failed,
    notMasked: object.notMasked,
  }));
  const error = postedError(answer.posted);
  const missing = (data.fieldsNotFound ?? []).map((m) =>
    missingFieldLine(m.objectApiName, m.fieldApiName),
  );
  return {
    objects,
    ...(data.snapshot !== undefined ? { snapshotId: data.snapshot.operationId } : {}),
    ...(error !== undefined ? { refusal: error } : {}),
    ...(missing.length > 0 ? { short: missing.join('; ') } : {}),
  };
}

// ─── What the org holds of a masking applied ─────────────────────────────────

/**
 * What the org holds of a masking applied, read by its dry run now: per
 * object, the records its condition selects against those its last run went
 * through. The same count is the same masking, kept; another is drift —
 * records copied in since, which hold their original values, or records
 * gone. A dry run that does not say leaves it unread.
 */
export function maskHeldOf(
  kept: Pick<EnvResourceState, 'runs'>,
  answer: MaskDryRunAnswer,
): { objects: EnvPlanObject[]; masked: number; drift?: string; unread?: string } {
  const read = maskDryRead(answer);
  const last = kept.runs.at(-1);
  const masked = new Map(
    (last?.objects ?? []).map((object) => [object.objectApiName, object.masked ?? 0]),
  );
  if (read.refusals.length > 0) {
    return { objects: [], masked: 0, unread: read.refusals.join(' ') };
  }
  const drift: string[] = [];
  const objects: EnvPlanObject[] = [];
  for (const { object, count } of read.objects) {
    const now = count ?? 0;
    const before = masked.get(object) ?? 0;
    // Held masked: those of its records still under its condition.
    objects.push({
      object,
      present: Math.min(now, before),
      ...(now < before ? { gone: before - now } : {}),
    });
    if (now > before) {
      drift.push(
        `${object} ${now} under its condition, ${before} masked: ${now - before} more, which ` +
          'hold their original values',
      );
    } else if (now < before) {
      drift.push(`${object} ${now} under its condition, ${before} masked: ${before - now} gone`);
    }
  }
  return {
    objects,
    masked: [...masked.values()].reduce((sum, n) => sum + n, 0),
    ...(drift.length > 0 ? { drift: drift.join('; ') } : {}),
  };
}

// ─── What the plan and the destroy say ───────────────────────────────────────

/** Where a plan says a mask resource's store is, and the org a restore would name. */
export interface MaskPlace {
  /** sf CLI alias of the org the environment is applied to. */
  alias: string;
  /** The resource's store, from the root; its place beside the state when not given. */
  store?: string;
}

/** The line that puts a snapshot's values back, as the script prints it. */
function restoreLine(place: MaskPlace, snapshot: string): string {
  return (
    `sandforge-dataops anonymize --org ${place.alias} --restore ${snapshot} ` +
    `--store ${place.store ?? '<its store>'}`
  );
}

/** Where a resource's store is, as a plan names it. */
function storeWords(resource: string, place: MaskPlace): string {
  return place.store ?? `${maskStoreOf(resource)} beside the state`;
}

/** What a plan says of a mask resource it runs, beside why: masking is one-way. */
export function maskNotes(resource: string, place: MaskPlace): string[] {
  return [
    'masking is one-way: each run first takes a snapshot of the values it writes over, kept ' +
      `on this machine in ${storeWords(resource, place)}, and destroy never puts them back: it ` +
      'deletes the snapshots. Putting them back is your own act, before a destroy: ' +
      restoreLine(place, '<the snapshot its run names>'),
  ];
}

/** The first run of a resource not taken back: the one whose snapshot holds the values before any masking. */
function firstRunOf(
  kept: Pick<EnvResourceState, 'runs'>,
): EnvResourceState['runs'][number] | undefined {
  return kept.runs.find((run) => run.takenBack !== true);
}

/** The snapshot the first run of a resource took, as a plan names it. */
function firstSnapshotOf(kept: Pick<EnvResourceState, 'runs'>): string {
  const first = firstRunOf(kept);
  return first?.snapshotId !== undefined
    ? `snapshot ${first.snapshotId}, run ${first.n}'s`
    : first !== undefined
      ? `the snapshot run ${first.n} took`
      : 'the snapshot its first run took';
}

/**
 * What a replace of a mask resource keeps, said after why: it masks again,
 * over what it masked, and takes nothing back first.
 */
export function maskReplaceWords(kept: Pick<EnvResourceState, 'runs'>): string {
  return (
    'it masks again what its condition selects, the records it masked before a second time, ' +
    'and takes nothing back first: the values they held before any masking stay only in ' +
    `${firstSnapshotOf(kept)}, which destroy deletes`
  );
}

/** Why a mask resource is replaced, from its last run's status: what each leaves. */
export const MASK_STATUS_WHY: Readonly<Partial<Record<EnvResourceState['status'], string>>> = {
  applying: 'its last masking was stopped part way',
  partial:
    'its last masking left values as they were: records the org refused, or fields it does ' +
    'not show this user',
  failed: 'its last masking failed',
  destroying: 'a deletion of its snapshots was stopped part way',
};

/** Why a mask resource kept as applied is: the same rules, the same records. */
export function maskKeptWhy(masked: number): string {
  return (
    `applied, and its condition selects the ${masked} record(s) it masked, with the same ` +
    'rules: masked again they would only be masked twice'
  );
}

/** Why a mask resource whose records moved since is drifted, and how to mask them again. */
export function maskDriftWhy(resource: string, drift: string): string {
  return (
    `its condition selects other records than it masked: ${drift}. Left as they are: ` +
    `--replace ${resource} or --replace-drifted masks them all again`
  );
}

/**
 * Why a mask resource that leaves the file, or the org's environment, is
 * deleted, and what of it stays: its records, masked. The line that puts
 * back the values they held before any masking, the person's own act, is
 * given while the snapshot that holds them is still there.
 */
export function maskDeleteWhy(
  verb: 'apply' | 'destroy',
  resource: string,
  kept: Pick<EnvResourceState, 'runs'>,
  place: MaskPlace,
): string {
  const first = firstRunOf(kept)?.snapshotId;
  return (
    `${verb === 'destroy' ? 'taken back by destroy, which never unmasks' : 'in the state, gone from the file'}: ` +
    `its records stay masked, and its store, ${storeWords(resource, place)}, is deleted from ` +
    'this machine with its snapshots, the only copy of the values they held. ' +
    (first !== undefined
      ? `To put back those they held before any masking, before this ${verb}, as your own ` +
        `act: ${restoreLine(place, first)}`
      : `Its snapshots are listed in its store: ${restoreLine(place, '<snapshot>')} puts one ` +
        `back, before this ${verb}, as your own act`)
  );
}

// ─── Its store, deleted ──────────────────────────────────────────────────────

/** What deleting a mask resource's store came to. */
export interface MaskStoreForgotten {
  /** The snapshots it held, deleted with it. */
  snapshots: string[];
}

/**
 * Delete a mask resource's DataOps store whole: its snapshots, the only
 * place the values it masked were kept, the template its rules were saved
 * as, the audit trail of its runs. Whole, not snapshot by snapshot: a run
 * stopped as it read its snapshot leaves record files no listing names,
 * holding values in clear. Gone already, it was deleted before.
 *
 * @throws When the folder is still there once deleted.
 */
export async function forgetMaskStore(dir: string): Promise<MaskStoreForgotten> {
  if (!existsSync(dir)) return { snapshots: [] };
  // Its metadata keys, `backup:<id>`; a key of an object's records is
  // `backup:<id>:<object>`.
  const snapshots = existsSync(join(dir, SNAPSHOTS_FILE))
    ? fileConfigStore(join(dir, SNAPSHOTS_FILE))
        .getKeysByPrefix('backup:')
        .map((key) => key.slice('backup:'.length))
        .filter((id) => !id.includes(':'))
    : [];
  await rm(dir, { recursive: true, force: true });
  if (existsSync(dir)) {
    throw new Error(`${dir} is still there: delete it, it holds the values a masking wrote over`);
  }
  return { snapshots: [...new Set(snapshots)].sort() };
}

/** What a destroy says once a mask resource's store is gone, the restore line no longer one. */
export function maskForgottenLine(resource: string, forgotten: MaskStoreForgotten): string {
  const held =
    forgotten.snapshots.length > 0
      ? `its snapshot${forgotten.snapshots.length === 1 ? '' : 's'} ${forgotten.snapshots.join(', ')}`
      : 'no snapshot';
  return (
    `${resource}: its records stay masked — destroy never unmasks —, and ${held}, the only ` +
    'copy of the values they held, deleted from this machine with its store'
  );
}
