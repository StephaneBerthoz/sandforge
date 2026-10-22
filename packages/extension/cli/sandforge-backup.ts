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
 *   pnpm exec tsx packages/extension/cli/sandforge-backup.ts --org TGT --list
 *   pnpm exec tsx packages/extension/cli/sandforge-backup.ts --org TGT --restore <id> --yes
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { defaultBackupStoreOf, openBackupStore } from './backupStore.js';
import { join } from 'node:path';
import { orgTypeOf } from '@sandforge/shared';
import { loadOrg } from './sfSession.js';
import { fileConfigStore } from './fileConfigStore.js';
import { DataOpsHandler } from '../src/bridge/handlers/DataOpsHandler.js';
import { BackupRecordStore, nodeBackupFiles } from '../src/modules/dataops/BackupRecordStore.js';
import { nodeSyncRunCreations } from '../src/modules/sync/SyncRunCreations.js';
import { journalDirOf } from './sandforge-clone.js';
import { commandLineGuard } from './commandLineGuard.js';
import { AuthProvider } from '../src/core/connection/AuthProvider.js';
import type { ReplacedOrgRestoreQuestion } from '../src/bridge/handlers/HandlerTypes.js';

const HELP = `sandforge-backup — take and restore DataOps snapshots, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-backup.ts --org <alias> [options]

Required:
  --org <alias>          sf CLI alias of the org

One of:
  --object <ApiName>     object to snapshot; repeat for more
  --list                 name the snapshots taken so far, then stop
  --restore <id>         upsert a snapshot back into the org by record Id

Options:
  --store <dir>          where snapshots live, a folder of your own
                         (default: ~/.sandforge/backups, under the folder
                         SANDFORGE_JOURNAL_DIR names when it is set)
  --max-records <n>      most records of each object a snapshot reads, as
                         sandforge.backup.maxRecordsPerObject sets it
                         (default: 50000; 100 to 1000000)
  --rewrite-all          with --restore: write every row of the snapshot back,
                         the ones the org already holds as the snapshot does
                         included
  --yes                  do not ask before a restore writes
  --json                 emit what the panel would receive
  --help                 this text

A restore never deletes: it upserts on Id, so it overwrites the fields of
records that are there, after bringing back from the recycle bin the ones
deleted since the snapshot. It reads the org's values first and writes only
the rows where one of them differs from the snapshot, and says how many it
found unchanged; --rewrite-all writes them all. Of the snapshot a Sync run
kept of what it wrote over, the records changed or deleted since the run —
read against the run's file in SANDFORGE_JOURNAL_DIR — are left as they are
and counted, as removing the run with sandforge-sync leaves them unless it
is told to include them.

Exit codes: 0 the run finished, 1 it could not start, or the snapshot or the
restore failed or was refused, 2 a bad command line.
`;

/** Everything the command line settled. */
interface CliArgs {
  org: string;
  objects: string[];
  list: boolean;
  restoreId?: string;
  storeDir: string;
  /** The cap of records per object a snapshot reads, when the line sets one. */
  maxRecords?: number;
  /** A restore writes every row back, without comparing it with the org's. */
  rewriteAll: boolean;
  yes: boolean;
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

  const org = get('--org');
  if (!org) {
    process.stderr.write('Missing --org. Run with --help.\n');
    process.exit(2);
  }
  const objects = collect('--object');
  const list = args.includes('--list');
  const restoreId = get('--restore');

  const asked = [objects.length > 0, list, restoreId !== undefined].filter(Boolean).length;
  if (asked === 0) {
    process.stderr.write('Nothing to do: give --object, --list or --restore.\n');
    process.exit(2);
  }
  if (asked > 1) {
    // Three answers to "what should this run do" is two too many.
    process.stderr.write('Give one of --object, --list or --restore.\n');
    process.exit(2);
  }
  for (const name of objects) {
    if (!API_NAME_RE.test(name)) {
      process.stderr.write(`Not an SObject API name: "${name}"\n`);
      process.exit(2);
    }
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

  return {
    org,
    objects,
    list,
    restoreId,
    storeDir: get('--store', defaultBackupStoreOf()) ?? '',
    ...(cap !== undefined ? { maxRecords: Number(cap) } : {}),
    rewriteAll,
    yes: args.includes('--yes'),
    json: args.includes('--json'),
  };
}

/** Ask on the terminal, unless the answer was given on the command line. */
async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.once('data', (chunk) => {
      resolve(/^y(es)?$/i.test(String(chunk).trim()));
      process.stdin.pause();
    });
    process.stdin.resume();
  });
}

/** Run one DataOps operation; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const log = (line: string): void => {
    if (!args.json) process.stdout.write(`${line}\n`);
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
  const org = await loadOrg(args.org);
  const configStore = fileConfigStore(join(args.storeDir, 'snapshots.json'));

  if (args.list) {
    const keys = configStore.getKeysByPrefix('backup:');
    if (keys.length === 0) log('No snapshot in this store.');
    for (const key of keys) {
      const meta = configStore.get(key) as {
        operationId: string;
        timestamp: string;
        totalRecords: number;
        status?: string;
        objects: Array<{
          objectApiName: string;
          recordCount: number;
          orgCount?: number;
          stoppedAt?: string;
        }>;
      };
      // Each object as `Contact:500/1234(cap)` when the snapshot holds part of it.
      const held = meta.objects.map(
        (o) =>
          `${o.objectApiName}:${o.recordCount}` +
          (o.stoppedAt !== undefined ? `/${o.orgCount ?? '?'}(${o.stoppedAt})` : ''),
      );
      log(
        `${meta.operationId}  ${meta.timestamp}  ${meta.totalRecords} record(s)` +
          `${meta.status === 'failed' ? ' failed part-way' : ''}  ${held.join(' ')}`,
      );
    }
    return;
  }

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

  // What the panel would have received, printed instead of posted.
  const posted: Array<Record<string, unknown>> = [];
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
    orgManager: { getOrg: () => typed },
    orgRegistry: {
      getCredentials: async () => ({
        accessToken: org.accessToken,
        instanceUrl: org.instanceUrl,
      }),
    },
    configStore,
    // The one setting a snapshot reads, as the line sets it; every other one
    // takes the extension's default.
    services: {
      getSandforgeSetting: <T>(key: string, fallback: T): T =>
        key === 'backup.maxRecordsPerObject' && args.maxRecords !== undefined
          ? (args.maxRecords as T)
          : fallback,
    },
    infraServices: {
      // A restore refuses to write without the guard, as in the extension.
      productionGuard: commandLineGuard(log, args.org),
      // A snapshot of the org an alias reached before a refresh goes into the
      // org it reaches now only on a yes typed here: `--yes` answers the
      // question asked before the restore, not this one.
      confirmRestoreIntoReplacedOrg: ({
        alias,
        backedUpFrom,
        now,
      }: ReplacedOrgRestoreQuestion): Promise<boolean> =>
        args.yes
          ? Promise.resolve(false)
          : confirm(
              `${alias} answered as org ${backedUpFrom} when this snapshot was taken and ` +
                `answers as org ${now} now. Write its saved values into the org it is now?`,
            ),
    },
    // Built rather than stubbed: the handler stamps every message it posts
    // with one, and a message with no id settles nothing on the other side.
    nextId: () => `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } as never);
  // The store takes its own file operations; here, as in the extension, they
  // are Node's, under the directory given.
  handler.setBackupRecordStore(new BackupRecordStore(nodeBackupFiles(args.storeDir)));
  // The Sync runs the command line kept: a restore of a run's snapshot reads
  // when the run last wrote, and leaves what changed since as it is.
  handler.setSyncRuns(nodeSyncRunCreations(journalDirOf()));

  if (args.restoreId) {
    const meta = configStore.get(`backup:${args.restoreId}`);
    if (!meta) {
      process.stderr.write(`No snapshot "${args.restoreId}" in ${args.storeDir}.\n`);
      process.exit(1);
    }
    if (!args.yes) {
      const ok = await confirm(
        `Upsert snapshot ${args.restoreId} back into ${args.org}? Records with these Ids ` +
          'will have their fields overwritten.',
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
      },
    } as never);
    // What the restore wrote, refused and found unchanged, as the panel hears it.
    const answer = posted.find((message) => message.type === 'dataops:rollback:response');
    const said = (answer?.payload as { message?: unknown } | undefined)?.message;
    if (typeof said === 'string') log(said);
  } else {
    log(`snapshot ${args.org}: ${args.objects.join(', ')}`);
    await handler.handle({
      id: `cli-backup-${Date.now()}`,
      type: 'backup:execute',
      payload: { orgId: args.org, objects: args.objects },
    } as never);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ tool: 'sandforge-backup', posted }, null, 2)}\n`);
    return;
  }
  const last = posted[posted.length - 1];
  if (last) log(`\nlast message: ${String(last.type)}`);
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-backup')) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
