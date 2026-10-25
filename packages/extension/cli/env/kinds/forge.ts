/**
 * The `forge` kind of resource: records cloned by Forge from an org the file
 * names by its role — one record and what discovery reaches from it, or
 * whole tables under their conditions.
 *
 * A forge resource is converted into an exported Forge template — a
 * template entry of the project's own templates file when it names one, the
 * file's depth, caps, anonymization and contact points over it — and checked
 * by `forgeTemplateSchema`, as `sandforge-clone --template` reads it. What it
 * clones is given on the line beside it: `--record`, or each table's
 * `--object` and `--where`.
 *
 * A record named by a query is read on its source at each plan, and the
 * query must answer exactly one row: a source scratch org made again gives
 * the same case another id, which a file naming it by id could not follow.
 * The source's Organization Id and the record it resolves to go into the
 * resource's fingerprint, its alias does not: an alias pointed at another
 * org is a change, an alias renamed is not.
 *
 * It runs `sandforge-clone`: a dry run, whose gate counts what a run would
 * write; a run held to that count with `--max-total`, its summary written as
 * it goes with `--summary`, beside the state; the verification of what it
 * created (`--verify`), which tells an applied resource from a partial one;
 * and the removal of the run from its summary, and the preview of that
 * removal (`--remove … --preview`).
 *
 * Held to its plan's count: a clone whose scope widened between its dry run
 * and its run — a parent added to the graph reads all its children — once
 * wrote 34 216 records where its dry run had said 37. The run is refused
 * before its first write when it would write more than its dry run counted.
 *
 * Real data. Reading a production org is allowed to every script, which
 * refuses only to write to one; and an org built for tests is often reached
 * by more people, pipelines and integrations than the source it was filled
 * from. A resource whose source types as a production org, by the live rule
 * every guard reads (`isProductionTarget`), is refused unless it anonymizes
 * what it clones (`anonymize`, a method for at least one category of
 * personal field) or the file accepts real data (`accept: { realData: true }`),
 * reviewed with it. The clone neutralizes emails and phone numbers by default
 * either way, and the plan says so.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { z } from 'zod';
import {
  forgeTemplateSchema,
  type EnvDocumentPath,
  type EnvForgeResource,
  type EnvForgeRun,
  type EnvForgeTable,
  type ForgeTemplateInput,
} from '@sandforge/shared';
import {
  isProductionTarget,
  typeTarget,
  type TypedTarget,
} from '../../../src/core/precheck/orgKindLive.js';
import type { RunnableScript } from '../../scriptRunner.js';
import {
  countSchema,
  idSchema,
  readAnswer,
  refusalAt,
  removalObjectSchema,
  removalPreviewSchema,
  valueOf,
  type EnvDryRunCount,
  type EnvFileRefusal,
  type EnvRunCount,
} from './common.js';

/** The script a `forge` resource runs. */
export const FORGE_SCRIPT = 'sandforge-clone' satisfies RunnableScript;

/** The most a clone writes when nothing says otherwise: the clone's own `--max-total` default. */
export const FORGE_DEFAULT_MAX_TOTAL = 10_000;

/** The largest templates file read: a file of templates with every decision a graph holds stays well under it. */
const TEMPLATES_FILE_MAX_BYTES = 1_000_000;

// ─── The resource, converted ─────────────────────────────────────────────────

/** The input a template's config holds, which the line gives instead. */
const INPUT_KEYS = ['inputMode', 'recordId', 'soqlQuery', 'templateId', 'aiPrompt', 'dryRun'];

/** The query a clone of whole tables is discovered from: the first table, under its condition. */
export function tablesQueryOf(tables: readonly EnvForgeTable[]): string {
  const [root] = tables;
  return `SELECT Id FROM ${root?.object ?? ''}${root?.where !== undefined ? ` WHERE ${root.where}` : ''}`;
}

/**
 * The entry `id` of the templates file the resource names, read from the
 * folder of the file and checked by the template schema, or why it cannot be.
 */
function templateEntryOf(
  name: string,
  ref: NonNullable<EnvForgeResource['template']>,
  folder: string,
): { entry: ForgeTemplateInput } | { refusals: EnvFileRefusal[] } {
  const at: EnvDocumentPath = ['resources', name, 'template'];
  const refused = (message: string) => ({ refusals: [refusalAt(at, message)] });
  let text: string;
  try {
    text = readFileSync(join(folder, ref.file), 'utf8');
  } catch (err: unknown) {
    return refused(
      `${ref.file} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (text.length > TEMPLATES_FILE_MAX_BYTES) {
    return refused(`${ref.file} is larger than ${TEMPLATES_FILE_MAX_BYTES} bytes`);
  }
  let entries: unknown;
  try {
    entries = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return refused(`${ref.file} is not JSON`);
  }
  // The workspace's file holds a list; a template exported from its row is one entry.
  const list = Array.isArray(entries) ? (entries as unknown[]) : [entries];
  const found = list.find(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>)['id'] === ref.id,
  );
  if (found === undefined) {
    const ids = list
      .map((entry) =>
        entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>)['id'] : '',
      )
      .filter((id): id is string => typeof id === 'string' && id !== '');
    return refused(
      `${ref.file} holds no template "${ref.id}"` +
        (ids.length > 0 ? `: it holds ${ids.join(', ')}` : ': it holds none'),
    );
  }
  const checked = forgeTemplateSchema.safeParse(found);
  if (!checked.success) {
    return {
      refusals: checked.error.issues.map((issue) =>
        refusalAt(
          at,
          `the template "${ref.id}" of ${ref.file} is refused by Forge's template schema at ` +
            `${issue.path.map(String).join('.') || 'its top'}: ${issue.message}`,
        ),
      ),
    };
  }
  return { entry: checked.data };
}

/**
 * What a forge resource runs, checked: an exported template — the entry the
 * resource names, the file's depth, caps, anonymization and contact points
 * over it — held to Forge's own template schema, and what it clones, which
 * the line gives beside it.
 *
 * @param folder - The folder of the file: a templates file is named from it.
 */
export function forgeRunOfResource(
  env: string,
  name: string,
  resource: EnvForgeResource,
  folder: string,
  now: Date,
): { run: EnvForgeRun; warnings: EnvFileRefusal[] } | { refusals: EnvFileRefusal[] } {
  const base: EnvDocumentPath = ['resources', name];
  const warnings: EnvFileRefusal[] = [];
  let entry: ForgeTemplateInput | undefined;
  if (resource.template !== undefined) {
    const read = templateEntryOf(name, resource.template, folder);
    if ('refusals' in read) return read;
    entry = read.entry;
  }
  const fromEntry: Record<string, unknown> = { ...entry?.config };
  for (const key of INPUT_KEYS) delete fromEntry[key];
  if (resource.tables !== undefined && fromEntry['expandOrphanParents'] === true) {
    return {
      refusals: [
        refusalAt(
          [...base, 'template'],
          'the template brings orphan parents (expandOrphanParents), which go with a clone of ' +
            'one record: a clone of tables reads the parents its tables point at, named with them',
        ),
      ],
    };
  }
  if (entry?.files !== undefined) {
    warnings.push(
      refusalAt(
        [...base, 'template'],
        'the template copies the files of the cloned records: an environment copies none, and ' +
          'the clone writes the records alone',
      ),
    );
  }
  const depth = resource.depth ?? (fromEntry['depth'] as ForgeTemplateInput['config']['depth']);
  const customDepth =
    (depth ?? 'custom') === 'custom'
      ? (resource.customDepth ?? (fromEntry['customDepth'] as number | undefined))
      : undefined;
  delete fromEntry['customDepth'];
  const at = now.toISOString();
  const template = {
    id: `env-${env}-${name}`,
    name: `${env}/${name}`,
    description: `The ${name} resource of the ${env} environment`,
    config: {
      anonymizePII: false,
      skipEmpty: true,
      batchSize: 'auto',
      ...fromEntry,
      ...(resource.tables !== undefined
        ? { inputMode: 'soql', soqlQuery: tablesQueryOf(resource.tables) }
        : {
            inputMode: 'record',
            ...(resource.record?.id !== undefined ? { recordId: resource.record.id } : {}),
          }),
      depth: depth ?? 'custom',
      ...(customDepth !== undefined ? { customDepth } : {}),
      ...(resource.maxNodes !== undefined ? { maxNodes: resource.maxNodes } : {}),
      ...(resource.keepContactPoints !== undefined
        ? { keepContactPoints: resource.keepContactPoints }
        : {}),
      ...(resource.anonymize !== undefined ? { anonymizePII: true } : {}),
    },
    ...(resource.anonymize !== undefined
      ? { anonymization: structuredClone(resource.anonymize) }
      : entry?.anonymization !== undefined
        ? { anonymization: structuredClone(entry.anonymization) }
        : {}),
    objectCount: 0,
    recordCount: 0,
    createdAt: at,
    lastUsedAt: at,
  };
  const checked = forgeTemplateSchema.safeParse(template);
  if (!checked.success) {
    return {
      refusals: checked.error.issues.map((issue) =>
        refusalAt(
          base,
          `the template it converts into is refused by Forge's template schema at ` +
            `${issue.path.map(String).join('.') || 'its top'}: ${issue.message}`,
        ),
      ),
    };
  }
  return {
    run: {
      source: resource.source,
      template: checked.data,
      ...(resource.record !== undefined ? { record: { ...resource.record } } : {}),
      ...(resource.tables !== undefined
        ? { tables: resource.tables.map((table) => ({ ...table })) }
        : {}),
      ...(resource.maxTotal !== undefined ? { maxTotal: resource.maxTotal } : {}),
      acceptAutomation: resource.accept?.automation === true,
      acceptRealData: resource.accept?.realData === true,
    },
    warnings,
  };
}

/** The objects a forge resource names, counted by its dry run alone: what `validate` lists. */
export function forgeObjectsOf(run: EnvForgeRun): Array<{ object: string }> {
  if (run.tables !== undefined) return run.tables.map((table) => ({ object: table.object }));
  return run.record?.object !== undefined ? [{ object: run.record.object }] : [];
}

// ─── The source, read at each plan ───────────────────────────────────────────

/**
 * What the plan read of a forge resource's source before fingerprinting it:
 * the org its role's alias reaches, whether it is a production org, and the
 * record a query names on it; or why it could not be read or may not be
 * cloned, which blocks the resource.
 */
export type EnvSourceRead =
  { organizationId: string; recordId?: string; production?: true } | { refusal: string };

/**
 * Whether what a forge resource clones is anonymized: its template
 * anonymizes, with a method for at least one category of personal field. An
 * anonymization that names none anonymizes nothing.
 */
export function forgeAnonymizes(run: Pick<EnvForgeRun, 'template'>): boolean {
  const rules = run.template.anonymization?.rules ?? {};
  return (
    run.template.config.anonymizePII === true &&
    Object.values(rules).some((method) => method !== undefined)
  );
}

/** What a production org's Organization record said, as a refusal quotes it. */
function productionEvidence(typed: TypedTarget): string {
  return typed.edition
    ? `its Organization record says IsSandbox false, edition ${typed.edition}`
    : 'its Organization record says IsSandbox false, and no edition';
}

/**
 * Why a forge resource may not clone its source, a production org, or
 * nothing when it may: it anonymizes what it clones, or the file accepts real
 * data. The refusal names both ways out.
 */
export function realDataRefusal(
  run: Pick<EnvForgeRun, 'template' | 'acceptRealData'>,
  what: string,
  typed: TypedTarget,
): string | undefined {
  if (run.acceptRealData || forgeAnonymizes(run)) return undefined;
  const empty =
    run.template.config.anonymizePII === true
      ? ' Its anonymize sets a method for no category of personal field, so it anonymizes nothing.'
      : '';
  return (
    `its source, ${what}, is a production org (${productionEvidence(typed)}): what it clones ` +
    'is real people’s data, written as read into an org built for tests.' +
    `${empty} Give the resource anonymize — Forge’s anonymization, a method for each category ` +
    'of personal field — or, reviewed in the file, accept: { realData: true }. Emails and phone ' +
    'numbers are neutralized either way, unless keepContactPoints: true'
  );
}

/**
 * What the plan says of a forge resource whose source is a production org:
 * that its data is real, what is done to it, and what the clone does to
 * emails and phone numbers — neutralized unless the resource keeps them.
 */
export function realDataNotes(
  run: Pick<EnvForgeRun, 'template' | 'acceptRealData'>,
  source: { role: string; alias: string; read?: EnvSourceRead },
): string[] {
  const read = source.read;
  if (read === undefined || 'refusal' in read || read.production !== true) return [];
  const rules = Object.entries(run.template.anonymization?.rules ?? {})
    .filter(([, method]) => method !== undefined)
    .map(([category, method]) => `${category} ${String(method)}`);
  const data = forgeAnonymizes(run)
    ? `anonymized as its anonymize says (${rules.join(', ')})`
    : 'written as read, as the file accepts (accept: { realData: true })';
  return [
    `real data: its source, the ${source.role} org (${source.alias}), is a production org; ` +
      `what it clones is ${data}`,
    run.template.config.keepContactPoints === true
      ? 'contact points: written as read (keepContactPoints: true)'
      : 'contact points: neutralized before writing (emails under .invalid, phone numbers in a ' +
        'fictional range), as the clone does unless keepContactPoints',
  ];
}

/**
 * The source of a forge resource, read: its Organization Id, from its own
 * Organization record, and, for a record named by a query, the one row the
 * query answers. No row, or more than one, refuses it with the count: a
 * clone of the first of two would be a clone nobody chose.
 */
export async function readForgeSource(
  conn: Pick<Connection, 'query'>,
  run: EnvForgeRun,
  role: string,
  alias: string,
): Promise<EnvSourceRead> {
  const what = `the ${role} org (${alias})`;
  let typed: TypedTarget;
  try {
    typed = await typeTarget(conn);
  } catch (err: unknown) {
    return { refusal: `${what} could not be read: ${messageOf(err)}` };
  }
  const organizationId = typed.id;
  // Refused before a record of it is read: a query of a production org for
  // a clone that may not be made is a read of real data for nothing.
  const production = isProductionTarget(typed);
  if (production) {
    const refused = realDataRefusal(run, what, typed);
    if (refused !== undefined) return { refusal: refused };
  }
  const read = { organizationId, ...(production ? { production: true as const } : {}) };
  const record = run.record;
  if (record?.object === undefined || record.where === undefined) return read;
  const where = `${record.object} WHERE ${record.where}`;
  try {
    const rows = (await conn.query<{ Id?: string }>(`SELECT Id FROM ${where} LIMIT 2`)).records;
    if (rows.length === 1 && typeof rows[0]?.Id === 'string') {
      return { ...read, recordId: rows[0].Id };
    }
    if (rows.length === 0) {
      return {
        refusal:
          `its record query finds no ${record.object} in ${what} (WHERE ${record.where}): a ` +
          'record named by a query is one its source answers with exactly one row',
      };
    }
    const counted = (await conn.query(`SELECT COUNT() FROM ${where}`)).totalSize;
    return {
      refusal:
        `its record query finds ${counted} ${record.object} records in ${what} (WHERE ` +
        `${record.where}), not one: narrow the where to one row, or name the record by its id`,
    };
  } catch (err: unknown) {
    return { refusal: `its record query could not be read in ${what}: ${messageOf(err)}` };
  }
}

/**
 * What a forge run writes, and nothing else: the fingerprint of a resource is
 * of this. Its source by the Organization Id its alias reaches, never the
 * alias; its record by the id its query resolved to; its tables under their
 * conditions; its template's config and anonymization — not the template's
 * name, dates and counts, nor the most it may write, which changes no record.
 */
export function forgeWritten(
  run: EnvForgeRun,
  read: EnvSourceRead | undefined,
): Record<string, unknown> {
  const source = read !== undefined && 'organizationId' in read ? read : undefined;
  return {
    kind: 'forge',
    kindVersion: 1,
    source: source?.organizationId.slice(0, 15) ?? null,
    record:
      run.record === undefined
        ? null
        : ((run.record.id ?? source?.recordId)?.slice(0, 15) ?? { unread: run.record }),
    tables: run.tables ?? null,
    config: run.template.config,
    anonymization: run.template.anonymization ?? null,
  };
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** What a forge resource's run, or its dry run, is given. */
export interface ForgeRunLine {
  /** sf CLI alias of the org it clones from. */
  source: string;
  /** sf CLI alias of the org the environment is applied to. */
  target: string;
  /** The exported template the resource converts into, written to a file. */
  templateFile: string;
  /** The record it clones; the tables when absent. */
  recordId?: string;
  tables?: readonly EnvForgeTable[];
  /** The most records it may write: a run's, its dry run's count. */
  maxTotal: number;
  /** Write although the target runs automation as the records go in: the file's acceptance. */
  acceptAutomation: boolean;
}

/** What a run and its dry run are given alike: the same records, planned then written. */
function forgeRunSwitches(input: ForgeRunLine): string[] {
  if (input.recordId === undefined && (input.tables ?? []).length === 0) {
    throw new Error('A forge resource clones a record or tables: its line names neither.');
  }
  return [
    '--source',
    valueOf('--source', input.source),
    '--target',
    valueOf('--target', input.target),
    ...(input.recordId !== undefined
      ? ['--record', valueOf('--record', input.recordId)]
      : (input.tables ?? []).flatMap((table) => [
          '--object',
          valueOf('--object', table.object),
          ...(table.where !== undefined ? ['--where', valueOf('--where', table.where)] : []),
        ])),
    '--template',
    valueOf('--template', input.templateFile),
    '--max-total',
    String(input.maxTotal),
    // The environment reads the clone's own gates; the row counts of the
    // target it prints first are thirty reads it does not need.
    '--skip-preflight',
    ...(input.acceptAutomation ? ['--accept-automation'] : []),
  ];
}

/** The line of a forge resource's dry run: what its gate counts, nothing written. */
export function forgeDryRunLine(input: ForgeRunLine): string[] {
  return [...forgeRunSwitches(input), '--dry-run', '--json'];
}

/** The line of a forge resource's run: its summary written as it goes, alone on stdout too. */
export function forgeApplyLine(input: ForgeRunLine & { summary: string }): string[] {
  return [...forgeRunSwitches(input), '--summary', valueOf('--summary', input.summary), '--json'];
}

/** What the removal of a forge resource's run, or its preview, is given. */
export interface ForgeRemovalLine {
  /** sf CLI alias of the org the run wrote to. */
  target: string;
  /** The summary the run wrote with `--summary`, beside the state. */
  summary: string;
  includeChanged?: boolean;
  acceptAutomation?: boolean;
}

function forgeRemovalSwitches(input: ForgeRemovalLine): string[] {
  return [
    '--remove',
    valueOf('--remove', input.summary),
    '--target',
    valueOf('--target', input.target),
    ...(input.includeChanged === true ? ['--include-changed'] : []),
    ...(input.acceptAutomation === true ? ['--accept-automation'] : []),
  ];
}

/** The line of the removal of a forge resource's run, its outcome alone on stdout. */
export function forgeRemoveLine(input: ForgeRemovalLine & { sweep?: boolean }): string[] {
  return [...forgeRemovalSwitches(input), ...(input.sweep === true ? ['--sweep'] : []), '--json'];
}

/** The line of the preview of that removal: what it would do, nothing written. */
export function forgePreviewLine(input: ForgeRemovalLine): string[] {
  return [...forgeRemovalSwitches(input), '--preview', '--json'];
}

/** The line of the verification of what a forge resource's run created. */
export function forgeVerifyLine(input: {
  summary: string;
  target: string;
  source: string;
}): string[] {
  return [
    '--verify',
    valueOf('--verify', input.summary),
    '--target',
    valueOf('--target', input.target),
    '--source',
    valueOf('--source', input.source),
    '--json',
  ];
}

// ─── The answers ─────────────────────────────────────────────────────────────

const emailLimitSchema = z.enum(['SingleEmail', 'DailyWorkflowEmails']);

/**
 * What `sandforge-clone --dry-run --json` prints, as an environment reads it:
 * what its gate counted as the write would have begun (`writePlan`) — per
 * object the records, their storage and the emails they send, in all the
 * records a run is held to — and what a real run would be refused for
 * (`wouldBeRefused`). A dry run that never reached its gate gives no plan.
 */
export const forgeDryRunAnswerSchema = z.object({
  tool: z.literal(FORGE_SCRIPT),
  version: z.literal(1),
  dryRun: z.literal(true),
  result: z.object({ wouldInsertCount: countSchema, failedCount: countSchema }),
  writePlan: z
    .object({
      totalRows: countSchema,
      storageBytes: countSchema,
      objects: z.array(
        z.object({
          objectApiName: z.string().min(1),
          rows: countSchema,
          storageBytes: countSchema,
          mayAdd: countSchema.optional(),
        }),
      ),
      emails: z.array(z.object({ limit: emailLimitSchema, emails: countSchema })).optional(),
    })
    .optional(),
  wouldBeRefused: z.array(z.string()).optional(),
});

/**
 * The summary a run writes with `--summary` and prints with `--json`, as an
 * environment reads it back: what it created per object, what the org
 * refused, and whether it ended, was stopped part way or failed.
 */
export const forgeRunAnswerSchema = z.object({
  tool: z.literal(FORGE_SCRIPT),
  version: z.literal(1),
  dryRun: z.literal(false),
  targetOrgId: idSchema.optional(),
  result: z.object({
    successCount: countSchema,
    failedCount: countSchema,
    createdByObject: z.array(
      z.object({ objectApiName: z.string().min(1), sourceIds: z.array(idSchema) }),
    ),
    errors: z.array(
      z.object({
        objectApiName: z.string().min(1),
        failedCount: countSchema,
        samples: z.array(z.unknown()).optional(),
      }),
    ),
  }),
  running: z.literal(true).optional(),
  interrupted: z.literal(true).optional(),
  error: z.string().optional(),
});

/** What `sandforge-clone --remove … --json` prints once a removal ran. */
export const forgeRemovalAnswerSchema = z.object({
  tool: z.literal(FORGE_SCRIPT),
  version: z.literal(1),
  action: z.literal('remove'),
  summary: z.string().min(1),
  target: z.string().min(1),
  includeChanged: z.boolean(),
  result: z.object({
    status: z.enum(['success', 'partial', 'failure', 'cancelled']),
    planned: countSchema,
    objects: z.array(removalObjectSchema),
    sweep: z.object({ status: z.string() }).loose().optional(),
  }),
  elapsedMs: countSchema,
});

/** What `sandforge-clone --remove … --preview --json` prints: what a removal would do, nothing written. */
export const forgePreviewAnswerSchema = z.object({
  tool: z.literal(FORGE_SCRIPT),
  version: z.literal(1),
  action: z.literal('remove-preview'),
  summary: z.string().min(1),
  target: z.string().min(1),
  includeChanged: z.boolean(),
  preview: removalPreviewSchema,
  refusals: z.array(z.string()),
  notes: z.array(z.string()),
  elapsedMs: countSchema,
});

/** What `sandforge-clone --verify … --json` prints: what of the run's records the target holds as written. */
export const forgeVerifyAnswerSchema = z.object({
  tool: z.literal(FORGE_SCRIPT),
  version: z.literal(1),
  action: z.literal('verify'),
  result: z.object({
    verdict: z.enum(['verified', 'partial', 'unstable']),
    attempts: countSchema,
    objects: z.array(
      z.object({
        objectApiName: z.string().min(1),
        expected: countSchema,
        present: countSchema,
        deleted: countSchema,
        notVisible: countSchema,
        changed: countSchema,
        linksChecked: countSchema,
        linksBroken: countSchema,
        error: z.string().optional(),
      }),
    ),
    linksUnchecked: z.string().optional(),
  }),
});

export type ForgeDryRunAnswer = z.infer<typeof forgeDryRunAnswerSchema>;
export type ForgeRunAnswer = z.infer<typeof forgeRunAnswerSchema>;
export type ForgeRemovalAnswer = z.infer<typeof forgeRemovalAnswerSchema>;
export type ForgePreviewAnswer = z.infer<typeof forgePreviewAnswerSchema>;
export type ForgeVerifyAnswer = z.infer<typeof forgeVerifyAnswerSchema>;

/** What a forge resource's dry run printed, read: see {@link forgeDryRunAnswerSchema}. */
export function readForgeDryRun(stdout: string): ForgeDryRunAnswer {
  return readAnswer(FORGE_SCRIPT, 'the summary of a dry run', forgeDryRunAnswerSchema, stdout);
}

/** A forge run's summary, from its file or its stdout, read: see {@link forgeRunAnswerSchema}. */
export function readForgeRun(text: string): ForgeRunAnswer {
  return readAnswer(FORGE_SCRIPT, 'the summary of a run', forgeRunAnswerSchema, text);
}

/** What the removal of a forge run printed, read: see {@link forgeRemovalAnswerSchema}. */
export function readForgeRemoval(stdout: string): ForgeRemovalAnswer {
  return readAnswer(FORGE_SCRIPT, 'the outcome of a removal', forgeRemovalAnswerSchema, stdout);
}

/** What the preview of a forge run's removal printed, read: see {@link forgePreviewAnswerSchema}. */
export function readForgePreview(stdout: string): ForgePreviewAnswer {
  return readAnswer(FORGE_SCRIPT, 'the preview of a removal', forgePreviewAnswerSchema, stdout);
}

/** What the verification of a forge run printed, read: see {@link forgeVerifyAnswerSchema}. */
export function readForgeVerify(stdout: string): ForgeVerifyAnswer {
  return readAnswer(FORGE_SCRIPT, 'a verification', forgeVerifyAnswerSchema, stdout);
}

// ─── The answers, as the plan and the apply read every kind's ────────────────

/**
 * What a forge dry run counted, as its gate counts it: per object the records
 * a run would write, in all what `--max-total` holds the run to. The gate
 * counts the rows read to write; a row the target already holds is linked,
 * not written, so where the dry run would insert fewer, each object's count
 * is the most it writes. A dry run that never reached its gate, or that
 * counts nothing to write, is refused: a run held to no count is held to
 * nothing, and `--max-total` takes no nought.
 */
export function forgeDryRunCount(answer: ForgeDryRunAnswer): EnvDryRunCount {
  const plan = answer.writePlan;
  const said = (answer.wouldBeRefused ?? []).join(' ');
  if (plan === undefined) {
    return {
      objects: [],
      total: 0,
      created: 0,
      storageBytes: 0,
      emails: [],
      refusal:
        said !== ''
          ? said
          : 'the clone never came to count what it would write, and a run held to no count is ' +
            'held to nothing',
    };
  }
  const exact = answer.result.wouldInsertCount === plan.totalRows;
  const refusal =
    said !== ''
      ? said
      : plan.totalRows === 0
        ? 'it would write nothing: the clone reads no record to write; look at its record or ' +
          'the conditions of its tables'
        : undefined;
  return {
    objects: plan.objects.map((object) => ({
      object: object.objectApiName,
      wouldCreate: object.rows,
      ...(exact ? {} : { atMost: true as const }),
    })),
    total: plan.totalRows,
    created: answer.result.wouldInsertCount,
    storageBytes: plan.storageBytes,
    emails: plan.emails ?? [],
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

/** What a forge run wrote, per object, from its summary: the records it created, and the refused. */
export function forgeRunCount(answer: ForgeRunAnswer): EnvRunCount {
  const objects = answer.result.createdByObject.map((object) => ({
    object: object.objectApiName,
    created: object.sourceIds.length,
    refused: 0,
    errors: [] as string[],
  }));
  for (const error of answer.result.errors) {
    if (error.failedCount === 0) continue;
    const at = objects.find((object) => object.object === error.objectApiName);
    const said = `${error.failedCount} refused by the org`;
    if (at !== undefined) {
      at.refused += error.failedCount;
      at.errors.push(said);
    } else {
      objects.push({
        object: error.objectApiName,
        created: 0,
        refused: error.failedCount,
        errors: [said],
      });
    }
  }
  return { objects, created: answer.result.successCount };
}

/** What a verification found the run's records short of, in words; nothing when it holds them. */
export function verificationShortOf(answer: ForgeVerifyAnswer): string | undefined {
  const { result } = answer;
  if (result.verdict === 'unstable') {
    return (
      `no two of ${result.attempts} readings agreed: something still writes to the run's ` +
      'records; verify again once it is done'
    );
  }
  const parts = result.objects.flatMap((object) => {
    if (object.error !== undefined) return [`${object.objectApiName} not read (${object.error})`];
    const missing = object.deleted + object.notVisible;
    return [
      ...(missing > 0
        ? [`${object.objectApiName} ${missing} of ${object.expected} not there`]
        : []),
      ...(object.linksBroken > 0
        ? [`${object.objectApiName} ${object.linksBroken} lookup(s) that do not hold`]
        : []),
    ];
  });
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
