#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sandforge-cleanup — bulk delete records cloned by the current user on a
 * target sandbox. Practical companion to `sandforge-clone` so dev
 * sandboxes don't fill up with leftover test data after iterative runs.
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
 * Usage:
 *   sandforge-cleanup --target <alias> [--since today|yesterday|N]
 *                     [--objects A,B,C] [--max <n>] [--dry-run]
 *
 * Example:
 *   sandforge-cleanup --target TARGET-DEV --since today --dry-run
 */
import { execFileSync } from 'node:child_process';
import jsforce from 'jsforce';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../src/core/common/soqlValidator.js';

/** SF org alias = letters/digits/underscore/dash/dot. Defends against shell metachars. */
const SF_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;
/** SF user/record ID. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
/** Validated `--since` literal. */
const SINCE_LITERAL_RE = /^(TODAY|YESTERDAY|LAST_WEEK|THIS_WEEK|LAST_N_DAYS:\d+|\d{4}-\d{2}-\d{2})$/i;

const DEFAULT_OBJECTS = [
  'CaseContact__c',
  'GlobalContext2__c',
  'CoverageContext2__c',
  'CaseHistory2',
  'CaseInvoice2__c',
  'Recipient__c',
  'CaseComment',
  'EmailMessage',
  'Asset',
  'Contract',
  'InsurancePolicy',
  'InsurancePolicyCoverage',
  'Case',
  'Contact',
  'Account',
];

interface CliArgs {
  target: string;
  since: string;
  objects: string[];
  max: number;
  dryRun: boolean;
}

const HELP = `sandforge-cleanup — Bulk delete records cloned by you today on a sandbox.

Usage:
  sandforge-cleanup --target <alias> [options]

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
  if (!target) {
    process.stderr.write('Missing --target. Run with --help.\n');
    process.exit(2);
  }

  const objectsCsv = get('--objects');
  const objects = objectsCsv ? objectsCsv.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_OBJECTS;

  return {
    target,
    since: get('--since', 'today') ?? 'today',
    objects,
    max: Number(get('--max', '200')),
    dryRun: has('--dry-run'),
  };
}

interface SfOrg {
  alias: string;
  username: string;
  userId: string;
  instanceUrl: string;
  accessToken: string;
}

function loadOrg(alias: string): SfOrg {
  // Defense-in-depth: re-validate alias here even though main() also checks.
  // shell:true on Windows lets cmd.exe interpret metacharacters — alias must
  // be alphanumeric+underscore+dash+dot only.
  if (!SF_ALIAS_RE.test(alias)) {
    throw new Error(`Invalid SF org alias: "${alias}"`);
  }
  const json = execFileSync('sf', ['org', 'display', '--target-org', alias, '--json'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(json) as {
    result?: { accessToken?: string; instanceUrl?: string; username?: string; userId?: string };
  };
  if (!parsed.result?.accessToken || !parsed.result?.instanceUrl) {
    throw new Error(`sf org display did not return a usable session for '${alias}'.`);
  }
  return {
    alias,
    username: parsed.result.username ?? '',
    userId: parsed.result.userId ?? '',
    instanceUrl: parsed.result.instanceUrl,
    accessToken: parsed.result.accessToken,
  };
}

function makeConn(org: SfOrg): jsforce.Connection {
  return new jsforce.Connection({
    instanceUrl: org.instanceUrl,
    accessToken: org.accessToken,
    version: '66.0',
  });
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
    throw new Error(`Invalid --since: ${since}. Allowed: today, yesterday, last_week, last_n_days:N, YYYY-MM-DD.`);
  }
  return since;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(process.argv);
  console.log(`sandforge-cleanup  target=${args.target}  since=${args.since}  ${args.dryRun ? 'DRY-RUN' : 'REAL'}`);

  // Validate ALL CLI inputs that flow into SOQL or shell execution.
  if (!SF_ALIAS_RE.test(args.target)) {
    console.error(`Invalid --target alias: ${args.target}. Letters/digits/_/-/. only.`);
    process.exit(1);
  }
  for (const obj of args.objects) {
    try {
      assertSoqlIdentifier(obj);
    } catch {
      console.error(`Invalid object name in --objects: ${obj}`);
      process.exit(1);
    }
  }
  const org = loadOrg(args.target);
  const conn = makeConn(org);
  // sf CLI doesn't surface User.Id directly — query it via SOQL using the
  // authenticated username.
  let userId = org.userId;
  if (!userId) {
    const userQuery = await conn.query<{ Id: string }>(
      `SELECT Id FROM User WHERE Username = '${sanitizeSoqlValue(org.username)}' LIMIT 1`,
    );
    userId = userQuery.records[0]?.Id ?? '';
  }
  if (!userId) {
    console.error(`Could not resolve userId for ${org.username} on ${org.alias}.`);
    process.exit(1);
  }
  if (!SF_ID_RE.test(userId)) {
    console.error(`Invalid userId returned by org: ${userId}`);
    process.exit(1);
  }
  console.log(`user: ${org.username} (${userId})\n`);

  const since = sinceClause(args.since);
  const cap = Math.floor(args.max);
  if (!Number.isFinite(cap) || cap <= 0) {
    console.error(`Invalid --max: ${args.max}`);
    process.exit(1);
  }
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

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
