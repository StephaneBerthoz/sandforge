#!/usr/bin/env tsx
/**
 * sandforge-sync — headless Sync runner.
 *
 * Why this exists: until it did, Sync had never been run against a real pair
 * of orgs. Every other check it passes — 4 000-odd unit tests, the end-to-end
 * suite, mutation testing, six workflows on three operating systems — Forge
 * passed too, and the first real run of Forge found eleven defects none of
 * them had seen. The only tool that ever found those was a script like this
 * one, so Sync gets its own.
 *
 * It drives the same `SyncOrchestrator` the panel drives, through the same
 * `BulkDataWriter`, with the same query path. What it leaves out is what the
 * panel adds around the run: progress posted to a webview, history, the
 * offline queue, grappe partitioning. A failure here is a failure of the sync
 * itself and not of the plumbing around it.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-sync.ts \
 *     --source SRC --target TGT --object Account --object Contact
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import jsforce from 'jsforce';
import type { Connection } from 'jsforce';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import type { OperationOutcome } from '../src/modules/sync/DataSync.js';
import { loadOrg, makeConn } from './sfSession.js';
import { SyncOrchestrator } from '../src/modules/sync/SyncOrchestrator.js';
import { DataSync } from '../src/modules/sync/DataSync.js';
import {
  targetWriteFieldsOf,
  type TargetWriteFields,
} from '../src/modules/sync/targetWriteFields.js';
import { MetadataSync } from '../src/modules/sync/MetadataSync.js';
import { ConflictResolver } from '../src/modules/sync/ConflictResolver.js';
import { FieldMappingService } from '../src/modules/sync/FieldMapping.js';
import { TransformPipeline } from '../src/modules/sync/TransformPipeline.js';
import { IncrementalTracker } from '../src/modules/sync/IncrementalTracker.js';
import { BulkDataWriter } from '../src/modules/sync/BulkDataWriter.js';
import { BulkApiExecutor } from '../src/core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../src/core/engine/BulkApiManager.js';
import { queryAllPages } from '../src/modules/forge/queryAllPages.js';

const HELP = `sandforge-sync — run a Sync between two orgs, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-sync.ts \\
    --source <alias> --target <alias> --object <ApiName> [options]

Required:
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target org
  --object <ApiName>     object to sync; repeat for more, in insert order
                         Append ":<Field>" to match on an external Id, which
                         turns that object's operation into an upsert.

Options:
  --operation <op>       insert | upsert | update       (default: insert)
                         Per-object ":<Field>" wins over this.
  --where <obj=clause>   SOQL WHERE for one object (repeatable)
                         e.g. --where "Account=BillingCountry = 'France'"
  --batch-size <n>       records per write call            (default: 200)
  --dry-run              read and map, write nothing       (default: off)
  --json                 emit the run summary as JSON      (default: off)
  --help                 this text

Exit codes: 0 the run finished (read the summary for per-object failures),
1 the run could not be started, 2 a bad command line.
`;

/** One object to sync, as the command line describes it. */
interface ObjectSpec {
  objectApiName: string;
  externalIdField?: string;
}

/** Everything the command line settled. */
interface CliArgs {
  source: string;
  target: string;
  objects: ObjectSpec[];
  operation: 'insert' | 'upsert' | 'update';
  where: Record<string, string>;
  batchSize: number;
  dryRun: boolean;
  json: boolean;
}

/** SObject API name — letter-prefixed, alphanumeric and underscore. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const get = (flag: string, fallback?: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
  };
  const collect = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
    }
    return out;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const source = get('--source');
  const target = get('--target');
  const rawObjects = collect('--object');
  if (!source || !target || rawObjects.length === 0) {
    process.stderr.write('Missing --source, --target or --object. Run with --help.\n');
    process.exit(2);
  }

  const objects: ObjectSpec[] = rawObjects.map((raw) => {
    const [objectApiName, externalIdField] = raw.split(':');
    if (!API_NAME_RE.test(objectApiName)) {
      process.stderr.write(`Not an SObject API name: "${objectApiName}"\n`);
      process.exit(2);
    }
    if (externalIdField !== undefined && !API_NAME_RE.test(externalIdField)) {
      process.stderr.write(`Not a field API name: "${externalIdField}"\n`);
      process.exit(2);
    }
    return { objectApiName, externalIdField };
  });

  const operationRaw = get('--operation', 'insert') ?? 'insert';
  if (operationRaw !== 'insert' && operationRaw !== 'upsert' && operationRaw !== 'update') {
    process.stderr.write(`--operation takes insert, upsert or update, not "${operationRaw}".\n`);
    process.exit(2);
  }

  const where: Record<string, string> = {};
  for (const pair of collect('--where')) {
    const at = pair.indexOf('=');
    // The name has to be one, or a bare clause like "Name = 'A'" reads as a
    // filter on an object called "Name " and is quietly applied to nothing.
    const objectApiName = at > 0 ? pair.slice(0, at) : '';
    if (!API_NAME_RE.test(objectApiName)) {
      process.stderr.write(`--where wants "Object=clause", not "${pair}".\n`);
      process.exit(2);
    }
    where[objectApiName] = pair.slice(at + 1);
  }

  const batchRaw = get('--batch-size', '200') ?? '200';
  const batchSize = Number(batchRaw);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    process.stderr.write('--batch-size takes a whole number between 1 and 10000.\n');
    process.exit(2);
  }

  return {
    source,
    target,
    objects,
    operation: operationRaw,
    where,
    batchSize,
    dryRun: has('--dry-run'),
    json: has('--json'),
  };
}

/** Turn the command line into the config the orchestrator executes. */
export function buildConfig(args: CliArgs): SyncConfig {
  const now = new Date().toISOString();
  const objects: SyncObjectConfig[] = args.objects.map((spec, index) => ({
    objectApiName: spec.objectApiName,
    externalIdField: spec.externalIdField,
    // An external Id is only useful as a match key, so naming one chooses the
    // operation with it rather than leaving the two to disagree.
    operation: spec.externalIdField ? 'upsert' : args.operation,
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: args.batchSize,
    where: args.where[spec.objectApiName],
    insertOrder: index,
  }));

  return {
    id: `cli-${Date.now()}`,
    name: 'sandforge-sync',
    description: 'Headless run',
    sourceOrgId: args.source,
    targetOrgId: args.target,
    direction: 'source_to_target',
    mode: 'full',
    objects,
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Read every row of an object, following the cursor.
 *
 * `FIELDS(ALL)` with the explicit-field fallback, the same two-step the panel
 * uses: an org that refuses the shorthand still gets read. Exported so the
 * read can be tested.
 */
export function buildQueryFn(conn: Connection) {
  return async (
    _orgId: string,
    objectConfig: SyncObjectConfig,
  ): Promise<Record<string, unknown>[]> => {
    const object = objectConfig.objectApiName;
    if (!API_NAME_RE.test(object)) throw new Error(`Not an SObject API name: ${object}`);
    const where = objectConfig.where ? ` WHERE ${objectConfig.where}` : '';
    try {
      const result = await conn.query<Record<string, unknown>>(
        `SELECT FIELDS(ALL) FROM ${object}${where} LIMIT 200`,
      );
      return result.records;
    } catch {
      const described = await conn.sobject(object).describe();
      const fields = described.fields
        .filter((f) => f.type !== 'address' && f.type !== 'location')
        .map((f) => f.name)
        .join(', ');
      // Asked by name with no LIMIT, the rows come a page of 2 000 at most at
      // a time: every page is read, as the panel reads them.
      const { records } = await queryAllPages<Record<string, unknown>>(
        {
          query: async (q) => conn.query<Record<string, unknown>>(q),
          queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
        },
        `SELECT ${fields} FROM ${object}${where}`,
      );
      return records;
    }
  };
}

/** Run one sync from the given command line; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  const log = (line: string): void => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  log(`sandforge-sync  ${args.source} -> ${args.target}`);
  log(`objects: ${args.objects.map((o) => o.objectApiName).join(', ')}`);

  const sourceConn = makeConn(await loadOrg(args.source));
  const targetConn = makeConn(await loadOrg(args.target));
  const config = buildConfig(args);

  // One describe of the target per object, kept for the run.
  const targetFieldsByObject = new Map<string, TargetWriteFields>();
  const controller = new AbortController();
  const writer = new BulkDataWriter({
    connection: targetConn,
    bulkExecutor: new BulkApiExecutor(),
    bulkManager: new BulkApiManager(),
    retryConfig: {},
    signal: controller.signal,
    onProgress: (processed, total, label) => log(`  ${label}: ${processed}/${total}`),
    log,
  });

  // A dry run reads, maps and transforms exactly as a real one does, and then
  // reports what it would have written. Anything short of that would test a
  // different code path from the one that matters.
  const write = async (
    kind: 'insert' | 'update' | 'upsert' | 'delete',
    objectName: string,
    records: Record<string, unknown>[] | string[],
    externalIdField?: string,
  ): Promise<OperationOutcome[]> => {
    if (args.dryRun) {
      log(`  [dry-run] ${kind} ${objectName}: ${records.length} record(s)`);
      return records.map(() => ({ id: '', success: true, errors: [] }));
    }
    if (kind === 'delete') return writer.delete(objectName, records as string[], args.batchSize);
    if (kind === 'upsert') {
      return writer.upsert(
        objectName,
        externalIdField ?? 'Id',
        records as Record<string, unknown>[],
        args.batchSize,
      );
    }
    if (kind === 'update') {
      return writer.update(objectName, records as Record<string, unknown>[], args.batchSize);
    }
    return writer.insert(objectName, records as Record<string, unknown>[], args.batchSize);
  };

  const orchestrator = new SyncOrchestrator({
    dataSync: new DataSync({
      insert: (objectName, records) => write('insert', objectName, records),
      update: (objectName, records) => write('update', objectName, records),
      upsert: (objectName, externalIdField, records) =>
        write('upsert', objectName, records, externalIdField),
      delete: (objectName, recordIds) => write('delete', objectName, recordIds),
      describeTargetFields: async (objectApiName) => {
        const cached = targetFieldsByObject.get(objectApiName);
        if (cached) return cached;
        const described = await targetConn.sobject(objectApiName).describe();
        // Fields and record types from the one describe, as the panel reads them.
        const answer = targetWriteFieldsOf(described);
        targetFieldsByObject.set(objectApiName, answer);
        return answer;
      },
    }),
    // The panel wires no metadata source either: a data sync deploys nothing.
    metadataSync: new MetadataSync({
      fetchMetadata: async () => [],
      deployMetadata: async () => [],
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    incrementalTracker: new IncrementalTracker(),
    querySource: buildQueryFn(sourceConn),
    queryTarget: buildQueryFn(targetConn),
  });

  log(args.dryRun ? '\nexecuting… (DRY-RUN)' : '\nexecuting… (REAL)');
  const result = await orchestrator.execute(config);
  const elapsedMs = Date.now() - t0;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-sync', source: args.source, target: args.target, dryRun: args.dryRun, result, elapsedMs }, null, 2)}\n`,
    );
    return;
  }

  const objects = (result as { objectResults?: unknown[] }).objectResults ?? [];
  log(`\nstatus:  ${(result as { status?: string }).status ?? 'unknown'}`);
  for (const entry of objects as Array<Record<string, unknown>>) {
    const failed = Number(entry.failed ?? 0);
    log(
      `  ${String(entry.objectApiName)}: ${String(entry.processed ?? 0)} processed, ` +
        `${String(entry.success ?? 0)} succeeded, ${failed} failed, ` +
        `${String(entry.skipped ?? 0)} skipped`,
    );
    // `errors` is a list of strings on SyncObjectResult, not of objects.
    const errors = (entry.errors as string[] | undefined) ?? [];
    for (const error of errors.slice(0, 3)) log(`      ${error}`);
  }
  log(`\ndone in ${elapsedMs}ms`);
}

// `tsx` runs this file directly; the import check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-sync')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { jsforce };
