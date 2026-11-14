#!/usr/bin/env tsx
/**
 * sandforge-backup — headless DataOps runner: take a snapshot, restore one.
 *
 * The fifth of these. The four before it found twenty-three defects between
 * them, every one against a real org and none against any gate.
 *
 * DataOps is the one module whose failure could cost data rather than refuse
 * to write it, so this runs the real handler rather than a copy of its logic:
 * `DataOpsHandler` holds the whole flow (there is no orchestrator to inject),
 * so what it needs is stood up around it — an org manager and registry backed
 * by the `sf` CLI, a config store backed by a JSON file, and a broker that
 * prints what the panel would have received.
 *
 * A restore is an upsert on `Id`: it overwrites the fields of records that are
 * there, and first brings back from the recycle bin the ones deleted since the
 * snapshot. A record no longer in the bin cannot come back with its Id, and
 * the restore says so. It never deletes. `--restore` still
 * asks before it writes unless `--yes` is given.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-backup.ts \
 *     --org TGT --object Account --object Contact
 *   pnpm exec tsx packages/extension/cli/sandforge-backup.ts --list [--org TGT]
 *   pnpm exec tsx packages/extension/cli/sandforge-backup.ts --org TGT --restore <id> --yes
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import {
  defaultBackupStoreOf,
  expiredLine,
  maxAgeDaysOf,
  openBackupStore,
  restoredSliceLines,
  restoreTargetOf,
  setExpiresAt,
  setLine,
  setsOfStore,
  settingsOf,
  slicesNamed,
  valuesOf,
} from './backupStore.js';
import { join } from 'node:path';
import type {
  BackupSetSummary,
  DataOpsAutomationAnswer,
  DataOpsWriteAccord,
  SliceSetResult,
} from '@sandforge/shared';
import { BACKUP_MAX_RECORDS_PER_OBJECT, orgTypeOf } from '@sandforge/shared';
import {
  accordOf,
  dataOpsAutomationHelp,
  DATAOPS_AUTOMATION_SWITCHES,
} from './dataOpsAutomationCli.js';
import { refusedLine } from './runRefused.js';
import { loadOrg } from './sfSession.js';
import { fileConfigStore } from './fileConfigStore.js';
import { DataOpsHandler } from '../src/bridge/handlers/DataOpsHandler.js';
import { BackupRecordStore, nodeBackupFiles } from '../src/modules/dataops/BackupRecordStore.js';
import { backupMaxAgeDays } from '../src/modules/dataops/backupRetention.js';
import { backupSetSummaryOf, type BackupSet } from '../src/modules/dataops/slices/backupSet.js';
import { fileRunKeys } from '../src/modules/dataops/slices/runKeyStore.js';
import { isSafeSoqlWhere, SOQL_WHERE_RULE } from '../src/core/common/soqlValidator.js';
import { nodeSyncRunCreations } from '../src/modules/sync/SyncRunCreations.js';
import { journalDirOf } from './sandforge-clone.js';
import { commandLineGuard } from './commandLineGuard.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { confirm } from './prompt.js';
import { endWith, PARTIAL_EXIT, restoreExitCode } from './exitCodes.js';
import { AuthProvider } from '../src/core/connection/AuthProvider.js';
import type { ReplacedOrgRestoreQuestion } from '../src/bridge/handlers/HandlerTypes.js';
import { holdOutputWhole } from './wholeOutput.js';
import { commandOf } from './invocation.js';

const HELP = `sandforge backup — take and restore DataOps snapshots, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-backup.ts --org <alias> [options]
  pnpm exec tsx packages/extension/cli/sandforge-backup.ts --list [--org <alias>]

Required:
  --org <alias>          sf CLI alias of the org (--list: every org of the
                         store without it)

One of:
  --object <ApiName>     object to snapshot; repeat for more
  --list                 name the snapshots kept in the store, each with the
                         org it was taken of, then stop: the org's with --org
                         (those taken under its alias, and the others of the
                         same Organization Id), every org's without it; a set
                         of slices in one line, whatever its slices, with when
                         the retention removes it. It reads the store alone and
                         contacts no org
  --restore <id>         upsert a snapshot back into the org by record Id: a
                         snapshot's id, or a set of slices', every slice not
                         put back yet, in their order; stopped part way, the
                         same line puts back the rest
  --delete <id>          delete a snapshot, or a set of slices with every slice
                         and the key it holds, from the store; repeat for more.
                         A slice is deleted with its set. It contacts no org

Options:
  --where <Object>:<clause>
                         with --object: snapshot only the records of that object
                         the SOQL condition selects, written without WHERE, as
                         --where "Contact:CreatedDate >= 2025-01-01T00:00:00Z";
                         read up to its first colon, the object's name. One per
                         object; the snapshot holds the records under it, not
                         the object, and says so
  --slices               with --object: back each object up in slices of
                         --max-records records, consecutive by Id, each a
                         snapshot of its own, listed and restored as one set:
                         an object past what one snapshot holds is backed up
                         whole
  --store <dir>          where snapshots live, a folder of your own
                         (default: ~/.sandforge/backups, under the folder
                         SANDFORGE_JOURNAL_DIR names when it is set)
  --max-records <n>      most records of each object a snapshot reads, as
                         sandforge.backup.maxRecordsPerObject sets it; with
                         --slices, the records of a slice (default: 50000; 100
                         to 1000000)
  --slice <k[,k]>        with --restore of a set of slices: only these slices, by
                         their number, put back again if they were already
  --rewrite-all          with --restore: write every row of the snapshot back,
                         the ones the org already holds as the snapshot does
                         included; of a set, every slice, those put back
                         already too
  --include-changed      with --restore of the snapshot a Sync run kept: put
                         back the records changed or deleted since the run too
${dataOpsAutomationHelp('written back')}  --max-age-days <n>     the retention, as sandforge.backup.maxAgeDays sets it:
                         snapshots taken more than <n> days ago are removed as
                         the command starts, each named on stderr — the one a
                         Sync run kept of what it wrote over too, which removing
                         that run then no longer puts back; 0 keeps them all
                         (default: 30)
  --yes                  do not ask before a restore writes. Without it, a
                         command with no terminal to answer the question — a
                         CI step — stops there, exit 2, and writes nothing.
                         Into an org that is not the one the snapshot was
                         taken of — a sandbox refreshed since — --yes counts
                         as no, exit 1: run it without --yes, in a terminal
  --json                 emit what the panel would receive, or with --list the
                         snapshots, every other line on stderr
  --help                 this text

A restore never deletes: it upserts on Id, so it overwrites the fields of
records that are there, after bringing back from the recycle bin the ones
deleted since the snapshot. It reads the org's values first and writes only
the rows where one of them differs from the snapshot, and says how many it
found unchanged; --rewrite-all writes them all. Of the snapshot a Sync run
kept of what it wrote over, the records changed or deleted since the run —
read against the run's file in SANDFORGE_JOURNAL_DIR — are left as they are
and counted, as removing the run with sandforge sync leaves them unless it
is told to include them; --include-changed includes them here.

Before it asks or writes, a restore says what the org runs as the records are
brought back from the recycle bin and written back — its record-triggered
flows, Apex triggers, processes and workflow rules on update and undelete —,
the emails that sends against what the org has left today, and whether the
org delivers them.

A snapshot says its id, which --restore takes, and what it holds short of the
org: an object stopped at --max-records, or never reached. A set of slices
says its id and its slices; a slice the org would not read whole, even read in
smaller parts, stops it there, and the set is listed as partial.

Exit codes: 0 the run finished: the snapshot holds every record of its objects,
or the restore put back every value, or the snapshots were deleted; 1 it could
not start, or the snapshot or
the restore failed or was refused — what the org runs as it writes, without
--accept-automation (AUTOMATION_NOT_ACCEPTED), emails it delivers, without
--accept-emails (EMAILS_NOT_ACCEPTED), more emails than it has left today
(EMAILS_EXCEEDED), or a mute refused among the reasons; 2 a bad command line, or a question with no
terminal to answer it (give --yes); 3 the snapshot holds part of an object's
records — a set of slices stopped short among them —, or the restore left
values as they are (rows the org refused, a
snapshot that holds part of the records, or records of a Sync run's snapshot
changed since the run, held back without --include-changed).
`;

/**
 * Everything the command line settled. A listing alone may name no org: it
 * then lists every org's snapshots.
 */
type CliArgs = CommonArgs & ({ list: true; org?: string } | { list: false; org: string });

/** What the command line settles whatever it asks. */
interface CommonArgs {
  objects: string[];
  /** Per object, the records its snapshot keeps; every record of an object it names none for. */
  wheres?: Record<string, string>;
  /** Back each object up in slices of `maxRecords` records, a snapshot each. */
  slices: boolean;
  restoreId?: string;
  /** Of a restore of a set of slices, the slices to put back, by their number. */
  restoreSlices?: number[];
  /** The snapshots and sets to delete from the store. */
  deleteIds?: string[];
  storeDir: string;
  /** The cap of records per object a snapshot reads, when the line sets one. */
  maxRecords?: number;
  /** A restore writes every row back, without comparing it with the org's. */
  rewriteAll: boolean;
  /** A restore of a Sync run's snapshot puts back the records changed since the run too. */
  includeChanged: boolean;
  /** The retention, in days, when the line sets one; 0 keeps every snapshot. */
  maxAgeDays?: number;
  yes: boolean;
  json: boolean;
  /** What a restore accepts of what the org runs as it writes, and the mute it asks for. */
  accord: DataOpsWriteAccord;
}

/** SObject API name — letter-prefixed, alphanumeric and underscore. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** What the line reads. */
const FLAGS: CommandFlags = {
  switches: [
    '--list',
    '--slices',
    '--rewrite-all',
    '--include-changed',
    '--yes',
    '--json',
    ...DATAOPS_AUTOMATION_SWITCHES,
  ],
  values: [
    '--org',
    '--object',
    '--where',
    '--restore',
    '--slice',
    '--delete',
    '--store',
    '--max-records',
    '--max-age-days',
  ],
};

/** Say why the line cannot be read, and stop. */
function refuseLine(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * The filters `--where <Object>:<clause>` give, by object: read up to the
 * first colon, since a date and time in the clause holds two
 * (`Contact:CreatedDate >= 2025-01-01T08:00:00Z`). Each names an object the
 * line backs up, once, and holds a condition a filter may be. Stops the
 * command, exit 2, on one that does not. Exported so it can be tested.
 *
 * @param objects - The objects the line backs up.
 */
export function wheresOf(
  values: readonly string[],
  objects: readonly string[],
): Record<string, string> {
  const wheres: Record<string, string> = {};
  for (const value of values) {
    const colon = value.indexOf(':');
    const named = colon > 0 ? value.slice(0, colon).trim() : '';
    const clause = colon > 0 ? value.slice(colon + 1).trim() : '';
    if (!API_NAME_RE.test(named) || clause === '') {
      refuseLine(
        `Not a filter --where can take: "${value}". Give the object, a colon and the ` +
          'condition, as --where "Contact:CreatedDate >= 2025-01-01T00:00:00Z".',
      );
    }
    const object = objects.find((o) => o.toLowerCase() === named.toLowerCase());
    if (object === undefined) {
      refuseLine(
        `--where names ${named}, which the line does not back up: give it with --object ${named}.`,
      );
    }
    if (wheres[object] !== undefined) {
      refuseLine(`Give one --where per object: ${object} is given two.`);
    }
    if (!isSafeSoqlWhere(clause)) {
      refuseLine(`Not a filter --where can take: "${clause}". ${SOQL_WHERE_RULE}`);
    }
    wheres[object] = clause;
  }
  return wheres;
}

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  // A flag it does not read, `--yes=true` or a misspelt one, was dropped without a word.
  refuseUnreadArguments(args, FLAGS);
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

  const org = get('--org');
  const list = args.includes('--list');
  // A listing reads the store alone: without --org, every org's snapshots.
  if (!org && !list) {
    process.stderr.write('Missing --org. Run with --help.\n');
    process.exit(2);
  }
  const objects = collect('--object');
  const restoreId = get('--restore');
  const deleteIds = collect('--delete');

  const asked = [objects.length > 0, list, restoreId !== undefined, deleteIds.length > 0].filter(
    Boolean,
  ).length;
  if (asked === 0) {
    process.stderr.write('Nothing to do: give --object, --list, --restore or --delete.\n');
    process.exit(2);
  }
  if (asked > 1) {
    // Several answers to "what should this run do" is one too many.
    process.stderr.write('Give one of --object, --list, --restore or --delete.\n');
    process.exit(2);
  }
  for (const name of objects) {
    if (!API_NAME_RE.test(name)) {
      process.stderr.write(`Not an SObject API name: "${name}"\n`);
      process.exit(2);
    }
  }
  for (const id of deleteIds) {
    // An id as a snapshot or a set is named: no colon, which the keys of a
    // snapshot's records add after it, and nothing a path would read.
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) refuseLine(`Not a snapshot's id: "${id}"`);
  }
  const whereValues = valuesOf(args, '--where');
  const slices = args.includes('--slices');
  if ((whereValues.length > 0 || slices) && objects.length === 0) {
    refuseLine(
      `${whereValues.length > 0 ? '--where' : '--slices'} goes with --object: it says how the ` +
        'objects a snapshot reads are read.',
    );
  }
  const wheres = wheresOf(whereValues, objects);
  const sliceValues = valuesOf(args, '--slice');
  if (sliceValues.length > 0 && restoreId === undefined) {
    refuseLine(
      '--slice goes with --restore: it names the slices of a set to put back. A backup in ' +
        'slices is --slices.',
    );
  }
  const cap = get('--max-records');
  if (cap !== undefined && !/^[1-9]\d*$/.test(cap)) {
    process.stderr.write(`Not a number of records: "${cap}"\n`);
    process.exit(2);
  }
  const rewriteAll = args.includes('--rewrite-all');
  if (rewriteAll && restoreId === undefined) {
    process.stderr.write('--rewrite-all goes with --restore.\n');
    process.exit(2);
  }
  const includeChanged = args.includes('--include-changed');
  if (includeChanged && restoreId === undefined) {
    process.stderr.write('--include-changed goes with --restore.\n');
    process.exit(2);
  }
  const maxAgeDays = maxAgeDaysOf(get('--max-age-days'));
  const accord = accordOf(args);
  const given = DATAOPS_AUTOMATION_SWITCHES.filter((flag) => args.includes(flag));
  if (given.length > 0 && restoreId === undefined) {
    process.stderr.write(
      `${given.join(', ')} go${given.length === 1 ? 'es' : ''} with --restore.\n`,
    );
    process.exit(2);
  }

  const common: CommonArgs = {
    objects,
    ...(Object.keys(wheres).length > 0 ? { wheres } : {}),
    slices,
    restoreId,
    ...(sliceValues.length > 0 ? { restoreSlices: slicesNamed(sliceValues) } : {}),
    ...(deleteIds.length > 0 ? { deleteIds } : {}),
    storeDir: get('--store', defaultBackupStoreOf()) ?? '',
    ...(cap !== undefined ? { maxRecords: Number(cap) } : {}),
    rewriteAll,
    includeChanged,
    ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
    accord,
  };
  // Only a listing gets here without an org.
  if (!org) return { ...common, list: true };
  return list ? { ...common, list: true, org } : { ...common, list: false, org };
}

/** Run one DataOps operation; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  // On stderr with --json, where stdout carries the JSON alone: dropped there,
  // the guard's refusal said nothing at all.
  const log = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };

  const refused = openBackupStore(args.storeDir);
  if (refused !== undefined) {
    process.stderr.write(`${refused}\n`);
    process.exitCode = 1;
    return;
  }
  // Said first, as the clone command says where its journal goes: the
  // snapshots hold the records' values, and the user should know where.
  log(`store: ${args.storeDir}`);
  const configStore = fileConfigStore(join(args.storeDir, 'snapshots.json'));

  if (args.list) {
    // The store alone, before any org is reached: a listing asked for the
    // org's session first, then named every org's snapshots all the same.
    // A slice is listed with its set, one line whatever its slices.
    const kept = configStore
      .getKeysByPrefix('backup:')
      .filter((key) => !key.slice('backup:'.length).includes(':'))
      .map((key) => configStore.get(key) as ListedSnapshot)
      .filter((meta) => meta.origin !== 'slice');
    const snapshots = args.org !== undefined ? snapshotsOf(kept, args.org) : kept;
    const allSets = setsOfStore(configStore);
    const sets = args.org !== undefined ? snapshotsOf(allSets, args.org) : allSets;
    const days = backupMaxAgeDays({ getSandforgeSetting: settingsOf(args) });
    // Printed before the JSON did: `--list --json` printed nothing at all, and
    // a pipeline could not read which snapshot to restore.
    if (args.json) {
      process.stdout.write(`${JSON.stringify(snapshotListing(snapshots, sets, days), null, 2)}\n`);
      return;
    }
    if (snapshots.length === 0 && sets.length === 0) {
      log(
        args.org !== undefined
          ? `No snapshot of ${args.org} in this store.`
          : 'No snapshot in this store.',
      );
    }
    for (const line of snapshots.map(snapshotLine)) log(line);
    if (sets.length > 0) log('sets of slices, each restored and deleted whole:');
    for (const set of sets) log(`  ${setLine(set, days)}`);
    return;
  }

  // What the panel would have received, printed instead of posted.
  const posted: Array<Record<string, unknown>> = [];

  if (args.deleteIds) {
    // From the store alone: an org deleted since, or a sandbox refreshed,
    // leaves backups no session reaches, and they are the first to go.
    const handler = await handlerOf(args, configStore, log, posted);
    const id = `cli-delete-${Date.now()}`;
    await handler.handle({
      id,
      type: 'backup:delete',
      payload: { orgId: args.org, operationIds: args.deleteIds },
    } as never);
    const answer = posted.find((message) => message.correlationId === id);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ tool: 'sandforge-backup', posted }, null, 2)}\n`);
    }
    if (answer?.type !== 'backup:delete:result') {
      process.exitCode = 1;
      return;
    }
    const deleted = ((answer.payload as { deleted?: string[] } | undefined)?.deleted ?? []).filter(
      (each) => args.deleteIds?.includes(each),
    );
    for (const each of deleted) log(`deleted ${each}`);
    const missing = args.deleteIds.filter((each) => !deleted.includes(each));
    if (missing.length > 0) {
      process.stderr.write(
        `No snapshot or set ${missing.join(', ')} of ${args.org} in ${args.storeDir}: nothing ` +
          `deleted for ${missing.length === 1 ? 'it' : 'them'}. "${commandOf('backup')} --list ` +
          `--org ${args.org} --store ${args.storeDir}" names those it keeps.\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  const org = await loadOrg(args.org);

  // Typed as the extension types an org it connects (`orgTypeOf`): its
  // `Organization` record, `IsSandbox` and its edition. Handed neither, the
  // Production Guard took every org for a production one, and a restore into
  // a Developer Edition or a sandbox was refused as one into production:
  // `--restore` wrote nowhere.
  const identity = await new AuthProvider().validateConnection(org.accessToken, org.instanceUrl);
  const typed = {
    alias: org.alias,
    orgType: orgTypeOf({ isSandbox: identity.isSandbox, edition: identity.orgType }),
    metadata: { apiVersion: '66.0', edition: identity.orgType },
  };
  const handler = await handlerOf(args, configStore, log, posted, { typed, session: org });

  /** The answer the handler posted for a request, by its id. */
  const answerTo = (id: string): Record<string, unknown> | undefined =>
    posted.find((message) => message.correlationId === id);

  if (args.restoreId) {
    // A snapshot, or a set of slices, the slices it puts back counted as the
    // restore chooses them.
    const target = restoreTargetOf(configStore, args.restoreId, {
      ...(args.restoreSlices ? { slices: args.restoreSlices } : {}),
      rewriteAll: args.rewriteAll,
    });
    if (!target) {
      // Said with where it looked alone, the store a CI job's cache restores
      // under another name read as a snapshot lost.
      process.stderr.write(
        `No snapshot "${args.restoreId}" in ${args.storeDir}. "${commandOf('backup')} --list ` +
          `--org ${args.org} --store ${args.storeDir}" names those it keeps; a snapshot taken ` +
          'with another --store, or with SANDFORGE_JOURNAL_DIR set otherwise, is restored with ' +
          'that --store. Nothing was written.\n',
      );
      process.exit(1);
    }
    // What the org runs as the restore brings records back from the recycle
    // bin and writes the snapshot's values over them, said before the
    // question, and refused before it unless accepted: a restore fired the
    // org's update flows on every record it put back, unasked.
    const readId = `cli-restore-automation-${Date.now()}`;
    await handler.handle({
      id: readId,
      type: 'dataops:automation',
      payload: {
        orgId: args.org,
        act: 'restore',
        objects: target.objects,
        ...args.accord,
      },
    } as never);
    const read = answerTo(readId);
    if (read?.type !== 'dataops:automation:response') {
      process.exitCode = 1;
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ tool: 'sandforge-backup', posted }, null, 2)}\n`);
      }
      return;
    }
    const automation = read.payload as DataOpsAutomationAnswer;
    for (const line of automation.lines) log(line);
    if (automation.refusals.length > 0) {
      for (const refusal of automation.refusals) process.stderr.write(`${refusedLine(refusal)}\n`);
      process.exitCode = 1;
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ tool: 'sandforge-backup', posted }, null, 2)}\n`);
      }
      return;
    }
    if (!args.yes) {
      const ok = await confirm(
        `Upsert ${target.words} back into ${args.org}? ${target.totalRecords} record(s) with ` +
          'these Ids will have their fields overwritten.',
      );
      if (!ok) {
        log('Nothing written.');
        return;
      }
    }
    log(
      `restoring ${args.restoreId} into ${args.org}` +
        `${args.rewriteAll ? ', every row written back' : ''}…`,
    );
    await handler.handle({
      id: `cli-restore-${Date.now()}`,
      type: 'dataops:rollback',
      payload: {
        orgId: args.org,
        operationId: args.restoreId,
        ...(args.rewriteAll ? { rewriteAll: true } : {}),
        ...(args.includeChanged ? { includeChanged: true } : {}),
        ...(args.restoreSlices ? { slices: args.restoreSlices } : {}),
        ...args.accord,
      },
    } as never);
    // What the restore wrote, refused and found unchanged, as the panel hears it.
    const answer = posted.find((message) => message.type === 'dataops:rollback:response');
    const payload = (answer?.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.message === 'string') log(payload.message);
    for (const line of restoredSliceLines(payload)) log(line);
    // Rows the org refused, or a snapshot holding part of the records, left
    // values as they are: the restore exited 0 as one that put them all back.
    if (answer) endWith(restoreExitCode(payload));
  } else {
    log(
      `snapshot ${args.org}: ${args.objects
        .map((o) => `${o}${args.wheres?.[o] !== undefined ? ` (where ${args.wheres[o]})` : ''}`)
        .join(', ')}${args.slices ? ', in slices' : ''}`,
    );
    await handler.handle({
      id: `cli-backup-${Date.now()}`,
      type: 'backup:execute',
      payload: {
        orgId: args.org,
        objects: args.objects,
        ...(args.wheres ? { wheres: args.wheres } : {}),
        ...(args.slices ? { slices: true } : {}),
      },
    } as never);
    // The snapshot's id, which --restore takes, and what it holds short of
    // the org: a snapshot cut at --max-records said only the type of the last
    // message, and exited 0.
    const answer = posted.find((message) => message.type === 'dataops:backup:response');
    if (answer) {
      const taken = snapshotTaken((answer.payload ?? {}) as TakenSnapshot);
      log(taken.line);
      endWith(taken.exitCode);
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ tool: 'sandforge-backup', posted }, null, 2)}\n`);
    return;
  }
  const last = posted[posted.length - 1];
  if (last) log(`\nlast message: ${String(last.type)}`);
}

/**
 * The real handler, stood up for the line: the org it reaches, when the
 * command reaches one — a deletion reaches none —, the store's snapshots,
 * the keys of its sets and the Sync runs kept here, its retention run to its
 * end before anything else.
 */
async function handlerOf(
  args: CliArgs,
  configStore: ReturnType<typeof fileConfigStore>,
  log: (line: string) => void,
  posted: Array<Record<string, unknown>>,
  reached?: {
    typed: { alias: string; orgType: unknown; metadata: unknown };
    session: { accessToken: string; instanceUrl: string };
  },
): Promise<DataOpsHandler> {
  const handler = new DataOpsHandler({
    log: (message: string) => log(`  ${message}`),
    broker: {
      postToWebview: (message: Record<string, unknown>) => {
        posted.push(message);
        const type = String(message.type ?? '');
        if (type.endsWith(':error') || type.includes('failed')) {
          log(`  ! ${JSON.stringify(message.payload ?? message)}`);
          // A snapshot or a restore the handler refused or failed: the run
          // did not do what it was asked, whatever else it said.
          process.exitCode = 1;
        }
      },
    },
    orgManager: { getOrg: () => reached?.typed },
    orgRegistry: {
      getCredentials: async () => {
        if (!reached) throw new Error('This command reaches no org.');
        return {
          accessToken: reached.session.accessToken,
          instanceUrl: reached.session.instanceUrl,
        };
      },
    },
    configStore,
    // The settings a snapshot and the retention read, as the line sets
    // them; every other one takes the extension's default.
    services: { getSandforgeSetting: settingsOf(args) },
    infraServices: {
      // A restore refuses to write without the guard, as in the extension.
      productionGuard: commandLineGuard(log, args.org ?? ''),
      // A snapshot of the org an alias reached before a refresh goes into the
      // org it reaches now only on a yes typed here: `--yes` answers the
      // question asked before the restore, not this one, and counts as no.
      // Said: the restore was refused "not confirmed", and a CI job given
      // --yes could not tell why, nor that only a terminal answers it.
      confirmRestoreIntoReplacedOrg: (question: ReplacedOrgRestoreQuestion): Promise<boolean> => {
        if (args.yes) {
          process.stderr.write(`${replacedOrgYesWords(question)}\n`);
          return Promise.resolve(false);
        }
        return confirm(
          `${question.alias} answered as org ${question.backedUpFrom} when this snapshot was ` +
            `taken and answers as org ${question.now} now. Write its saved values into the org ` +
            'it is now?',
        );
      },
    },
    // Built rather than stubbed: the handler stamps every message it posts
    // with one, and a message with no id settles nothing on the other side.
    nextId: () => `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } as never);
  // Every snapshot the retention removes is said on stderr, the one a Sync
  // run kept named: a nightly snapshot removed the values a run had written
  // over, which its removal then could not put back, with one log line.
  handler.setExpiryListener((expired) => process.stderr.write(`${expiredLine(expired)}\n`));
  // The keys of the masking runs in slices `sandforge dataops` left in this
  // store go with their sets, deleted or removed by the retention.
  handler.setRunKeyStore(fileRunKeys(args.storeDir));
  // The store takes its own file operations; here, as in the extension, they
  // are Node's, under the directory given. Its retention runs first, to its end.
  handler.setBackupRecordStore(new BackupRecordStore(nodeBackupFiles(args.storeDir)));
  await handler.swept();
  // The Sync runs the command line kept: a restore of a run's snapshot reads
  // when the run last wrote, and leaves what changed since as it is.
  handler.setSyncRuns(nodeSyncRunCreations(journalDirOf()));
  return handler;
}

/** A snapshot as the store lists it. */
interface ListedSnapshot {
  operationId: string;
  timestamp: string;
  /** The alias the snapshot was taken under. */
  orgId?: string;
  /** The Organization Id the org answered with; absent from snapshots taken before it was recorded. */
  organizationId?: string;
  totalRecords: number;
  status?: string;
  /** `slice` for a slice of a set, listed with its set. */
  origin?: string;
  objects: Array<{
    objectApiName: string;
    recordCount: number;
    orgCount?: number;
    stoppedAt?: string;
    /** The filter the snapshot held the object's records to. */
    where?: string;
  }>;
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/**
 * The snapshots of the org `org` names, read from the store alone: those
 * taken under that alias, and every other one of the Organization Id one of
 * them was taken of — the org under another alias — as `sandforge-checkpoint
 * list` reads an org's checkpoints. A set of slices is read the same way.
 */
function snapshotsOf<T extends { orgId?: string; organizationId?: string }>(
  snapshots: readonly T[],
  org: string,
): T[] {
  const ids = snapshots.flatMap((meta) =>
    meta.orgId === org && meta.organizationId !== undefined ? [meta.organizationId] : [],
  );
  return snapshots.filter(
    (meta) => meta.orgId === org || ids.some((id) => sameOrganization(id, meta.organizationId)),
  );
}

/** One snapshot of the listing, as a line; `Contact:500/1234(cap)` for an object it holds part of. */
function snapshotLine(meta: ListedSnapshot): string {
  const held = meta.objects.map(
    (o) =>
      `${o.objectApiName}:${o.recordCount}` +
      (o.stoppedAt !== undefined ? `/${o.orgCount ?? '?'}(${o.stoppedAt})` : '') +
      (o.where !== undefined ? `(where ${o.where})` : ''),
  );
  return (
    `${meta.operationId}  ${meta.timestamp}  ${meta.orgId ?? '?'}  ${meta.totalRecords} record(s)` +
    `${meta.status === 'failed' ? ' failed part-way' : ''}  ${held.join(' ')}`
  );
}

/**
 * What a restore given `--yes` is told when the org its alias reaches is no
 * longer the org the snapshot was taken of — a sandbox refreshed since:
 * `--yes` answers the question every restore asks, never this one, and counts
 * as no; only a person at a terminal answers it. Exported so it can be tested.
 */
export function replacedOrgYesWords(question: ReplacedOrgRestoreQuestion): string {
  return (
    `${question.alias} answered as org ${question.backedUpFrom} when this snapshot was taken, ` +
    `and answers as org ${question.now} now: a sandbox refreshed since, or another org. ` +
    "--yes does not answer whether to write the snapshot's values into the org it is now, and " +
    'counts as no: nothing is written. Run the restore again without --yes, in a terminal, ' +
    'to answer it.'
  );
}

/**
 * The listing as `--list --json` prints it: the snapshots, and the sets of
 * slices, each with its slices and when the retention removes it, when the
 * store keeps any. Exported so it can be tested.
 *
 * @param days - The retention, in days; 0 keeps every backup.
 */
export function snapshotListing(
  snapshots: readonly ListedSnapshot[],
  sets: readonly BackupSet[] = [],
  days = 0,
): {
  tool: 'sandforge-backup';
  snapshots: ListedSnapshot[];
  sets?: Array<BackupSetSummary & { expiresOn?: string }>;
} {
  return {
    tool: 'sandforge-backup',
    ...(sets.length > 0
      ? {
          sets: sets.map((set) => {
            const expiresOn = setExpiresAt(set, days);
            return {
              ...backupSetSummaryOf(set),
              ...(set.organizationId !== undefined ? { organizationId: set.organizationId } : {}),
              ...(expiresOn !== undefined ? { expiresOn } : {}),
            };
          }),
        }
      : {}),
    snapshots: snapshots.map((meta) => ({
      operationId: meta.operationId,
      timestamp: meta.timestamp,
      // Which org each is of: without --org, the listing names every org's.
      ...(meta.orgId !== undefined ? { orgId: meta.orgId } : {}),
      ...(meta.organizationId !== undefined ? { organizationId: meta.organizationId } : {}),
      totalRecords: meta.totalRecords,
      ...(meta.status !== undefined ? { status: meta.status } : {}),
      objects: meta.objects,
    })),
  };
}

/** A snapshot as the handler answers it once taken. */
interface TakenSnapshot {
  operationId?: unknown;
  totalRecords?: unknown;
  partial?: unknown;
  /** Of a backup in slices, its set. */
  slices?: SliceSetResult;
  objects?: Array<{
    objectApiName: string;
    recordCount: number;
    truncated?: boolean;
    orgCount?: number;
    stoppedAt?: string;
  }>;
}

/**
 * What a snapshot taken says, and the code it leaves: 3 when it holds fewer
 * records of an object than the org has — stopped at --max-records, or before
 * the object — since a restore of it puts back only those. Exported so it can
 * be tested.
 */
export function snapshotTaken(payload: TakenSnapshot): { line: string; exitCode: number } {
  const id = String(payload.operationId ?? '?');
  const short = (payload.objects ?? []).filter((o) => o.truncated === true);
  if (payload.slices !== undefined) return setTaken(payload.slices, short);
  const head = `snapshot ${id}: ${String(payload.totalRecords ?? 0)} record(s)`;
  if (payload.partial !== true && short.length === 0) {
    return { line: `${head} (--restore ${id} puts them back)`, exitCode: 0 };
  }
  const objects = short.map(
    (o) =>
      `${o.objectApiName} ${o.recordCount} of ${o.orgCount ?? '?'}` +
      (o.stoppedAt !== undefined ? ` (${o.stoppedAt})` : ''),
  );
  return {
    line:
      `${head} (partial: ${objects.join(', ') || 'an object holds fewer records than the org'})` +
      partialWords(short),
    exitCode: PARTIAL_EXIT,
  };
}

/**
 * What a backup in slices says once taken: its set, its slices and records,
 * and the restore that takes it; stopped short — a slice the org would not
 * read whole, a Ctrl-C —, the objects it did not read to their end, exit 3.
 */
function setTaken(
  set: SliceSetResult,
  short: NonNullable<TakenSnapshot['objects']>,
): { line: string; exitCode: number } {
  const slices = set.objects.flatMap((o) => o.slices);
  const records = slices.reduce((sum, s) => sum + s.rows, 0);
  const head =
    `set ${set.setId}: ${records} record(s) in ${slices.length} slice(s) of up to ${set.size}` +
    (slices.length > 0 ? ` (--restore ${set.setId} puts them back)` : '');
  if (set.state === 'done' && short.length === 0) return { line: head, exitCode: 0 };
  return {
    line:
      `${head}, partial: ${short.map((o) => o.objectApiName).join(', ') || 'an object'} not ` +
      'read to its end, its reason above. The same line takes a new set of every record',
    exitCode: PARTIAL_EXIT,
  };
}

/**
 * What takes the rest of each object a snapshot holds part of: `--max-records`
 * as high as the org's count, up to what a snapshot reads of one object, or
 * `--slices`; past it, `--slices`, a set of snapshots of one object each; and
 * a run again for an object a stopped or failed run never reached. It said
 * "partial" and nothing more, then sent the user out of SandForge, to Data
 * Export or the Bulk API.
 */
function partialWords(short: NonNullable<TakenSnapshot['objects']>): string {
  const capped = short.filter((o) => o.stoppedAt === 'cap' && o.orgCount !== undefined);
  const raisable = capped.filter((o) => (o.orgCount ?? 0) <= BACKUP_MAX_RECORDS_PER_OBJECT);
  const past = capped.filter((o) => (o.orgCount ?? 0) > BACKUP_MAX_RECORDS_PER_OBJECT);
  const words: string[] = [];
  if (raisable.length > 0) {
    const most = Math.max(...raisable.map((o) => o.orgCount ?? 0));
    words.push(
      `--max-records ${most} takes ${raisable.map((o) => o.objectApiName).join(', ')} whole, ` +
        'or --slices takes it in slices of --max-records records, listed and restored as one set',
    );
  }
  if (past.length > 0) {
    const names = past.map((o) => o.objectApiName).join(', ');
    words.push(
      `No snapshot holds more than ${BACKUP_MAX_RECORDS_PER_OBJECT} records of one object: ` +
        `${names} ${past.length === 1 ? 'is' : 'are'} not whole, and a restore puts back only ` +
        'what it holds. --slices takes it whole, in slices of --max-records records, each a ' +
        'snapshot of its own, listed and restored as one set',
    );
  }
  if (short.some((o) => o.stoppedAt === 'not_reached' || o.stoppedAt === 'failure')) {
    words.push('Run it again for an object not reached');
  }
  return words.length > 0 ? `. ${words.join('. ')}` : '';
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-backup')) {
  holdOutputWhole();
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
