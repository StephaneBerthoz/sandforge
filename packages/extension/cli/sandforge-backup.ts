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

import { mkdirSync } from 'node:fs';
import {
  mkdir as mkdirAsync,
  readFile as readFileAsync,
  rm as rmAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrg } from './sfSession.js';
import { fileConfigStore } from './fileConfigStore.js';
import { DataOpsHandler } from '../src/bridge/handlers/DataOpsHandler.js';
import { BackupRecordStore } from '../src/modules/dataops/BackupRecordStore.js';
import { ProductionGuard } from '../src/core/precheck/ProductionGuard.js';
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
  --store <dir>          where snapshots live      (default: a temp directory)
  --yes                  do not ask before a restore writes
  --json                 emit what the panel would receive
  --help                 this text

A restore never deletes: it upserts on Id, so it overwrites the fields of
records that are there, after bringing back from the recycle bin the ones
deleted since the snapshot.

Exit codes: 0 the run finished, 1 it could not start, 2 a bad command line.
`;

/** Everything the command line settled. */
interface CliArgs {
  org: string;
  objects: string[];
  list: boolean;
  restoreId?: string;
  storeDir: string;
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

  return {
    org,
    objects,
    list,
    restoreId,
    storeDir: get('--store', join(tmpdir(), 'sandforge-backups')) ?? '',
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

  mkdirSync(args.storeDir, { recursive: true });
  const org = loadOrg(args.org);
  const configStore = fileConfigStore(join(args.storeDir, 'snapshots.json'));

  if (args.list) {
    const keys = configStore.getKeysByPrefix('backup:');
    if (keys.length === 0) log('No snapshot in this store.');
    for (const key of keys) {
      const meta = configStore.get(key) as {
        operationId: string;
        timestamp: string;
        totalRecords: number;
        objects: Array<{ objectApiName: string; recordCount: number }>;
      };
      log(
        `${meta.operationId}  ${meta.timestamp}  ${meta.totalRecords} record(s)  ` +
          meta.objects.map((o) => `${o.objectApiName}:${o.recordCount}`).join(' '),
      );
    }
    return;
  }

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
        }
      },
    },
    orgManager: {
      getOrg: () => ({ alias: org.alias, metadata: { apiVersion: '66.0' } }),
    },
    orgRegistry: {
      getCredentials: async () => ({
        accessToken: org.accessToken,
        instanceUrl: org.instanceUrl,
      }),
    },
    configStore,
    infraServices: {
      // A restore refuses to write without the guard, as in the extension.
      productionGuard: new ProductionGuard(),
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
  // The store takes its own file operations, which is what lets the extension
  // give it the VS Code filesystem API. Here they are Node's.
  handler.setBackupRecordStore(
    new BackupRecordStore({
      storagePath: args.storeDir,
      readFile: (filePath) => readFileAsync(filePath, 'utf8'),
      writeFile: (filePath, content) => writeFileAsync(filePath, content, 'utf8'),
      mkdir: async (dirPath) => {
        await mkdirAsync(dirPath, { recursive: true });
      },
      rm: (filePath) => rmAsync(filePath, { force: true }),
    }),
  );

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
    log(`restoring ${args.restoreId} into ${args.org}…`);
    await handler.handle({
      id: `cli-restore-${Date.now()}`,
      type: 'dataops:rollback',
      payload: { orgId: args.org, operationId: args.restoreId },
    } as never);
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
  log(`store: ${args.storeDir}`);
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-backup')) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
