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
 *     [--objects A,B,C] [--max <n>] [--dry-run] [--json]
 *
 * Example:
 *   pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts \
 *     --target TARGET-DEV --since today --dry-run
 */
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../src/core/common/soqlValidator.js';
import { queryAllPages } from '../src/modules/forge/queryAllPages.js';
import { loadOrg, makeConn } from './sfSession.js';
import { refuseProductionTarget } from './targetKind.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { endWith } from './exitCodes.js';

/** SF org alias = letters/digits/underscore/dash/dot. Defends against shell metachars. */
const SF_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;
/** SF user/record ID. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
/** An ISO date, as `--since` takes one. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  /** Print what became of each object as JSON on stdout, every other line on stderr. */
  json: boolean;
}

const HELP = `sandforge-cleanup — Bulk delete records you created on a sandbox in the
--since window, whether or not a clone wrote them. Preview with --dry-run and
narrow with --objects before deleting.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-cleanup.ts --target <alias> [options]

  Run from the repository root of a checkout, after pnpm install and
  pnpm build:shared.

Required:
  --target <alias>      sf CLI alias of the target sandbox, or Developer
                        Edition org. A production org is refused.

Options:
  --since <when>        the records created from the start of: today
                        (default), yesterday, last_week, this_week,
                        last_n_days:N (N days ago), or an ISO date
                        YYYY-MM-DD (midnight UTC), up to now.
  --objects <a,b,c>     Comma-separated object API names. Defaults to a
                        whitelist of common Forge targets.
  --max <n>             Max records to delete per object (default: 200).
  --dry-run             Print counts, don't delete.
  --json                print per object the records found, deleted and
                        refused as JSON on stdout, every other line on stderr
  -h, --help            Show this help.

Exit codes: 0 every record found was deleted (or counted, with --dry-run);
1 the cleanup could not start, the target is a production org, or an object
could not be read or deleted (one the target does not have is passed over);
2 a bad command line; 3 the target refused to delete some of the records found.
`;

/** What the line reads. */
const FLAGS: CommandFlags = {
  switches: ['--dry-run', '--json'],
  values: ['--target', '--since', '--objects', '--max'],
};

/** The exit code of an object that could not be read or deleted. */
const FAILED_EXIT = 1;

/** The exit code of a cleanup whose deletes the target refused in part. */
const RECORDS_LEFT_EXIT = 3;

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
  // `--dry-run=true` or `--dryrun` dropped without a word deleted for real.
  refuseUnreadArguments(args, FLAGS);
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
    json: has('--json'),
  };
}

/**
 * Translate `--since` into the strictly validated SOQL value that
 * `CreatedDate >=` is held to: the start of the period it names, up to now.
 *
 * The query read `CreatedDate = <since>`: `--since yesterday` took yesterday's
 * records and none of today's, `this_week` was read as last week, and an ISO
 * date was compared, as a date, with a dateTime field, which SOQL refuses —
 * every object failed, and the cleanup said it had deleted nothing. An ISO
 * date is midnight UTC of that day. Exported so it can be tested.
 */
export function sinceClause(since: string): string {
  const lc = since.toLowerCase();
  if (lc === 'today') return 'TODAY';
  if (lc === 'yesterday') return 'YESTERDAY';
  if (lc === 'this_week') return 'THIS_WEEK';
  if (lc === 'last_week') return 'LAST_WEEK';
  if (lc.startsWith('last_n_days:')) {
    const raw = lc.slice('last_n_days:'.length);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid --since: ${since}`);
    }
    return `LAST_N_DAYS:${n}`;
  }
  // ISO date — strictly matched, and a day the calendar has; no verbatim passthrough.
  if (ISO_DATE_RE.test(since)) {
    const midnight = new Date(`${since}T00:00:00Z`);
    if (!Number.isNaN(midnight.getTime()) && midnight.toISOString().startsWith(since)) {
      return `${since}T00:00:00Z`;
    }
  }
  throw new Error(
    `Invalid --since: ${since}. Allowed: today, yesterday, this_week, last_week, ` +
      'last_n_days:N, YYYY-MM-DD.',
  );
}

/** The query of one object: what the user created from the start of `since`, at most `cap`. */
export function cleanupSoql(
  objectName: string,
  since: string,
  userId: string,
  cap: number,
): string {
  return (
    `SELECT Id FROM ${assertSoqlIdentifier(objectName)} WHERE CreatedDate >= ${since} ` +
    `AND CreatedById = '${sanitizeSoqlValue(userId)}' LIMIT ${cap}`
  );
}

/** What became of one object, as `--json` says it. */
export interface CleanupObject {
  objectApiName: string;
  /** The records the query found. */
  found: number;
  deleted: number;
  /** The records the target refused to delete. */
  failed: number;
  /** The first reasons the target gave for them. */
  reasons?: string[];
  /** The target has no such object: passed over. */
  notPresent?: true;
  /** Why the object could not be read or deleted. */
  error?: string;
}

/** Reasons a refused delete prints; the others are counted. */
const MAX_REASONS = 3;

/** One delete's answer, as jsforce gives it. */
type DeleteAnswer = { success: boolean; errors?: Array<{ message?: string } | string> };

/** The reasons the target gave for the deletes it refused, each once, the first few. */
function reasonsOf(answers: readonly DeleteAnswer[]): string[] {
  const reasons = new Set<string>();
  for (const answer of answers) {
    if (answer.success) continue;
    for (const error of answer.errors ?? []) {
      reasons.add(typeof error === 'string' ? error : (error.message ?? 'refused'));
    }
  }
  return [...reasons].slice(0, MAX_REASONS);
}

/**
 * The exit code of a cleanup, from what became of its objects: an object that
 * could not be read or deleted is a failure, deletes the target refused leave
 * records behind. Exported so it can be tested.
 */
export function cleanupExitCode(objects: readonly CleanupObject[]): number {
  if (objects.some((o) => o.error !== undefined)) return FAILED_EXIT;
  if (objects.some((o) => o.failed > 0)) return RECORDS_LEFT_EXIT;
  return 0;
}

/** Run one cleanup from the given command line; exported so its flag checks can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  /** A line said whatever the mode: on stderr with --json, where stdout carries the JSON alone. */
  const say = (line: string): void => (args.json ? console.error(line) : console.log(line));
  say(
    `sandforge-cleanup  target=${args.target}  since=${args.since}  ${args.dryRun ? 'DRY-RUN' : 'REAL'}`,
  );

  // The session every headless tool shares. This script used to read its own
  // from `sf org display`, whose token CLI 2.150 prints as "[REDACTED] …":
  // every run sent that sentence as the token.
  const org = await loadOrg(args.target);
  const conn = makeConn(org);
  // Refused on a production org, or one that will not say what it is, before
  // a record is read: the cleanup deleted on whatever org --target named. No
  // flag lifts it. A dry run only counts.
  if (!args.dryRun) {
    await refuseProductionTarget(conn, args.target, {
      tool: 'sandforge-cleanup',
      action: 'delete',
      readOnly: '--dry-run',
    });
  }
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
  say(`user: ${org.username} (${userId})\n`);

  const objects: CleanupObject[] = [];
  for (const objectName of args.objects) {
    const outcome: CleanupObject = { objectApiName: objectName, found: 0, deleted: 0, failed: 0 };
    objects.push(outcome);
    try {
      // Every page: a query answers with 2 000 records at most and a cursor
      // to the rest, and a --max above that found 2 000.
      const { records } = await queryAllPages<{ Id: string }>(
        {
          query: async (q) => conn.query<{ Id: string }>(q),
          queryMore: async (url) => conn.queryMore<{ Id: string }>(url),
        },
        cleanupSoql(objectName, args.sinceSoql, userId, args.max),
      );
      const ids = records.map((r) => r.Id);
      outcome.found = ids.length;
      if (ids.length === 0) {
        say(`  ${objectName.padEnd(40)} 0`);
        continue;
      }
      if (args.dryRun) {
        say(`  ${objectName.padEnd(40)} ${ids.length}  [dry-run]`);
        continue;
      }
      // 200 to a request: jsforce sends every id in one unless it may split
      // them, and Salesforce refuses a delete of more than 200 records.
      const delResult = await conn.sobject(objectName).destroy(ids, { allowRecursive: true });
      const arr = (Array.isArray(delResult) ? delResult : [delResult]) as DeleteAnswer[];
      outcome.deleted = arr.filter((r) => r.success).length;
      outcome.failed = arr.length - outcome.deleted;
      const reasons = reasonsOf(arr);
      if (reasons.length > 0) outcome.reasons = reasons;
      const failTag = outcome.failed > 0 ? `  \x1b[31m(${outcome.failed} failed)\x1b[0m` : '';
      say(`  ${objectName.padEnd(40)} ${ids.length}  deleted ${outcome.deleted}${failTag}`);
      for (const reason of reasons) say(`      ${reason.slice(0, 200)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Object missing on this sandbox — passed over.
      if (msg.includes('INVALID_TYPE') || msg.includes("sObject type '")) {
        outcome.notPresent = true;
        say(`  ${objectName.padEnd(40)} -  (object not present on target)`);
        continue;
      }
      // Any other error leaves the object's records where they were, and the
      // run did not do what it was asked: it printed a red line and exited 0.
      outcome.error = msg;
      say(`  ${objectName.padEnd(40)} ERROR: ${msg.slice(0, 200)}`);
    }
  }

  const found = objects.reduce((sum, o) => sum + o.found, 0);
  const deleted = objects.reduce((sum, o) => sum + o.deleted, 0);
  const failed = objects.reduce((sum, o) => sum + o.failed, 0);
  const elapsedMs = Date.now() - t0;
  endWith(cleanupExitCode(objects));
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'sandforge-cleanup',
          target: args.target,
          since: args.since,
          condition: `CreatedDate >= ${args.sinceSoql}`,
          dryRun: args.dryRun,
          objects,
          found,
          deleted,
          failed,
          elapsedMs,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  console.log(
    `\n${args.dryRun ? 'would delete' : 'deleted'} ${args.dryRun ? found : deleted} record(s)` +
      `${failed > 0 ? `, ${failed} refused` : ''} in ${elapsedMs}ms`,
  );
}

// Only when run as a script: importing the module must not start a cleanup.
if (/sandforge-cleanup\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error('FATAL:', err instanceof Error ? err.stack : err);
      process.exit(1);
    });
}
