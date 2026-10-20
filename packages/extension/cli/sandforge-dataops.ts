#!/usr/bin/env tsx
/**
 * sandforge-dataops — headless DataOps masking: mask the records of an object,
 * and put their values back.
 *
 * `sandforge-backup` takes and restores snapshots through the real
 * `DataOpsHandler`; masking had no command line, so it could not be run
 * against a real org outside the editor, and a test over a large org went
 * without it. This one drives the same handler the same way: the handler holds
 * the whole flow — the count, Production Guard, the snapshot, the pages, the
 * checkpoint a stopped run leaves, the restore — and the runner stands up only
 * what it needs around it: an org typed as the extension types one it
 * connects, a config store in a JSON file, the backup files under the same
 * directory, and a broker that prints what the panel would have received.
 *
 * A run takes a snapshot of the records it masks, their masked fields as they
 * are, once the guard let it go and before its first write; `--restore` puts
 * those values back, by Id. A production org is refused: the guard asks
 * before every write to one, and nobody here may answer for it. A sandbox, a
 * scratch org and a Developer Edition org are what the handler takes them for.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize \
 *     --org TGT --object Contact --template tpl-gdpr-standard --dry-run
 *   pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize --org TGT --restore <id>
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrg } from './sfSession.js';
import { fileConfigStore } from './fileConfigStore.js';
import { DataOpsHandler } from '../src/bridge/handlers/DataOpsHandler.js';
import { anonymizationTemplateSavePayloadSchema } from '../src/bridge/validatePayload.js';
import { BackupRecordStore, nodeBackupFiles } from '../src/modules/dataops/BackupRecordStore.js';
import { ProductionGuard } from '../src/core/precheck/ProductionGuard.js';
import { BackgroundOperationRegistry } from '../src/core/engine/BackgroundOperationRegistry.js';
import { AuthProvider } from '../src/core/connection/AuthProvider.js';
import { isSafeSoqlWhere, SOQL_WHERE_RULE } from '../src/core/common/soqlValidator.js';
import { personAccountRules } from '../src/modules/dataops/personAccountMasking.js';
import { ACCOUNT } from '../src/core/common/platformRecords.js';
import type { ReplacedOrgRestoreQuestion } from '../src/bridge/handlers/HandlerTypes.js';
import type { AnonymizationTemplateRule } from '@sandforge/shared';
import { orgTypeOf } from '@sandforge/shared';

const HELP = `sandforge-dataops — mask an org's records, and put them back, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize \\
    --org <alias> [--object <ApiName>] (--template <id> | --rules <file>) [options]
  pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize \\
    --org <alias> --restore <snapshot> [--rewrite-all] [--store <dir>] [--yes]

Required:
  anonymize              the command
  --org <alias>          sf CLI alias of the org
  --template <id>        a template that ships (tpl-gdpr-standard, tpl-ccpa-california,
                         tpl-hipaa-health, tpl-sandbox-scrub) or one saved in the store
  --rules <file>         or a JSON file of rules, saved in the store as a template:
                         {"name": "...", "rules": [{"fieldPattern": "Contact.Email",
                         "ruleType": "hash"}]} — a rule as the panel's editor saves it

Options:
  --object <ApiName>     the object to mask, one per run; without it, every object
                         the template masks, as the panel's Apply masks them —
                         Account's person accounts among them, in an org that has
                         person accounts, when the template masks contacts
  --where <clause>       with --object: mask only the records this SOQL condition
                         selects, written without WHERE
  --dry-run              say what a run would mask — the fields, the records, the
                         first records masked as a run masks them — and write
                         nothing
  --resume               mask only what the last run of the same template, object
                         and filter left, from where it stopped
  --restore <snapshot>   put back the values a snapshot holds, by Id: the id a run
                         printed. It reads the org's values first and writes only
                         the rows where one of them differs from the snapshot, and
                         says how many it found unchanged
  --rewrite-all          with --restore: write every row of the snapshot back,
                         the ones the org already holds as the snapshot does
                         included
  --store <dir>          where snapshots, saved templates and checkpoints live; the
                         directory sandforge-backup reads and lists
                         (default: a temp directory, which the system may clear)
  --max-records <n>      most records of the object a snapshot holds, as
                         sandforge.backup.maxRecordsPerObject sets it; a run with
                         more writes nothing  (default: 50000; 100 to 1000000)
  --yes                  do not ask before writing
  --json                 emit what the panel would receive; a preview's original
                         values are left out
  --help                 this text

A run takes a snapshot of the records it masks, their masked fields as they are,
before its first write, and writes nothing unless the snapshot holds every one of
them. A production org is refused.

Ctrl-C stops a run as the panel's Cancel does: before its next page, what it
masked recorded in the audit trail of the store, and --resume masks only what it
left. It stops a --restore before its next batch, what it put back recorded the
same way, and the same --restore puts back the rest. Ctrl-C again ends the
process at once.

Exit codes: 0 the run finished (read the summary for records left unmasked),
1 it could not start, was refused or failed, 2 a bad command line, 130 Ctrl-C
stopped the run.
`;

/** What the run does. */
type Mode = 'run' | 'dry-run' | 'resume' | 'restore';

/** A rule as a rules file gives it, checked by the schema the panel's save goes through. */
interface FileRules {
  name: string;
  rules: Array<{ fieldPattern: string; ruleType: string; config?: Record<string, unknown> }>;
}

/** Everything the command line settled. */
interface CliArgs {
  org: string;
  mode: Mode;
  object?: string;
  templateId?: string;
  rules?: FileRules;
  where?: string;
  restoreId?: string;
  /** With a restore: every row of the snapshot written back, the unchanged ones too. */
  rewriteAll: boolean;
  storeDir: string;
  /** The cap of records per object a snapshot reads, when the line sets one. */
  maxRecords?: number;
  yes: boolean;
  json: boolean;
}

/** SObject API name — letter-prefixed, alphanumeric and underscore. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** SF alias = letters/digits/underscore/dash/dot. */
const ALIAS_RE = /^[A-Za-z0-9_.-]+$/;

/** Say why the line cannot be read, and stop. */
function refuseLine(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * The rules a file gives, as the panel's editor saves them: `{name, rules}`,
 * or the rules alone, named after the file. Held to the schema of a save, so a
 * rule the panel would refuse is refused here before any org is reached.
 */
function readRulesFile(file: string): FileRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    refuseLine(
      `Cannot read the rules in ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const given = Array.isArray(parsed) ? { rules: parsed } : parsed;
  const named =
    typeof given === 'object' && given !== null && !('name' in given)
      ? { ...given, name: `Rules from ${basename(file)}` }
      : given;
  const checked = anonymizationTemplateSavePayloadSchema.safeParse(named);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((issue) => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
      .join('; ');
    refuseLine(`The rules in ${file} are not rules the panel saves: ${issues}`);
  }
  return checked.data as FileRules;
}

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args[0] !== 'anonymize') {
    refuseLine('The command is anonymize: sandforge-dataops.ts anonymize --org … Run with --help.');
  }
  const get = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    const value = at >= 0 ? args[at + 1] : undefined;
    // A flag's value is never the next flag: `--where --dry-run` filters nothing.
    if (at >= 0 && (value === undefined || value.startsWith('--'))) {
      refuseLine(`${flag} needs a value.`);
    }
    return value;
  };
  const count = (flag: string): number => args.filter((arg) => arg === flag).length;

  const org = get('--org');
  if (!org) refuseLine('Missing --org. Run with --help.');
  if (!ALIAS_RE.test(org)) refuseLine(`Not an sf alias: "${org}"`);

  const restoreId = get('--restore');
  const dryRun = args.includes('--dry-run');
  const resume = args.includes('--resume');
  const maxRecords = get('--max-records');
  if (maxRecords !== undefined && !/^[1-9]\d*$/.test(maxRecords)) {
    refuseLine(`Not a number of records: "${maxRecords}"`);
  }
  const rewriteAll = args.includes('--rewrite-all');
  if (rewriteAll && restoreId === undefined) refuseLine('--rewrite-all goes with --restore.');
  const common = {
    org,
    rewriteAll,
    storeDir: get('--store') ?? join(tmpdir(), 'sandforge-backups'),
    ...(maxRecords !== undefined ? { maxRecords: Number(maxRecords) } : {}),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
  };

  if (restoreId !== undefined) {
    // A restore puts back what a snapshot holds, whatever the run it came from.
    const extra = ['--object', '--template', '--rules', '--where', '--dry-run', '--resume'].filter(
      (flag) => args.includes(flag),
    );
    if (extra.length > 0) {
      refuseLine(`--restore puts a snapshot back as it is: drop ${extra.join(', ')}.`);
    }
    return { ...common, mode: 'restore', restoreId };
  }

  if (count('--object') > 1) {
    refuseLine(
      'Give one --object at most: a run masks one object, or every object its template masks.',
    );
  }
  const object = get('--object');
  if (object !== undefined && !API_NAME_RE.test(object)) {
    refuseLine(`Not an SObject API name: "${object}"`);
  }

  const templateId = get('--template');
  const rulesFile = get('--rules');
  if ((templateId === undefined) === (rulesFile === undefined)) {
    refuseLine('Give one of --template or --rules: the rules a run masks with.');
  }
  if (dryRun && resume) refuseLine('Give one of --dry-run or --resume.');

  const where = get('--where')?.trim();
  if (where !== undefined && (where === '' || !isSafeSoqlWhere(where))) {
    refuseLine(`Not a filter --where can take: "${where}". ${SOQL_WHERE_RULE}`);
  }
  // A filter is written for one object's fields, as the panel takes it.
  if (where !== undefined && object === undefined) {
    refuseLine('--where filters the records of one object: give it with --object.');
  }

  return {
    ...common,
    mode: dryRun ? 'dry-run' : resume ? 'resume' : 'run',
    ...(object !== undefined ? { object } : {}),
    ...(templateId !== undefined ? { templateId } : {}),
    ...(rulesFile !== undefined ? { rules: readRulesFile(rulesFile) } : {}),
    ...(where !== undefined ? { where } : {}),
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

/** A message as the handler posts it to the panel. */
interface Posted {
  type: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

/** A template as the handler lists it. */
interface Listed {
  id: string;
  name: string;
  saved?: boolean;
  rules: Array<{ fieldPattern: string; ruleType: string; config?: unknown }>;
}

/** One object of a run's answer, as the panel's result reads it. */
interface ResultObject {
  objectApiName: string;
  total: number;
  processed: number;
  failed: number;
  notMasked: number;
}

/** The rules of a template that mask `object`: those naming it, and a wildcard. */
function rulesOf(template: Listed, object: string): Listed['rules'] {
  const prefix = `${object.toLowerCase()}.`;
  return template.rules.filter(
    (r) => r.fieldPattern.toLowerCase().startsWith(prefix) || r.fieldPattern === '*',
  );
}

/**
 * Whether a template masks anything of `object`: a rule of its own, or — on
 * Account — what its Contact rules mask on a person account
 * (`personAccountRules`), which the handler applies to person accounts alone.
 * Refused for want of a rule on Account, `--object Account` could not mask a
 * person account with the CCPA template, whose rules name Contact and Lead.
 */
export function masksObject(template: Listed, object: string): boolean {
  if (rulesOf(template, object).length > 0) return true;
  return (
    object.toLowerCase() === ACCOUNT.toLowerCase() &&
    personAccountRules(template.rules as AnonymizationTemplateRule[]).length > 0
  );
}

/** Whether two templates' rules mask the same fields the same way. */
function sameRules(a: Listed['rules'], b: Listed['rules']): boolean {
  const key = (rules: Listed['rules']): string =>
    JSON.stringify(
      rules
        .map((r) => [r.fieldPattern.toLowerCase(), r.ruleType, r.config ?? null])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  return key(a) === key(b);
}

/** A value as a line shows it: text in quotes, cut at forty characters. */
function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}

/**
 * The lines a run's answer comes to, as the panel shows it: the message its
 * notification carries, then each object's records — counted, masked, refused,
 * still holding their original values — the first refusal, the fields the org
 * does not have, and the snapshot with the line that puts it back. Exported so
 * it can be tested.
 */
export function resultLines(
  payload: Record<string, unknown>,
  restoreLine: (snapshotId: string) => string,
): string[] {
  const lines: string[] = [];
  if (typeof payload.message === 'string') lines.push(payload.message);
  for (const o of (payload.objects as ResultObject[] | undefined) ?? []) {
    lines.push(
      `  ${o.objectApiName.padEnd(28)} counted ${o.total}  masked ${o.processed}  ` +
        `refused ${o.failed}  still original ${o.notMasked}`,
    );
  }
  const errors = (payload.errors as Array<{ objectApiName: string; message: string }>) ?? [];
  if (errors[0]) lines.push(`  e.g. ${errors[0].objectApiName}: ${errors[0].message}`);
  const snapshot = payload.snapshot as { operationId: string; totalRecords: number } | undefined;
  if (snapshot) {
    lines.push(
      `snapshot ${snapshot.operationId}: ${snapshot.totalRecords} record(s) as they were before ` +
        'the run. To put their values back:',
      `  ${restoreLine(snapshot.operationId)}`,
    );
  }
  return lines;
}

/**
 * The lines a dry run comes to: per object, the records a run would mask
 * under its filter, each field with its method, the fields the org lacks, and
 * the first records masked as a run masks them — their new values only. A
 * stopped run that a resume would carry on is said. Exported so it can be tested.
 */
export function dryRunLines(
  template: Listed,
  coverage: Record<string, unknown>,
  preview: Record<string, unknown>,
): string[] {
  const lines = ['dry run — nothing is written'];
  const counted =
    (coverage.objects as Array<{ objectApiName: string; count: number | null }>) ?? [];
  const previewed =
    (preview.objects as Array<{
      objectApiName: string;
      fields: string[];
      methods?: Record<string, string>;
      rows: Array<{ id: string; after: Record<string, unknown> }>;
      error?: string;
    }>) ?? [];
  const missing =
    (preview.fieldsNotFound as Array<{ objectApiName: string; fieldApiName: string }>) ?? [];
  for (const o of counted) {
    const rows = o.count === null ? 'an unknown number of' : String(o.count);
    lines.push(`  ${o.objectApiName}: ${rows} record(s) to mask`);
    const shownObject = previewed.find((p) => p.objectApiName === o.objectApiName);
    if (shownObject?.error) {
      lines.push(`    not read: ${shownObject.error}`);
      continue;
    }
    // The method the handler says each field is masked by — a person
    // account's fields the template does not name included — or else the
    // template's.
    const methods = new Map([
      ...rulesOf(template, o.objectApiName).map(
        (r) => [r.fieldPattern.split('.').pop()?.toLowerCase() ?? '', r.ruleType] as const,
      ),
      ...Object.entries(shownObject?.methods ?? {}).map(
        ([field, method]) => [field.toLowerCase(), method] as const,
      ),
    ]);
    const fields = shownObject?.fields ?? [];
    lines.push(
      `    fields: ${
        fields.map((f) => `${f} (${methods.get(f.toLowerCase()) ?? '?'})`).join(', ') || '(none)'
      }`,
    );
    for (const m of missing.filter((m) => m.objectApiName === o.objectApiName)) {
      lines.push(
        `    ${m.objectApiName}.${m.fieldApiName}: the org has no such field — masks nothing`,
      );
    }
    const sample = shownObject?.rows ?? [];
    if (sample.length > 0) {
      // The handler masks with a key its window draws, and each command is a
      // window of its own: run for real after this dry run, the first contact
      // was given another made-up name than the one shown here. A mask, a
      // constant or a truncation is what the run writes.
      lines.push(
        '    the first records, masked as a run masks them (a run draws its own key, so its ' +
          'made-up names and digests differ from these):',
      );
      for (const row of sample) {
        lines.push(
          `      ${row.id}: ${fields.map((f) => `${f} ${shown(row.after[f])}`).join(', ')}`,
        );
      }
    }
  }
  const total = counted.reduce((sum, o) => sum + (o.count ?? 0), 0);
  if (total > 0) {
    lines.push(
      `  a run takes a snapshot of these ${total} record(s) first, and writes nothing without it`,
    );
  }
  const checkpoint = coverage.checkpoint as { id: string; savedAt: string } | undefined;
  if (checkpoint) {
    lines.push(
      `  a run of this template, object and filter stopped short on ${checkpoint.savedAt}: ` +
        '--resume masks only what it left',
    );
  }
  return lines;
}

/** The exit code of a run Ctrl-C stopped, as a shell gives a process SIGINT ended. */
const INTERRUPTED_EXIT = 130;

/**
 * What a restore Ctrl-C stopped says last: the line that puts back the rest.
 * Exported so it can be tested.
 */
export function restoreInterruptedLine(again: string): string {
  return (
    'interrupted: the restore stopped before it was through; what it restored is in the audit ' +
    `trail, and the same line puts back the rest: ${again}`
  );
}

/** What a masking run Ctrl-C stopped says last. Exported so it can be tested. */
export function maskingInterruptedLine(): string {
  return (
    'interrupted: the masking stopped before it was through; what it masked is in the audit ' +
    'trail, the snapshot puts their values back (--restore), and the same line with --resume ' +
    'masks only what it left'
  );
}

/** The posted messages, with a preview's original values left out (see --json). */
function withoutOriginals(posted: readonly Posted[]): Posted[] {
  return posted.map((message) => {
    if (message.type !== 'dataops:anonymize:preview:response') return message;
    const objects = (message.payload?.objects as Array<Record<string, unknown>>) ?? [];
    return {
      ...message,
      payload: {
        ...message.payload,
        objects: objects.map((o) => ({
          ...o,
          rows: ((o.rows as Array<Record<string, unknown>>) ?? []).map(({ id, after }) => ({
            id,
            after,
          })),
        })),
      },
    };
  });
}

/** Run one DataOps masking operation; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const log = (line: string): void => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };
  /** End the run as failed, saying why. */
  const fail = (message: string): void => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  };

  mkdirSync(args.storeDir, { recursive: true });
  const session = await loadOrg(args.org);
  // Typed as the extension types an org it connects (`orgTypeOf`): its
  // `Organization` record, `IsSandbox` and its edition.
  const identity = await new AuthProvider().validateConnection(
    session.accessToken,
    session.instanceUrl,
  );
  const org = {
    alias: args.org,
    orgType: orgTypeOf({ isSandbox: identity.isSandbox, edition: identity.orgType }),
    metadata: { apiVersion: '66.0', edition: identity.orgType },
  };
  log(
    `sandforge-dataops  ${args.org} (${identity.isSandbox ? 'sandbox' : identity.orgType || 'production'})` +
      `  store: ${args.storeDir}`,
  );
  const configStore = fileConfigStore(join(args.storeDir, 'snapshots.json'));

  // What the panel would have received, kept rather than posted; the progress
  // of a run is printed as it goes, every tenth of the way.
  const posted: Posted[] = [];
  const lastPercent = new Map<string, number>();
  // Where the masking run and its snapshot are listed while they go, as in
  // the extension: what Ctrl-C stops them through.
  const registry = new BackgroundOperationRegistry();
  const handler = new DataOpsHandler({
    log: (message: string) => {
      if (/^\[(WARN|INFO)\]/.test(message)) log(`  ${message}`);
    },
    broker: {
      postToWebview: (message: Posted) => {
        posted.push(message);
        if (message.type !== 'operation:progress') return;
        // The snapshot and the run are two operations, each with its own progress.
        const operation = String(message.payload?.operationId ?? '');
        const percent = Number(message.payload?.percentage ?? 0);
        if (percent - (lastPercent.get(operation) ?? -10) >= 10 || percent === 100) {
          lastPercent.set(operation, percent);
          log(`  ${percent}%  ${String(message.payload?.currentStep ?? '')}`);
        }
      },
    },
    orgManager: { getOrg: () => org },
    orgRegistry: {
      getCredentials: async () => ({
        accessToken: session.accessToken,
        instanceUrl: session.instanceUrl,
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
      backgroundRegistry: registry,
      // The guard asks before a write to a production org, and the question is
      // answered here: no. `--yes` answers the question this command asks, not
      // the one the guard would put to a person in front of the extension.
      productionGuard: new ProductionGuard({
        requestConfirmation: (impactSummary: string, tier: string): Promise<boolean> => {
          log(
            `refused: ${args.org} is taken for a ${tier} org, and this command writes to none ` +
              `(${impactSummary})`,
          );
          return Promise.resolve(false);
        },
      }),
      // As sandforge-backup asks it: a snapshot of the org an alias reached
      // before a refresh goes into the org it reaches now only on a yes typed here.
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
  handler.setBackupRecordStore(new BackupRecordStore(nodeBackupFiles(args.storeDir)));

  /**
   * Send a request as the panel does, and take what answers it as the
   * panel's hook does: its response type, or the error channel, carrying the
   * request's id.
   */
  const send = async (type: string, payload: Record<string, unknown>): Promise<Posted> => {
    const id = `cli-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await handler.handle({ id, type, timestamp: Date.now(), payload } as never);
    const answer = posted.find(
      (m) =>
        m.correlationId === id && (m.type === `${type}:response` || m.type === 'dataops:error'),
    );
    return answer ?? { type: 'dataops:error', payload: { message: `${type} was not answered.` } };
  };
  const failed = (answer: Posted): boolean => answer.type === 'dataops:error';
  const reason = (answer: Posted): string => String(answer.payload?.message ?? answer.type);
  const restoreLine = (snapshotId: string): string =>
    `pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize --org ${args.org} ` +
    `--restore ${snapshotId} --store ${args.storeDir}`;
  const emit = (command: Mode): void => {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          { tool: 'sandforge-dataops', command, org: args.org, posted: withoutOriginals(posted) },
          null,
          2,
        )}\n`,
      );
    }
  };

  if (args.mode === 'restore') {
    const restoreId = args.restoreId!;
    const meta = configStore.get<{
      totalRecords?: number;
      objects?: Array<{ objectApiName: string }>;
    }>(`backup:${restoreId}`);
    if (!meta) {
      fail(`No snapshot "${restoreId}" in ${args.storeDir}.`);
      return;
    }
    const objects = (meta.objects ?? []).map((o) => o.objectApiName).join(', ');
    if (
      !args.yes &&
      !(await confirm(
        `Put back into ${args.org} the values snapshot ${restoreId} holds? ` +
          `${meta.totalRecords ?? '?'} record(s) of ${objects} will have those fields written over.`,
      ))
    ) {
      log('Nothing written.');
      return;
    }
    log(
      `restoring ${restoreId} into ${args.org}` +
        `${args.rewriteAll ? ', every row written back' : ''}…`,
    );
    // Ctrl-C stops the restore as the panel's Cancel does, through the
    // registry it is listed in: before its next batch, with what it restored
    // kept in the audit trail. It used to end the process part way. A second
    // Ctrl-C ends the process at once.
    let restoreInterrupted = false;
    const interruptRestore = (): void => {
      restoreInterrupted = true;
      process.stderr.write(
        '\ninterrupted: the restore stops before its next batch, and says what it restored ' +
          '(Ctrl-C again ends it at once)\n',
      );
      for (const operation of registry.getRunning()) registry.abort(operation.operationId);
    };
    process.once('SIGINT', interruptRestore);
    let answer: Posted;
    try {
      answer = await send('dataops:rollback', {
        orgId: args.org,
        operationId: restoreId,
        ...(args.rewriteAll ? { rewriteAll: true } : {}),
      });
    } finally {
      process.off('SIGINT', interruptRestore);
    }
    emit('restore');
    if (failed(answer)) {
      fail(reason(answer));
      return;
    }
    log(String(answer.payload?.message ?? ''));
    if (restoreInterrupted) {
      process.stderr.write(`${restoreInterruptedLine(restoreLine(restoreId))}\n`);
      process.exitCode = INTERRUPTED_EXIT;
    }
    return;
  }

  // The template, as the panel lists it: one that ships, one saved in the
  // store, or the rules file saved as one the way the panel's editor saves it.
  const listed = await send('dataops:anonymization-templates', {});
  const templates = (listed.payload?.templates as Listed[] | undefined) ?? [];
  let template: Listed | undefined;
  if (args.rules) {
    const fileRules = args.rules;
    const same = templates.find(
      (t) => t.saved === true && t.name.trim().toLowerCase() === fileRules.name.toLowerCase(),
    );
    if (same && sameRules(same.rules, fileRules.rules)) {
      // Saved by a run before this one: its checkpoint is kept under its id.
      template = same;
    } else {
      if (same) {
        // Its rules were edited since: a checkpoint of the old ones resumes nothing.
        await send('dataops:anonymization-template:delete', { templateId: same.id });
      }
      const saved = await send('dataops:anonymization-template:save', {
        name: fileRules.name,
        rules: fileRules.rules,
      });
      if (failed(saved)) {
        fail(reason(saved));
        return;
      }
      template = saved.payload?.template as Listed;
      log(`rules saved in the store as template "${template.name}" (${template.id})`);
    }
  } else {
    template = templates.find((t) => t.id === args.templateId);
    if (!template) {
      fail(
        `No template "${args.templateId ?? ''}". Templates: ` +
          templates.map((t) => `${t.id}${t.saved ? ` (saved: ${t.name})` : ''}`).join(', '),
      );
      return;
    }
  }
  const object = args.object;
  if (object !== undefined && !masksObject(template, object)) {
    fail(`Template "${template.name}" has no rule for ${object}: a run would mask nothing.`);
    return;
  }
  const scope = {
    orgId: args.org,
    templateId: template.id,
    ...(object !== undefined ? { objects: [object] } : {}),
    ...(args.where !== undefined ? { where: args.where } : {}),
  };
  log(
    `template: ${template.name} (${template.id})  ` +
      (object !== undefined ? `object: ${object}` : 'objects: every object the template masks') +
      (args.where !== undefined ? `  where: ${args.where}` : ''),
  );

  // What a run would mask, as the panel shows it before Apply: the records
  // under the filter, and the checkpoint a resume would carry on from.
  const coverage = await send('dataops:anonymize:coverage', scope);
  if (failed(coverage)) {
    fail(reason(coverage));
    return;
  }
  const counted =
    (coverage.payload?.objects as Array<{ objectApiName: string; count: number | null }>) ?? [];
  const toMask = counted.reduce((sum, o) => sum + (o.count ?? 0), 0);

  if (args.mode === 'dry-run') {
    const preview = await send('dataops:anonymize:preview', scope);
    emit('dry-run');
    if (failed(preview)) {
      fail(reason(preview));
      return;
    }
    for (const line of dryRunLines(template, coverage.payload ?? {}, preview.payload ?? {})) {
      log(line);
    }
    return;
  }

  const checkpoint = coverage.payload?.checkpoint as { id: string; savedAt: string } | undefined;
  if (args.mode === 'resume' && !checkpoint) {
    fail(
      'There is nothing to resume: no run of this template, object and filter stopped short ' +
        `in ${args.storeDir}.`,
    );
    return;
  }
  if (args.mode === 'run' && toMask === 0) {
    log(
      object !== undefined
        ? 'Nothing to mask: no record of the object is under the filter.'
        : 'Nothing to mask: no object the template masks holds a record.',
    );
    emit('run');
    return;
  }
  if (!args.yes) {
    /** What the run masks, in words: the object, or the objects the coverage counted. */
    const masked = object ?? counted.map((o) => o.objectApiName).join(', ');
    const question =
      args.mode === 'resume'
        ? `Resume the masking of ${masked} in ${args.org} that stopped on ${checkpoint!.savedAt}? ` +
          'What it left is written over; the snapshot the first run took holds their values.'
        : `Mask ${toMask} record(s) of ${masked} in ${args.org} with ${template.name}? ` +
          'A snapshot of their values is taken first.';
    if (!(await confirm(question))) {
      log('Nothing written.');
      return;
    }
  }

  log(args.mode === 'resume' ? 'resuming…' : 'masking…');
  // Ctrl-C stops the run as the panel's Cancel does, through the registry
  // the run is listed in: before its next page, with what it masked kept in
  // the audit trail and the checkpoint a resume carries on from. Killed
  // outright, it left neither. A second Ctrl-C ends the process at once.
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    process.stderr.write(
      '\ninterrupted: the masking stops before its next page, and says what it masked ' +
        '(Ctrl-C again ends it at once)\n',
    );
    for (const operation of registry.getRunning()) registry.abort(operation.operationId);
  };
  process.once('SIGINT', interrupt);
  let answer: Posted;
  try {
    answer = await send('dataops:anonymize', {
      ...scope,
      ...(args.mode === 'resume' ? { resumeFrom: checkpoint!.id } : { snapshot: true }),
    });
  } finally {
    process.off('SIGINT', interrupt);
  }
  emit(args.mode);
  for (const line of resultLines(answer.payload ?? {}, restoreLine)) log(line);
  if (interrupted) {
    process.stderr.write(`${maskingInterruptedLine()}\n`);
    process.exitCode = INTERRUPTED_EXIT;
    return;
  }
  if (failed(answer)) {
    process.exitCode = 1;
    return;
  }
  const left = Number(answer.payload?.recordsNotMasked ?? 0);
  if (left > 0) {
    log(
      'A resume masks only what this run left: the same line with --resume, in place of the ' +
        'snapshot it does not take again.',
    );
  }
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (/sandforge-dataops\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  main()
    .then(() => process.exit())
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
