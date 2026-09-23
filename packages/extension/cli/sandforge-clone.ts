#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sandforge-clone — headless record-scoped clone CLI.
 *
 * Wraps the production discovery + scoped-execute pipeline so devs can
 * run a Forge from the terminal without opening VSCode. The script
 * delegates org auth to the `sf` CLI (`sf org display`) and reuses the
 * exact same orchestrator/executor as the wizard.
 *
 * Runs from a checkout of the repository, at its root, after `pnpm install`
 * and `pnpm build:shared`.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
 *     --record <recordId> --source <alias> --target <alias>
 *     [--depth direct|full|custom] [--custom-depth <n>]
 *     [--max <n>] [--anonymize] [--dry-run]
 *
 * Example:
 *   pnpm exec tsx packages/extension/cli/sandforge-clone.ts \
 *     --record 500XX00000000001AAA \
 *     --source SOURCE-UAT --target TARGET-DEV \
 *     --depth custom --custom-depth 5 --max 50 --dry-run
 */
import type { Connection, DescribeSObjectResult } from 'jsforce';
import { loadOrg, makeConn } from './sfSession.js';

import type { ForgeConfig, ForgeFilesReport, ForgeGraph } from '@sandforge/shared';
import {
  BYTES_PER_MB,
  FILE_COPY_CEILING_MB,
  FILE_COPY_DEFAULT_MAX_MB,
  fileCopyRefusal,
  forgeConfigSchemaStrict,
  duplicateRuleHeaders,
  formatFileSize,
} from '@sandforge/shared';
import { GraphDiscoveryService } from '../src/modules/forge/GraphDiscoveryService.js';
import type {
  GraphDiscoveryDeps,
  ObjectDescribe,
} from '../src/modules/forge/GraphDiscoveryService.js';
import { ForgePlanGenerator } from '../src/modules/forge/ForgePlanGenerator.js';
import { ForgeExecutor } from '../src/modules/forge/ForgeExecutor.js';
import { runAnonymization, type PIIFieldInfo } from '../src/modules/forge/ForgeAnonymizer.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  FieldInfo,
  TargetObjectInfo,
} from '../src/modules/forge/ForgeExecutor.js';
import { RecordTypeMapper } from '../src/modules/sync/RecordTypeMapper.js';
import type { RecordTypeInfo, RecordTypeMapping } from '../src/modules/sync/RecordTypeMapper.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';
import { formatSaveError, toSaveOutcomes } from '../src/core/common/existingRecordMatch.js';
import { parseRecordTypeInfos } from '../src/core/metadata/recordTypeAvailability.js';
import { ForgeFilesRefusedError } from '../src/modules/forge/stages/FileCopier.js';
import {
  insertFile,
  readFileBody,
  remainingFileStorageMB,
} from '../src/modules/forge/fileTransfer.js';

export interface CliArgs {
  record: string;
  source: string;
  target: string;
  depth: 'direct' | 'full' | 'custom';
  customDepth: number;
  /** Discovery node cap; undefined leaves the service default in place. */
  maxNodes: number | undefined;
  maxRecordsPerObject: number | undefined;
  anonymize: boolean;
  dryRun: boolean;
  /** Print the objects discovery reached and stop, without reading a row. */
  listObjects: boolean;
  /** Enable upsert path on objects with externalId fields (skips DUPLICATE_VALUE on re-runs). */
  upsert: boolean;
  /** Single-hop orphan parent expansion when a required FK is out-of-graph. */
  expandOrphans: boolean;
  /** Skip the pre-execute target preflight (counts existing rows on target). */
  skipPreflight: boolean;
  /** Emit JSON summary on stdout (machine-readable for CI integration). */
  json: boolean;
  /** Per-object field exclusions: { Account: ['Description', 'NumberOfEmployees'] }. */
  fieldExclusions: Record<string, string[]>;
  /** Source User Id → target User Id remap for OwnerId. */
  ownerMappings: Record<string, string>;
  /** Per-object SOQL WHERE filter: { Case: "Status = 'Open' AND CreatedDate > LAST_N_DAYS:30" }. */
  objectSoqlFilters: Record<string, string>;
  /** Per-object source→target field rename: { Account: { 'Region__c': 'Region__pc' } }. */
  fieldMappings: Record<string, Record<string, string>>;
  /** Output path for the remap-table CSV (sourceId,targetId). undefined = no export. */
  remapCsv: string | undefined;
  /**
   * Copy the files attached to the cloned records (`--files`): the largest
   * file copied, and whether the files were accepted as they are
   * (`--files-as-is`). undefined = no file is read.
   */
  files: { maxFileSizeMB: number; acceptedAsIs: boolean } | undefined;
}

const HELP = `sandforge-clone — Forge a record-scoped clone from a source org to a target sandbox.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-clone.ts \\
    --record <id> --source <alias> --target <alias> [options]

  Run from the repository root of a checkout, after pnpm install and
  pnpm build:shared.

Required:
  --record <id>          Source record ID (any object type — prefix detected automatically)
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target sandbox

Options:
  --depth <mode>         direct | full | custom    (default: custom)
  --custom-depth <n>     traversal depth when --depth=custom    (default: 5)
  --max <n>              max records cloned per object          (default: unlimited)
  --list-objects         print the objects discovery reached, then stop
                         Answers "why was my object not cloned?" — an object
                         absent from this list was never in the graph.
  --max-nodes <n>        objects discovery may reach            (default: 50)
                         Raise it when the summary says TRUNCATED and the run
                         fails on a dependency, e.g. an Opportunity's line
                         items needing their PricebookEntry.
  --anonymize            anonymize PII fields                   (default: off)
  --dry-run              skip writes, surface scoped queries    (default: off)
  --upsert               use external Id upsert when available  (default: insert)
                         Skips DUPLICATE_VALUE on re-runs of the same source records.
  --expand-orphans       single-hop expand orphan parent FKs    (default: off)
                         Clones missing parents (out-of-graph) so child FKs resolve.
  --skip-preflight       skip pre-execute target row count      (default: off)
                         The preflight queries each object on target so the user
                         can see existing volume before pressing through.
  --json                 emit JSON summary on stdout (CI mode)  (default: off)
  --exclude <obj.field>  skip a field on an object during clone (repeatable)
                         e.g. --exclude Account.Description --exclude Account.NumberOfEmployees
  --owner-map <src=tgt>  remap OwnerId from source User Id to target User Id (repeatable)
                         e.g. --owner-map 005AB...=005XY...
                         Useful when source records were authored by users
                         that don't exist on the target sandbox (ex-employees).
  --filter <obj=where>   per-object SOQL WHERE filter (repeatable)
                         e.g. --filter "Case=Status = 'Open' AND CreatedDate > LAST_N_DAYS:30"
                         Lets BAs narrow a clone to a subset without changing
                         graph topology. Filter is appended via AND (...) to
                         the scope-derived clause. Max 512 chars per filter,
                         max 50 filters total.
  --map <obj.src=tgt>    per-object source→target field rename (repeatable)
                         e.g. --map Account.Region__c=Region__pc
                         Handles schema drift between source and target
                         (managed-package re-key, namespace change). The
                         source field is dropped and the value written to
                         the target field name on insert.
  --remap-csv <file>     write the source→target ID remap table to a CSV
                         file (header: sourceId,targetId). BA reconciliation:
                         "where did source X go on the target sandbox?"
  --files                copy the files of the cloned records   (default: off)
                         Salesforce Files (the latest version of each) and
                         attachments, after the records they hang on. The
                         total is checked against the target's file storage
                         before anything is written.
  --max-file-size <MB>   largest file --files copies, 1 to 35   (default: 10)
                         A larger file is left out and listed, never cut.
  --files-as-is          accept that files are copied as they are: their
                         content cannot be anonymized. Required with --files
                         when --anonymize is on.
  -h, --help             show this help and exit
`;

/** A 15- or 18-character Salesforce ID. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/** An SObject or field API name — the pattern the ForgeConfig schema enforces. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** The flag each ForgeConfig field is read from, to name it in an error. */
const FLAG_OF_FIELD: Readonly<Record<string, string>> = {
  inputMode: '--record',
  recordId: '--record',
  depth: '--depth',
  customDepth: '--custom-depth',
  maxRecordsPerObject: '--max',
  sourceOrgId: '--source',
  targetOrgId: '--target',
  fieldExclusions: '--exclude',
  ownerMappings: '--owner-map',
  objectSoqlFilters: '--filter',
  fieldMappings: '--map',
};

/** The command line read and checked; exits on `--help` or a bad flag. Exported so it can be tested. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const get = (flag: string, fallback?: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const record = get('--record');
  const source = get('--source');
  const target = get('--target');
  if (!record || !source || !target) {
    process.stderr.write('Missing required flag. Run with --help for usage.\n');
    process.exit(2);
  }

  const depthRaw = get('--depth', 'custom') ?? 'custom';
  const customDepthRaw = get('--custom-depth', '5');
  const maxRaw = get('--max');
  const maxNodesRaw = get('--max-nodes');
  // Repeatable flags: scan all positions for matches.
  const collectRepeated = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
    }
    return out;
  };
  const fieldExclusions: Record<string, string[]> = {};
  for (const raw of collectRepeated('--exclude')) {
    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0 || dotIdx === raw.length - 1) {
      process.stderr.write(`Invalid --exclude value "${raw}" (expected Object.field)\n`);
      process.exit(2);
    }
    const obj = raw.slice(0, dotIdx);
    const field = raw.slice(dotIdx + 1);
    if (!API_NAME_RE.test(obj) || !API_NAME_RE.test(field)) {
      process.stderr.write(
        `Invalid --exclude name in "${raw}" (must match SObject API name pattern)\n`,
      );
      process.exit(2);
    }
    (fieldExclusions[obj] ??= []).push(field);
  }
  const ownerMappings: Record<string, string> = {};
  for (const raw of collectRepeated('--owner-map')) {
    const eqIdx = raw.indexOf('=');
    if (eqIdx <= 0 || eqIdx === raw.length - 1) {
      process.stderr.write(`Invalid --owner-map value "${raw}" (expected sourceId=targetId)\n`);
      process.exit(2);
    }
    const src = raw.slice(0, eqIdx);
    const tgt = raw.slice(eqIdx + 1);
    if (!SF_ID_RE.test(src) || !SF_ID_RE.test(tgt)) {
      process.stderr.write(
        `Invalid --owner-map IDs in "${raw}" (must be 15 or 18 char Salesforce IDs)\n`,
      );
      process.exit(2);
    }
    ownerMappings[src] = tgt;
  }
  const objectSoqlFilters: Record<string, string> = {};
  for (const raw of collectRepeated('--filter')) {
    const eqIdx = raw.indexOf('=');
    if (eqIdx <= 0 || eqIdx === raw.length - 1) {
      process.stderr.write(`Invalid --filter value "${raw}" (expected Object=where-clause)\n`);
      process.exit(2);
    }
    const obj = raw.slice(0, eqIdx);
    const where = raw.slice(eqIdx + 1);
    if (where.length > 512) {
      process.stderr.write(`--filter where-clause for "${obj}" exceeds 512 chars\n`);
      process.exit(2);
    }
    if (/--|\/\*|\*\/|;\s*$/.test(where)) {
      process.stderr.write(
        `--filter where-clause for "${obj}" contains forbidden tokens (--, /*, */, trailing ;)\n`,
      );
      process.exit(2);
    }
    objectSoqlFilters[obj] = where;
  }
  const fieldMappings: Record<string, Record<string, string>> = {};
  for (const raw of collectRepeated('--map')) {
    const dotIdx = raw.indexOf('.');
    const eqIdx = raw.indexOf('=');
    if (dotIdx <= 0 || eqIdx <= dotIdx + 1 || eqIdx === raw.length - 1) {
      process.stderr.write(
        `Invalid --map value "${raw}" (expected Object.sourceField=targetField)\n`,
      );
      process.exit(2);
    }
    const obj = raw.slice(0, dotIdx);
    const src = raw.slice(dotIdx + 1, eqIdx);
    const tgt = raw.slice(eqIdx + 1);
    if (!API_NAME_RE.test(src) || !API_NAME_RE.test(tgt)) {
      process.stderr.write(
        `Invalid --map field name in "${raw}" (must match SObject API name pattern)\n`,
      );
      process.exit(2);
    }
    (fieldMappings[obj] ??= {})[src] = tgt;
  }
  const customDepth = customDepthRaw ? Number(customDepthRaw) : 5;
  const maxRecordsPerObject = maxRaw ? Number(maxRaw) : undefined;
  // Discovery stops at fifty objects by default, which a CRM graph exceeds
  // long before it has reached everything a write needs: an Opportunity's
  // line items cannot be written without the price book entries behind them,
  // and those sit past the cap on any org with a real catalogue.
  const maxNodes = maxNodesRaw ? Number(maxNodesRaw) : undefined;
  if (maxNodes !== undefined && (!Number.isInteger(maxNodes) || maxNodes < 1)) {
    process.stderr.write('--max-nodes takes a whole number of objects, 1 or more.\n');
    process.exit(2);
  }
  const files = fileCopyArgs(args);

  // The schema the wizard's ForgeConfig goes through, run on the same fields.
  // Without it `--depth deep` was cast into the union, and a malformed record
  // ID or object name was only refused after both orgs had been authenticated.
  const checked = forgeConfigSchemaStrict.safeParse({
    inputMode: 'record',
    recordId: record,
    depth: depthRaw,
    customDepth: depthRaw === 'custom' ? customDepth : undefined,
    sourceOrgId: source,
    targetOrgId: target,
    anonymizePII: has('--anonymize'),
    skipEmpty: true,
    batchSize: 'auto',
    maxRecordsPerObject,
    fieldExclusions,
    ownerMappings,
    objectSoqlFilters,
    fieldMappings,
  });
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      const [field, ...rest] = issue.path.map(String);
      const flag = FLAG_OF_FIELD[field ?? ''] ?? field ?? 'arguments';
      const at = rest.length > 0 ? ` (${rest.join('.')})` : '';
      process.stderr.write(`Invalid ${flag}${at}: ${issue.message}\n`);
    }
    process.exit(2);
  }

  return {
    record,
    source,
    target,
    depth: checked.data.depth,
    customDepth,
    maxNodes,
    maxRecordsPerObject,
    anonymize: has('--anonymize'),
    dryRun: has('--dry-run'),
    listObjects: has('--list-objects'),
    upsert: has('--upsert'),
    expandOrphans: has('--expand-orphans'),
    skipPreflight: has('--skip-preflight'),
    json: has('--json'),
    fieldExclusions,
    ownerMappings,
    objectSoqlFilters,
    fieldMappings,
    remapCsv: get('--remap-csv'),
    files,
  };
}

/**
 * The file flags read and checked; exits 2 on a combination that cannot run.
 *
 * `--anonymize` covers the records and never the files, whose content cannot
 * be anonymized: with it, `--files` copies nothing unless `--files-as-is`
 * says the files may go as they are. The other two flags only mean something
 * with `--files`, and are refused without it rather than ignored.
 */
function fileCopyArgs(args: readonly string[]): CliArgs['files'] {
  const wanted = args.includes('--files');
  const acceptedAsIs = args.includes('--files-as-is');
  const sizeAt = args.indexOf('--max-file-size');
  const sizeRaw = sizeAt >= 0 ? args[sizeAt + 1] : undefined;
  if (!wanted) {
    if (acceptedAsIs || sizeAt >= 0) {
      process.stderr.write('--files-as-is and --max-file-size go with --files.\n');
      process.exit(2);
    }
    return undefined;
  }
  const maxFileSizeMB = sizeAt >= 0 ? Number(sizeRaw) : FILE_COPY_DEFAULT_MAX_MB;
  if (
    !Number.isInteger(maxFileSizeMB) ||
    maxFileSizeMB < 1 ||
    maxFileSizeMB > FILE_COPY_CEILING_MB
  ) {
    process.stderr.write(
      `--max-file-size takes a whole number of MB from 1 to ${FILE_COPY_CEILING_MB}, ` +
        'the most one call to Salesforce carries.\n',
    );
    process.exit(2);
  }
  const refusal = fileCopyRefusal(args.includes('--anonymize'), acceptedAsIs);
  if (refusal) {
    process.stderr.write(
      '--anonymize anonymizes the records, and the content of a file cannot be anonymized: ' +
        'add --files-as-is to accept that files are copied as they are, or leave out --files.\n',
    );
    process.exit(2);
  }
  return { maxFileSizeMB, acceptedAsIs };
}

/** Shape a raw describe for the discovery service; exported so the field reading can be tested. */
export function adaptDescribe(raw: DescribeSObjectResult): ObjectDescribe {
  return {
    name: raw.name,
    fields: raw.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
      referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
      relationshipName: f.relationshipName ?? null,
      // Reads cascadeDelete as the extension's own describe adapter does. The
      // flag is not decoration: discovery keeps a master-detail edge over a
      // lookup for the same object pair, and the plan breaks a cycle by
      // nulling a lookup only when the cycle has one.
      isMasterDetail: f.cascadeDelete === true,
      // Not decoration either: discovery admits a parent behind a lookup the
      // platform refuses to leave null even when the node cap is spent.
      // Dropped here, that rule could never fire for a CLI run.
      nillable: f.nillable !== false,
    })),
    childRelationships: raw.childRelationships.map((c) => ({
      childSObject: c.childSObject,
      field: c.field,
      relationshipName: c.relationshipName ?? '',
      isCascadeDelete: Boolean(c.cascadeDelete),
    })),
  };
}

/** Match the active record types of both orgs; exported so the match can be tested. */
export async function loadRecordTypes(
  sourceConn: Connection,
  targetConn: Connection,
): Promise<RecordTypeMapping[]> {
  // SobjectType is read so the match stays within one object: Account and
  // Opportunity can each have a "Business" record type.
  const soql = 'SELECT Id, Name, DeveloperName, SobjectType FROM RecordType WHERE IsActive = true';
  type RecordTypeRow = { Id: string; Name: string; DeveloperName: string; SobjectType: string };
  const [s, tgt] = await Promise.all([
    sourceConn.query<RecordTypeRow>(soql),
    targetConn.query<RecordTypeRow>(soql),
  ]);
  const toInfo = (r: RecordTypeRow): RecordTypeInfo => ({
    id: r.Id,
    name: r.Name,
    developerName: r.DeveloperName,
    sobjectType: r.SobjectType,
  });
  return new RecordTypeMapper().buildMapping(s.records.map(toInfo), tgt.records.map(toInfo));
}

/**
 * The key prefix and record types of an object, read from the describe the
 * connection already holds — `describe$` answers from jsforce's cache, which
 * the field describe of the same object filled. Exported so it can be tested.
 */
export async function describeObjectInfo(
  conn: Connection,
  objectName: string,
): Promise<TargetObjectInfo> {
  const meta = await conn.describe$(objectName);
  return {
    keyPrefix: meta.keyPrefix ?? null,
    recordTypes: parseRecordTypeInfos(meta.recordTypeInfos),
  };
}

/**
 * Whether a run failed outright: records failed and none was created, updated
 * or linked, nor — for a dry run — would have been inserted. A run that linked
 * what it could not create, or wrote over what its external ids matched, has
 * done part of its job. Exported so it can be tested.
 */
export function failedOutright(summary: ExecutionSummary): boolean {
  const settled =
    summary.successCount + summary.updatedCount + summary.linkedCount + summary.wouldInsertCount;
  return summary.failedCount > 0 && settled === 0;
}

/**
 * What `--files` did, or — on a dry run — would do: per object the files and
 * their size, the links to the other cloned records, and every file left out
 * with why. Exported so it can be tested.
 */
export function fileLines(files: ForgeFilesReport, dryRun: boolean): string[] {
  const cap = formatFileSize(files.maxFileBytes);
  const lines = [`files (up to ${cap} each):`];
  for (const entry of files.objects) {
    const size = formatFileSize(entry.plannedBytes);
    lines.push(
      dryRun
        ? `  ${entry.objectApiName}  ${entry.planned} would be copied (${size}, dry run, nothing written)`
        : `  ${entry.objectApiName}  ${entry.copied} of ${entry.planned} copied (${size})` +
            (entry.failed > 0 ? `, ${entry.failed} failed` : ''),
    );
  }
  if (files.objects.length === 0) lines.push('  none to copy');
  if (dryRun && files.wouldCopy && files.wouldCopy.length > 0) {
    lines.push(`  would copy (${files.wouldCopy.length}):`);
    for (const file of files.wouldCopy) {
      lines.push(`    ${file.objectApiName}  ${file.name}  ${formatFileSize(file.bytes)}`);
    }
  }
  if (files.links > 0) lines.push(`  links to other cloned records: ${files.links}`);
  if (files.remainingStorageBytes !== undefined) {
    lines.push(`  target file storage left: ${formatFileSize(files.remainingStorageBytes)}`);
  }
  if (files.leftOut.length > 0) {
    lines.push(`  left out (${files.leftOut.length}):`);
    for (const file of files.leftOut) {
      const why =
        file.reason === 'too-large'
          ? `larger than ${cap}`
          : file.reason === 'external'
            ? 'kept outside Salesforce'
            : 'its records were not created by this run';
      lines.push(`    ${file.objectApiName}  ${file.name}  ${formatFileSize(file.bytes)} — ${why}`);
    }
  }
  return lines;
}

/**
 * The text summary of a run. Records the target already held are named apart
 * from the created and the failed ones: linked is neither, and a duplicate
 * nobody could identify is a failure whose children lost their lookup.
 * Exported so it can be tested.
 *
 * @param dryRun - Whether the run wrote nothing, for the files it would copy.
 */
export function summaryLines(summary: ExecutionSummary, dryRun = false): string[] {
  const lines = [
    `success: ${summary.successCount}`,
    // A dry run creates nothing: what it would have inserted, under its own name.
    ...(summary.wouldInsertCount > 0
      ? [`would be inserted: ${summary.wouldInsertCount} (dry run, nothing written)`]
      : []),
    // Only an `--upsert` run updates: a row matched by its external id is a
    // record the target held, written over and not created.
    ...(summary.updatedCount > 0
      ? [`updated: ${summary.updatedCount} (matched by their external id, not created)`]
      : []),
    `linked:  ${summary.linkedCount} (already in the target, not created)`,
    `failed:  ${summary.failedCount}`,
    `skipped: ${summary.skippedCount}`,
    `remaps:  ${summary.remapCount}`,
  ];
  if (summary.existingRecords.length > 0) {
    lines.push('', `already in the target (${summary.existingRecords.length} object(s)):`);
    for (const e of summary.existingRecords) {
      const parts = [`${e.linked} linked`];
      if (e.unidentified > 0) {
        parts.push(`${e.unidentified} not identified — their children lost the link`);
      }
      lines.push(`  ${e.objectApiName}  ${parts.join(', ')}`);
    }
  }
  if (summary.files) lines.push('', ...fileLines(summary.files, dryRun));
  if (summary.errors.length > 0) {
    lines.push('', `errors (${summary.errors.length} object(s)):`);
    for (const e of summary.errors) {
      lines.push(`  [${e.stage}] ${e.objectApiName}  ${e.failedCount}/${e.attemptedCount}`);
      for (const s of e.samples.slice(0, 2)) {
        lines.push(`    ${s.recordSummary}`);
        for (const m of s.messages) lines.push(`      └ ${m}`);
      }
    }
  }
  return lines;
}

/**
 * The `result` of the `--json` summary, a stable schema for CI.
 *
 * `remapTable` maps every source id the run gave a counterpart in the target.
 * `existingSourceIds` names the entries the target already held and
 * `updatedSourceIds` the ones `--upsert` wrote over, so the table's other
 * entries are exactly the records the run created. Exported so it can be
 * tested.
 */
export function jsonResult(summary: ExecutionSummary) {
  return {
    successCount: summary.successCount,
    // Written over by `--upsert`: the target held them before the run.
    updatedCount: summary.updatedCount,
    // Neither created nor failed: the target already held these records —
    // it named them, or they were matched by name — and their children link
    // to them.
    linkedCount: summary.linkedCount,
    // What a dry run would have inserted: it writes nothing.
    wouldInsertCount: summary.wouldInsertCount,
    failedCount: summary.failedCount,
    skippedCount: summary.skippedCount,
    remapCount: summary.remapCount,
    existingRecords: summary.existingRecords,
    errors: summary.errors.map((e) => ({
      objectApiName: e.objectApiName,
      stage: e.stage,
      failedCount: e.failedCount,
      attemptedCount: e.attemptedCount,
      samples: e.samples,
    })),
    // remapTable only included in JSON output for CI consumers; the
    // text output stays terse (use --remap-csv for the file dump).
    remapTable: summary.remapTable,
    existingSourceIds: summary.existingSourceIds,
    updatedSourceIds: summary.updatedSourceIds,
    // Only with --files: what became of the files. The ones copied are in
    // remapTable too, under their document or attachment id.
    ...(summary.files ? { files: summary.files } : {}),
  };
}

/**
 * The line an object's end of run prints, or nothing for a step on the way.
 * The executor says what each object came to — `--dry-run`'s "would be
 * inserted" counts among them — and the run passed it a callback that
 * dropped every word. Exported so it can be tested.
 */
export function objectOutcomeLine(event: ForgeProgressEvent): string | undefined {
  if (event.status !== 'done' && event.status !== 'error') return undefined;
  return event.message ? `  ${event.message}` : undefined;
}

/**
 * What the executor is asked to do, from the command line and the graph
 * discovery built. Exported so it can be tested.
 *
 * @param personalFieldsOf - The personal fields of an object, as discovery
 *   names them: what `--anonymize` covers on an orphan parent from outside
 *   the graph.
 */
export function executeOptions(
  args: CliArgs,
  graph: ForgeGraph,
  recordTypeMappings: RecordTypeMapping[],
  personalFieldsOf?: (fields: PIIFieldInfo[]) => string[],
): ExecuteOptions {
  return {
    rootRecordId: args.record,
    rootObjectApiName: graph.nodes[0]?.objectApiName ?? '',
    dryRun: args.dryRun,
    recordTypeMappings,
    maxRecordsPerObject: args.maxRecordsPerObject,
    // Force 'nullify' for cross-org CLI clones. The default
    // ('keep' for non-scoped) preserves source IDs which would be
    // invalid on the target unless source and target share state, which
    // is never the case for a real cross-org clone via this CLI.
    referenceFallback: 'nullify',
    upsertMode: args.upsert ? 'auto' : undefined,
    expandOrphanParents: args.expandOrphans,
    fieldExclusions:
      Object.keys(args.fieldExclusions).length > 0 ? args.fieldExclusions : undefined,
    ownerMappings: Object.keys(args.ownerMappings).length > 0 ? args.ownerMappings : undefined,
    objectSoqlFilters:
      Object.keys(args.objectSoqlFilters).length > 0 ? args.objectSoqlFilters : undefined,
    fieldMappings: Object.keys(args.fieldMappings).length > 0 ? args.fieldMappings : undefined,
    // `--anonymize` had discovery select each object's PII fields, and every
    // record was then written as the source held it. The selected fields go,
    // each with its category's default method.
    anonymization: runAnonymization(args.anonymize, graph, {}, personalFieldsOf),
    files: args.files
      ? {
          maxFileBytes: args.files.maxFileSizeMB * BYTES_PER_MB,
          acceptedAsIs: args.files.acceptedAsIs,
        }
      : undefined,
  };
}

/** Run one clone from the given command line; exported so its flag checks can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  console.log(`sandforge-clone  ${args.source} -> ${args.target}  record=${args.record}`);

  const sourceOrg = await loadOrg(args.source);
  const targetOrg = await loadOrg(args.target);
  const conns = new Map<string, Connection>();
  conns.set(args.source, makeConn(sourceOrg));
  conns.set(args.target, makeConn(targetOrg));

  const config: ForgeConfig = {
    inputMode: 'record',
    recordId: args.record,
    depth: args.depth,
    customDepth: args.depth === 'custom' ? args.customDepth : undefined,
    sourceOrgId: args.source,
    targetOrgId: args.target,
    anonymizePII: args.anonymize,
    skipEmpty: true,
    batchSize: 'auto',
  };

  const piiDetector = new PIIDetector();
  const fullDescribes = new Map<string, ObjectDescribe>();
  const discoveryDeps: GraphDiscoveryDeps = {
    describeObject: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const raw = await c.sobject(name).describe();
      const adapted = adaptDescribe(raw);
      fullDescribes.set(name, adapted);
      return adapted;
    },
    queryCount: async (orgId, soql) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.query(soql);
      return r.totalSize;
    },
    detectPII: (fields) => {
      const adapted = fields.map((f) => ({ apiName: f.name, label: f.name, type: f.type }));
      return piiDetector.detectPII('graph-node', adapted).piiFields.map((p) => p.fieldApiName);
    },
    describeGlobal: async (orgId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.describeGlobal();
      return r.sobjects.map((s) => ({ name: s.name, keyPrefix: s.keyPrefix ?? null }));
    },
  };

  console.log('discovery…');
  const discovery = new GraphDiscoveryService(discoveryDeps);
  const graph = await discovery.discover(
    config,
    args.maxNodes === undefined ? undefined : { maxNodes: args.maxNodes },
  );
  const plan = new ForgePlanGenerator().generate(graph);
  console.log(
    `graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${plan.waves.length} waves, ${plan.cycleResolutions.length} cycles${graph.truncated ? ' (TRUNCATED)' : ''}`,
  );

  if (args.listObjects) {
    // The question a user asks when an object they expected is missing from a
    // clone: is it in the graph at all? Nothing answered it before, and the
    // answer decides whether to raise --max-nodes or to look elsewhere.
    const rows = [...graph.nodes]
      .sort((a, b) => a.objectApiName.localeCompare(b.objectApiName))
      .map(
        (n) =>
          `  ${n.objectApiName.padEnd(42)}${String(n.recordCount).padStart(8)}` +
          `  depth ${n.level}${n.included ? '' : '  (excluded)'}`,
      );
    console.log(`\nobjects in the graph (${graph.nodes.length}):`);
    console.log(rows.join('\n'));
    if (graph.truncated) {
      console.log(
        '\nThe graph was truncated: discovery stopped before it had walked ' +
          'everything. Raise --max-nodes if an object you need is missing.',
      );
    }
    return;
  }

  console.log('record-type mapping…');
  const recordTypeMappings = await loadRecordTypes(
    conns.get(args.source)!,
    conns.get(args.target)!,
  );
  console.log(`record-types: ${recordTypeMappings.length} mappings`);

  const executorDeps: ForgeExecutorDeps = {
    queryRecords: async (orgId, soql) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.query<Record<string, unknown>>(soql);
      return r.records;
    },
    insertRecords: async (orgId, name, records) => {
      if (args.dryRun) return records.map(() => ({ id: '', success: true, errors: [] }));
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      // A clone is a deliberate duplicate; see `duplicateRuleHeaders`. Without
      // this header every root Account of a real UAT → DEV run was refused
      // with DUPLICATES_DETECTED, and its whole graph skipped behind it.
      const r = await c.sobject(name).create(records, { headers: duplicateRuleHeaders(true) });
      // With the records a blocking duplicate rule matched: the run links a
      // row the target already holds to the one record the refusal names.
      return toSaveOutcomes(r, name);
    },
    updateRecords: async (orgId, name, records) => {
      if (args.dryRun) return [];
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c.sobject(name).update(records as unknown as { Id: string }[]);
      const arr = Array.isArray(r) ? r : [r];
      return arr.map((x, i) => ({
        id: x.id ?? (records[i]['Id'] as string) ?? '',
        success: x.success,
        errors: (x.errors ?? []).map(formatSaveError),
      }));
    },
    describeFields: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const meta = await c.sobject(name).describe();
      return meta.fields.map<FieldInfo>((f) => ({
        name: f.name,
        type: f.type,
        queryable: true,
        createable: f.createable ?? false,
        isReference: f.type === 'reference',
        referenceTo: (f.referenceTo ?? []).filter((r): r is string => typeof r === 'string'),
        nillable: f.nillable ?? true,
        picklistValues: (f.picklistValues ?? [])
          .filter((p) => p?.active !== false && typeof p?.value === 'string')
          .map((p) => p.value as string),
      }));
    },
    isObjectCreatable: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const meta = await c.sobject(name).describe();
      return meta.createable !== false;
    },
    // The key prefix a duplicate's id must carry, and the record types the
    // running user may use, from the describe already cached for the object.
    describeObject: async (orgId, name) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return describeObjectInfo(c, name);
    },
    // Surface upsert path so re-runs against the same source records
    // don't pile DUPLICATE_VALUE errors on objects with external Id fields.
    upsertRecords: async (orgId, name, externalIdField, records) => {
      if (args.dryRun) return records.map(() => ({ id: '', success: true, errors: [] }));
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      const r = await c
        .sobject(name)
        .upsert(records, externalIdField, { headers: duplicateRuleHeaders(true) });
      return toSaveOutcomes(r, name);
    },
    // What --files reads and writes: one file per request each way, and the
    // target's file storage before any of them.
    readFileBody: async (orgId, objectApiName, id) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return readFileBody(c, objectApiName, id);
    },
    insertFile: async (orgId, objectApiName, record) => {
      if (args.dryRun) return { id: '', success: true, errors: [] };
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return insertFile(c, objectApiName, record);
    },
    remainingFileStorageMB: async (orgId) => {
      const c = conns.get(orgId);
      if (!c) throw new Error(`No connection for ${orgId}`);
      return remainingFileStorageMB(c);
    },
  };

  // Preflight: pre-count rows on the target for every node in the graph so
  // the user sees how much data already exists before pulling the trigger.
  // Skip with --skip-preflight if it's slow on big graphs (10s+ on 100 nodes).
  if (!args.skipPreflight) {
    console.log('\npreflight (target row counts)…');
    const targetConn = conns.get(args.target)!;
    const sample = graph.nodes.slice(0, 30); // cap to first 30 to keep it snappy
    const preflight: Array<{ name: string; existing: number }> = [];
    for (const n of sample) {
      try {
        const r = await targetConn.query(`SELECT COUNT() FROM ${n.objectApiName}`);
        preflight.push({ name: n.objectApiName, existing: r.totalSize });
      } catch {
        preflight.push({ name: n.objectApiName, existing: -1 });
      }
    }
    const nonZero = preflight.filter((p) => p.existing > 0);
    if (nonZero.length === 0) {
      console.log('  target is empty for all sampled objects.');
    } else {
      const top = nonZero.sort((a, b) => b.existing - a.existing).slice(0, 10);
      console.log(
        `  ${nonZero.length}/${preflight.length} sampled objects have existing rows. Top 10:`,
      );
      for (const p of top) {
        const flag = p.existing > 1000 ? '  ⚠' : '';
        console.log(`    ${p.name.padEnd(40)} ${String(p.existing).padStart(8)}${flag}`);
      }
      if (graph.nodes.length > sample.length) {
        console.log(
          `  (sampled first ${sample.length}/${graph.nodes.length} nodes; --skip-preflight to bypass)`,
        );
      }
    }
  }

  console.log(
    `\nexecuting… (${args.dryRun ? 'DRY-RUN' : 'REAL'}${args.upsert ? ', UPSERT' : ''}${args.expandOrphans ? ', EXPAND-ORPHANS' : ''}${args.files ? ', FILES' : ''})`,
  );
  let summary: ExecutionSummary;
  try {
    summary = await new ForgeExecutor(executorDeps).execute(
      graph,
      args.source,
      args.target,
      (event) => {
        const line = args.json ? undefined : objectOutcomeLine(event);
        if (line) console.log(line);
      },
      executeOptions(args, graph, recordTypeMappings, (fields) => discovery.personalFields(fields)),
    );
  } catch (err: unknown) {
    // Refused before anything was written — the files do not fit in the
    // target, or its storage could not be read: said as it is, not as a crash.
    if (err instanceof ForgeFilesRefusedError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const elapsed = Date.now() - t0;

  // BA reconciliation export. Written before the JSON/text summary so a
  // post-execute script can pick it up by tailing the file.
  if (args.remapCsv) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    // Containment check: resolve against cwd and refuse anything that
    // escapes (path traversal). Force `.csv` extension and refuse to
    // overwrite an existing file so a misuse can't clobber sensitive
    // files (e.g. authorized_keys, profile.ps1, scheduled-task XML).
    const resolved = path.resolve(process.cwd(), args.remapCsv);
    const cwdResolved = path.resolve(process.cwd());
    const inside = resolved === cwdResolved || resolved.startsWith(cwdResolved + path.sep);
    if (!inside) {
      throw new Error(
        `--remap-csv must stay inside cwd: "${args.remapCsv}" resolves outside ${cwdResolved}`,
      );
    }
    if (!resolved.toLowerCase().endsWith('.csv')) {
      throw new Error(`--remap-csv must use a .csv extension: "${args.remapCsv}"`);
    }
    try {
      await fs.access(resolved);
      throw new Error(`--remap-csv refuses to overwrite existing file: "${resolved}"`);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw err;
    }
    const lines = ['sourceId,targetId'];
    for (const [src, tgt] of Object.entries(summary.remapTable)) {
      // Both IDs are validated SF IDs (15/18 alphanum) — safe to embed
      // without quoting. Defense: in case a future source returns
      // something odd, double-quote both columns to neutralize commas.
      lines.push(`"${src.replace(/"/g, '""')}","${tgt.replace(/"/g, '""')}"`);
    }
    await fs.writeFile(resolved, lines.join('\n') + '\n', 'utf8');
    if (!args.json) {
      console.log(
        `remap-csv: wrote ${Object.keys(summary.remapTable).length} mappings to ${resolved}`,
      );
    }
  }

  if (args.json) {
    // Machine-readable summary for CI/automation. Stable schema.
    process.stdout.write(
      JSON.stringify(
        {
          tool: 'sandforge-clone',
          version: 1,
          source: args.source,
          target: args.target,
          record: args.record,
          dryRun: args.dryRun,
          upsert: args.upsert,
          expandOrphans: args.expandOrphans,
          files: args.files !== undefined,
          graph: {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            waves: plan.waves.length,
            cycles: plan.cycleResolutions.length,
            truncated: graph.truncated ?? false,
          },
          result: jsonResult(summary),
          elapsedMs: elapsed,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    console.log('');
    for (const line of summaryLines(summary, args.dryRun)) console.log(line);
    console.log(`\ndone in ${elapsed}ms`);
  }
  if (failedOutright(summary)) {
    process.exit(1);
  }
}

// Only when run as a script: importing the module must not start a clone.
if (/sandforge-clone\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('FATAL:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
