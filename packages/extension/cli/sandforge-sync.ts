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
 * A run printed with `--json` and saved to a file can be taken back:
 * `--remove` deletes from its target what the run created — the records it
 * inserted, or upserted where the target held none — with the removal the
 * panel runs, from the summary alone.
 *
 * A configuration saved as the panel saves one runs with `--config-file`,
 * kept between runs in the directory `--store` names with its watermarks and
 * the files it copied, as the panel keeps them beside it: its second run in
 * delta mode reads only what the source changed since the first.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-sync.ts \
 *     --source SRC --target TGT --object Account --object Contact
 *   pnpm exec tsx packages/extension/cli/sandforge-sync.ts \
 *     --config-file <config.json> --store <dir> --source SRC --target TGT
 *   pnpm exec tsx packages/extension/cli/sandforge-sync.ts \
 *     --remove <summary.json> --target TGT [--include-changed] [--store <dir>] [--json]
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jsforce from 'jsforce';
import type { Connection } from 'jsforce';
import { z } from 'zod';
import type {
  CurrencyReplaced,
  PriceCurrencySettled,
  ForgeContactPointsReport,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  SyncConfig,
  SyncDeltaOutcome,
  SyncObjectConfig,
  SyncObjectResult,
  SyncRemovalResult,
  SyncSimulationResult,
  SyncWriteCheck,
} from '@sandforge/shared';
import { guardTierOf, isDeveloperEdition, orgTypeOf, recordWriteHeaders } from '@sandforge/shared';
import {
  orgFileCopyDeps,
  targetAllowsDeletes,
  type FileCopyOrg,
  type SyncCopiedFile,
  type SyncFileDeps,
  type SyncFileStore,
} from '../src/modules/sync/SyncFiles.js';
import { toSaveOutcomes } from '../src/core/common/existingRecordMatch.js';
import { ProductionGuard } from '../src/core/precheck/ProductionGuard.js';
import { SyncConfigStore } from '../src/modules/sync/SyncConfigStore.js';
import { nodeSyncIdMap, savedConfigIdMap } from '../src/modules/sync/SyncIdMap.js';
import { fileConfigStore } from './fileConfigStore.js';
import type { OperationOutcome } from '../src/modules/sync/DataSync.js';
import { removalOrg } from '../src/modules/forge/ForgeRunRemoval.js';
import { removeSyncRun } from '../src/modules/sync/SyncRunRemoval.js';
import {
  readRemovalState,
  syncRemovalPlan,
  type SyncCreationRecorder,
  type SyncRunKept,
  type SyncRunRemovalState,
} from '../src/modules/sync/SyncRunCreations.js';
import { loadOrg, makeConn } from './sfSession.js';
import { SyncOrchestrator, type SourceRead } from '../src/modules/sync/SyncOrchestrator.js';
import { orgDeltaReads, sourceReadWhere } from '../src/modules/sync/SyncDelta.js';
import { DataSync } from '../src/modules/sync/DataSync.js';
import {
  targetWriteFieldsOf,
  type TargetWriteFields,
} from '../src/modules/sync/targetWriteFields.js';
import { ConflictResolver } from '../src/modules/sync/ConflictResolver.js';
import { FieldMappingService } from '../src/modules/sync/FieldMapping.js';
import { TransformPipeline } from '../src/modules/sync/TransformPipeline.js';
import { targetLookup } from '../src/modules/sync/SyncSimulation.js';
import { readSyncRecordTypes } from '../src/modules/sync/syncRecordTypes.js';
import {
  describeCurrencyReplaced,
  readRunCurrencies,
} from '../src/core/common/recordCurrencies.js';
import {
  readStandardPricebooks,
  STANDARD_PRICEBOOK_MATCHED_NOTE,
} from '../src/modules/sync/syncPrices.js';
import { describeSettledPrices } from '../src/modules/forge/stages/PriceCurrencies.js';
import {
  cannotCopyMessage,
  syncCannotCopy,
  syncExecutePayloadSchema,
} from '../src/bridge/validatePayload.js';
import { BulkDataWriter } from '../src/modules/sync/BulkDataWriter.js';
import { BulkApiExecutor } from '../src/core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../src/core/engine/BulkApiManager.js';
import { queryAllPages } from '../src/modules/forge/queryAllPages.js';
import {
  toolingQueriesOver,
  toolingValidationRules,
} from '../src/modules/forge/TargetGapReader.js';
import { toolingRetrievesOver } from '../src/modules/forge/TargetAutomationReader.js';
import {
  DEFAULT_CONFIRM_ABOVE_RECORDS,
  formatMB,
  readDataStorage,
  readEmailLimits,
} from '../src/modules/forge/ForgeRunGate.js';
import {
  gateSyncWrite,
  measureSyncWrite,
  type SyncWriteGate,
  type SyncWriteMeasures,
} from '../src/modules/sync/SyncRunGate.js';
import { SyncRunRefused } from '../src/modules/sync/SyncRunFailure.js';
import { targetAutomationReader } from './sandforge-clone.js';

const HELP = `sandforge-sync — run a Sync between two orgs, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-sync.ts \\
    --source <alias> --target <alias> --object <ApiName> [options]

Required:
  --source <alias>       sf CLI alias of the source org
  --target <alias>       sf CLI alias of the target org
  --object <ApiName>     object to sync; repeat for more. The run writes the
                         parents their lookups name first, and keeps the
                         order given otherwise.
                         Append ":<Field>" to match on an external Id, which
                         turns that object's operation into an upsert.

Options:
  --operation <op>       insert | upsert | update       (default: insert)
                         Per-object ":<Field>" wins over this.
  --where <obj=clause>   SOQL WHERE for one object (repeatable)
                         e.g. --where "Account=BillingCountry = 'France'"
  --batch-size <n>       records per write call            (default: 200)
  --dry-run              simulate: read both orgs and say what the run
                         would insert, update, skip or refuse, writing
                         nothing                           (default: off)
  --files                copy the files of the records each object writes:
                         Salesforce Files and legacy attachments, 10 MB each
                         and 100 MB a run at most, as a configuration that
                         copies files does. The command keeps no record of
                         the files it copied: run again, it copies them
                         again                             (default: off)
  --keep-contact-points  write emails and phone numbers as read. Without
                         it, as in the panel, every address is written
                         under .invalid and every phone number as a
                         fictional one                     (default: off)
  --json                 emit the run summary as JSON      (default: off)
                         Saved to a file, it is what --remove takes the
                         run back from: it names what the run created.
  --help                 this text

Run a saved configuration:
  pnpm exec tsx packages/extension/cli/sandforge-sync.ts \\
    --config-file <config.json> --store <dir> --source <alias> --target <alias> \\
    [--dry-run] [--json]

  --config-file <file>   a Sync configuration as the panel saves one, checked
                         as the panel checks it: its objects, filters,
                         mappings, add-ons, mode, and whether it copies files.
                         It runs between the two orgs given, whatever orgs it
                         names. In delta mode, each object reads only what the
                         source changed since its last good run.
  --store <dir>          where the configuration is kept between runs, with
                         its watermarks, the files it copied and which record
                         of the target each source record it wrote became, as
                         the panel keeps them beside it: give every run of it
                         the same directory, and --remove too. A later run
                         points a lookup at the copy an earlier run wrote.
  --object, --where, --operation, --batch-size, --files and
  --keep-contact-points come from the file (keepContactPoints), and are refused
  with it. A legacy attachment the source changed since it was copied is
  replaced, its earlier copy deleted, on a sandbox or a Developer Edition org,
  as in the panel; a production org keeps the copy.

Remove what a run created:
  pnpm exec tsx packages/extension/cli/sandforge-sync.ts \\
    --remove <summary.json> --target <alias> [--include-changed] [--store <dir>] [--json]

  --remove <file>        the summary a run printed with --json, saved to a
                         file. Deletes from the target what the run created:
                         the records it inserted, or upserted where the target
                         held none — never one it updated — the last object
                         written first, into the target's recycle bin.
  --target <alias>       the org the run wrote to, and no other. It must be a
                         sandbox or a Developer Edition org.
  --include-changed      remove also the records changed since the run, which
                         are kept otherwise
  --store <dir>          for a run of a saved configuration: its store, which
                         the removal tells what it took, so that the next
                         delta run reads those objects whole and copies the
                         files it deleted again
  --json                 print the removal as JSON

  What the removal left on the run's records is kept beside the summary, in
  <summary>.removals.json, and the next --remove of that summary reads it.

Before its first write, a run counts the records it writes under each filter,
and is refused, with nothing written, when they would take more data storage
than the target has left, or make the target's automation send more emails
than it has left today; --dry-run says what it would meet. A run of a saved
configuration leaves as they are the records an earlier run of it copied that
are still in the target, and inserts the others.

Exit codes: 0 the run finished (read the summary for per-object failures), or
the removal took every record it set out to; 1 the run or the removal could
not be started, or the run was refused before it wrote anything; 2 a bad
command line, or a summary --remove cannot take a run back from; 3 the removal
left records of the run in the target.
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
  /** Copy the files of the records each object writes. */
  files: boolean;
  /** Write emails and phone numbers as read rather than neutralized. */
  keepContactPoints: boolean;
  json: boolean;
  /** A saved configuration to run instead of the objects of the line. */
  configFile?: string;
  /** Where that configuration is kept between runs. */
  store?: string;
}

/** The flags whose settings a saved configuration carries itself. */
const CONFIG_FILE_SETTINGS: readonly string[] = [
  '--object',
  '--where',
  '--operation',
  '--batch-size',
  '--files',
  '--keep-contact-points',
];

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

  if (has('--config-file')) {
    const configFile = get('--config-file');
    const store = get('--store');
    if (!configFile || !store || !source || !target) {
      process.stderr.write(
        '--config-file wants the file, --store <dir> where it is kept between runs, ' +
          '--source and --target. Run with --help.\n',
      );
      process.exit(2);
    }
    const given = CONFIG_FILE_SETTINGS.filter(has);
    if (given.length > 0) {
      process.stderr.write(
        `--config-file takes its objects, filters and files from the file: ${given.join(', ')} ` +
          'cannot be given with it.\n',
      );
      process.exit(2);
    }
    return {
      source,
      target,
      objects: [],
      operation: 'insert',
      where: {},
      batchSize: 200,
      dryRun: has('--dry-run'),
      files: false,
      keepContactPoints: false,
      json: has('--json'),
      configFile,
      store,
    };
  }
  if (has('--store')) {
    process.stderr.write(
      '--store keeps a saved configuration between runs: give it with --config-file.\n',
    );
    process.exit(2);
  }

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
    // The panel's boundary: the command took User, a history or a file
    // object as it took any other.
    if (syncCannotCopy(objectApiName)) {
      process.stderr.write(`${cannotCopyMessage(objectApiName)}\n`);
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
    files: has('--files'),
    keepContactPoints: has('--keep-contact-points'),
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
    // The panel's defaults for a configuration that copies files.
    ...(args.files ? { files: { maxFileSizeMB: 10, maxRunMB: 100 } } : {}),
    // Absent, the run neutralizes emails and phone numbers, as the panel's does.
    ...(args.keepContactPoints ? { keepContactPoints: true } : {}),
  };
}

/**
 * The configuration a `--config-file` holds, as a run takes it, or why it
 * cannot run: external input, checked as the panel checks a configuration it
 * saves or runs (`syncExecutePayloadSchema`) — a delta configuration that
 * inserts, a script, a strategy no run acts on are refused here as there. It
 * runs between the orgs of the command line, whatever orgs it names, and
 * needs an id, which its watermarks and copied files are kept under.
 */
export function readSavedConfig(
  text: string,
  orgs: { source: string; target: string },
): { config: SyncConfig } | { refusal: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { refusal: 'is not JSON: give a Sync configuration as the panel saves one.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { refusal: 'is not a Sync configuration: it holds no object.' };
  }
  const parsed = syncExecutePayloadSchema.safeParse({
    config: { ...raw, sourceOrgId: orgs.source, targetOrgId: orgs.target },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.slice(1).join('.') || 'configuration';
    return { refusal: `is not a configuration a run takes (${where}: ${issue.message})` };
  }
  const checked = parsed.data.config;
  if (checked.id === undefined) {
    return {
      refusal:
        'names no id: a saved configuration keeps its watermarks and the files it copied ' +
        'under its id.',
    };
  }
  const now = new Date().toISOString();
  return {
    config: {
      ...checked,
      id: checked.id,
      createdAt: checked.createdAt ?? now,
      updatedAt: checked.updatedAt ?? now,
      // The panel's default for an object saved without one.
      objects: checked.objects.map((object) => ({ ...object, batchSize: object.batchSize ?? 200 })),
    } as SyncConfig,
  };
}

/**
 * The store a saved configuration is kept in between runs of the command:
 * the panel's own (`SyncConfigStore`), over a file in `dir`.
 */
export function savedConfigStore(dir: string): SyncConfigStore {
  mkdirSync(dir, { recursive: true });
  return new SyncConfigStore(fileConfigStore(join(dir, 'configStore.json')));
}

/**
 * What a run that copies files reads and writes beside its records, over the
 * two connections: the requests the panel's run sends. A configuration the
 * panel saved keeps which file it copied where, and so does one the command
 * runs from `--config-file`, in its store (`store`); otherwise the command
 * keeps it for the run alone, so a file is never copied twice within it, and
 * copied again by the next run. Exported so it can be tested.
 *
 * @param deletes - Whether Production Guard lets Sync delete in the target
 *   (`targetAllowsDeletes`): then the earlier copy of a legacy attachment the
 *   source changed is deleted once its new copy is written, as the panel's
 *   run deletes it. The command never replaced one, even on a sandbox.
 */
export function cliFileDeps(
  config: Pick<SyncConfig, 'sourceOrgId' | 'targetOrgId'>,
  sourceConn: Connection,
  targetConn: Connection,
  store?: SyncFileStore,
  deletes = false,
): SyncFileDeps {
  const pagesOf = (conn: Connection) => ({
    query: async (q: string) => conn.query<Record<string, unknown>>(q),
    queryMore: async (url: string) => conn.queryMore<Record<string, unknown>>(url),
  });
  const fileOrg = (conn: Connection): FileCopyOrg => ({
    pages: pagesOf(conn),
    transport: conn,
    // The links of a copied file, written as every record write is.
    create: async (objectApiName, records) =>
      conn.sobject(objectApiName).create(records, { headers: recordWriteHeaders() }),
  });
  const copied = new Map<string, SyncCopiedFile>();
  return {
    copy: orgFileCopyDeps({
      [config.sourceOrgId]: fileOrg(sourceConn),
      [config.targetOrgId]: fileOrg(targetConn),
    }),
    // The ids the object's read returns, asked for alone, with its filter.
    sourceIds: async (objectConfig, changedSince) => {
      const object = objectConfig.objectApiName;
      if (!API_NAME_RE.test(object)) throw new Error(`Not an SObject API name: ${object}`);
      const clause = sourceReadWhere(objectConfig.where, changedSince);
      const { records } = await queryAllPages(
        pagesOf(sourceConn),
        `SELECT Id FROM ${object}${clause ? ` WHERE ${clause}` : ''}`,
      );
      return records.flatMap((row) => (typeof row.Id === 'string' ? [row.Id] : []));
    },
    store: store ?? {
      load: () =>
        copied.size === 0
          ? { kind: 'none' }
          : { kind: 'stored', map: { version: 1, entries: [...copied.values()] } },
      record: (_configId, entry) => {
        copied.set(`${entry.sourceOrgId}|${entry.targetOrgId}|${entry.sourceId}`, entry);
      },
    },
    // In one call, as a record delete is, read as the panel reads it.
    ...(deletes
      ? {
          deleteFromTarget: async (objectApiName: string, ids: string[]) =>
            toSaveOutcomes(await targetConn.sobject(objectApiName).destroy(ids), objectApiName).map(
              (outcome) => ({ id: outcome.id, success: outcome.success, errors: outcome.errors }),
            ),
        }
      : {}),
  };
}

/**
 * Whether a run of the command may delete in its target, as the panel's run
 * may (`targetAllowsDeletes`): judged by Production Guard on what the org says
 * it is, typed as the panel types an org it connects (`orgTypeOf`). A sandbox
 * and a Developer Edition org may; a production org may not.
 */
export function cliAllowsDeletes(org: TypedTarget): boolean {
  const orgType = orgTypeOf({ isSandbox: org.sandbox, edition: org.edition });
  return targetAllowsDeletes(new ProductionGuard(), org.id, { orgType });
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
    read?: SourceRead,
  ): Promise<Record<string, unknown>[]> => {
    const object = objectConfig.objectApiName;
    if (!API_NAME_RE.test(object)) throw new Error(`Not an SObject API name: ${object}`);
    // The panel's WHERE: the filter checked as query text, and on a delta
    // read the bound before it.
    const clause = sourceReadWhere(objectConfig.where, read?.changedSince);
    const where = clause ? ` WHERE ${clause}` : '';
    const pages = {
      query: async (q: string) => conn.query<Record<string, unknown>>(q),
      queryMore: async (url: string) => conn.queryMore<Record<string, unknown>>(url),
    };
    const answer = (paged: { records: Record<string, unknown>[]; truncated: boolean }) => {
      if (paged.truncated) read?.onBoundReached?.();
      return paged.records;
    };
    try {
      // No LIMIT, as the panel asks: Salesforce answers FIELDS(ALL) only under
      // a LIMIT of 200 at most, and asked so the command synced the first 200
      // rows of every object without a word. Refused, the read goes on by name.
      return answer(await queryAllPages(pages, `SELECT FIELDS(ALL) FROM ${object}${where}`));
    } catch {
      const described = await conn.sobject(object).describe();
      const fields = described.fields
        .filter((f) => f.type !== 'address' && f.type !== 'location')
        .map((f) => f.name)
        .join(', ');
      // Asked by name with no LIMIT, the rows come a page of 2 000 at most at
      // a time: every page is read, as the panel reads them.
      return answer(await queryAllPages(pages, `SELECT ${fields} FROM ${object}${where}`));
    }
  };
}

/**
 * What the records each object's read returns are counted with before the
 * first write, as the panel counts them: `COUNT()` under the same filter,
 * and on a delta read the same bound.
 */
export function cliCountFn(conn: Connection) {
  return async (
    _orgId: string,
    objectConfig: SyncObjectConfig,
    read?: SourceRead,
  ): Promise<number> => {
    const object = objectConfig.objectApiName;
    if (!API_NAME_RE.test(object)) throw new Error(`Not an SObject API name: ${object}`);
    const clause = sourceReadWhere(objectConfig.where, read?.changedSince);
    return (await conn.query(`SELECT COUNT() FROM ${object}${clause ? ` WHERE ${clause}` : ''}`))
      .totalSize;
  };
}

/**
 * Of an account's or a contact's records under the filter, those of person
 * accounts, as the panel counts them: none in an org without them.
 */
export function cliPersonAccountsFn(conn: Connection) {
  return async (objectConfig: SyncObjectConfig, read?: SourceRead): Promise<number> => {
    const object = objectConfig.objectApiName;
    if (!API_NAME_RE.test(object)) return 0;
    const clause = sourceReadWhere(objectConfig.where, read?.changedSince);
    try {
      return (
        await conn.query(
          `SELECT COUNT() FROM ${object} WHERE IsPersonAccount = true` +
            (clause ? ` AND (${clause})` : ''),
        )
      ).totalSize;
    } catch {
      return 0;
    }
  };
}

/** The ids an object's read returns, asked for alone under the same filter, as the panel asks them. */
export function cliSourceIdsFn(conn: Connection) {
  return async (objectConfig: SyncObjectConfig): Promise<string[]> => {
    const object = objectConfig.objectApiName;
    if (!API_NAME_RE.test(object)) throw new Error(`Not an SObject API name: ${object}`);
    const clause = sourceReadWhere(objectConfig.where, undefined);
    const { records } = await queryAllPages(
      {
        query: async (q: string) => conn.query<Record<string, unknown>>(q),
        queryMore: async (url: string) => conn.queryMore<Record<string, unknown>>(url),
      },
      `SELECT Id FROM ${object}${clause ? ` WHERE ${clause}` : ''}`,
    );
    return records.flatMap((row) => (typeof row.Id === 'string' ? [row.Id] : []));
  };
}

/** How each daily email limit is said. */
const EMAIL_LIMIT_WORDS: Readonly<Record<SyncWriteCheck['emails'][number]['limit'], string>> = {
  SingleEmail: 'single emails',
  DailyWorkflowEmails: 'workflow emails',
};

/**
 * What the command says of the records a run writes, before its first write
 * or in a simulation: how many per object, the records an earlier run copied
 * left as they are, the data storage they take, and the emails the target's
 * automation sends for them, against what the target has left.
 */
export function writeCheckLines(check: SyncWriteCheck, target: string): string[] {
  const lines = [
    `write gate: ${check.total} record(s) to write to ${target}, about ` +
      `${formatMB(check.storage.estimateMB)} MB of data storage`,
  ];
  for (const object of check.objects) {
    lines.push(`  ${object.objectApiName.padEnd(42)}${String(object.rows).padStart(8)}`);
  }
  if (check.alreadyCopied > 0) {
    lines.push(
      `  not counted: ${check.alreadyCopied} record(s) an earlier run of this configuration ` +
        'copied, still in the target, left as they are',
    );
  }
  const { storage } = check;
  if (storage.verdict === 'unread') {
    lines.push(
      `  the data storage ${target} has left could not be read (${storage.unread ?? ''}): ` +
        'whether the records fit is not known',
    );
  } else if (storage.remainingMB !== undefined && storage.maxMB !== undefined) {
    lines.push(
      `  data storage of ${target}: ${storage.remainingMB} MB left of ${storage.maxMB} MB` +
        (storage.verdict === 'exceeds'
          ? ': the records do not fit'
          : storage.verdict === 'near'
            ? ': the records take more than 80 % of it'
            : ''),
    );
  }
  for (const email of check.emails) {
    const per = email.objects.map((o) => `${o.perRecord} per ${o.objectApiName}`).join('; ');
    const sent =
      `  emails: these records make ${target} send about ${email.emails} ` +
      `${EMAIL_LIMIT_WORDS[email.limit]} (${per})` +
      (email.alertsCounted
        ? ', its email alerts among them, as a Developer Edition counts them'
        : '');
    lines.push(
      email.verdict === 'unread'
        ? `${sent}; what it has left today could not be read (${email.unread ?? ''})`
        : email.verdict === 'fits'
          ? `${sent}; it has ${email.remaining ?? '?'} of ${email.max ?? '?'} left today`
          : `${sent}, more than the ${email.remaining ?? '?'} of ${email.max ?? '?'} it has left today`,
    );
  }
  if (check.emailsUnread !== undefined) {
    lines.push(`  emails: not counted, ${check.emailsUnread} could not be read`);
  }
  if (check.aboveRecords !== undefined) {
    lines.push(
      `  more than ${check.aboveRecords} records: the panel asks before it writes ` +
        '(sandforge.safety.confirmAboveRecords)',
    );
  }
  return lines;
}

/** What a simulation found, as the lines the command prints. */
export function simulationLines(simulation: SyncSimulationResult, target = 'the target'): string[] {
  const lines = [`\nsimulation: ${simulation.objects.length} object(s), nothing written`];
  // The order the run writes the objects in, and what moved.
  if (simulation.writeOrder) {
    lines.push(`  write order: ${simulation.writeOrder.objects.join(', ')}`);
    for (const moved of simulation.writeOrder.moved) {
      lines.push(`    ${moved.objectApiName} after ${moved.after}: its ${moved.field} names one`);
    }
    for (const cycle of simulation.writeOrder.cycles) {
      lines.push(
        `    ${cycle.join(', ')} name each other: in this order, the lookup at the one ` +
          'written later is left empty',
      );
    }
  }
  if (simulation.writeCheck) {
    for (const line of writeCheckLines(simulation.writeCheck, target)) lines.push(`  ${line}`);
    if (simulation.writeCheck.verdict === 'refused') {
      lines.push('    a run would be refused before it writes: the records do not fit');
    }
    const over = simulation.writeCheck.emails.some((email) => email.verdict === 'exceeds');
    if (simulation.writeCheck.verdict !== 'refused' && over) {
      lines.push(
        '    a run of the command would be refused before it writes: past a daily email limit',
      );
    }
  }
  if (simulation.writeCheckUnread !== undefined) {
    lines.push(`  the records to write could not be counted: ${simulation.writeCheckUnread}`);
  }
  for (const o of simulation.objects) {
    lines.push(
      `  ${o.objectApiName} (${o.operation}): ${o.read} read, would insert ${o.insert}, ` +
        `update ${o.update}, delete ${o.delete}, skip ${o.skipped}, refuse ${o.refused}` +
        (simulation.direction === 'bidirectional' ? `, ${o.conflicts} in conflict` : ''),
    );
    if (o.alreadyCopied !== undefined) {
      lines.push(
        `      ${o.alreadyCopied} already copied by an earlier run of this configuration, ` +
          'left as they are',
      );
    }
    if (o.conflictFields.length > 0) lines.push(`      differ on: ${o.conflictFields.join(', ')}`);
    if (o.files) {
      lines.push(
        `      files: would copy ${o.files.copied}, add ${o.files.versions} version(s), ` +
          `${o.files.unchanged} unchanged, ${o.files.tooLarge + o.files.pastRunCap} skipped past the caps`,
      );
    }
    for (const note of o.notes) lines.push(`      ${note}`);
    // What the counts above cannot say: a record one of these refuses is
    // counted as written.
    if (o.validationRules && o.validationRules.length > 0) {
      lines.push(
        `      ${o.validationRules.length} active validation rule(s) of the target, which a ` +
          'simulation cannot evaluate — a record one of them refuses is counted as written:',
      );
      for (const rule of o.validationRules) {
        lines.push(
          `        ${rule.name}${rule.field ? ` (${rule.field})` : ''}: ${rule.message || '(no message)'}`,
        );
      }
    }
  }
  if (simulation.validationRulesUnread) {
    lines.push(
      `  the target's validation rules could not be listed (${simulation.validationRulesUnread}): ` +
        'any of them may refuse a record counted as written',
    );
  }
  if (simulation.cancelled) lines.push('  stopped by a cancel before its last object');
  if (simulation.error) {
    lines.push(`  stopped at ${simulation.failedObject ?? 'an object'}: ${simulation.error}`);
  }
  return lines;
}

/** A line of an object's result on what its write held back or sent without a field. */
const SAID_ONCE =
  /^(PARENT_REFUSED|RECORD_TYPE_UNAVAILABLE|RECORD_TYPE_UNMAPPED):|^\d+ record\(s\) written again without /;

/**
 * The lines the command prints of an object's errors: its first three, and
 * each line on what the write held back or wrote without a field — said once
 * for every record it is about, after the refusals of each record.
 */
export function objectErrorLines(errors: readonly string[]): string[] {
  const lines = errors.slice(0, 3);
  for (const error of errors.slice(3)) if (SAID_ONCE.test(error)) lines.push(error);
  return lines;
}

/**
 * The lines the command prints of what an object's write did that no refusal
 * says: the records linked to one the target holds rather than written, and
 * those written without lookups they held, with why. Every one, however many
 * refusals the object had.
 */
export function objectWrittenLines(
  result: Pick<SyncObjectResult, 'linkedToExisting' | 'lookupsLeftOut'>,
): string[] {
  const lines: string[] = [];
  const linked = result.linkedToExisting;
  if (linked) {
    lines.push(
      `${linked.records} record(s) linked to a record the target holds, not written: the ` +
        `target refused them as a duplicate of it${linked.refusal ? ` (${linked.refusal})` : ''}; ` +
        'what the run writes under them points at that record.',
    );
  }
  for (const { records, fields, reason } of result.lookupsLeftOut ?? []) {
    lines.push(
      reason === 'ownerRefusedEarlier'
        ? `${records} record(s) written without ${fields.join(', ')}, left out from the start: ` +
            'the target refused the same owner earlier in this run, an id from the source org ' +
            'that the target does not have.'
        : `${records} record(s) written without ${fields.join(', ')}: the lookup held an id ` +
            'from the source org that the target does not have.',
    );
  }
  return lines;
}

/**
 * The lines the command prints of what the run did with the emails and phone
 * numbers it wrote: how many it neutralized, field by field, or that it kept
 * them as read. Nothing when it neutralized none.
 */
export function contactPointLines(report: ForgeContactPointsReport | undefined): string[] {
  if (!report) return [];
  if (!report.neutralized) {
    return [
      "emails and phone numbers: written as read (--keep-contact-points): the target's " +
        'automation may have emailed or texted the people the records name',
    ];
  }
  return [
    `emails and phone numbers: ${report.values} value(s) in ${report.fields.length} field(s) ` +
      "neutralized, addresses under .invalid and numbers fictional, so the target's automation " +
      'reaches no one',
    ...report.fields.map(
      ({ objectApiName, field, values }) => `  ${objectApiName}.${field}  ${values}`,
    ),
    ...(report.numbersExhausted
      ? [
          `  ${report.numbersExhausted} phone number(s) left out, their field empty: the 10 000 ` +
            'fictional numbers were all given to other numbers of the run',
        ]
      : []),
  ];
}

/**
 * The lines the command prints of the rows an object's write sent in
 * another currency than it read them in: every one, however many refusals
 * the object had.
 */
export function objectCurrencyLines(currencies: readonly CurrencyReplaced[] | undefined): string[] {
  return (currencies ?? []).map((entry) => `${describeCurrencyReplaced(entry)}.`);
}

/**
 * The lines the command prints of the prices an object's write read in a
 * currency the target does not hold active, and how each went, after the
 * standard price book matched when the write left it out: none of them a
 * refusal, said after the refusals.
 */
export function objectPriceLines(
  prices: readonly PriceCurrencySettled[] | undefined,
  standardPricebookMatched = false,
): string[] {
  return [
    ...(standardPricebookMatched ? [STANDARD_PRICEBOOK_MATCHED_NOTE] : []),
    ...describeSettledPrices(prices ?? []).map((sentence) => `${sentence}.`),
  ];
}

/** How an object of a delta configuration was read, as the line the command prints. */
export function deltaLine(delta: SyncDeltaOutcome): string {
  const read =
    delta.read === 'delta'
      ? `delta: ${delta.changed} record(s) changed since ${delta.since ?? 'the last run'}`
      : `delta: read whole (${delta.reason ?? 'no watermark'}), ${delta.changed} record(s)`;
  const deletions = delta.deletionsChecked
    ? `, ${delta.deleted} deleted as the source deleted them` +
      (delta.deleteFailed > 0 ? `, ${delta.deleteFailed} refused` : '')
    : '';
  const mark =
    delta.recorded !== undefined
      ? '; watermark recorded'
      : '; watermark kept as it was: the next run reads from the same point';
  return `${read}${deletions}${mark}`;
}

/** What a run created, kept in memory as it writes it, for its summary. */
export function memoryCreations(runId: string): SyncCreationRecorder & {
  /** Per object in the order first written, each id once. */
  created(): Array<{ objectApiName: string; ids: string[] }>;
  /** When the run last wrote something it created. */
  lastWrittenAt(): string | undefined;
} {
  const byObject = new Map<string, string[]>();
  let last: string | undefined;
  return {
    runId,
    note: (objectApiName, ids) => {
      if (ids.length === 0) return;
      byObject.set(objectApiName, [...(byObject.get(objectApiName) ?? []), ...ids]);
      last = new Date().toISOString();
    },
    flush: async () => undefined,
    created: () => [...byObject].map(([objectApiName, ids]) => ({ objectApiName, ids: [...ids] })),
    lastWrittenAt: () => last,
  };
}

/** The org's own id, or undefined when it does not say. */
async function organizationIdOf(conn: Connection): Promise<string | undefined> {
  try {
    const answer = await conn.query<{ Id?: string }>('SELECT Id FROM Organization LIMIT 1');
    const id = answer.records[0]?.Id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Run one sync from the given command line; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.slice(2).includes('--remove')) return removeMain(argv);
  const t0 = Date.now();
  const args = parseArgs(argv);
  const log = (line: string): void => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  // A saved configuration is read and checked before any org is contacted,
  // and kept in its store before it runs, as the panel's Save keeps it: its
  // watermarks and copied files are kept beside it, and only for a saved one.
  let config: SyncConfig;
  let saved: SyncConfigStore | undefined;
  if (args.configFile !== undefined && args.store !== undefined) {
    let text: string;
    try {
      text = readFileSync(args.configFile, 'utf8');
    } catch (err: unknown) {
      process.stderr.write(
        `--config-file ${args.configFile} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
    const read = readSavedConfig(text, args);
    if ('refusal' in read) {
      process.stderr.write(`--config-file ${args.configFile} ${read.refusal}\n`);
      process.exit(2);
    }
    config = read.config;
    saved = savedConfigStore(args.store);
    saved.save(config);
  } else {
    config = buildConfig(args);
  }

  log(`sandforge-sync  ${args.source} -> ${args.target}`);
  log(
    `objects: ${config.objects.map((o) => o.objectApiName).join(', ')}` +
      (saved ? `  (configuration ${config.id}, ${config.mode})` : ''),
  );

  const sourceConn = makeConn(await loadOrg(args.source));
  const targetConn = makeConn(await loadOrg(args.target));

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

  // A dry run is the panel's simulation: the same reads, mappings and
  // transforms, then the target asked which records it holds. It never
  // reaches the writer, which refuses to write if anything ever tried.
  // Answering every record "written" instead told nothing a run would not.
  // Each object's batch size, as the engine hands it: the line's for every
  // object of a line, each object's own for a saved configuration.
  const write = async (
    kind: 'insert' | 'update' | 'upsert' | 'delete',
    objectName: string,
    records: Record<string, unknown>[] | string[],
    batchSize: number,
    externalIdField?: string,
  ): Promise<OperationOutcome[]> => {
    if (args.dryRun) throw new Error(`A dry run writes nothing: ${kind} ${objectName} refused.`);
    if (kind === 'delete') return writer.delete(objectName, records as string[], batchSize);
    if (kind === 'upsert') {
      return writer.upsert(
        objectName,
        externalIdField ?? 'Id',
        records as Record<string, unknown>[],
        batchSize,
      );
    }
    if (kind === 'update') {
      return writer.update(objectName, records as Record<string, unknown>[], batchSize);
    }
    return writer.insert(objectName, records as Record<string, unknown>[], batchSize);
  };

  const describeTargetFields = async (objectApiName: string): Promise<TargetWriteFields> => {
    const cached = targetFieldsByObject.get(objectApiName);
    if (cached) return cached;
    const described = await targetConn.sobject(objectApiName).describe();
    // Fields and record types from the one describe, as the panel reads them.
    const answer = targetWriteFieldsOf(described);
    targetFieldsByObject.set(objectApiName, answer);
    return answer;
  };

  // What a real run creates, for its summary to name and --remove to take back.
  const kept = memoryCreations(`sandforge-sync-${randomUUID()}`);
  const startedAt = new Date().toISOString();

  // Held, before its first write, to what the target has left of its data
  // storage and of its daily emails, as a clone is: refused past either, with
  // nothing written. Sync wrote until the target refused its records one by
  // one; a dry run says what the run would meet.
  const measures: SyncWriteMeasures = {
    readStorage: () => readDataStorage(targetConn),
    readAutomation: (objects) => targetAutomationReader(targetConn).read(args.target, objects),
    readLimits: () => readEmailLimits(targetConn),
    confirmAboveRecords: DEFAULT_CONFIRM_ABOVE_RECORDS,
  };
  const orgTier = await typeTarget(targetConn).then(
    (org) =>
      guardTierOf({
        orgType: orgTypeOf({ isSandbox: org.sandbox, edition: org.edition }),
        metadata: { edition: org.edition },
      }),
    () => 'production' as const,
  );
  /** What the gate measured of the run, for its summary. */
  let gateCheck: SyncWriteCheck | undefined;
  const writeGate: SyncWriteGate = {
    measure: async (counted) => (await measureSyncWrite(counted, measures)).check,
    hold: async (counted) => {
      const measured = await measureSyncWrite(counted, measures);
      gateCheck = measured.check;
      log('');
      for (const line of writeCheckLines(measured.check, args.target)) log(line);
      return {
        check: measured.check,
        answer: await gateSyncWrite(measured, {
          policy: 'refuse',
          org: args.target,
          orgTier,
        }),
      };
    },
  };

  // A configuration that copies files replaces a changed attachment where
  // Production Guard lets Sync delete in the target, as the panel's run does:
  // judged on what the org says it is, nowhere when it will not say. A dry run
  // finds the files as the run would, deleting none.
  let fileDeps: SyncFileDeps | undefined;
  if (config.files !== undefined) {
    const deletes = await typeTarget(targetConn).then(cliAllowsDeletes, () => false);
    fileDeps = cliFileDeps(config, sourceConn, targetConn, saved?.fileStore(), deletes);
    if (args.dryRun && fileDeps.deleteFromTarget) {
      fileDeps = {
        ...fileDeps,
        deleteFromTarget: async (objectApiName) => {
          throw new Error(`A dry run writes nothing: delete ${objectApiName} refused.`);
        },
      };
    }
  }

  const orchestrator = new SyncOrchestrator({
    ...(args.dryRun ? {} : { creations: kept }),
    ...(fileDeps ? { files: fileDeps } : {}),
    // A saved configuration's watermarks, kept in its store, and what a delta
    // run asks both orgs beside its reads: the panel's. And which record of
    // the target each record its runs wrote became, which a later run points
    // its lookups by.
    ...(saved && args.store !== undefined
      ? {
          idMap: savedConfigIdMap(nodeSyncIdMap(args.store), (configId) => saved.isSaved(configId)),
        }
      : {}),
    ...(saved
      ? {
          deltaStore: saved.deltaStore(),
          deltaReads: orgDeltaReads(
            {
              query: async (q, options) => sourceConn.query<Record<string, unknown>>(q, options),
              queryMore: async (url) => sourceConn.queryMore<Record<string, unknown>>(url),
            },
            {
              query: async (q) => targetConn.query<Record<string, unknown>>(q),
              queryMore: async (url) => targetConn.queryMore<Record<string, unknown>>(url),
            },
            controller.signal,
          ),
        }
      : {}),
    dataSync: new DataSync({
      insert: (objectName, records, batchSize) => write('insert', objectName, records, batchSize),
      update: (objectName, records, batchSize) => write('update', objectName, records, batchSize),
      upsert: (objectName, externalIdField, records, batchSize) =>
        write('upsert', objectName, records, batchSize, externalIdField),
      delete: (objectName, recordIds, batchSize) =>
        write('delete', objectName, recordIds, batchSize),
      describeTargetFields,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: buildQueryFn(sourceConn),
    queryTarget: buildQueryFn(targetConn),
    findInTarget: targetLookup({
      query: async (q) => targetConn.query<Record<string, unknown>>(q),
      queryMore: async (url) => targetConn.queryMore<Record<string, unknown>>(url),
    }),
    // The parents its objects' lookups name written first.
    describeTargetFields,
    // What it writes, counted before the first write and held to the gate,
    // and what an earlier run of a saved configuration copied, left as it is.
    countSource: cliCountFn(sourceConn),
    countPersonAccounts: cliPersonAccountsFn(sourceConn),
    readSourceIds: cliSourceIdsFn(sourceConn),
    writeGate,
    // What a simulation cannot evaluate, listed beside what it predicts: the
    // target's validation rules, as the panel reads them, each with its field
    // read back from the label a French org answers, and its formula, so an
    // insert's caveat leaves out the rules that refuse only a change.
    readValidationRules: toolingValidationRules(
      async (soql) =>
        (
          await queryAllPages<Record<string, unknown>>(
            {
              query: async (q) => targetConn.tooling.query<Record<string, unknown>>(q),
              queryMore: async (url) => targetConn.tooling.queryMore<Record<string, unknown>>(url),
            },
            soql,
          )
        ).records,
      toolingQueriesOver(targetConn),
      toolingRetrievesOver(targetConn),
    ),
    // Both orgs' currencies, as the panel reads them: a row in one the target
    // does not hold active goes in its corporate currency, its amounts
    // converted at the source's rates.
    currencies: () =>
      readRunCurrencies(
        async (soql) => (await sourceConn.query<Record<string, unknown>>(soql)).records,
        async (soql) => (await targetConn.query<Record<string, unknown>>(soql)).records,
        {
          source: async (soql) =>
            (await sourceConn.tooling.query<Record<string, unknown>>(soql)).records,
          target: async (soql) =>
            (await targetConn.tooling.query<Record<string, unknown>>(soql)).records,
        },
      ),
    // Both orgs' standard price books, as the panel reads them: the source's
    // matched to the target's, and the prices written as the platform takes
    // them.
    standardPricebooks: () =>
      readStandardPricebooks(
        async (soql) => (await sourceConn.query<Record<string, unknown>>(soql)).records,
        async (soql) => (await targetConn.query<Record<string, unknown>>(soql)).records,
      ),
    // Both orgs' record types, as the panel reads them: a record's type is
    // mapped to the target's of the same object and API name.
    recordTypes: () =>
      readSyncRecordTypes(
        {
          query: async (q) => sourceConn.query<Record<string, unknown>>(q),
          queryMore: async (url) => sourceConn.queryMore<Record<string, unknown>>(url),
        },
        {
          query: async (q) => targetConn.query<Record<string, unknown>>(q),
          queryMore: async (url) => targetConn.queryMore<Record<string, unknown>>(url),
        },
      ),
  });

  if (args.dryRun) {
    log('\nsimulating… (DRY-RUN: nothing is written)');
    const simulation = await orchestrator.simulate(config);
    const elapsed = Date.now() - t0;
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ tool: 'sandforge-sync', source: args.source, target: args.target, dryRun: true, simulation, elapsedMs: elapsed }, null, 2)}\n`,
      );
      return;
    }
    for (const line of simulationLines(simulation, args.target)) log(line);
    log(`\ndone in ${elapsed}ms`);
    return;
  }

  log('\nexecuting… (REAL)');
  let result: Awaited<ReturnType<typeof orchestrator.execute>>;
  try {
    result = await orchestrator.execute(config);
  } catch (err: unknown) {
    // Refused before its first write: nothing was written.
    if (!(err instanceof SyncRunRefused)) throw err;
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'sandforge-sync',
            source: args.source,
            target: args.target,
            dryRun: false,
            refused: { code: err.code, message: err.message },
            ...(gateCheck ? { writeCheck: gateCheck } : {}),
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      log(`\nrefused (${err.code}): ${err.message}`);
    }
    process.exit(1);
  }
  const elapsedMs = Date.now() - t0;
  const created = kept.created();
  const lastWrittenAt = kept.lastWrittenAt();
  // The org's own id, so --remove takes the run back from it and no other,
  // whatever alias names it then.
  const targetOrgId = created.length > 0 ? await organizationIdOf(targetConn) : undefined;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'sandforge-sync',
          source: args.source,
          target: args.target,
          ...(targetOrgId ? { targetOrgId } : {}),
          // The saved configuration that ran: --remove tells its store.
          ...(saved ? { configId: config.id } : {}),
          dryRun: args.dryRun,
          startedAt,
          finishedAt: new Date().toISOString(),
          result,
          created: {
            runId: kept.runId,
            ...(lastWrittenAt ? { lastWrittenAt } : {}),
            objects: created,
          },
          elapsedMs,
        },
        null,
        2,
      )}\n`,
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
    // Not inserted a second time: an earlier run of the configuration copied them.
    if (typeof entry.alreadyCopied === 'number') {
      log(
        `      ${entry.alreadyCopied} already copied by an earlier run of this configuration, ` +
          'left as they are',
      );
    }
    // `errors` is a list of strings on SyncObjectResult, not of objects: the
    // first refusals, and every line on what the run held back or wrote
    // without a field, which a refusal per record would push out of sight.
    for (const line of objectErrorLines((entry.errors as string[] | undefined) ?? [])) {
      log(`      ${line}`);
    }
    // The records linked to one the target holds, and those written without
    // a lookup: none of them a refusal, said after the refusals.
    for (const line of objectWrittenLines(entry as Partial<SyncObjectResult>)) {
      log(`      ${line}`);
    }
    // The rows written in another currency, and what became of their amounts.
    for (const line of objectCurrencyLines(
      entry.currenciesReplaced as CurrencyReplaced[] | undefined,
    )) {
      log(`      ${line}`);
    }
    // The standard price book matched, and the prices read in a currency the
    // target lacks and how each went.
    for (const line of objectPriceLines(
      entry.pricesSettled as PriceCurrencySettled[] | undefined,
      entry.standardPricebookMatched === true,
    )) {
      log(`      ${line}`);
    }
    const files = entry.files as
      { copied?: number; versions?: number; failed?: number } | undefined;
    if (files) {
      log(
        `      files: ${files.copied ?? 0} copied, ${files.versions ?? 0} version(s) added, ` +
          `${files.failed ?? 0} failed`,
      );
    }
    const delta = entry.delta as SyncDeltaOutcome | undefined;
    if (delta) log(`      ${deltaLine(delta)}`);
  }
  // Said once for the run, as Forge's command line says it.
  for (const line of contactPointLines(
    (result as { contactPoints?: ForgeContactPointsReport }).contactPoints,
  )) {
    log(`  ${line}`);
  }
  const count = created.reduce((sum, object) => sum + object.ids.length, 0);
  if (count > 0) {
    log(
      `\ncreated ${count} record(s) and file(s) in ${args.target}: run with --json and save the ` +
        'summary to a file, and --remove takes them back from it',
    );
  }
  log(`\ndone in ${elapsedMs}ms`);
}

// ─── --remove ────────────────────────────────────────────────────────────────

/** What `--remove` was given. */
export interface RemoveArgs {
  /** The summary a run printed with `--json`, saved to a file. */
  summaryPath: string;
  /** sf CLI alias of the org the run wrote to. */
  target: string;
  /** Remove also the records changed since the run. */
  includeChanged: boolean;
  /** Print the removal as JSON on stdout, every other line on stderr. */
  json: boolean;
  /** The store of the saved configuration the run was of, which the removal tells. */
  store?: string;
}

/** The flags a removal reads. */
const REMOVE_FLAGS: ReadonlySet<string> = new Set([
  '--remove',
  '--target',
  '--include-changed',
  '--store',
  '--json',
]);
const REMOVE_VALUE_FLAGS: ReadonlySet<string> = new Set(['--remove', '--target', '--store']);

/** Read the command line of a removal, or explain why it cannot be read. */
export function parseRemoveArgs(argv: string[]): RemoveArgs {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (REMOVE_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!REMOVE_FLAGS.has(arg)) {
      process.stderr.write(
        `--remove takes --target, --include-changed, --store and --json, not "${arg}". ` +
          'Run with --help.\n',
      );
      process.exit(2);
    }
  }
  const get = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
  };
  const summaryPath = get('--remove');
  const target = get('--target');
  const store = get('--store');
  if (args.includes('--store') && (!store || REMOVE_FLAGS.has(store))) {
    process.stderr.write('--store wants the directory the configuration of the run is kept in.\n');
    process.exit(2);
  }
  if (!summaryPath || !target || REMOVE_FLAGS.has(summaryPath) || REMOVE_FLAGS.has(target)) {
    process.stderr.write(
      '--remove takes the file a run printed its --json summary to, and --target the org the ' +
        'run wrote to. Run with --help.\n',
    );
    process.exit(2);
  }
  return {
    summaryPath,
    target,
    includeChanged: args.includes('--include-changed'),
    json: args.includes('--json'),
    ...(store !== undefined ? { store } : {}),
  };
}

/** A Salesforce id, as every id a summary names is: they end up in deletes. */
const ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** The summary a run printed with `--json`, as `--remove` reads it: external input. */
const runSummarySchema = z
  .object({
    tool: z.literal('sandforge-sync'),
    source: z.string().min(1),
    target: z.string().min(1),
    targetOrgId: z.string().regex(ID).optional(),
    configId: z.string().min(1).max(200).optional(),
    dryRun: z.boolean().optional(),
    startedAt: z.string().min(1).max(40).optional(),
    finishedAt: z.string().min(1).max(40).optional(),
    result: z.object({ status: z.enum(['success', 'partial', 'failure']) }).loose(),
    created: z
      .object({
        runId: z.string().min(1).max(200),
        lastWrittenAt: z.string().min(1).max(40).optional(),
        objects: z.array(
          z.object({
            objectApiName: z.string().regex(API_NAME_RE),
            ids: z.array(z.string().regex(ID)),
          }),
        ),
      })
      .optional(),
  })
  .loose();

/** A run summary, as `--remove` reads it. */
export type RunSummary = z.infer<typeof runSummarySchema>;

/** The summary in `text`, or why `--remove` cannot take a run back from it. */
export function readRunSummary(text: string): { summary: RunSummary } | { refusal: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { refusal: 'is not JSON: save the output of a run printed with --json.' };
  }
  const parsed = runSummarySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      refusal:
        `is not the summary of a sandforge-sync run (${issue.path.join('.') || 'summary'}: ` +
        `${issue.message}).`,
    };
  }
  if (parsed.data.dryRun === true) {
    return {
      refusal: 'is the summary of a dry run, which wrote nothing: there is nothing to remove.',
    };
  }
  if (!parsed.data.created) {
    return {
      refusal:
        'names nothing the run created: it was printed before runs named what they created, so ' +
        'its records cannot be told from the ones it updated.',
    };
  }
  return { summary: parsed.data };
}

/**
 * Where a removal keeps what it left on the run's records, beside the summary
 * — `run.removals.json` for `run.json` — never the summary itself.
 */
export function removalsPathOf(summaryPath: string): string {
  return /\.json$/i.test(summaryPath)
    ? summaryPath.replace(/\.json$/i, '.removals.json')
    : `${summaryPath}.removals.json`;
}

/** The run a summary names, as the removal reads it. */
export function runOfSummary(summary: RunSummary, removal?: SyncRunRemovalState): SyncRunKept {
  const created = summary.created;
  const finishedAt = summary.finishedAt ?? created?.lastWrittenAt ?? new Date().toISOString();
  return {
    runId: created?.runId ?? 'sandforge-sync',
    configId: summary.configId ?? 'sandforge-sync',
    configName: summary.configId ?? 'sandforge-sync',
    sourceOrgId: summary.source,
    targetOrgId: summary.target,
    startedAt: summary.startedAt ?? finishedAt,
    end: { at: finishedAt, status: summary.result.status },
    ...(created?.lastWrittenAt ? { lastWrittenAt: created.lastWrittenAt } : {}),
    created: (created?.objects ?? []).filter((object) => object.ids.length > 0),
    ...(removal ? { removal } : {}),
  };
}

/** An org as the removal types it: a sandbox, or not and its edition. */
export interface TypedTarget {
  id: string;
  sandbox: boolean;
  edition?: string;
}

/** What the org says it is. `IsSandbox` false and no edition is a production org's. */
export async function typeTarget(conn: Connection): Promise<TypedTarget> {
  const answer = await conn.query<{ Id?: string; IsSandbox?: boolean }>(
    'SELECT Id, IsSandbox FROM Organization LIMIT 1',
  );
  const row = answer.records[0];
  if (typeof row?.Id !== 'string') {
    throw new Error('The org gave no Organization record: whether it is a sandbox cannot be told.');
  }
  if (row.IsSandbox === true) return { id: row.Id, sandbox: true };
  try {
    const typed = await conn.query<{ OrganizationType?: string }>(
      'SELECT OrganizationType FROM Organization LIMIT 1',
    );
    const edition = typed.records[0]?.OrganizationType;
    return typeof edition === 'string' && edition !== ''
      ? { id: row.Id, sandbox: false, edition }
      : { id: row.Id, sandbox: false };
  } catch {
    return { id: row.Id, sandbox: false };
  }
}

/**
 * Why the command will not delete from an org: it is a production org. A
 * sandbox, or a Developer Edition org — which says IsSandbox false and holds
 * nobody's business — is not refused, as the clone command removes from both
 * and the panel's removal takes one for a development org. The command has
 * no guard to ask, and takes the org's own word for what it is.
 *
 * @param tool - The command that refuses: the seed command removes as this one does.
 */
export function removalRefusal(
  alias: string,
  org: TypedTarget,
  tool = 'sandforge-sync',
): string | undefined {
  if (org.sandbox || isDeveloperEdition(org.edition)) return undefined;
  const said = org.edition
    ? `IsSandbox false, edition ${org.edition}`
    : 'IsSandbox false, and no edition';
  return (
    `${alias} is a production org (its Organization record says ${said}): ${tool} ` +
    'removes records from sandboxes and Developer Edition orgs only. Nothing was deleted.'
  );
}

/** What a removal did, as the lines the command prints. */
export function removalSummaryLines(
  status: ForgeUndoStatus,
  objects: readonly ForgeUndoObjectResult[],
): string[] {
  const counts = (o: ForgeUndoObjectResult): string =>
    [
      o.deleted > 0 ? `${o.deleted} deleted` : '',
      o.alreadyGone > 0 ? `${o.alreadyGone} already gone` : '',
      (o.notVisible ?? 0) > 0 ? `${o.notVisible} not visible` : '',
      o.keptChanged > 0 ? `${o.keptChanged} kept, changed since the run` : '',
      o.keptDependents > 0 ? `${o.keptDependents} kept, records that stay depend on them` : '',
      o.refused > 0 ? `${o.refused} refused` : '',
    ]
      .filter(Boolean)
      .join(', ');
  return [
    `removal: ${status.toUpperCase()}`,
    ...objects.flatMap((o) => [
      `  ${o.objectApiName}: ${counts(o) || 'nothing'} of ${o.planned}`,
      ...o.reasons.map((reason) => `      ${reason}`),
    ]),
  ];
}

/** What a removal told the saved configuration its run was of. */
type ConfigurationTold = Pick<SyncRemovalResult, 'readWhole' | 'filesForgotten'> & {
  /** How many of its pairs it forgot: see `SyncIdMap`. */
  linksForgotten?: number;
};

/**
 * What a removal told the saved configuration its run was of, as the lines the
 * command prints: the objects its next run reads whole, the copied files it
 * forgot, the records whose copies no later run points a lookup at.
 */
export function configurationToldLines(
  configId: string | undefined,
  told: ConfigurationTold,
): string[] {
  if (configId === undefined) return [];
  return [
    ...(told.readWhole && told.readWhole.length > 0
      ? [`configuration ${configId}: its next run reads ${told.readWhole.join(', ')} whole`]
      : []),
    ...((told.filesForgotten ?? 0) > 0
      ? [
          `configuration ${configId}: ${told.filesForgotten} copied file(s) forgotten, copied ` +
            'again by its next run',
        ]
      : []),
    ...((told.linksForgotten ?? 0) > 0
      ? [
          `configuration ${configId}: ${told.linksForgotten} record(s) forgotten, which no later ` +
            'run points a lookup at',
        ]
      : []),
  ];
}

/** The exit code of a removal that left records of the run in the org. */
const RECORDS_LEFT_EXIT = 3;

/**
 * Remove from its target what a run created, from the summary the run printed
 * with `--json`: the removal the panel runs (`removeSyncRun`). The summary and
 * what earlier removals of it kept beside it are read and checked before any
 * org is contacted; then the target is typed, and refused unless it is a
 * sandbox or a Developer Edition org, and the org the run wrote to.
 */
export async function removeMain(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseRemoveArgs(argv);
  // In --json mode stdout carries the outcome alone, for a parser to read.
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };

  let text: string;
  try {
    text = readFileSync(args.summaryPath, 'utf8');
  } catch (err: unknown) {
    process.stderr.write(
      `--remove ${args.summaryPath} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  const read = readRunSummary(text);
  if ('refusal' in read) {
    process.stderr.write(`--remove ${args.summaryPath} ${read.refusal}\n`);
    process.exit(2);
  }
  const { summary } = read;
  if (summary.targetOrgId === undefined && summary.target !== args.target) {
    process.stderr.write(
      `The run wrote to ${summary.target}, and what it created is removed from that org only: ` +
        `give --target ${summary.target}.\n`,
    );
    process.exit(2);
  }

  // The store of the configuration the run was of, which the removal tells
  // what it took: checked before any org is contacted.
  let configs: SyncConfigStore | undefined;
  if (args.store !== undefined) {
    if (summary.configId === undefined) {
      process.stderr.write(
        `--store tells the configuration a run was of what its removal took, and ` +
          `${args.summaryPath} names none: the run was not of a saved configuration ` +
          '(--config-file).\n',
      );
      process.exit(2);
    }
    configs = existsSync(join(args.store, 'configStore.json'))
      ? savedConfigStore(args.store)
      : undefined;
    if (!configs?.isSaved(summary.configId)) {
      process.stderr.write(
        `${args.store} holds no configuration ${summary.configId}: give the --store the run ` +
          'was made with.\n',
      );
      process.exit(2);
    }
  }

  // What earlier removals of this summary left on the run's records: unread,
  // a second removal would take what the first wrote to a record it left for
  // a change since the run, and keep the record.
  const removalsFile = removalsPathOf(args.summaryPath);
  let earlier: SyncRunRemovalState | undefined;
  let removalsText: string | undefined;
  try {
    removalsText = readFileSync(removalsFile, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      process.stderr.write(
        `${removalsFile} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
  }
  if (removalsText !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(removalsText);
    } catch {
      raw = undefined;
    }
    const ofRun = (raw as { runId?: unknown } | undefined)?.runId;
    earlier = ofRun === summary.created?.runId ? readRemovalState(raw) : undefined;
    if (ofRun !== summary.created?.runId) {
      say(`${removalsFile} is of another run: it is not read, and this removal's takes its place`);
    } else if (!earlier) {
      process.stderr.write(`${removalsFile} does not read as what earlier removals did.\n`);
      process.exit(2);
    }
  }
  const run = runOfSummary(summary, earlier);

  const output = (
    status: ForgeUndoStatus,
    objects: ForgeUndoObjectResult[],
    planned: number,
    told: ConfigurationTold = {},
  ) => {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'sandforge-sync',
            action: 'remove',
            summary: args.summaryPath,
            target: args.target,
            includeChanged: args.includeChanged,
            result: { status, planned, objects, ...told },
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    for (const line of removalSummaryLines(status, objects)) say(line);
    for (const line of configurationToldLines(summary.configId, told)) say(line);
    say(`\ndone in ${Date.now() - t0}ms`);
  };

  const plan = syncRemovalPlan(run);
  if (plan.length === 0) {
    say(
      earlier?.undo
        ? `what the run created was removed already, on ${earlier.undo.removedAt}`
        : 'The run created nothing: there is nothing of it to remove.',
    );
    output('success', [], 0);
    return;
  }

  const conn = makeConn(await loadOrg(args.target));
  const org = await typeTarget(conn);
  const refusal = removalRefusal(args.target, org);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(1);
  }
  if (
    summary.targetOrgId !== undefined &&
    summary.targetOrgId.slice(0, 15) !== org.id.slice(0, 15)
  ) {
    process.stderr.write(
      `${args.target} is not the org the run wrote to (${summary.targetOrgId}), and what it ` +
        'created is removed from that org only. Nothing was deleted.\n',
    );
    process.exit(1);
  }
  say(`sandforge-sync --remove  ${args.summaryPath}  from ${args.target}`);
  for (const { objectApiName, ids } of plan) say(`  ${objectApiName}: ${ids.length} to remove`);

  // Ctrl-C stops the removal before its next call to the org, as Cancel does
  // in the panel.
  const stop = new AbortController();
  const interrupt = (): void => stop.abort();
  process.once('SIGINT', interrupt);
  let state: SyncRunRemovalState = earlier ?? {};
  let outcome: Awaited<ReturnType<typeof removeSyncRun>>;
  try {
    outcome = await removeSyncRun({
      run,
      org: removalOrg(conn, 'sandforge-sync --remove'),
      includeChanged: args.includeChanged,
      signal: stop.signal,
      // The configuration's store, told what the removal took: its
      // watermarks and copied files, and which records its runs wrote.
      ...(configs && args.store !== undefined ? { configs, links: nodeSyncIdMap(args.store) } : {}),
      store: {
        // Kept beside the summary whatever the removal ended on, written
        // whole through a file renamed over it.
        updateRemoval: async (_runId, change) => {
          state = change(state);
          const written = `${removalsFile}.${process.pid}.tmp`;
          writeFileSync(
            written,
            `${JSON.stringify({ version: 1, runId: run.runId, ...state }, null, 2)}\n`,
          );
          renameSync(written, removalsFile);
        },
      },
    });
  } finally {
    process.off('SIGINT', interrupt);
  }
  for (const note of outcome.notes) process.stderr.write(`${note}\n`);
  const took = outcome.result.objects.some((o) => o.deleted + o.alreadyGone > 0);
  if (summary.configId !== undefined && !configs && took) {
    process.stderr.write(
      `The run was of the saved configuration ${summary.configId}, and its store was not given: ` +
        'its next delta run is not told what this removal took, and a later run may point a ' +
        'lookup at a record it deleted. Give --store with the next removal, or run the ' +
        'configuration full next time.\n',
    );
  }
  const { readWhole, filesForgotten } = outcome.result;
  output(outcome.result.status, outcome.result.objects, outcome.planned, {
    ...(readWhole ? { readWhole } : {}),
    ...(filesForgotten !== undefined ? { filesForgotten } : {}),
    ...(outcome.linksForgotten !== undefined ? { linksForgotten: outcome.linksForgotten } : {}),
  });
  if (outcome.result.status !== 'success') process.exit(RECORDS_LEFT_EXIT);
}

// `tsx` runs this file directly; the import check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-sync')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { jsforce };
