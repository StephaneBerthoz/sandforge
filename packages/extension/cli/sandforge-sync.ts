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
 * A run can be taken back: `--remove` deletes from its target what the run
 * created — the records it inserted, or upserted where the target held none —
 * with the removal the panel runs, from the summary it printed with `--json`
 * or from its file, which every run that writes keeps as it goes, as the
 * panel keeps its runs'. A run killed, stopped by a Ctrl-C or ended by an
 * error printed no summary: it kept what it created in memory alone, and the
 * Bulk API job it had under way ran on in the target with nothing left to
 * name its records.
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
 *     --remove <summary.json | run file | run id> --target TGT [--include-changed]
 *     [--store <dir>] [--sweep | --sweep-list] [--json]
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import jsforce from 'jsforce';
import type { Connection } from 'jsforce';
import { z } from 'zod';
import type {
  CurrencyReplaced,
  PriceCurrencySettled,
  ForgeContactPointsReport,
  ForgeFieldRefusal,
  ForgeSweepResult,
  ForgeTargetAutomation,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  SyncConfig,
  SyncDeltaOutcome,
  SyncLookupsLeftOut,
  SyncObjectConfig,
  SyncObjectResult,
  SyncRemovalResult,
  SyncSimulationResult,
  SyncWriteCheck,
} from '@sandforge/shared';
import { guardTierOf, isDeveloperEdition, orgTypeOf, recordWriteHeaders } from '@sandforge/shared';
import type { SyncRestoreObjectResult } from '@sandforge/shared';
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
import { seedSweepInput } from '../src/modules/seed/seedRunSweep.js';
import { listSweep, sweepRunRecords } from '../src/modules/forge/ForgeRunSweep.js';
import {
  nodeSyncRunCreations,
  backupIdSchema,
  readRemovalState,
  readRunFile,
  SYNC_FILE_OBJECTS,
  SYNC_RUNS_DIR,
  syncRemovalPlan,
  syncRestorePlan,
  OverwritesRead,
  type SyncCreationRecorder,
  type SyncRunCreations,
  type SyncRunKept,
  type SyncRunOverwritten,
  type SyncRunRemovalState,
} from '../src/modules/sync/SyncRunCreations.js';
import { storeOverwriteBackup, syncOverwriteKeeper } from '../src/modules/sync/syncOverwrites.js';
import { BackupRecordStore, nodeBackupFiles } from '../src/modules/dataops/BackupRecordStore.js';
import { defaultBackupStoreOf, openBackupStore } from './backupStore.js';
import { answerJobsInFlight, type IngestJobReading } from '../src/modules/sync/inFlightJob.js';
import { loadOrg, makeConn } from './sfSession.js';
import { refuseProductionTarget, typeTarget, type TypedTarget } from './targetKind.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import { endWith, runExitCode } from './exitCodes.js';
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
import { BulkDataWriter, syncWriterCalls } from '../src/modules/sync/BulkDataWriter.js';
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
import {
  journalDirOf,
  sweepLines,
  sweepListingLines,
  targetAutomationReader,
} from './sandforge-clone.js';

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
                         The run's file does too, whatever becomes of the
                         run (see SANDFORGE_JOURNAL_DIR).
  --fail-on-partial      exit 3, not 0, when the run wrote some records and
                         the target refused others        (default: off)
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
    --remove <summary.json | run file | run id> --target <alias>
    [--include-changed] [--store <dir>] [--sweep | --sweep-list] [--json]

  --remove <file | id>   the summary a run printed with --json, saved to a
                         file; or the run's file, which it names as it
                         begins, or its run id. Deletes from the target what
                         the run created: the records it inserted, or
                         upserted where the target held none, the last object
                         written first, into the target's recycle bin. Before
                         that, gives the records it wrote over — an update,
                         an upsert that found the record — the values they
                         held before the run, of the fields it wrote, which
                         the run kept first in <dir>/backups (below); one
                         changed since the run stays as it is unless
                         --include-changed. From its file, a run killed,
                         stopped or ended by an error is taken back too: a
                         Bulk API job it had under way, which ran on in the
                         target, is read back by its id first, and its
                         records go with the rest.
  --target <alias>       the org the run wrote to, and no other. It must be a
                         sandbox or a Developer Edition org.
  --include-changed      remove also the records changed since the run, which
                         are kept otherwise, and give back their values from
                         before the run to the records it wrote over that
                         were changed since
  --store <dir>          for a run of a saved configuration: its store, which
                         the removal tells what it took, so that the next
                         delta run reads those objects whole and copies the
                         files it deleted again
  --sweep                before the run's records go, delete too what the
                         target's automation created during the run, as the
                         run's user, that the run did not write: in the objects
                         whose records it created, tasks, events, feed, email
                         messages, notes, case comments, and the objects the
                         target's flows create. The window runs from a second
                         before the run's first write — its first call, an
                         update before anything was created included, which
                         the summary dates by this machine's clock, read on
                         the org's — to a minute after its last write: the
                         last record it created, read back from the org, or
                         a later call, an update included, as the summary
                         dates it. Refused
                         when that user created records in the window on
                         objects neither the run nor the automation reaches
                         (hand work, likely). Records someone changed since
                         stay, unless --include-changed     (default: off)
  --sweep-list           list what --sweep would delete, per object with a few
                         names, and delete nothing, the run's records included
  --json                 print the removal as JSON

  What the removal left on the run's records is kept beside the summary, in
  <summary>.removals.json, or beside the run's file, in <run id>.removal.json,
  and the next --remove of the same summary or file reads it.

Environment:
  SANDFORGE_JOURNAL_DIR=<dir>
                         where every run that writes keeps its file, in
                         <dir>/sync-runs/<run id>.ndjson (default: ~/.sandforge),
                         said as it begins: what it created, its calls as
                         they went and answered, a Bulk API job's id once the
                         org opened it, and how it ended. Ids and dates only.
                         What a run writes over — an update, an upsert that
                         finds the record — is read from the target first and
                         kept in <dir>/backups, readable by you alone, as
                         sandforge-backup keeps a snapshot: the values the
                         records held, of the fields the run writes, which
                         --remove gives back. A call whose values cannot be
                         kept is not sent, its rows refused with why.

Before its first write, a run counts the records it writes under each filter,
and is refused, with nothing written, when they would take more data storage
than the target has left, or make the target's automation send more emails
than it has left today; --dry-run says what it would meet. A run of a saved
configuration leaves as they are the records an earlier run of it copied that
are still in the target, and inserts the others.

Exit codes: 0 the run finished, some of its records refused included (read
the summary for per-object failures), or the removal took every record it set
out to; 1 the run or the removal could not be started, the run was refused
before it wrote anything — a production target among the reasons — or it
produced only failures, or it stopped on an error (its file keeps what it
created); 2 a bad command line, or a summary or a file --remove cannot take a
run back from; 3 the removal left records of the run in the target, or the
run was partial and --fail-on-partial was given; 130 a Ctrl-C stopped the
run, 143 a SIGTERM (a CI job cancelled or timed out), 129 a SIGHUP: its file
keeps what it created.
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
  /** Exit 3, not 0, when the run wrote some records and the target refused others. */
  failOnPartial: boolean;
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

/** What the line of a run reads; a removal's reads its own (`REMOVE_FLAGS`). */
const RUN_FLAGS: CommandFlags = {
  switches: ['--dry-run', '--files', '--keep-contact-points', '--json', '--fail-on-partial'],
  values: [
    '--source',
    '--target',
    '--object',
    '--operation',
    '--where',
    '--batch-size',
    '--config-file',
    '--store',
  ],
};

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // `--dry-run=true` or `--dryrun` dropped without a word ran for real.
  refuseUnreadArguments(args, RUN_FLAGS);
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
      failOnPartial: has('--fail-on-partial'),
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
    failOnPartial: has('--fail-on-partial'),
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
  if ((check.overwrites ?? 0) > 0) {
    lines.push(
      `  of them, up to ${check.overwrites} written by an update or an upsert over records ` +
        `${target} holds: their values are kept first, and --remove puts them back`,
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

/** A line of an object's result on what its write held back. */
const SAID_ONCE = /^(PARENT_REFUSED|RECORD_TYPE_UNAVAILABLE|RECORD_TYPE_UNMAPPED):/;

/**
 * The lines the command prints of an object's errors: its first three, and
 * each line on what the write held back — said once for every record it is
 * about, after the refusals of each record.
 */
export function objectErrorLines(errors: readonly string[]): string[] {
  const lines = errors.slice(0, 3);
  for (const error of errors.slice(3)) if (SAID_ONCE.test(error)) lines.push(error);
  return lines;
}

/** Why records went without lookups they held, as a line says it after their count and fields. */
const LEFT_OUT_BECAUSE: Readonly<Record<SyncLookupsLeftOut['reason'], string>> = {
  notInTarget: ': the lookup held an id from the source org that the target does not have.',
  ownerRefusedEarlier:
    ', left out from the start: the target refused the same owner earlier in this run, an ' +
    'id from the source org that the target does not have.',
  parentRefused: ': the record it names, written after them, was refused in this run.',
  notSet: ': the target refused setting it once the record it names was written',
  notReached: ': the run was stopped before it was set, once the record it names was written.',
};

/** What refused a field records were written again without, as a line says it. */
const REFUSED_FIELD_BY: Readonly<Record<ForgeFieldRefusal, string>> = {
  'validation-rule': 'a validation rule of the target refused it',
  'restricted-picklist': 'a restricted picklist of the target refused its value',
  'lookup-filter': 'a lookup filter of the target refused the record it names',
};

/**
 * The lines the command prints of what an object's write did that no refusal
 * says: the records linked to one the target holds rather than written, those
 * written without lookups they held, with why, those given lookups at an
 * object written after them, and those written again without the fields the
 * target refused them on. Every one, however many refusals the object had.
 */
export function objectWrittenLines(
  result: Pick<
    SyncObjectResult,
    'linkedToExisting' | 'lookupsLeftOut' | 'lookupsSetAfter' | 'writtenWithoutFields'
  >,
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
  for (const { records, fields, reason, refusal } of result.lookupsLeftOut ?? []) {
    const said = reason === 'notSet' ? `${refusal ? ` (${refusal})` : ''}.` : '';
    lines.push(
      `${records} record(s) written without ${fields.join(', ')}${LEFT_OUT_BECAUSE[reason]}${said}`,
    );
  }
  const setAfter = result.lookupsSetAfter;
  if (setAfter) {
    lines.push(
      `${setAfter.records} record(s) given ${setAfter.fields.join(', ')} by a second write once ` +
        `${setAfter.after.join(', ')} ${setAfter.after.length === 1 ? 'was' : 'were'} written: ` +
        'the objects name each other, and no order writes both first.',
    );
  }
  const without = result.writtenWithoutFields;
  if (without) {
    lines.push(
      `${without.rows} record(s) written again without the fields the target refused them on:`,
      ...without.fields.map(
        ({ field, rows, refusedBy = 'validation-rule', reason }) =>
          `  ${rows} without ${field}: ${REFUSED_FIELD_BY[refusedBy]}, ${reason}`,
      ),
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
  // Why it stayed, when the run left records without a lookup it was to set:
  // past them, the next run would not read them again, and the lookup stayed
  // unset for good.
  const owed =
    (delta.lookupsOwed ?? 0) > 0
      ? `, ${delta.lookupsOwed} record(s) left without a lookup this run was to set among them`
      : '';
  return `${read}${deletions}${mark}${owed}`;
}

/** What a run created, kept in memory as it writes it, for its summary. */
export function memoryCreations(runId: string): SyncCreationRecorder & {
  /** Per object in the order first written, each id once. */
  created(): Array<{ objectApiName: string; ids: string[] }>;
  /** When the run last wrote something it created. */
  lastWrittenAt(): string | undefined;
  /**
   * When the run first wrote to the target: its first call, one that creates
   * or an update, as the panel's file dates it (`SyncRunKept.firstWrittenAt`).
   */
  firstWrittenAt(): string | undefined;
  /**
   * When the run last wrote to the target, whatever it wrote: a call as it
   * went or as it answered, as the run's file dates it (`SyncRunKept.lastWriteAt`).
   */
  lastWriteAt(): string | undefined;
  /** What it wrote over, per object, as the run's file reads it back (`SyncRunKept.overwritten`). */
  overwritten(): SyncRunOverwritten[];
} {
  const byObject = new Map<string, string[]>();
  const overwrites = new OverwritesRead();
  /** The ids kept so far, by their first fifteen characters, as a run's file reads them back. */
  const seen = new Set<string>();
  let last: string | undefined;
  let first: string | undefined;
  let lastWrite: string | undefined;
  /** A call goes or answers: the first dates the run's first write, each its last. */
  const calling = (rows: number): void => {
    if (rows <= 0) return;
    const now = new Date().toISOString();
    first ??= now;
    lastWrite = now;
  };
  return {
    runId,
    sending: (_objectApiName, rows) => calling(rows),
    writing: (_objectApiName, rows) => calling(rows),
    // An answer dates the run's last write, an upsert that matched every row
    // included, however few it created.
    answered: () => {
      lastWrite = new Date().toISOString();
    },
    note: (objectApiName, ids) => {
      if (ids.length === 0) return;
      // Each id once, as the panel's file reads a run back (`readRunFile`):
      // an id noted twice went into the summary twice, and its removal
      // counted the second as already gone.
      const fresh = ids.filter((id) => {
        const key = id.slice(0, 15);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length > 0) {
        byObject.set(objectApiName, [...(byObject.get(objectApiName) ?? []), ...fresh]);
      }
      last = new Date().toISOString();
      first ??= last;
      lastWrite = last;
    },
    // Records it created, written again once the records their lookups name
    // were: when it last wrote, which its removal reads the org's dates against.
    touched: (_objectApiName, rows) => {
      if (rows <= 0) return;
      last = new Date().toISOString();
      lastWrite = last;
    },
    // What a call writes over, named before it goes and answered after it:
    // writes of the run, dated as the run's file dates them.
    overwriting: (objectApiName, backup, ids) => {
      if (ids.length === 0) return;
      overwrites.candidates(objectApiName, backup, ids);
      calling(ids.length);
    },
    overwrote: (objectApiName, notWritten) => {
      overwrites.answer(objectApiName, notWritten);
      lastWrite = new Date().toISOString();
    },
    overwrittenCount: () => overwrites.count,
    flush: async () => undefined,
    created: () => [...byObject].map(([objectApiName, ids]) => ({ objectApiName, ids: [...ids] })),
    lastWrittenAt: () => last,
    firstWrittenAt: () => first,
    lastWriteAt: () => lastWrite,
    overwritten: () => overwrites.read(),
  };
}

/**
 * Each line of a run told to both its recorders: the summary's, in memory,
 * and the run's file, written as it goes, which a run killed, stopped by a
 * Ctrl-C or ended by an error leaves behind. The command kept them in memory
 * alone, printed once the run returned: one that did not return left no
 * trace of what it created, and the Bulk API job it had under way ran on to
 * its end in the target. Exported so it can be tested.
 */
export function bothRecorders(
  summary: SyncCreationRecorder,
  file: SyncCreationRecorder | undefined,
): SyncCreationRecorder {
  if (!file) return summary;
  return {
    runId: summary.runId,
    note: (objectApiName, ids, at) => {
      summary.note(objectApiName, ids, at);
      file.note(objectApiName, ids, at);
    },
    sending: (objectApiName, rows, call) => {
      summary.sending?.(objectApiName, rows, call);
      file.sending?.(objectApiName, rows, call);
    },
    answered: (objectApiName, ids) => {
      summary.answered?.(objectApiName, ids);
      file.answered?.(objectApiName, ids);
    },
    writing: (objectApiName, rows) => {
      summary.writing?.(objectApiName, rows);
      file.writing?.(objectApiName, rows);
    },
    touched: (objectApiName, rows) => {
      summary.touched?.(objectApiName, rows);
      file.touched?.(objectApiName, rows);
    },
    overwriting: (objectApiName, backup, ids) => {
      summary.overwriting?.(objectApiName, backup, ids);
      file.overwriting?.(objectApiName, backup, ids);
    },
    overwrote: (objectApiName, notWritten) => {
      summary.overwrote?.(objectApiName, notWritten);
      file.overwrote?.(objectApiName, notWritten);
    },
    overwrittenCount: () => summary.overwrittenCount?.() ?? file.overwrittenCount?.() ?? 0,
    flush: async () => (await summary.flush()) ?? (await file.flush()),
  };
}

/**
 * What a run of objects named on the line keeps as its configuration in its
 * file: no saved configuration was, and none is told of its removal.
 */
export const LINE_RUN = 'sandforge-sync';

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
  /** A line said whatever the mode: on stderr with --json, where stdout carries the summary alone. */
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
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
  // What the target says it is, read once: the gate types it by it, a run
  // that copies files replaces an attachment by it, and the run's file names
  // its own id, which --remove takes the run back from and from no other. A
  // run that writes is refused first on a production org, or on one that
  // will not say what it is, as the clone is: the gate's policy for a command
  // line never read the type, and --remove refuses such an org, so a run
  // written there could not be taken back. A dry run only reads.
  const typed = args.dryRun
    ? await typeTarget(targetConn).catch(() => undefined)
    : await refuseProductionTarget(targetConn, args.target, {
        tool: 'sandforge-sync',
        action: 'write',
        readOnly: '--dry-run',
      });
  // What a real run creates, for its summary to name and --remove to take
  // back, and in its file as it writes it, whatever becomes of the run.
  const runId = `sandforge-sync-${randomUUID()}`;
  const kept = memoryCreations(runId);
  const runs = args.dryRun ? undefined : nodeSyncRunCreations(journalDirOf());
  const runFile = runs?.recorder({
    runId,
    configId: saved ? config.id : LINE_RUN,
    configName: saved ? config.name : LINE_RUN,
    sourceOrgId: args.source,
    targetOrgId: args.target,
    ...(typed ? { targetOrganizationId: typed.id } : {}),
  });
  const recorder = bothRecorders(kept, runFile);
  const describeTargetFields = async (objectApiName: string): Promise<TargetWriteFields> => {
    const cached = targetFieldsByObject.get(objectApiName);
    if (cached) return cached;
    const described = await targetConn.sobject(objectApiName).describe();
    // Fields and record types from the one describe, as the panel reads them.
    const answer = targetWriteFieldsOf(described);
    targetFieldsByObject.set(objectApiName, answer);
    return answer;
  };

  // What it writes over, read from the target first and kept in the backup
  // store DataOps' command lines keep their snapshots in, its owner's alone:
  // what --remove gives back. A run that only inserts keeps none.
  const writesOver = config.objects.some(
    (object) => object.operation === 'update' || object.operation === 'upsert',
  );
  const backupDir = defaultBackupStoreOf();
  let overwrites: ReturnType<typeof storeOverwriteBackup> | undefined;
  if (!args.dryRun && writesOver) {
    const refused = openBackupStore(backupDir);
    if (refused !== undefined) {
      process.stderr.write(
        `${refused} What the run would write over could not be kept, so nothing was written.\n`,
      );
      process.exit(1);
    }
    overwrites = storeOverwriteBackup({
      runId,
      orgId: args.target,
      ...(typed ? { organizationId: typed.id } : {}),
      files: new BackupRecordStore(nodeBackupFiles(backupDir)),
      meta: fileConfigStore(join(backupDir, 'snapshots.json')),
    });
  }
  const keeper = overwrites
    ? syncOverwriteKeeper({
        query: async (soql) =>
          (
            await queryAllPages<Record<string, unknown>>(
              {
                query: async (q) => targetConn.query<Record<string, unknown>>(q),
                queryMore: async (url) => targetConn.queryMore<Record<string, unknown>>(url),
              },
              soql,
            )
          ).records,
        backup: overwrites,
        recorder,
        describe: (objectApiName) => describeTargetFields(objectApiName),
      })
    : undefined;
  const writer = new BulkDataWriter({
    connection: targetConn,
    bulkExecutor: new BulkApiExecutor(),
    bulkManager: new BulkApiManager(),
    retryConfig: {},
    signal: controller.signal,
    onProgress: (processed, total, label) => log(`  ${label}: ${processed}/${total}`),
    log,
    // Each call as it goes and as it answers, a Bulk API job with its id once
    // the org opened it, as the panel's run keeps them (`syncWriterCalls`),
    // and what each call writes over kept before it goes.
    calls: syncWriterCalls(recorder, keeper),
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
  const orgTier = typed
    ? guardTierOf({
        orgType: orgTypeOf({ isSandbox: typed.sandbox, edition: typed.edition }),
        metadata: { edition: typed.edition },
      })
    : ('production' as const);
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
    const deletes = typed ? cliAllowsDeletes(typed) : false;
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
    ...(args.dryRun ? {} : { creations: recorder }),
    // The run's cancel, which a Ctrl-C aborts, as the panel's Cancel aborts
    // its run's: it stops before its next object, its writer before its next call.
    signal: controller.signal,
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
  // Where what the run creates is kept as it writes it, however the run
  // ends: said before its first write, on stderr with --json.
  const runFilePath = runs?.pathOf(runId);
  if (runFilePath !== undefined) {
    say(`run file: ${runFilePath} (--remove ${runFilePath} takes back what the run creates)`);
  }
  // Ctrl-C stops the run before its next call, as Cancel does in the panel:
  // what it wrote is kept, its file ended. Again, it ends the command at once,
  // and the file, without its end, reads as a run stopped part way. A SIGTERM
  // — a CI job cancelled or timed out — or a SIGHUP stops it the same way.
  let interrupted: StopSignal | undefined;
  const interrupt = (signal: StopSignal): void => {
    interrupted = signal;
    process.stderr.write(
      '\ninterrupted: the run stops before its next call, and its file keeps what it created ' +
        '(Ctrl-C again ends it at once)\n',
    );
    controller.abort();
  };
  const releaseStop = onStopSignal(interrupt);
  let result: Awaited<ReturnType<typeof orchestrator.execute>>;
  /** How the run ended, as its file's last line says it: a failure unless it returned. */
  let ending: { status: 'success' | 'partial' | 'failure'; cancelled?: boolean } = {
    status: 'failure',
  };
  try {
    result = await orchestrator.execute(config);
    ending = { status: result.status, ...(result.cancelled ? { cancelled: true } : {}) };
  } catch (err: unknown) {
    // Refused before its first write: nothing was written.
    overwrites?.close();
    if (!(err instanceof SyncRunRefused)) {
      await runFile?.end(ending);
      if (runFilePath !== undefined && existsSync(runFilePath)) {
        process.stderr.write(
          `the run stopped on an error; what it created is kept in ${runFilePath}, and ` +
            `--remove ${runFilePath} takes it back\n`,
        );
      }
      throw err;
    }
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
  } finally {
    releaseStop();
  }
  await runFile?.end(ending);
  overwrites?.close();
  const unkept = await runFile?.flush();
  if (unkept !== undefined) {
    process.stderr.write(
      `what the run created could not all be written to ${runFilePath ?? 'its file'} ` +
        `(${unkept}): --remove takes it back from the --json summary\n`,
    );
  }
  const elapsedMs = Date.now() - t0;
  const created = kept.created();
  const lastWrittenAt = kept.lastWrittenAt();
  const firstWrittenAt = kept.firstWrittenAt();
  const lastWriteAt = kept.lastWriteAt();
  const overwritten = kept.overwritten();
  // The org's own id, so --remove takes the run back from it and no other,
  // whatever alias names it then.
  const targetOrgId =
    created.length > 0 || overwritten.length > 0
      ? (typed?.id ?? (await organizationIdOf(targetConn)))
      : undefined;
  const keptInFile = runFilePath !== undefined && existsSync(runFilePath) ? runFilePath : undefined;

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
            // When it first and last wrote, by this machine's clock: where
            // the sweep of its removal starts and stops looking.
            ...(firstWrittenAt ? { firstWrittenAt } : {}),
            ...(lastWriteAt ? { lastWriteAt } : {}),
            // Its file, which --remove takes it back from too.
            ...(keptInFile ? { runFile: keptInFile } : {}),
            objects: created,
            // What it wrote over, by id, and the backup its values went to.
            ...(overwritten.length > 0 ? { overwritten } : {}),
          },
          elapsedMs,
        },
        null,
        2,
      )}\n`,
    );
    if (interrupted) process.exit(stopExitCode(interrupted));
    endWith(runExitCode(result.status, args.failOnPartial));
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
  const over = overwritten.reduce((sum, object) => sum + object.ids.length, 0);
  if (over > 0) {
    log(
      `\nwrote over ${over} record(s) of ${args.target}, their values from before kept in ` +
        `${join(backupDir, 'backups')}: --remove ${keptInFile ?? 'with the --json summary'} ` +
        'gives them back',
    );
  }
  if (count > 0) {
    log(
      `\ncreated ${count} record(s) and file(s) in ${args.target}: ` +
        (keptInFile !== undefined
          ? `--remove ${keptInFile} takes them back`
          : 'run with --json and save the summary to a file, and --remove takes them back from it'),
    );
  }
  log(`\ndone in ${elapsedMs}ms`);
  if (interrupted) process.exit(stopExitCode(interrupted));
  // A run whose every record the target refused exited 0, as one that wrote them all.
  endWith(runExitCode(result.status, args.failOnPartial));
}

// ─── --remove ────────────────────────────────────────────────────────────────

/** What `--remove` was given. */
export interface RemoveArgs {
  /**
   * The summary a run printed with `--json`, saved to a file; or the run's
   * file, or its id, which the command keeps in its directory.
   */
  summaryPath: string;
  /** sf CLI alias of the org the run wrote to. */
  target: string;
  /** Remove also the records changed since the run. */
  includeChanged: boolean;
  /** Print the removal as JSON on stdout, every other line on stderr. */
  json: boolean;
  /** The store of the saved configuration the run was of, which the removal tells. */
  store?: string;
  /** Sweep first what the target's automation created during the run. */
  sweep: boolean;
  /** List what a sweep would delete, and delete nothing. */
  sweepList: boolean;
}

/** The flags a removal reads. */
const REMOVE_FLAGS: ReadonlySet<string> = new Set([
  '--remove',
  '--target',
  '--include-changed',
  '--store',
  '--sweep',
  '--sweep-list',
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
        `--remove takes --target, --include-changed, --store, --sweep, --sweep-list and ` +
          `--json, not "${arg}". Run with --help.\n`,
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
      '--remove takes the file a run printed its --json summary to, or the run file it named ' +
        'as it began, or its run id, and --target the org the run wrote to. Run with --help.\n',
    );
    process.exit(2);
  }
  if (args.includes('--sweep') && args.includes('--sweep-list')) {
    process.stderr.write(
      '--sweep deletes and --sweep-list only lists: give one of them. Run with --help.\n',
    );
    process.exit(2);
  }
  return {
    summaryPath,
    target,
    includeChanged: args.includes('--include-changed'),
    json: args.includes('--json'),
    ...(store !== undefined ? { store } : {}),
    sweep: args.includes('--sweep'),
    sweepList: args.includes('--sweep-list'),
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
        firstWrittenAt: z.string().min(1).max(40).optional(),
        lastWriteAt: z.string().min(1).max(40).optional(),
        objects: z.array(
          z.object({
            objectApiName: z.string().regex(API_NAME_RE),
            ids: z.array(z.string().regex(ID)),
          }),
        ),
        overwritten: z
          .array(
            z.object({
              objectApiName: z.string().regex(API_NAME_RE),
              backup: backupIdSchema,
              ids: z.array(z.string().regex(ID)),
            }),
          )
          .optional(),
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
    ...(created?.firstWrittenAt ? { firstWrittenAt: created.firstWrittenAt } : {}),
    ...(created?.lastWriteAt ? { lastWriteAt: created.lastWriteAt } : {}),
    created: (created?.objects ?? []).filter((object) => object.ids.length > 0),
    ...((created?.overwritten ?? []).some((object) => object.ids.length > 0)
      ? { overwritten: (created?.overwritten ?? []).filter((object) => object.ids.length > 0) }
      : {}),
    ...(removal ? { removal } : {}),
  };
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

/**
 * What a removal gave back of what the run wrote over, as the lines the
 * command prints: per object, the records holding their values from before
 * the run again, and those it left, with why. Exported so it can be tested.
 */
export function restoredLines(restored: readonly SyncRestoreObjectResult[]): string[] {
  return restored.flatMap((o) => {
    const left = [
      o.keptChanged > 0 ? `${o.keptChanged} left as they are, changed since the run` : '',
      o.alreadyGone > 0 ? `${o.alreadyGone} no longer in the org` : '',
      o.refused > 0 ? `${o.refused} refused` : '',
      o.notKept > 0
        ? `${o.notKept} whose values from before are no longer kept (their backup was deleted, or past its retention)`
        : '',
      (o.notReached ?? 0) > 0 ? `${o.notReached} not reached` : '',
    ].filter(Boolean);
    return [
      `  ${o.objectApiName}: ${o.restored} of ${o.planned} given back their values from before ` +
        `the run${left.length > 0 ? `; ${left.join(', ')}` : ''}`,
      ...o.reasons.map((reason) => `      ${reason}`),
    ];
  });
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

/** A run id as `--remove` takes one: what names its file in the command's directory. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/**
 * The file of the run `value` names, when it names one: a run's file, whose
 * first line names its run, or the id of a run whose file is in the command's
 * own directory (`SANDFORGE_JOURNAL_DIR`, `sync-runs/`). Undefined for
 * anything else, a summary included. Exported so it can be tested, and for
 * the seed command, whose runs keep the same files under `seed-runs/`.
 *
 * @param runsDir - The folder of the command's runs, under `journalDir`.
 */
export function runFileOf(
  value: string,
  journalDir: string = journalDirOf(),
  runsDir: string = SYNC_RUNS_DIR,
): string | undefined {
  if (existsSync(value)) {
    let first: string | undefined;
    try {
      first = readFileSync(value, 'utf8')
        .split('\n')
        .find((line) => line.trim() !== '');
    } catch {
      return undefined;
    }
    let head: unknown;
    try {
      head = JSON.parse(first ?? '');
    } catch {
      return undefined;
    }
    return typeof head === 'object' && head !== null && 'run' in head
      ? resolvePath(value)
      : undefined;
  }
  if (!RUN_ID_RE.test(value)) return undefined;
  const file = join(journalDir, runsDir, `${value}.ndjson`);
  return existsSync(file) ? file : undefined;
}

/** What a removal takes a run back from: the summary it printed, or its file. */
interface RemovalSubject {
  /** The run, as the removal reads it, with what earlier removals of it did. */
  run: SyncRunKept;
  /** The saved configuration it was of, when it was of one. */
  configId?: string;
  /** The Organization id of the org it wrote to, when it says it. */
  targetOrgId?: string;
  /** What earlier removals of it did. */
  earlier?: SyncRunRemovalState;
  /** Keep what this removal does, for the next one. */
  updateRemoval: (change: (state: SyncRunRemovalState) => SyncRunRemovalState) => Promise<void>;
  /** Its file's store, when it is taken back from its file: its jobs are read back into it. */
  runs?: SyncRunCreations;
}

/** The run a summary names, and where what its removals did is kept: beside the summary. */
function subjectOfSummary(args: RemoveArgs, say: (line: string) => void): RemovalSubject {
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
  let state: SyncRunRemovalState = earlier ?? {};
  return {
    run,
    ...(summary.configId !== undefined ? { configId: summary.configId } : {}),
    ...(summary.targetOrgId !== undefined ? { targetOrgId: summary.targetOrgId } : {}),
    ...(earlier ? { earlier } : {}),
    // Kept beside the summary whatever the removal ended on, written whole
    // through a file renamed over it.
    updateRemoval: async (change) => {
      state = change(state);
      const written = `${removalsFile}.${process.pid}.tmp`;
      writeFileSync(
        written,
        `${JSON.stringify({ version: 1, runId: run.runId, ...state }, null, 2)}\n`,
      );
      renameSync(written, removalsFile);
    },
  };
}

/**
 * The run a file of the command keeps, as its file reads it, with what its
 * removals did, kept beside it in its directory (`SyncRunCreations`).
 */
async function subjectOfRunFile(file: string, args: RemoveArgs): Promise<RemovalSubject> {
  const runs = nodeSyncRunCreations(dirname(file), '');
  let read: ReturnType<typeof readRunFile>;
  try {
    read = readRunFile(readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    process.stderr.write(
      `--remove ${file} cannot be read: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  if (!read) {
    process.stderr.write(`--remove ${file} names no run of sandforge-sync.\n`);
    process.exit(2);
  }
  // Read by its run's id, beside what its removals did: under another name,
  // a removal would not find what the one before it did.
  if (runs.pathOf(read.runId) !== file) {
    process.stderr.write(
      `--remove ${file} is the file of the run ${read.runId} under another name: give it as ` +
        `${runs.pathOf(read.runId)}, where what its removals did is kept beside it.\n`,
    );
    process.exit(2);
  }
  const run: SyncRunKept = (await runs.get(read.runId)) ?? read;
  if (run.targetOrganizationId === undefined && run.targetOrgId !== args.target) {
    process.stderr.write(
      `The run wrote to ${run.targetOrgId}, and what it created is removed from that org only: ` +
        `give --target ${run.targetOrgId}.\n`,
    );
    process.exit(2);
  }
  return {
    run,
    ...(run.configId !== LINE_RUN ? { configId: run.configId } : {}),
    ...(run.targetOrganizationId !== undefined ? { targetOrgId: run.targetOrganizationId } : {}),
    ...(run.removal ? { earlier: run.removal } : {}),
    updateRemoval: (change) => runs.updateRemoval(run.runId, change),
    runs,
  };
}

/**
 * What reading back a run's Bulk API jobs came to, as the lines the command
 * prints: each job no line of the run's file answered, read back from the
 * target by its id. Exported so it can be tested.
 */
export function jobLines(
  answered: ReadonlyArray<Awaited<ReturnType<typeof answerJobsInFlight>>[number]>,
  target: string,
): string[] {
  return answered.map(({ job, objectApiName, read }) => {
    const of = `  Bulk API job ${job} (${objectApiName})`;
    switch (read.state) {
      case 'ended':
        return (
          `${of}: the run's file holds no answer of it; it ended in ${target}, and the ` +
          `${read.created.length} record(s) it created are removed with the rest`
        );
      case 'never-closed':
        return `${of}: never closed, it wrote nothing`;
      case 'running':
        return (
          `${of}: still running in ${target}: what it creates stays, and the next --remove ` +
          'of the run reads it again'
        );
      default:
        return `${of}: could not be read back (${read.reason}): what it created stays`;
    }
  });
}

/**
 * Remove from its target what a run created, from the summary the run printed
 * with `--json`, or from its file — the file's path, or the run's id — which
 * a run killed, stopped or ended by an error leaves too: the removal the
 * panel runs (`removeSyncRun`). The summary, or the file, and what earlier
 * removals of it kept beside it are read and checked before any org is
 * contacted; then the target is typed, and refused unless it is a sandbox or
 * a Developer Edition org, and the org the run wrote to. A Bulk API job the
 * file names that no line of it answers is read back from the target first,
 * by its id, and its records are removed with the rest.
 */
export async function removeMain(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseRemoveArgs(argv);
  // In --json mode stdout carries the outcome alone, for a parser to read.
  const say = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };

  const runFile = runFileOf(args.summaryPath);
  const subject =
    runFile !== undefined ? await subjectOfRunFile(runFile, args) : subjectOfSummary(args, say);
  const { earlier } = subject;

  // The store of the configuration the run was of, which the removal tells
  // what it took: checked before any org is contacted.
  let configs: SyncConfigStore | undefined;
  if (args.store !== undefined) {
    if (subject.configId === undefined) {
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
    if (!configs?.isSaved(subject.configId)) {
      process.stderr.write(
        `${args.store} holds no configuration ${subject.configId}: give the --store the run ` +
          'was made with.\n',
      );
      process.exit(2);
    }
  }
  let run = subject.run;

  const output = (
    status: ForgeUndoStatus,
    objects: ForgeUndoObjectResult[],
    planned: number,
    told: ConfigurationTold = {},
    sweep?: ForgeSweepResult,
    restored?: SyncRestoreObjectResult[],
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
            result: {
              status,
              planned,
              objects,
              ...told,
              ...(sweep ? { sweep } : {}),
              ...(restored ? { restored } : {}),
            },
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    // The sweep ran first, before the run's records went, and what the run
    // wrote over was given back before either.
    for (const line of sweep ? sweepLines(sweep) : []) say(line);
    for (const line of removalSummaryLines(status, objects)) say(line);
    for (const line of restored ? restoredLines(restored) : []) say(line);
    for (const line of configurationToldLines(subject.configId, told)) say(line);
    say(`\ndone in ${Date.now() - t0}ms`);
  };

  /** Whether the run's file names a Bulk API job that no line of it answers. */
  const jobsUnanswered = subject.runs !== undefined && (run.jobs ?? []).length > 0;
  // A sweep, or its listing, still has the run's window to look in; a job
  // no line answers, the records it created.
  if (
    syncRemovalPlan(run).length === 0 &&
    syncRestorePlan(run).length === 0 &&
    !jobsUnanswered &&
    !args.sweep &&
    !args.sweepList
  ) {
    const removedAt = earlier?.undo?.removedAt ?? earlier?.restoredAt;
    say(
      removedAt !== undefined
        ? `what the run created was removed already, on ${removedAt}`
        : 'The run created nothing: there is nothing of it to remove.',
    );
    output('success', [], 0);
    return;
  }

  const conn = makeConn(await loadOrg(args.target));
  const org = await typeTarget(conn);
  // A listing deletes nothing; a removal and a sweep delete, and are refused
  // before either reads anything outside a sandbox or a Developer Edition.
  const refusal = args.sweepList ? undefined : removalRefusal(args.target, org);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(1);
  }
  if (
    subject.targetOrgId !== undefined &&
    subject.targetOrgId.slice(0, 15) !== org.id.slice(0, 15)
  ) {
    process.stderr.write(
      `${args.target} is not the org the run wrote to (${subject.targetOrgId}), and what it ` +
        'created is removed from that org only. Nothing was deleted.\n',
    );
    process.exit(1);
  }
  // The Bulk API jobs the run's file names that no line of it answers: a
  // run killed, or ended by an error, while one ran. The job ran on to its
  // end in the target; read back by its id, what it created goes into the
  // run's file, and is removed with the rest.
  if (jobsUnanswered && subject.runs) {
    const runs = subject.runs;
    const answered = await answerJobsInFlight(runs, run, conn as unknown as IngestJobReading, () =>
      removalOrg(conn, 'sandforge-sync --remove').serverTime(),
    );
    for (const line of jobLines(answered, args.target)) say(line);
    if (answered.some((job) => job.answered)) run = (await runs.get(run.runId)) ?? run;
  }
  // A call the run had under way when it stopped that no job id names: a
  // REST call, whose records the org gave no id of before the run stopped.
  if (!run.end && run.inFlight && run.inFlight.job === undefined) {
    say(
      `  the run stopped during a call of ${run.inFlight.rows} ${run.inFlight.objectApiName} ` +
        `row(s): those ${args.target} took are not in its file, and stay; --sweep-list shows ` +
        "what the run's user created in the run's window",
    );
  }
  const plan = syncRemovalPlan(run);
  /**
   * What a sweep is told: the records the run created read back for its
   * window, as the panel's sweep reads them, and what the target's flows
   * create on their objects and on those whose records it wrote over. A run
   * that created nothing is dated by its writes, and its user read from the
   * records it wrote over, before their values are put back.
   */
  const sweepInput = async (signal?: AbortSignal) => {
    let automation: ForgeTargetAutomation | { error: string };
    try {
      automation = await targetAutomationReader(conn).read(args.target, [
        ...new Set(
          [...run.created, ...(run.overwritten ?? [])]
            .map((object) => object.objectApiName)
            .filter((name) => !SYNC_FILE_OBJECTS.includes(name)),
        ),
      ]);
    } catch (err: unknown) {
      automation = { error: err instanceof Error ? err.message : String(err) };
    }
    const org = removalOrg(conn, 'sandforge-sync --sweep');
    // From the run's first write to its last, as the panel's sweep looks: an
    // update before its first creation or after its last is the run's too.
    return seedSweepInput(
      org,
      run.created,
      automation,
      signal,
      run.firstWrittenAt !== undefined
        ? {
            at: run.firstWrittenAt,
            ...(run.lastWriteAt !== undefined ? { lastAt: run.lastWriteAt } : {}),
            serverTime: () => org.serverTime(),
          }
        : undefined,
      run.overwritten ?? [],
    );
  };

  if (args.sweepList) {
    // What a sweep would delete, read and said; nothing is deleted, the
    // run's own records included.
    const listing = await listSweep(
      removalOrg(conn, 'sandforge-sync --sweep-list'),
      await sweepInput(),
    );
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            tool: 'sandforge-sync',
            action: 'sweep-list',
            summary: args.summaryPath,
            target: args.target,
            listing,
            elapsedMs: Date.now() - t0,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      for (const line of sweepListingLines(listing, args.target)) say(line);
      say(`\ndone in ${Date.now() - t0}ms`);
    }
    return;
  }

  // What the run wrote over, given back before anything is deleted, from
  // the backup store it was kept in.
  const back = syncRestorePlan(run);
  let backups: BackupRecordStore | undefined;
  if (back.length > 0) {
    const backupDir = defaultBackupStoreOf();
    const refused = openBackupStore(backupDir);
    if (refused !== undefined) say(refused);
    else backups = new BackupRecordStore(nodeBackupFiles(backupDir));
  }
  say(`sandforge-sync --remove  ${args.summaryPath}  from ${args.target}`);
  for (const { objectApiName, ids } of back) {
    say(`  ${objectApiName}: ${ids.length} to give back their values from before the run`);
  }
  for (const { objectApiName, ids } of plan) say(`  ${objectApiName}: ${ids.length} to remove`);
  if (plan.length === 0 && back.length === 0) say('nothing left of the run to remove');
  if (args.sweep) {
    say(
      "before them, a sweep deletes what the target's automation created during the run, as " +
        "the run's user — run with --sweep-list to see what",
    );
  }

  // Ctrl-C stops the removal before its next call to the org, as Cancel does
  // in the panel; a SIGTERM or a SIGHUP does too.
  const stop = new AbortController();
  const releaseStop = onStopSignal(() => stop.abort());
  let state: SyncRunRemovalState = earlier ?? {};
  // The sweep comes before the run's records go, as the panel's does: a task
  // the target's automation opened on one of them would otherwise stay. The
  // removal makes it once it has read the run's records; what it is told is
  // read before anything is put back.
  const sweepMade: { result?: ForgeSweepResult } = {};
  const told = args.sweep ? await sweepInput(stop.signal) : undefined;
  const sweepFirst = told
    ? async (): Promise<boolean> => {
        sweepMade.result = await sweepRunRecords(removalOrg(conn, 'sandforge-sync --sweep'), told, {
          includeChanged: args.includeChanged,
          // What the earlier removals of the run changed while they ran is no
          // change since the run.
          removalSpans: state.removalSpans ?? [],
          // What it found, said before the first delete: --sweep asked for it.
          approve: async (listing) => {
            say('');
            for (const line of sweepListingLines(listing, args.target)) say(line);
            return undefined;
          },
        });
        return sweepMade.result.objects.some((object) => object.deleted > 0);
      }
    : undefined;
  let outcome: Awaited<ReturnType<typeof removeSyncRun>>;
  try {
    outcome = await removeSyncRun({
      run,
      org: removalOrg(conn, 'sandforge-sync --remove'),
      includeChanged: args.includeChanged,
      ...(sweepFirst ? { sweep: sweepFirst } : {}),
      signal: stop.signal,
      // The configuration's store, told what the removal took: its
      // watermarks and copied files, and which records its runs wrote.
      ...(configs && args.store !== undefined ? { configs, links: nodeSyncIdMap(args.store) } : {}),
      ...(backups ? { backups } : {}),
      store: {
        // Kept beside the summary, or beside the run's file, whatever the
        // removal ended on.
        updateRemoval: (_runId, change) =>
          subject.updateRemoval((kept) => {
            state = change(kept);
            return state;
          }),
      },
    });
  } finally {
    releaseStop();
  }
  for (const note of outcome.notes) process.stderr.write(`${note}\n`);
  const took = outcome.result.objects.some((o) => o.deleted + o.alreadyGone > 0);
  if (subject.configId !== undefined && !configs && took) {
    process.stderr.write(
      `The run was of the saved configuration ${subject.configId}, and its store was not given: ` +
        'its next delta run is not told what this removal took, and a later run may point a ' +
        'lookup at a record it deleted. Give --store with the next removal, or run the ' +
        'configuration full next time.\n',
    );
  }
  const { readWhole, filesForgotten } = outcome.result;
  const sweep = sweepMade.result;
  output(
    outcome.result.status,
    outcome.result.objects,
    outcome.planned,
    {
      ...(readWhole ? { readWhole } : {}),
      ...(filesForgotten !== undefined ? { filesForgotten } : {}),
      ...(outcome.linksForgotten !== undefined ? { linksForgotten: outcome.linksForgotten } : {}),
    },
    sweep,
    outcome.result.restored,
  );
  if (outcome.result.status !== 'success' || (sweep && sweep.status !== 'success')) {
    process.exit(RECORDS_LEFT_EXIT);
  }
}

// `tsx` runs this file directly; the import check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-sync')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { jsforce };
