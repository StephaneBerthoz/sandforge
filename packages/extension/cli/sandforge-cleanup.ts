#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sandforge-cleanup — bulk delete records the current user created on a
 * target sandbox in the `--since` window, whether or not a clone wrote them.
 * Practical companion to `sandforge-clone` so dev sandboxes don't fill up
 * with leftover test data after iterative runs.
 *
 * Strategy:
 *   1. Resolve the running user's Id on the target via `sf org display`.
 *   2. For each object the user requests (default: a small whitelist of
 *      common Forge clone targets), run
 *        SELECT Id FROM Object
 *        WHERE CreatedDate >= <since> AND CreatedById = <user>
 *      with an optional LIMIT cap.
 *   3. Bulk-delete the matched IDs via `conn.sobject(...).destroy(ids)`.
 *
 * Runs from a checkout of the repository, at its root, after `pnpm install`
 * and `pnpm build:shared`.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts \
 *     --target <alias> [--since today|yesterday|last_n_days:N]
 *     [--objects A,B,C] [--max <n>] [--dry-run]
 *
 * Example:
 *   pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts \
 *     --target TARGET-DEV --since today --dry-run
 */
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../src/core/common/soqlValidator.js';
import { loadOrg, makeConn } from './sfSession.js';

/** SF org alias = letters/digits/underscore/dash/dot. Defends against shell metachars. */
const SF_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;
/** SF user/record ID. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
/** Validated `--since` literal. */
const SINCE_LITERAL_RE =
  /^(TODAY|YESTERDAY|LAST_WEEK|THIS_WEEK|LAST_N_DAYS:\d+|\d{4}-\d{2}-\d{2})$/i;

/**
 * Standard objects only, deepest child first.
 *
 * This list used to carry six custom objects from one org's data model. A
 * default is a suggestion to every user, and a `__c` from someone else's org
 * is a suggestion nobody can act on — besides publishing that org's schema.
 * Pass `--objects` to clean custom objects.
 *
 * Industry-cloud objects (InsurancePolicy and its coverages) are left out for
 * the same reason: they exist only in orgs with that data model, and there a
 * default sweep would delete policies the user created by hand that day. Name
 * them in `--objects` when a clone wrote them.
 */
const DEFAULT_OBJECTS = [
  'CaseComment',
  'EmailMessage',
  'Asset',
  'Contract',
  'Case',
  'Contact',
  'Account',
];

interface CliArgs {
  target: string;
  since: string;
  /** `since` as the SOQL date literal it was validated into. */
  sinceSoql: string;
  objects: string[];
  max: number;
  dryRun: boolean;
}

const HELP = `sandforge-cleanup — Bulk delete records you created on a sandbox in the
--since window, whether or not a clone wrote them. Preview with --dry-run and
narrow with --objects before deleting.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts --target <alias> [options]

  Run from the repository root of a checkout, after pnpm install and
  pnpm build:shared.

Required:
  --target <alias>      sf CLI alias of the target sandbox

Options:
  --since <when>        SOQL filter for CreatedDate. Accepts:
                          today (default), yesterday, last_week,
                          last_n_days:N, or an ISO date.
  --objects <a,b,c>     Comma-separated object API names. Defaults to a
                        whitelist of common Forge targets.
  --max <n>             Max records to delete per object (default: 200).
  --dry-run             Print counts, don't delete.
  -h, --help            Show this help.
`;

/** Refuse a bad flag: exit 2, the code both CLIs use for a command line they will not run. */
function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * Read and check every flag before anything leaves the machine. `--since` and
 * `--max` used to be checked only after `sf org display` had handed over a
 * session, and a bad alias or object name exited 1 like a failed delete.
 */
function parseArgs(argv: string[]): CliArgs {
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

  const target = get('--target');
  if (!target) refuse('Missing --target. Run with --help.');
  // The alias reaches the sf command line, and everything below reaches SOQL.
  if (!SF_ALIAS_RE.test(target)) {
    refuse(`Invalid --target alias: ${target}. Letters/digits/_/-/. only.`);
  }

  const objectsCsv = get('--objects');
  const objects = objectsCsv
    ? objectsCsv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_OBJECTS;
  for (const obj of objects) {
    try {
      assertSoqlIdentifier(obj);
    } catch {
      refuse(`Invalid object name in --objects: ${obj}`);
    }
  }

  const since = get('--since', 'today') ?? 'today';
  let sinceSoql = '';
  try {
    sinceSoql = sinceClause(since);
  } catch (err: unknown) {
    refuse(err instanceof Error ? err.message : `Invalid --since: ${since}`);
  }

  const maxRaw = get('--max', '200') ?? '200';
  const max = Number(maxRaw);
  if (!Number.isInteger(max) || max <= 0) {
    refuse(`Invalid --max: ${maxRaw}. Expected a whole number above 0.`);
  }

  return {
    target,
    since,
    sinceSoql,
    objects,
    max,
    dryRun: has('--dry-run'),
  };
}

/** Translate `--since` into a strictly-validated SOQL date literal. */
function sinceClause(since: string): string {
  const lc = since.toLowerCase();
  if (lc === 'today') return 'TODAY';
  if (lc === 'yesterday') return 'YESTERDAY';
  if (lc === 'last_week' || lc === 'this_week') return 'LAST_WEEK';
  if (lc.startsWith('last_n_days:')) {
    const n = Number(lc.slice('last_n_days:'.length));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --since: ${since}`);
    return `LAST_N_DAYS:${n}`;
  }
  // ISO date fallback — strictly matched, no verbatim passthrough.
  if (!SINCE_LITERAL_RE.test(since)) {
    throw new Error(
      `Invalid --since: ${since}. Allowed: today, yesterday, last_week, last_n_days:N, YYYY-MM-DD.`,
    );
  }
  return since;
}

/** Run one cleanup from the given command line; exported so its flag checks can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  console.log(
    `sandforge-cleanup  target=${args.target}  since=${args.since}  ${args.dryRun ? 'DRY-RUN' : 'REAL'}`,
  );

  // The session every headless tool shares. This script used to read its own
  // from `sf org display`, whose token CLI 2.150 prints as "[REDACTED] …":
  // every run sent that sentence as the token.
  const org = await loadOrg(args.target);
  const conn = makeConn(org);
  // sf CLI doesn't surface User.Id directly — query it via SOQL using the
  // authenticated username.
  const userQuery = await conn.query<{ Id: string }>(
    `SELECT Id FROM User WHERE Username = '${sanitizeSoqlValue(org.username)}' LIMIT 1`,
  );
  const userId = userQuery.records[0]?.Id ?? '';
  if (!userId) {
    console.error(`Could not resolve userId for ${org.username} on ${org.alias}.`);
    process.exit(1);
  }
  if (!SF_ID_RE.test(userId)) {
    console.error(`Invalid userId returned by org: ${userId}`);
    process.exit(1);
  }
  console.log(`user: ${org.username} (${userId})\n`);

  const since = args.sinceSoql;
  const cap = args.max;
  let totalDeleted = 0;
  let totalSkipped = 0;

  for (const objectName of args.objects) {
    try {
      const soql = `SELECT Id FROM ${assertSoqlIdentifier(objectName)} WHERE CreatedDate = ${since} AND CreatedById = '${sanitizeSoqlValue(userId)}' LIMIT ${cap}`;
      const result = await conn.query<{ Id: string }>(soql);
      const ids = result.records.map((r) => r.Id);
      if (ids.length === 0) {
        process.stdout.write(`  ${objectName.padEnd(40)} 0\n`);
        continue;
      }
      if (args.dryRun) {
        console.log(`  ${objectName.padEnd(40)} ${ids.length}  [dry-run]`);
        totalSkipped += ids.length;
        continue;
      }
      const delResult = await conn.sobject(objectName).destroy(ids);
      const arr = Array.isArray(delResult) ? delResult : [delResult];
      const succ = arr.filter((r) => r.success).length;
      const fail = arr.length - succ;
      const failTag = fail > 0 ? `  \x1b[31m(${fail} failed)\x1b[0m` : '';
      console.log(`  ${objectName.padEnd(40)} ${ids.length}  deleted ${succ}${failTag}`);
      totalDeleted += succ;
    } catch (err) {
      // Object missing on this sandbox — skip silently.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('INVALID_TYPE') || msg.includes("sObject type '")) {
        process.stdout.write(`  ${objectName.padEnd(40)} -  (object not present on target)\n`);
        continue;
      }
      console.log(`  ${objectName.padEnd(40)} ERROR: ${msg.slice(0, 100)}`);
    }
  }

  console.log(
    `\n${args.dryRun ? 'would delete' : 'deleted'} ${args.dryRun ? totalSkipped : totalDeleted} record(s) in ${Date.now() - t0}ms`,
  );
}

// Only when run as a script: importing the module must not start a cleanup.
if (/sandforge-cleanup\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('FATAL:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
