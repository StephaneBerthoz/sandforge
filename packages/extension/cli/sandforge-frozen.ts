#!/usr/bin/env tsx
/**
 * sandforge-frozen — headless Frozen Dataset runner: select, extract, load,
 * verify and remove, through the panel's own handler.
 *
 * The sixth of these. The five before it found twenty-five defects between
 * them, every one against a real org and none against any gate.
 *
 * It drives `FrozenDatasetHandler` rather than a copy of its wiring, and
 * stands up only what the extension host hands it: orgs known to the `sf`
 * CLI, typed from the org itself the way the panel types them; a config store
 * kept in a JSON file; the production guard; and a broker that prints what
 * the panel would have received.
 *
 * Each step is one message the panel sends:
 *   select   pick one root record per combination of the coverage matrix
 *   extract  read those roots' graphs, pseudonymize, check, freeze
 *   load     replay the frozen dataset into a sandbox — writes
 *   verify   check the last load against the dataset, read-only
 *   remove   delete from the sandbox the records the last load created — or,
 *            once they went, those of the load before it — deletes
 *   status   what the store knows so far
 *
 * The configuration is the panel's own (`FrozenProjectConfig`, as JSON) and
 * goes in through the handler's schema. The pseudonymization salt comes from
 * `SANDFORGE_FROZEN_SALT` and nowhere else, as in the editor.
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts select  --config frozen.json --source SRC
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts extract --config frozen.json --source SRC
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts load    --config frozen.json --target TGT
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts remove  --config frozen.json --target TGT
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadOrg, makeConn } from './sfSession.js';
import { fileConfigStore } from './fileConfigStore.js';
import { FrozenDatasetHandler } from '../src/bridge/handlers/FrozenDatasetHandler.js';
import { ProductionGuard } from '../src/core/precheck/ProductionGuard.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';

const HELP = `sandforge-frozen — build and replay a Frozen Dataset, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-frozen.ts <step> --config <file> [options]

Steps:
  select     pick one root per combination of the coverage matrix   (needs --source)
  extract    read, pseudonymize, check and freeze those roots        (needs --source)
  load       replay the frozen dataset into a sandbox — WRITES       (needs --target)
  verify     check the last load against the dataset                 (needs --target)
  remove     delete the records a load created, the last first — DELETES (needs --target)
  status     what the store knows so far

Required:
  --config <file>        the project configuration, as the panel saves it (JSON)

Options:
  --source <alias>       sf CLI alias of the org the dataset is read from
  --target <alias>       sf CLI alias of the sandbox it is loaded into
  --author <name>        who froze the dataset, for the manifest   (default: sandforge)
  --store <file>         where the run keeps its state   (default: <sasDir>/cli-store.json)
  --pilot                load one root folder only
  --reload               purge what earlier loads created, then load again
  --include-changed      remove also the records changed since the load, and what
                         was added to them since (kept otherwise)
  --yes                  do not ask before a load writes or a removal deletes
  --json                 emit what the panel would receive
  --help                 this text

The salt that makes pseudonyms repeatable is read from SANDFORGE_FROZEN_SALT,
and only from there.

Exit codes: 0 the step finished, 1 it failed or could not start, 2 a bad command line.
`;

const STEPS = ['select', 'extract', 'load', 'verify', 'remove', 'status'] as const;
type Step = (typeof STEPS)[number];

/** Everything the command line settled. */
interface CliArgs {
  step: Step;
  configPath: string;
  source?: string;
  target?: string;
  author?: string;
  storePath?: string;
  pilot: boolean;
  reload: boolean;
  includeChanged: boolean;
  yes: boolean;
  json: boolean;
}

/** Read the command line, or explain why it cannot be read. */
export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const get = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
  };

  const step = args[0] as Step;
  if (!STEPS.includes(step)) {
    process.stderr.write(`The first word is the step: ${STEPS.join(', ')} — not "${args[0]}".\n`);
    process.exit(2);
  }
  const configPath = get('--config');
  if (!configPath) {
    process.stderr.write('Missing --config. Run with --help.\n');
    process.exit(2);
  }
  const source = get('--source');
  const target = get('--target');
  if ((step === 'select' || step === 'extract') && !source) {
    process.stderr.write(`${step} reads the source org: give --source.\n`);
    process.exit(2);
  }
  if ((step === 'load' || step === 'verify' || step === 'remove') && !target) {
    process.stderr.write(`${step} works on the target org: give --target.\n`);
    process.exit(2);
  }

  return {
    step,
    configPath,
    source,
    target,
    author: get('--author'),
    storePath: get('--store'),
    pilot: args.includes('--pilot'),
    reload: args.includes('--reload'),
    includeChanged: args.includes('--include-changed'),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
  };
}

/** An org as the extension's org manager and registry hold it. */
interface KnownOrg {
  org: { id: string; alias: string; orgType: string; metadata: { apiVersion: string } };
  credentials: { accessToken: string; instanceUrl: string };
}

/**
 * Register an `sf` alias under its real org id, typed from the org.
 *
 * The panel types an org from `Organization.IsSandbox` when it connects it
 * (`OrgHandler`), and every guard of the load reads that type. A runner that
 * guessed it would be testing its guess.
 */
async function registerOrg(alias: string, orgs: Map<string, KnownOrg>): Promise<string> {
  const session = await loadOrg(alias);
  const conn = makeConn(session);
  const result = await conn.query<{ Id: string; IsSandbox: boolean }>(
    'SELECT Id, IsSandbox FROM Organization LIMIT 1',
  );
  const row = result.records[0];
  if (!row) throw new Error(`Could not read the Organization record of '${alias}'.`);
  orgs.set(row.Id, {
    org: {
      id: row.Id,
      alias,
      orgType: row.IsSandbox ? 'Sandbox' : 'Production',
      metadata: { apiVersion: '66.0' },
    },
    credentials: { accessToken: session.accessToken, instanceUrl: session.instanceUrl },
  });
  return row.Id;
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

/** Ask on the terminal for a word to be typed, and hand back what was. */
async function typed(question: string): Promise<string> {
  process.stdout.write(`${question} `);
  return new Promise((resolve) => {
    process.stdin.once('data', (chunk) => {
      resolve(String(chunk).trim());
      process.stdin.pause();
    });
    process.stdin.resume();
  });
}

type Posted = { type?: unknown; payload?: Record<string, unknown> } & Record<string, unknown>;

/** The records of the load a removal takes next, as `frozen:status` counts them. */
interface LoadRecords {
  orgId: string;
  loadedAt: string;
  created: Array<{ objectApiName: string; count: number }>;
  linked: number;
  recorded: boolean;
  removed?: { removedAt: string };
  /** A load before the last one, whose records the loads after it left in the org. */
  earlier?: boolean;
}

/**
 * What a removal of the load would take, for the person asked to confirm it:
 * which load, the org, the records per object in the order they go, and what
 * stays. Exported so it can be tested.
 */
export function removalPlanLines(records: LoadRecords, org: string): string[] {
  const total = records.created.reduce((sum, object) => sum + object.count, 0);
  const which = records.earlier
    ? 'a load before the last one, whose records the loads after it left in place,'
    : 'the last load';
  return [
    `${which} wrote to ${org} at ${records.loadedAt}; a removal deletes the ${total} record(s) it created, children first:`,
    ...records.created.map((object) => `  ${object.objectApiName}: ${object.count}`),
    `${records.linked} record(s) it linked to or reused stay`,
  ];
}

/** What became of one object's records in a removal, the counts that are not zero. */
function removalCounts(object: {
  deleted: number;
  alreadyGone: number;
  keptChanged: number;
  keptDependents: number;
  refused: number;
  heldBy: string[];
}): string {
  return [
    object.deleted > 0 ? `${object.deleted} deleted` : '',
    object.alreadyGone > 0 ? `${object.alreadyGone} already gone` : '',
    object.keptChanged > 0 ? `${object.keptChanged} kept, changed since the load` : '',
    object.keptDependents > 0
      ? `${object.keptDependents} kept for records that stay` +
        (object.heldBy.length > 0 ? ` (${object.heldBy.join(', ')})` : '')
      : '',
    object.refused > 0 ? `${object.refused} refused` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * How far discovery reached, and whether it stopped short. The objects can
 * outnumber the cap — each parent a record reached cannot be written without
 * raises it by one, to twice it — and "100 object(s) at a cap of 50" read as
 * the cap not holding: that is said.
 */
function graphLine(graph: { objects: number; truncated: boolean; maxNodes: number }): string {
  return (
    `graph: ${graph.objects} object(s) at a cap of ${graph.maxNodes}` +
    (graph.objects > graph.maxNodes
      ? ' (raised for the parents their records cannot be written without)'
      : '') +
    (graph.truncated ? ' — TRUNCATED: objects further out were not read' : '')
  );
}

/**
 * One line per thing the panel would have shown, for a person reading along.
 * Exported so it can be tested.
 */
export function messageLines(message: Posted): string[] {
  const type = String(message.type ?? '');
  const p = message.payload ?? {};
  if (type.endsWith(':error')) {
    return [`! ${type}: ${String(p.message ?? '')}${p.code ? ` [${String(p.code)}]` : ''}`];
  }
  switch (type) {
    case 'frozen:select:response': {
      const s = p.selection as {
        combinations: Array<{ combinationKey: string }>;
        uncovered: Array<{ combinationKey: string; reason: string }>;
        volumetry: { total: number; budgetMax: number; measured: Record<string, number> };
        graph?: { objects: number; truncated: boolean; maxNodes: number };
      };
      return [
        `selected ${s.combinations.length} root(s): ${s.combinations.map((c) => c.combinationKey).join(', ')}`,
        ...s.uncovered.map((u) => `  uncovered ${u.combinationKey}: ${u.reason}`),
        ...(s.graph ? [graphLine(s.graph)] : []),
        `volumetry ${s.volumetry.total} / ${s.volumetry.budgetMax} record(s)`,
        ...Object.entries(s.volumetry.measured)
          .filter(([, n]) => n > 0)
          .map(([name, n]) => `  ${name}: ${n}`),
      ];
    }
    case 'frozen:control:result': {
      const r = p.report as {
        passed: boolean;
        checks: Array<{ name: string; passed: boolean; violations: unknown[] }>;
      };
      return [
        `non-reidentification control: ${r.passed ? 'PASSED' : 'FAILED'}`,
        ...r.checks.map(
          (c) =>
            `  ${c.passed ? 'ok  ' : 'FAIL'} ${c.name}` +
            (c.violations.length > 0 ? ` (${c.violations.length} violation(s))` : ''),
        ),
      ];
    }
    case 'frozen:extract:response': {
      const m = p.manifest as {
        version: string;
        volumetry: { measured: Record<string, number> };
        coverage?: {
          objects: number;
          truncated: boolean;
          maxNodes: number;
          unboundedObjects: string[];
          leftToThePlatform?: Array<{ objectApiName: string; note: string }>;
          exclusionCosts?: Array<{ objectApiName: string; note: string }>;
        };
      };
      return [
        `frozen ${String(p.recordCount)} record(s) as version ${m.version} in ${String(p.datasetDir)}`,
        ...(m.coverage ? [graphLine(m.coverage)] : []),
        ...(m.coverage && m.coverage.unboundedObjects.length > 0
          ? [`read without the time bound: ${m.coverage.unboundedObjects.join(', ')}`]
          : []),
        // Not in the dataset: no load could write them.
        ...(m.coverage?.leftToThePlatform ?? []).map(
          (left) => `${left.objectApiName}: ${left.note}`,
        ),
        // In the dataset, and not loadable as they are: excludedObjects left
        // out what they need.
        ...(m.coverage?.exclusionCosts ?? []).map((cost) => `${cost.objectApiName}: ${cost.note}`),
        ...Object.entries(m.volumetry.measured)
          .filter(([, n]) => n > 0)
          .map(([name, n]) => `  ${name}: ${n}`),
      ];
    }
    case 'frozen:load:response': {
      const r = p.report as {
        status: string;
        durationMs: number;
        alignment: {
          excludedObjects: Array<{ objectApiName: string; reason: string }>;
          removals: unknown[];
          recordTypeIssues: unknown[];
        };
        placeholders: unknown[];
        perObject: Array<{
          objectApiName: string;
          fromFiles: number;
          inserted: number;
          reused: number;
          skippedDuplicates: unknown[];
          failed: Array<{ errors?: string[]; error?: string }>;
        }>;
        pass2: {
          resolved: number;
          unresolved: Array<{ objectApiName: string; field: string; detail: string }>;
        };
        personContact?: { restored: number; unresolved: Array<{ detail: string }> };
        statuses?: {
          restored: number;
          refused: Array<{ objectApiName: string; status: string; detail: string }>;
        };
        purge: {
          deleted: Record<string, number>;
          deactivated?: Record<string, number>;
          failures: Array<{ objectApiName: string; errors: string[] }>;
          leftUnrecorded?: Record<string, number>;
        };
        leftToThePlatform?: Array<{ objectApiName: string; note: string }>;
        untypedFeedItems?: Array<{ objectApiName: string; note: string }>;
      };
      const lines = [
        `load: ${r.status} in ${r.durationMs}ms — ${r.alignment.excludedObjects.length} object(s) ` +
          `excluded, ${r.alignment.removals.length} field removal(s), ` +
          `${r.alignment.recordTypeIssues.length} record type issue(s), ` +
          `${r.placeholders.length} placeholder(s)`,
      ];
      // Which, and why: counted only, an object the target takes no insert of
      // read like one the target lacks, and the load's errors named nothing.
      for (const excluded of r.alignment.excludedObjects) {
        lines.push(`  ${excluded.objectApiName}: not loaded — ${excluded.reason}`);
      }
      for (const o of r.perObject) {
        lines.push(
          `  ${o.objectApiName}: ${o.inserted} inserted, ${o.reused} reused, ` +
            `${o.skippedDuplicates.length} duplicate(s), ${o.failed.length} failed of ${o.fromFiles}`,
        );
        const first = o.failed[0];
        if (first) lines.push(`      first refusal: ${first.errors?.[0] ?? first.error ?? '?'}`);
      }
      // Never sent: no load could write them, or this dataset cannot say
      // which of them the platform writes itself.
      for (const left of [...(r.leftToThePlatform ?? []), ...(r.untypedFeedItems ?? [])]) {
        lines.push(`  ${left.objectApiName}: ${left.note}`);
      }
      lines.push(`pass 2: ${r.pass2.resolved} resolved, ${r.pass2.unresolved.length} unresolved`);
      for (const u of r.pass2.unresolved.slice(0, 5)) {
        lines.push(`  ${u.objectApiName}.${u.field}: ${u.detail}`);
      }
      // A person account's link to its contact, set once both are in: the
      // Load tab says how many went back and why the others did not, and the
      // command said neither. A dataset with no person account has none.
      const personContact = r.personContact;
      if (personContact && personContact.restored + personContact.unresolved.length > 0) {
        lines.push(
          `PersonContact: ${personContact.restored} restored, ` +
            `${personContact.unresolved.length} unresolved`,
        );
        for (const u of personContact.unresolved.slice(0, 5)) {
          lines.push(`  Account.PersonContactId: ${u.detail}`);
        }
      }
      if (r.statuses && r.statuses.restored + r.statuses.refused.length > 0) {
        lines.push(
          `statuses applied after insert: ${r.statuses.restored}, refused ${r.statuses.refused.length}`,
        );
        for (const f of r.statuses.refused.slice(0, 5)) {
          lines.push(`  ${f.objectApiName} → ${f.status}: ${f.detail}`);
        }
      }
      // What the target lets no one delete, the purge deactivates: counted as
      // deleted only, a purge that took nothing else printed no line at all.
      const total = (counts: Record<string, number>): number =>
        Object.values(counts).reduce((a, b) => a + b, 0);
      const deleted = total(r.purge.deleted);
      const deactivated = total(r.purge.deactivated ?? {});
      if (deleted + deactivated + r.purge.failures.length > 0) {
        lines.push(
          `purge of earlier loads: ${deleted} deleted, ${deactivated} deactivated, ` +
            `${r.purge.failures.length} failed`,
        );
        for (const f of r.purge.failures.slice(0, 5)) {
          lines.push(`  ${f.objectApiName}: ${f.errors[0] ?? '?'}`);
        }
      }
      // A load recorded before loads kept what they created cannot say which
      // of its records it linked: what it may have linked stays, and is named.
      const left = Object.entries(r.purge.leftUnrecorded ?? {});
      if (left.length > 0) {
        lines.push(
          'left in place, of a load recorded before loads kept what they created — it may have linked them:',
        );
        for (const [objectApiName, count] of left) lines.push(`  ${objectApiName}: ${count}`);
      }
      return lines;
    }
    case 'frozen:verify:result': {
      const v = p.verdict as {
        status: string;
        checks: Array<{ name: string; passed: boolean; detail: string }>;
      };
      return [
        `verification: ${v.status.toUpperCase()}`,
        ...v.checks.map((c) => `  ${c.passed ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`),
      ];
    }
    case 'frozen:remove:response': {
      const r = p.result as {
        status: string;
        objects: Array<{
          objectApiName: string;
          planned: number;
          deleted: number;
          alreadyGone: number;
          keptChanged: number;
          keptDependents: number;
          refused: number;
          heldBy: string[];
          unchecked: string[];
          reasons: string[];
        }>;
      };
      const unchecked = [...new Set(r.objects.flatMap((o) => o.unchecked))];
      return [
        `removal: ${r.status.toUpperCase()}`,
        ...r.objects.flatMap((o) => [
          `  ${o.objectApiName}: ${removalCounts(o) || 'nothing'} of ${o.planned}`,
          ...o.reasons.map((reason) => `      ${reason}`),
        ]),
        ...(unchecked.length > 0
          ? [`not checked, deleted with their parent: ${unchecked.join(', ')}`]
          : []),
      ];
    }
    case 'frozen:status:response':
      return [JSON.stringify(p.status, null, 2)];
    default:
      return [];
  }
}

/** Run one step; exported so its parsing can be tested. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const t0 = Date.now();
  const args = parseArgs(argv);
  const log = (line: string): void => {
    if (!args.json) process.stdout.write(`${line}\n`);
  };

  const config = JSON.parse(readFileSync(args.configPath, 'utf8')) as Record<string, unknown>;
  const sasDir =
    typeof config.sasDir === 'string' ? config.sasDir : join(homedir(), '.sandforge-sas');
  mkdirSync(sasDir, { recursive: true });
  const configStore = fileConfigStore(args.storePath ?? join(sasDir, 'cli-store.json'));

  const orgs = new Map<string, KnownOrg>();
  const sourceOrgId = args.source ? await registerOrg(args.source, orgs) : undefined;
  const targetOrgId = args.target ? await registerOrg(args.target, orgs) : undefined;

  // What the panel would have received, printed instead of posted — but for
  // what a step reads for itself.
  const posted: Posted[] = [];
  let failed = false;
  let quiet = false;
  const handler = new FrozenDatasetHandler({
    log: () => undefined,
    broker: {
      postToWebview: (message: Posted) => {
        if (message.type === 'frozen:load:progress') return;
        posted.push(message);
        if (String(message.type ?? '').endsWith(':error')) failed = true;
        if (quiet) return;
        for (const line of messageLines(message)) log(line);
      },
    },
    orgManager: { getOrg: (id: string) => orgs.get(id)?.org },
    orgRegistry: { getCredentials: async (id: string) => orgs.get(id)?.credentials },
    configStore,
    infraServices: { productionGuard: new ProductionGuard(), piiDetector: new PIIDetector() },
    // Built rather than stubbed: every message the handler posts carries one.
    nextId: () => `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } as never);

  const send = (type: string, payload: Record<string, unknown>): Promise<boolean> =>
    handler.handle({ id: `cli-${type}-${Date.now()}`, type, payload } as never);

  // The configuration goes in the way the panel saves it: through the schema.
  await send('frozen:config:save', { config });
  if (failed) {
    process.exitCode = 1;
    return;
  }

  switch (args.step) {
    case 'select':
      log(`selecting from ${args.source}…`);
      await send('frozen:select', { sourceOrgId });
      break;
    case 'extract':
      log(`extracting from ${args.source}…`);
      await send('frozen:extract', {
        sourceOrgId,
        ...(args.author ? { author: args.author } : {}),
      });
      break;
    case 'load': {
      if (!args.yes) {
        const ok = await confirm(
          `Load the frozen dataset into ${args.target}${args.reload ? ', purging first what earlier loads created' : ''}?`,
        );
        if (!ok) {
          log('Nothing written.');
          return;
        }
      }
      log(`loading into ${args.target}${args.pilot ? ' (pilot)' : ''}…`);
      await send('frozen:load', {
        targetOrgId,
        ...(args.pilot ? { pilot: true } : {}),
        ...(args.reload ? { reload: true } : {}),
      });
      break;
    }
    case 'verify':
      log(`verifying ${args.target}…`);
      await send('frozen:verify', { targetOrgId });
      break;
    case 'remove': {
      // What the page reads before it offers the removal, read the same way.
      quiet = true;
      await send('frozen:status', {});
      quiet = false;
      const status = posted.filter((m) => m.type === 'frozen:status:response').at(-1)?.payload
        ?.status as { lastLoadRecords?: LoadRecords } | undefined;
      const records = status?.lastLoadRecords;
      if (!records || records.orgId !== targetOrgId) {
        log(`No load into ${args.target} is recorded in this sas: nothing to remove.`);
        process.exitCode = 1;
        return;
      }
      for (const line of removalPlanLines(records, args.target ?? '')) log(line);
      if (!args.yes && records.recorded && !records.removed) {
        // Typed, as the panel asks it: the name of the org the records leave.
        const answer = await typed(`Type ${args.target} to delete them:`);
        if (answer !== args.target) {
          log('Nothing deleted.');
          return;
        }
      }
      log(`removing from ${args.target}…`);
      await send('frozen:remove', {
        targetOrgId,
        loadedAt: records.loadedAt,
        ...(args.includeChanged ? { includeChanged: true } : {}),
      });
      break;
    }
    case 'status':
      await send('frozen:status', {});
      break;
  }

  if (failed) process.exitCode = 1;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ tool: 'sandforge-frozen', posted }, null, 2)}\n`);
    return;
  }
  log(`done in ${Date.now() - t0}ms`);
}

// `tsx` runs this file directly; the check keeps it silent under test.
if (process.argv[1]?.includes('sandforge-frozen')) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
