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
 *   load     replay the frozen dataset into a sandbox or a Developer Edition —
 *            writes; with --dry-run, what it would do, read from the target,
 *            and nothing written
 *   verify   check the last load against the dataset, read-only
 *   remove   delete from the sandbox the records the last load created — what an
 *            earlier removal left of them, or, once they all went, those of the
 *            load before it — deletes
 *   status   what the store knows so far
 *
 * The configuration is the panel's own (`FrozenProjectConfig`, as JSON) and
 * goes in through the handler's schema. The pseudonymization salt comes from
 * `SANDFORGE_FROZEN_SALT`, or from the file `--salt-file` names, and is never
 * made up here: the editor keeps its own in VS Code's secret storage, and a
 * teammate copies it from there (`FrozenSalt`).
 *
 * Usage:
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts select  --config frozen.json --source SRC
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts extract --config frozen.json --source SRC
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts load    --config frozen.json --target TGT
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts load    --config frozen.json --target TGT --dry-run
 *   pnpm exec tsx packages/extension/cli/sandforge-frozen.ts remove  --config frozen.json --target TGT
 *
 * Run from the repository root of a checkout, after pnpm install and
 * pnpm build:shared.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Connection } from 'jsforce';
import type {
  ForgeSweepListing,
  ForgeSweepResult,
  FrozenDiscoveryOrigin,
  FrozenSelectProgress,
  FrozenSelectionStop,
  OrgType,
} from '@sandforge/shared';
import { orgTypeOf } from '@sandforge/shared';
import { loadOrg, makeConn } from './sfSession.js';
import { sweepLines, sweepListingLines, targetAutomationReader } from './sandforge-clone.js';
import { fileConfigStore } from './fileConfigStore.js';
import { FrozenDatasetHandler } from '../src/bridge/handlers/FrozenDatasetHandler.js';
import { BackgroundOperationRegistry } from '../src/core/engine/BackgroundOperationRegistry.js';
import { commandLineGuard } from './commandLineGuard.js';
import { refuseUnreadArguments, type CommandFlags } from './commandLine.js';
import { confirm, typed } from './prompt.js';
import { onStopSignal, stopExitCode, type StopSignal } from './stopSignals.js';
import {
  DONE_EXIT,
  endWith,
  FAILED_EXIT,
  PARTIAL_EXIT,
  UNSTABLE_EXIT,
  worstExit,
} from './exitCodes.js';
import { PIIDetector } from '../src/core/precheck/PIIDetector.js';
import { commandLineSaltKeeper } from '../src/modules/frozendataset/FrozenSalt.js';

const HELP = `sandforge-frozen — build and replay a Frozen Dataset, without the editor.

Usage:
  pnpm exec tsx packages/extension/cli/sandforge-frozen.ts <step> --config <file> [options]

Steps:
  select     pick one root per combination of the coverage matrix   (needs --source)
  extract    read, pseudonymize, check and freeze those roots        (needs --source)
  load       replay the frozen dataset into a sandbox or a Developer Edition
             — WRITES                                                 (needs --target)
  verify     check the last load against the dataset                 (needs --target)
  remove     delete the records a load created, the last first — DELETES (needs --target)
  status     what the store knows so far

Required:
  --config <file>        the project configuration, as the panel saves it (JSON)

Options:
  --source <alias>       sf CLI alias of the org the dataset is read from
  --target <alias>       sf CLI alias of the sandbox, or Developer Edition org, it is
                         loaded into
  --author <name>        who froze the dataset, for the manifest   (default: sandforge)
  --salt-file <file>     the file holding the pseudonymization salt, when
                         SANDFORGE_FROZEN_SALT is not set
  --store <file>         where the run keeps its state   (default: <sasDir>/cli-store.json)
  --pilot                load one root folder only
  --reload               purge what earlier loads created, then load again
  --dry-run              with load: say what the load would do — per object, what it
                         would insert, link, drop, rewrite and purge — and write nothing
  --include-changed      remove also the records changed since the load, and what
                         was added to them since (kept otherwise)
  --sweep                with remove: before the load's records go, delete too what
                         the target's automation created during the load, as the
                         load's user, that the load's mapping does not hold — in the
                         objects the load wrote, tasks, events, feed, email
                         messages, notes, case comments, and the objects the
                         target's flows create; the window is the load's writes,
                         from a second before the first to a minute after the
                         last. Refused when that user created records in the
                         window on objects neither the load nor the automation
                         reaches (hand work, likely). Such records then keep none
                         of the load's records as records that stay (off otherwise)
  --sweep-list           with remove: list what --sweep would delete, per object
                         with a few names, and delete nothing
  --yes                  do not ask before a load writes or a removal deletes.
                         Without it, a step with no terminal to answer the
                         question — a CI step — stops there, exit 2, and
                         writes nothing
  --json                 emit what the panel would receive, every other line on
                         stderr; a step that ends before its request, refused or
                         with nothing to do, says "ended": true
  --help                 this text

The salt that makes pseudonyms repeatable is read from SANDFORGE_FROZEN_SALT,
or else from --salt-file, and never made up here: an extraction without one is
refused. The editor keeps its own in VS Code's secret storage; copy it from there
with "SandForge: Copy Frozen Dataset Salt" to extract the same pseudonyms.

The graph a selection or an extraction discovers is kept in the sas
(discovery.json) and reused by the next one while the source's schema has not
changed and a day has not gone by: each says "graph reused from <step>" or
"rediscovered: <why>".

Ctrl-C stops a step after the call under way, a load recorded in the sas with
what it wrote, which remove takes back; a SIGTERM — a CI job cancelled or timed
out — or a SIGHUP stops it the same way. Ctrl-C again ends it at once.

Exit codes: 0 the step finished — a removal with nothing to take included —,
and verify's verdict is PASSED; 1 it failed or could not start, or verify's
verdict is FAILED; 2 a bad command line, or a question with no terminal to
answer it (give --yes); 3 verify's verdict is PARTIAL, a load completed with
errors, or a removal left records of the load; 4 verify's verdict is UNSTABLE:
no two readings agreed; 130 Ctrl-C stopped the step, 143 a SIGTERM, 129 a
SIGHUP. A load is judged by its own report: the verification it runs after it
is said, and the verify step gives it a code.
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
  /** The file holding the salt, read when SANDFORGE_FROZEN_SALT is not set. */
  saltFile?: string;
  pilot: boolean;
  reload: boolean;
  /** With load: what the load would do, and nothing written. */
  dryRun: boolean;
  includeChanged: boolean;
  /** With remove: sweep first what the target's automation created during the load. */
  sweep: boolean;
  /** With remove: list what a sweep would delete, and delete nothing. */
  sweepList: boolean;
  yes: boolean;
  json: boolean;
}

/** What the line reads after its step. */
const FLAGS: CommandFlags = {
  words: 1,
  switches: [
    '--pilot',
    '--reload',
    '--dry-run',
    '--include-changed',
    '--sweep',
    '--sweep-list',
    '--yes',
    '--json',
  ],
  values: ['--config', '--source', '--target', '--author', '--salt-file', '--store'],
};

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
  // `--dry-run=true` or `--dryrun` dropped without a word loaded for real.
  refuseUnreadArguments(args, FLAGS);
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
  if (args.includes('--sweep') && args.includes('--sweep-list')) {
    process.stderr.write(
      '--sweep deletes and --sweep-list only lists: give one of them. Run with --help.\n',
    );
    process.exit(2);
  }
  if ((args.includes('--sweep') || args.includes('--sweep-list')) && step !== 'remove') {
    process.stderr.write('--sweep and --sweep-list go with remove. Run with --help.\n');
    process.exit(2);
  }

  return {
    step,
    configPath,
    source,
    target,
    author: get('--author'),
    storePath: get('--store'),
    saltFile: get('--salt-file'),
    pilot: args.includes('--pilot'),
    reload: args.includes('--reload'),
    dryRun: args.includes('--dry-run'),
    includeChanged: args.includes('--include-changed'),
    sweep: args.includes('--sweep'),
    sweepList: args.includes('--sweep-list'),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
  };
}

/** An org as the extension's org manager and registry hold it. */
interface KnownOrg {
  org: {
    id: string;
    alias: string;
    orgType: string;
    metadata: { apiVersion: string; edition?: string };
  };
  credentials: { accessToken: string; instanceUrl: string };
}

/** An org typed from its `Organization` record, as the panel registers it (`orgTypeOf`). */
export interface TypedOrg {
  id: string;
  orgType: OrgType;
  /** `Organization.OrganizationType` of an org that is not a sandbox; absent when it said none. */
  edition?: string;
}

/**
 * Type an org from its `Organization` record, as the panel does when it
 * connects it (`OrgHandler`): `IsSandbox` for its type, and its edition with
 * it, which every guard of the load reads. A Developer Edition org says
 * IsSandbox false: typed without its edition, it was refused as a production
 * org, where the panel and the clone command take it for the development org
 * it is. Asked of an org that is not a sandbox alone; an answer that does not
 * say leaves it a production org. Exported so it can be tested.
 */
export async function typeOrg(conn: Pick<Connection, 'query'>): Promise<TypedOrg> {
  const result = await conn.query<{ Id: string; IsSandbox: boolean }>(
    'SELECT Id, IsSandbox FROM Organization LIMIT 1',
  );
  const row = result.records[0];
  if (!row) throw new Error('The org gave no Organization record.');
  if (row.IsSandbox) return { id: row.Id, orgType: 'Sandbox' };
  try {
    const typed = await conn.query<{ OrganizationType?: string }>(
      'SELECT OrganizationType FROM Organization LIMIT 1',
    );
    const edition = typed.records[0]?.OrganizationType;
    return typeof edition === 'string' && edition !== ''
      ? { id: row.Id, orgType: orgTypeOf({ isSandbox: false, edition }), edition }
      : { id: row.Id, orgType: 'Production' };
  } catch {
    return { id: row.Id, orgType: 'Production' };
  }
}

/**
 * Register an `sf` alias under its real org id, typed from the org.
 *
 * Every guard of the load reads the type, and the edition, the panel gives an
 * org it connects. A runner that guessed them would be testing its guess.
 */
async function registerOrg(
  alias: string,
  orgs: Map<string, KnownOrg>,
  conns?: Map<string, Connection>,
): Promise<string> {
  const session = await loadOrg(alias);
  const conn = makeConn(session);
  let typed: TypedOrg;
  try {
    typed = await typeOrg(conn);
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read the Organization record of '${alias}': ${why}`);
  }
  orgs.set(typed.id, {
    org: {
      id: typed.id,
      alias,
      orgType: typed.orgType,
      metadata: { apiVersion: '66.0', ...(typed.edition ? { edition: typed.edition } : {}) },
    },
    credentials: { accessToken: session.accessToken, instanceUrl: session.instanceUrl },
  });
  conns?.set(typed.id, conn);
  return typed.id;
}

type Posted = { type?: unknown; payload?: Record<string, unknown> } & Record<string, unknown>;

/** The records of the load a removal takes next, as `frozen:status` counts them. */
interface LoadRecords {
  orgId: string;
  loadedAt: string;
  created: Array<{ objectApiName: string; count: number }>;
  linked: number;
  recorded: boolean;
  /** Set once a removal took records: `created` counts what it left, if any. */
  removed?: { removedAt: string };
  /** A load before the last one, whose records the loads after it left in the org. */
  earlier?: boolean;
  /** Records the load created that no removal takes, the platform deleting none of them. */
  keptByThePlatform?: Array<{ objectApiName: string; count: number }>;
}

/** What a removal says of the records it keeps, the platform deleting none of them, if any. */
function keptByThePlatformLine(
  kept: ReadonlyArray<{ objectApiName: string; count: number }> | undefined,
): string[] {
  if (!kept || kept.length === 0) return [];
  const objects = kept.map(({ objectApiName, count }) => `${objectApiName} (${count})`).join(', ');
  return [`kept: the platform does not delete them — ${objects}`];
}

/** How each record a default fills gets a value of its own, in words. */
function perRecordNote(perRecord: 'token' | 'unique' | 'name', example?: string): string {
  const how =
    perRecord === 'token'
      ? 'each record its own, from the token the value carries'
      : `each record its own, its rank appended: the field is ${perRecord === 'unique' ? 'unique in the target' : 'the record name'}`;
  return example === undefined ? how : `${how} (first: "${example}")`;
}

/** How many records a removal of the load would take. */
function recordsToTake(records: LoadRecords): number {
  return records.created.reduce((sum, object) => sum + object.count, 0);
}

/**
 * What a removal of the load would take, for the person asked to confirm it:
 * which load, the org, the records per object in the order they go — once a
 * removal left some in the org, those — and what stays. Exported so it can be
 * tested.
 */
export function removalPlanLines(records: LoadRecords, org: string): string[] {
  const total = recordsToTake(records);
  const which = records.earlier
    ? 'a load before the last one, whose records the loads after it left in place,'
    : 'the last load';
  let takes = `a removal deletes the ${total} record(s) it created, children first:`;
  if (records.removed && total === 0) {
    takes = `its records were removed on ${records.removed.removedAt}, and none is left to remove`;
  } else if (total === 0 && (records.keptByThePlatform?.length ?? 0) > 0) {
    takes = 'it created no record a removal takes';
  } else if (records.removed) {
    takes = `the removal of ${records.removed.removedAt} left ${total} of the records it created, and a removal deletes those, children first:`;
  }
  return [
    `${which} wrote to ${org} at ${records.loadedAt}; ${takes}`,
    ...records.created.map((object) => `  ${object.objectApiName}: ${object.count}`),
    `${records.linked} record(s) it linked to or reused stay`,
    ...keptByThePlatformLine(records.keptByThePlatform),
  ];
}

/**
 * Whether the person is asked to type the org's name before the removal: when
 * it would delete something — records the load created, or what an earlier
 * removal left of them. Exported so it can be tested.
 */
export function removalAsks(records: LoadRecords): boolean {
  return records.recorded && recordsToTake(records) > 0;
}

/** What became of one object's records in a removal, the counts that are not zero. */
function removalCounts(object: {
  deleted: number;
  alreadyGone: number;
  keptChanged: number;
  keptDependents: number;
  refused: number;
  notReached?: number;
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
    (object.notReached ?? 0) > 0 ? `${object.notReached} not reached` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The files attached to an object's records the removal deleted, which stay in
 * the org: the load did not create them, and the removal leaves them there.
 */
function filesLeftLine(files: { count: number; names: string[] }): string {
  const more = files.count > files.names.length ? ', …' : '';
  return (
    `${files.count} file(s) attached to them stay in the org, as the load did not create them: ` +
    `${files.names.join(', ')}${more}`
  );
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
 * Where a step's graph came from: the one an earlier step kept in the sas, or
 * a discovery of its own, and why. Exported so it can be tested.
 */
export function discoveryLine(origin: FrozenDiscoveryOrigin): string {
  return 'reusedFrom' in origin
    ? `graph reused from ${origin.reusedFrom} (discovered ${origin.discoveredAt}): the source's schema has not changed since`
    : `rediscovered: ${origin.rediscovered}`;
}

/**
 * One step of a selection as it starts: a selection of a large org runs for
 * minutes, and the command said nothing until it ended. Exported so it can be
 * tested.
 */
export function selectStepLine(step: FrozenSelectProgress): string {
  switch (step.phase) {
    case 'discovery':
      return `  discovery: ${step.objects ?? 0} object(s) reached`;
    case 'axis':
      return `  listing the values of axis ${step.axis ?? '?'}…`;
    case 'combination':
      return `  combination ${step.index ?? '?'}/${step.of ?? '?'}: ${step.combinationKey ?? '?'}`;
    case 'candidate':
      return `    candidate ${step.candidate ?? '?'}/${step.candidates ?? '?'} of ${step.combinationKey ?? '?'}: measuring its own records…`;
    case 'measure':
      return `  measuring the ${step.roots ?? 0} root(s) kept, together…`;
  }
}

/** Where a selection stopped short, what it kept and what it never reached. */
function stopLines(stop: FrozenSelectionStop): string[] {
  const why = stop.reason === 'timeout' ? 'its time ran out' : 'it was cancelled';
  const where =
    stop.during === 'axes'
      ? 'while it listed the axis values'
      : stop.during === 'measure'
        ? 'while it measured the roots it kept'
        : `while it probed ${stop.combinationKey ?? '?'}` +
          (stop.candidate !== undefined
            ? `, candidate ${stop.candidate} of ${stop.candidates ?? '?'}`
            : '');
  return [
    `STOPPED: ${why} ${where}; the combinations decided before are kept`,
    ...(stop.notProbed.length > 0 ? [`  never probed: ${stop.notProbed.join(', ')}`] : []),
  ];
}

/**
 * The refusals of a removal that say it has nothing to take: no load recorded
 * into the org, its records removed already, or none a removal takes.
 */
const NOTHING_TO_REMOVE_CODES: ReadonlySet<string> = new Set([
  'NO_LOAD',
  'ALREADY_REMOVED',
  'NOTHING_TO_REMOVE',
]);

/**
 * Whether a message the handler posts fails the step: an error, but for a
 * removal's refusal that it has nothing to take. Run again after a removal,
 * the command ended on exit 1 for a removal there was no need of, and a
 * script took it for a failure. Exported so it can be tested.
 */
export function failsTheStep(message: Posted): boolean {
  const type = String(message.type ?? '');
  if (!type.endsWith(':error')) return false;
  return !(
    type === 'frozen:remove:error' && NOTHING_TO_REMOVE_CODES.has(String(message.payload?.code))
  );
}

/** The exit code of each verdict of a verification, as `sandforge-clone --verify` gives it. */
const VERDICT_EXIT: Readonly<Record<string, number>> = {
  passed: DONE_EXIT,
  partial: PARTIAL_EXIT,
  unstable: UNSTABLE_EXIT,
  failed: FAILED_EXIT,
};

/**
 * The exit code of a step that ran through, from what it posted: `verify` by
 * its verdict — FAILED 1, PARTIAL 3, UNSTABLE 4 —, `load` 3 when it completed
 * with errors, `remove` 3 when it left records of the load. A load is judged
 * by its own report: the verification it runs after it is said, and `verify`
 * gives its verdict a code. Exported so it can be tested.
 */
export function frozenStepExit(step: string, posted: readonly Posted[]): number {
  return worstExit(
    posted.map((message) => {
      const p = message.payload ?? {};
      if (step === 'verify' && message.type === 'frozen:verify:result') {
        const status = String((p.verdict as { status?: unknown } | undefined)?.status ?? '');
        return Object.prototype.hasOwnProperty.call(VERDICT_EXIT, status)
          ? VERDICT_EXIT[status]
          : FAILED_EXIT;
      }
      if (step === 'load' && message.type === 'frozen:load:response') {
        return (p.report as { status?: unknown } | undefined)?.status === 'completed'
          ? DONE_EXIT
          : PARTIAL_EXIT;
      }
      if (step === 'remove' && message.type === 'frozen:remove:response') {
        return (p.result as { status?: unknown } | undefined)?.status === 'success'
          ? DONE_EXIT
          : PARTIAL_EXIT;
      }
      return DONE_EXIT;
    }),
  );
}

/**
 * One line per thing the panel would have shown, for a person reading along.
 * Exported so it can be tested.
 */
export function messageLines(message: Posted): string[] {
  const type = String(message.type ?? '');
  const p = message.payload ?? {};
  if (type === 'frozen:remove:error' && !failsTheStep(message)) {
    return [`nothing to remove: ${String(p.message ?? '')}`];
  }
  if (type.endsWith(':error')) {
    return [`! ${type}: ${String(p.message ?? '')}${p.code ? ` [${String(p.code)}]` : ''}`];
  }
  switch (type) {
    case 'frozen:select:progress':
      return [selectStepLine(p as unknown as FrozenSelectProgress)];
    case 'frozen:select:response': {
      const s = p.selection as {
        combinations: Array<{ combinationKey: string }>;
        uncovered: Array<{ combinationKey: string; reason: string }>;
        volumetry: {
          total: number;
          budgetMax: number;
          measured: Record<string, number>;
          summed?: true;
        };
        graph?: { objects: number; truncated: boolean; maxNodes: number };
        stopped?: FrozenSelectionStop;
        discovery?: FrozenDiscoveryOrigin;
      };
      return [
        `selected ${s.combinations.length} root(s): ${s.combinations.map((c) => c.combinationKey).join(', ')}`,
        ...s.uncovered.map((u) => `  uncovered ${u.combinationKey}: ${u.reason}`),
        ...(s.stopped ? stopLines(s.stopped) : []),
        ...(s.discovery ? [discoveryLine(s.discovery)] : []),
        ...(s.graph ? [graphLine(s.graph)] : []),
        `volumetry ${s.volumetry.total} / ${s.volumetry.budgetMax} record(s)` +
          (s.volumetry.summed
            ? " — each kept root's own records added up: they were not measured together"
            : ''),
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
          requiredLeftEmpty?: string[];
          keptWithoutARule?: string[];
        };
      };
      const discovery = p.discovery as FrozenDiscoveryOrigin | undefined;
      return [
        `frozen ${String(p.recordCount)} record(s) as version ${m.version} in ${String(p.datasetDir)}`,
        ...(discovery ? [discoveryLine(discovery)] : []),
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
        // Said now, not at the load that would ask a value for each.
        ...((m.coverage?.requiredLeftEmpty ?? []).length > 0
          ? [
              `required in the source and left empty by the rules — a load will ask a value ` +
                `for each: ${(m.coverage?.requiredLeftEmpty ?? []).join(', ')}`,
            ]
          : []),
        ...((m.coverage?.keptWithoutARule ?? []).length > 0
          ? [
              `kept without a rule, the platform's own words: ` +
                (m.coverage?.keptWithoutARule ?? []).join(', '),
            ]
          : []),
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
          writtenWithoutFields?: {
            rows: number;
            fields: Array<{
              field: string;
              refusedBy?: string;
              reason: string;
              rows: number;
              replacedWith?: string;
            }>;
          };
        }>;
        pass2: {
          resolved: number;
          unresolved: Array<{ objectApiName: string; field: string; detail: string }>;
        };
        personContact?: {
          restored: number;
          sent?: Array<{ contactReferenceId: string; detail: string }>;
          unresolved: Array<{ contactReferenceId: string; detail: string }>;
        };
        statuses?: {
          restored: number;
          refused: Array<{ objectApiName: string; status: string; detail: string }>;
        };
        purge: {
          deleted: Record<string, number>;
          deactivated?: Record<string, number>;
          failures: Array<{ objectApiName: string; errors: string[] }>;
          leftUnrecorded?: Record<string, number>;
          keptByThePlatform?: Record<string, number>;
        };
        leftToThePlatform?: Array<{ objectApiName: string; note: string }>;
        untypedFeedItems?: Array<{ objectApiName: string; note: string }>;
        heldForExcludedParents?: Array<{ objectApiName: string; note: string }>;
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
      // Nor sent either: what they cannot go in without is an object
      // excludedObjects leaves out.
      for (const left of [
        ...(r.leftToThePlatform ?? []),
        ...(r.untypedFeedItems ?? []),
        ...(r.heldForExcludedParents ?? []),
      ]) {
        lines.push(`  ${left.objectApiName}: ${left.note}`);
      }
      // Refused by a validation rule on the fields it named, or by a
      // restricted picklist on their value, and written again without them —
      // or with the value the declared picklist rule gives: in the target,
      // each short of a value the dataset held. Each field says which refused it.
      const withoutFields = r.perObject.filter(
        (o) => (o.writtenWithoutFields?.fields.length ?? 0) > 0,
      );
      if (withoutFields.length > 0) {
        lines.push(
          'written again without a field a validation rule or a restricted picklist refused ' +
            `(${withoutFields.length} object(s)):`,
        );
        for (const { objectApiName, writtenWithoutFields } of withoutFields) {
          for (const {
            field,
            refusedBy,
            reason,
            rows,
            replacedWith,
          } of writtenWithoutFields?.fields ?? []) {
            const by =
              refusedBy === 'restricted-picklist'
                ? 'a restricted picklist refused its value'
                : 'a validation rule refused it';
            const instead =
              replacedWith === undefined
                ? ''
                : ` — written with "${replacedWith}", as its picklist rule declares`;
            lines.push(
              `  ${objectApiName}.${field}  ${rows} record(s) — ${by}${instead} — ${reason}`,
            );
          }
        }
      }
      lines.push(`pass 2: ${r.pass2.resolved} resolved, ${r.pass2.unresolved.length} unresolved`);
      for (const u of r.pass2.unresolved.slice(0, 5)) {
        lines.push(`  ${u.objectApiName}.${u.field}: ${u.detail}`);
      }
      // A person account's contact: linked to the one the platform wrote
      // with its account, sent as a contact of its own where it wrote none,
      // or neither, and why. The Load tab says all three, and the command
      // said none. A dataset with no person account has none.
      const personContact = r.personContact;
      const sent = personContact?.sent ?? [];
      if (
        personContact &&
        personContact.restored + sent.length + personContact.unresolved.length > 0
      ) {
        lines.push(
          `person contacts: ${personContact.restored} linked, ${sent.length} sent as contacts ` +
            `of their own, ${personContact.unresolved.length} not linked`,
        );
        for (const s of sent.slice(0, 5)) {
          lines.push(`  ${s.contactReferenceId} sent: ${s.detail}`);
        }
        for (const u of personContact.unresolved.slice(0, 5)) {
          lines.push(`  ${u.contactReferenceId}: ${u.detail}`);
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
      // Never sent to be deleted: refused, they ended every reload with errors.
      const kept = Object.entries(r.purge.keptByThePlatform ?? {});
      if (kept.length > 0) {
        lines.push('kept by the purge, the platform does not delete them:');
        for (const [objectApiName, count] of kept) lines.push(`  ${objectApiName}: ${count}`);
      }
      return lines;
    }
    case 'frozen:load:preview:response': {
      const plan = p.plan as {
        mode: { pilot: boolean; reload: boolean };
        perObject: Array<{
          objectApiName: string;
          fromFiles: number;
          toInsert: number;
          reusedByKeys: number;
          reusedFromCatalog: number;
          fieldsDropped: number;
          picklistsRewritten: number;
          notSent: number;
          toPurge: number;
          toDeactivate: number;
          validationRules?: Array<{ name: string; message: string; field?: string }>;
          validationRulesOnChange?: string[];
        }>;
        excludedObjects: Array<{ objectApiName: string; reason: string }>;
        placeholders: Array<{
          objectApiName: string;
          field: string;
          placeholderObjectApiName: string;
          affectedRecords: number;
          validationRules?: Array<{ name: string; message: string; field?: string }>;
        }>;
        requiredDefaults: Array<{
          objectApiName: string;
          field: string;
          affectedRecords: number;
          perRecord?: 'token' | 'unique' | 'name';
          example?: string;
        }>;
        personContacts: number;
        earlierLoads: number;
        leftUnrecorded?: Record<string, number>;
        keptByThePlatform?: Record<string, number>;
        heldForExcludedParents?: Array<{ objectApiName: string; note: string }>;
        validationRulesUnread?: string;
      };
      const sum = (pick: (o: (typeof plan.perObject)[number]) => number): number =>
        plan.perObject.reduce((total, o) => total + pick(o), 0);
      const lines = [
        `dry run${plan.mode.pilot ? ' (pilot)' : ''}${plan.mode.reload ? ' (reload)' : ''}: ` +
          `${sum((o) => o.toInsert)} record(s) to insert, ` +
          `${sum((o) => o.reusedByKeys + o.reusedFromCatalog)} to link, ` +
          `${sum((o) => o.notSent)} not sent` +
          (plan.mode.reload
            ? `, ${sum((o) => o.toPurge)} to purge and ${sum((o) => o.toDeactivate)} to deactivate ` +
              `of ${plan.earlierLoads} earlier load(s)`
            : '') +
          ' — nothing written',
      ];
      for (const o of plan.perObject) {
        const parts = [
          `${o.toInsert} to insert`,
          o.reusedByKeys > 0 ? `${o.reusedByKeys} found by identity keys` : '',
          o.reusedFromCatalog > 0 ? `${o.reusedFromCatalog} found in the catalog` : '',
          o.fieldsDropped > 0 ? `${o.fieldsDropped} field(s) dropped` : '',
          o.picklistsRewritten > 0 ? `${o.picklistsRewritten} picklist value(s) rewritten` : '',
          o.notSent > 0 ? `${o.notSent} not sent` : '',
          o.toPurge > 0 ? `${o.toPurge} to purge` : '',
          o.toDeactivate > 0 ? `${o.toDeactivate} to deactivate` : '',
        ].filter(Boolean);
        lines.push(`  ${o.objectApiName}: ${parts.join(', ')} of ${o.fromFiles}`);
      }
      for (const excluded of plan.excludedObjects) {
        lines.push(`  ${excluded.objectApiName}: not loaded — ${excluded.reason}`);
      }
      for (const held of plan.heldForExcludedParents ?? []) {
        lines.push(`  ${held.objectApiName}: ${held.note}`);
      }
      for (const placeholder of plan.placeholders) {
        lines.push(
          `placeholder for ${placeholder.objectApiName}.${placeholder.field}: ` +
            `${placeholder.affectedRecords} record(s)`,
        );
      }
      for (const fill of plan.requiredDefaults) {
        lines.push(
          `default for ${fill.objectApiName}.${fill.field}: ${fill.affectedRecords} record(s)` +
            (fill.perRecord ? `, ${perRecordNote(fill.perRecord, fill.example)}` : ''),
        );
      }
      if (plan.personContacts > 0) {
        lines.push(
          `${plan.personContacts} person account contact(s) go in with their account, not counted above`,
        );
      }
      const left = Object.entries(plan.leftUnrecorded ?? {});
      if (left.length > 0) {
        lines.push(
          'left in place, of a load recorded before loads kept what they created — it may have linked them:',
        );
        for (const [objectApiName, count] of left) lines.push(`  ${objectApiName}: ${count}`);
      }
      const kept = Object.entries(plan.keptByThePlatform ?? {});
      if (kept.length > 0) {
        lines.push('left in place by the purge, the platform does not delete them:');
        for (const [objectApiName, count] of kept) lines.push(`  ${objectApiName}: ${count}`);
      }
      // What a preview cannot evaluate, beside what it counts: run on a client
      // sandbox, three loads in a row were each refused by the next rule.
      const ruleLine = (rule: { name: string; message: string; field?: string }): string =>
        `  ${rule.name}${rule.field ? ` (${rule.field})` : ''}${rule.message ? ` — ${rule.message}` : ''}`;
      const ruled = plan.perObject.filter((o) => (o.validationRules?.length ?? 0) > 0);
      for (const o of ruled) {
        lines.push(
          `${o.objectApiName}: ${o.validationRules?.length ?? 0} active validation rule(s) of the ` +
            'target, which a preview cannot evaluate — a record one of them refuses is counted to insert:',
        );
        for (const rule of o.validationRules ?? []) lines.push(ruleLine(rule));
      }
      // Named, not listed: run on a large client sandbox, the preview listed
      // fourteen rules of one object, most of them guards no insert meets.
      for (const o of plan.perObject) {
        const onChange = o.validationRulesOnChange ?? [];
        if (onChange.length === 0) continue;
        lines.push(
          `${o.objectApiName}: ${onChange.length} rule(s) left out — their formula holds only on a ` +
            'change of a record (ISCHANGED, PRIORVALUE, NOT(ISNEW())), which an insert never is: ' +
            onChange.join(', '),
        );
      }
      // A placeholder goes in with its name alone, and one refused stops the load.
      const placeholderRules = new Map(
        plan.placeholders
          .filter((p) => (p.validationRules?.length ?? 0) > 0)
          .map((p) => [p.placeholderObjectApiName, p.validationRules ?? []]),
      );
      for (const [objectApiName, rules] of placeholderRules) {
        lines.push(
          `placeholder of ${objectApiName}: ${rules.length} active validation rule(s) of the target, ` +
            'which a preview cannot evaluate — a placeholder one of them refuses stops the load:',
        );
        for (const rule of rules) lines.push(ruleLine(rule));
      }
      if (plan.validationRulesUnread) {
        lines.push(
          `the target's validation rules could not be listed (${plan.validationRulesUnread}): ` +
            'any of them may refuse a record counted to insert',
        );
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
        leftBy?: string;
        sweep?: ForgeSweepResult;
        objects: Array<{
          objectApiName: string;
          planned: number;
          deleted: number;
          alreadyGone: number;
          keptChanged: number;
          keptDependents: number;
          refused: number;
          notReached?: number;
          heldBy: string[];
          unchecked: string[];
          reasons: string[];
          filesLeft?: { count: number; names: string[] };
        }>;
        keptByThePlatform?: Array<{ objectApiName: string; count: number }>;
      };
      const unchecked = [...new Set(r.objects.flatMap((o) => o.unchecked))];
      return [
        // The sweep ran first, before the load's records went.
        ...(r.sweep ? sweepLines(r.sweep) : []),
        `removal: ${r.status.toUpperCase()}` +
          (r.leftBy ? ` — of what the removal of ${r.leftBy} left` : ''),
        ...r.objects.flatMap((o) => [
          `  ${o.objectApiName}: ${removalCounts(o) || 'nothing'} of ${o.planned}`,
          ...o.reasons.map((reason) => `      ${reason}`),
          ...(o.filesLeft && o.filesLeft.count > 0 ? [`      ${filesLeftLine(o.filesLeft)}`] : []),
        ]),
        ...(unchecked.length > 0
          ? [`not checked, deleted with their parent: ${unchecked.join(', ')}`]
          : []),
        // Never sent to be deleted, and never counted refused.
        ...keptByThePlatformLine(r.keptByThePlatform),
      ];
    }
    case 'frozen:remove:sweep:response':
      return sweepListingLines(p.listing as ForgeSweepListing, 'the target org');
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
  // On stderr with --json, where stdout carries the JSON alone. Dropped there,
  // a configuration the schema refused, and the guard's refusal, exited 1
  // with nothing said on either.
  const log = (line: string): void => {
    process[args.json ? 'stderr' : 'stdout'].write(`${line}\n`);
  };

  const config = JSON.parse(readFileSync(args.configPath, 'utf8')) as Record<string, unknown>;
  const sasDir =
    typeof config.sasDir === 'string' ? config.sasDir : join(homedir(), '.sandforge-sas');
  mkdirSync(sasDir, { recursive: true });
  const configStore = fileConfigStore(args.storePath ?? join(sasDir, 'cli-store.json'));

  const orgs = new Map<string, KnownOrg>();
  const conns = new Map<string, Connection>();
  const sourceOrgId = args.source ? await registerOrg(args.source, orgs) : undefined;
  const targetOrgId = args.target ? await registerOrg(args.target, orgs, conns) : undefined;

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
        if (failsTheStep(message)) failed = true;
        if (quiet) return;
        for (const line of messageLines(message)) log(line);
      },
    },
    orgManager: { getOrg: (id: string) => orgs.get(id)?.org },
    orgRegistry: { getCredentials: async (id: string) => orgs.get(id)?.credentials },
    configStore,
    infraServices: {
      productionGuard: commandLineGuard(log, args.target ?? args.source ?? 'the org'),
      piiDetector: new PIIDetector(),
    },
    // Built rather than stubbed: every message the handler posts carries one.
    nextId: () => `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  } as never);

  // What the target's flows create, which a sweep looks at: read as the panel
  // reads it, through Forge's reader.
  const targetConn = targetOrgId ? conns.get(targetOrgId) : undefined;
  if (targetConn) handler.setTargetAutomation(targetAutomationReader(targetConn));
  // The salt from the environment, or the file given; none is made up here.
  handler.setSaltKeeper(commandLineSaltKeeper(process.env, args.saltFile));

  // The extraction, the load and the removal are listed while they run, as in
  // the extension: what Ctrl-C stops them through, as the panel's Cancel does.
  // A load stopped so is recorded in the sas with what it wrote, which
  // `remove` takes back; killed outright, it left the records it had written
  // and no record of them. A second Ctrl-C ends the process at once. A
  // SIGTERM — a CI job cancelled or timed out — or a SIGHUP stops it the same way.
  const registry = new BackgroundOperationRegistry();
  handler.setRegistry(registry);
  /** The request the handler has, which a Ctrl-C before its run started cancels. */
  let underWay: string | undefined;
  let interrupted: StopSignal | undefined;
  const interrupt = (signal: StopSignal): void => {
    interrupted = signal;
    process.stderr.write(
      `\ninterrupted: the ${args.step} stops after the call under way, and says what it wrote ` +
        '(Ctrl-C again ends it at once)\n',
    );
    for (const operation of registry.getRunning()) registry.abort(operation.operationId);
    if (underWay) registry.cancelBeforeStart(underWay);
    // Nothing under way — a question on the terminal: nothing was written.
    if (!underWay) process.exit(stopExitCode(signal));
  };
  const releaseStop = onStopSignal(interrupt);
  /** What a step prints on stdout with --json: what the panel would have received. */
  const emit = (ended?: true): void => {
    if (!args.json) return;
    process.stdout.write(
      `${JSON.stringify({ tool: 'sandforge-frozen', posted, ...(ended ? { ended } : {}) }, null, 2)}\n`,
    );
  };

  const send = async (type: string, payload: Record<string, unknown>): Promise<boolean> => {
    const id = `cli-${type}-${Date.now()}`;
    underWay = id;
    try {
      return await handler.handle({ id, type, payload } as never);
    } finally {
      underWay = undefined;
    }
  };
  let ran: 'through' | 'ended';
  try {
    ran = await runStep();
  } finally {
    releaseStop();
  }
  if (ran === 'ended' && !interrupted) {
    // The configuration refused, a load or a removal declined, nothing to
    // remove: said already, and nothing more is — but on stdout with --json,
    // which printed nothing a parser could read.
    if (failed) process.exitCode = FAILED_EXIT;
    emit(true);
    return;
  }
  if (interrupted) {
    emit();
    process.stderr.write(`${frozenInterruptedLine(args.step)}\n`);
    process.exitCode = stopExitCode(interrupted);
    return;
  }
  // A verification FAILED, PARTIAL or UNSTABLE, and a load that completed
  // with errors, exited 0: only an error message failed the step.
  endWith(failed ? FAILED_EXIT : frozenStepExit(args.step, posted));
  if (args.json) {
    emit();
    return;
  }
  log(`done in ${Date.now() - t0}ms`);

  /**
   * The step itself: the configuration saved, then the step's own request;
   * `ended` when it stopped short of its request, having said why.
   */
  async function runStep(): Promise<'through' | 'ended'> {
    // The configuration goes in the way the panel saves it: through the schema.
    await send('frozen:config:save', { config });
    if (failed) return 'ended';

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
        if (args.dryRun) {
          // Nothing is written: nothing to confirm.
          log(`reading what a load into ${args.target}${args.pilot ? ' (pilot)' : ''} would do…`);
          await send('frozen:load:preview', {
            targetOrgId,
            ...(args.pilot ? { pilot: true } : {}),
            ...(args.reload ? { reload: true } : {}),
          });
          break;
        }
        if (!args.yes) {
          const ok = await confirm(
            `Load the frozen dataset into ${args.target}${args.reload ? ', purging first what earlier loads created' : ''}?`,
          );
          if (!ok) {
            log('Nothing written.');
            return 'ended';
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
        // The loads into the target, which a load into another org leaves named.
        const status = posted.filter((m) => m.type === 'frozen:status:response').at(-1)?.payload
          ?.status as { loadRecords?: LoadRecords[] } | undefined;
        const records = status?.loadRecords?.find((load) => load.orgId === targetOrgId);
        if (!records) {
          // Nothing to do is no failure.
          log(`No load into ${args.target} is recorded in this sas: nothing to remove.`);
          return 'ended';
        }
        if (args.sweepList) {
          // What a sweep would delete, read and said; nothing is deleted, the
          // load's own records included.
          log(`reading what a sweep of ${args.target} would take…`);
          await send('frozen:remove:sweep', { targetOrgId, loadedAt: records.loadedAt });
          break;
        }
        for (const line of removalPlanLines(records, args.target ?? '')) log(line);
        if (args.sweep) {
          log(
            "before them, a sweep deletes what the target's automation created during the load, " +
              "as the load's user — run with --sweep-list to see what",
          );
        }
        if (!args.yes && removalAsks(records)) {
          // Typed, as the panel asks it: the name of the org the records leave.
          const answer = await typed(`Type ${args.target} to delete them:`);
          if (answer !== args.target) {
            log('Nothing deleted.');
            return 'ended';
          }
        }
        log(`removing from ${args.target}…`);
        await send('frozen:remove', {
          targetOrgId,
          loadedAt: records.loadedAt,
          ...(args.includeChanged ? { includeChanged: true } : {}),
          ...(args.sweep ? { sweep: true } : {}),
        });
        break;
      }
      case 'status':
        await send('frozen:status', {});
        break;
    }
    return 'through';
  }
}

/**
 * What a step Ctrl-C stopped says last: what was kept of it, and what takes
 * it back. Exported so it can be tested.
 */
export function frozenInterruptedLine(step: string): string {
  if (step === 'load') {
    return (
      'interrupted: the load stopped before it was through; what it wrote is recorded in the ' +
      'sas and the audit trail, and `remove` takes it back'
    );
  }
  if (step === 'remove') {
    return (
      'interrupted: the removal stopped before it was through; what it deleted is recorded, and ' +
      '`remove` again takes what it left'
    );
  }
  return `interrupted: the ${step} stopped before it was through`;
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
