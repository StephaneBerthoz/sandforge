#!/usr/bin/env node
/**
 * The canary: SandForge's own commands, run end to end against the two
 * Developer Editions made for SandForge alone (synthetic data, see
 * test/fixtures/trap-org/README.md), so that a Salesforce release or a
 * dependency that breaks a real run is seen before a user sees it.
 *
 * Every serious defect of the 1.4x series came out of a real run, none out of
 * a mocked suite: a key prefix read as `0CF` instead of `0CP`, an `--upsert`
 * that inserted, a validation rule's field name translated on a non-English
 * org. The canary runs the same commands on a schedule.
 *
 *   node scripts/canary.mjs                    # run, compare with the baseline
 *   node scripts/canary.mjs --update-baseline  # run, then record its counts
 *   node scripts/canary.mjs --skip-probes      # leave out the trap probes (~6 min)
 *
 * It touches no org but SANDFORGE-SOURCE and SANDFORGE-TRAP, writes to the
 * target and, in the source, only the records the Sync and DataOps steps
 * create for themselves, never a seeded one, and removes what it wrote,
 * however the run ends. It prints counts and verdicts, never an id, a
 * username or a token: its log is public when it runs in CI.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskIds, tableCell } from './canary-mask.mjs';
import {
  autopilotCreated,
  changedRows,
  fieldsChecksum,
  frozenCreated,
  frozenLoadCounts,
  frozenPreviewCounts,
  idCount,
  postedError,
  postedOf,
  seedCreated,
  seedPlanned,
  seedWrittenAgain,
  soqlDate,
  windowAround,
} from './canary-steps.mjs';
import { acquireBypass, releaseBypass, sfOrg as trapOrg } from './trap-bypass.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'SANDFORGE-SOURCE';
const TARGET = 'SANDFORGE-TRAP';
/** The seeded account the clone starts from, found by name: no id is kept in the repository. */
const ROOT_ACCOUNT = 'Trap Account 01';
const FIXTURES = join(ROOT, 'test', 'fixtures', 'trap-org');
const BASELINE = join(FIXTURES, 'canary-baseline.json');
const CLONE_CONFIG = join(FIXTURES, 'canary-clone-config.json');
const CLONE_CLI = 'packages/extension/cli/sandforge-clone.ts';
/** Trap 9's bypass: the permission its flow checks, and the set that grants it. */
const BYPASS_PERMISSION = 'Trap_Bypass_Flow';
const BYPASS_SET = 'Trap_Bypass';
const BACKUP_CLI = 'packages/extension/cli/sandforge-backup.ts';
const SYNC_CLI = 'packages/extension/cli/sandforge-sync.ts';
/** The REST API version the canary's own record writes go through. */
const API = 'v62.0';
/** The key the Sync steps upsert on: unique in the target (trap 7). */
const SYNC_KEY = 'Trap_Ext_Id__c';
/** Accounts the Sync steps create in the source, the ones of them the source then changes, and their files. */
const SYNC_RECORDS = 4;
const SYNC_CHANGED = 2;
const SYNC_FILES = 2;
/** How far before its watermark a delta read starts: `DELTA_OVERLAP_MS` in SyncDelta.ts. */
const DELTA_OVERLAP_MS = 5 * 60_000;
/** What the delta's change writes, and what the target is then counted by. */
const SYNC_CHANGE = 'changed by the canary';
/**
 * The canary's own records in both orgs carry this in their key and their
 * files in their title: never a seeded record's, so nothing else is touched,
 * and what a run that broke left behind is found by it.
 */
const SYNC_TAG = `CANARY-SYNC-${Date.now().toString(36).toUpperCase()}`;

const FROZEN_CLI = 'packages/extension/cli/sandforge-frozen.ts';
/**
 * The Frozen project: one root, `Trap Account 15`, a Customer, so that trap
 * 5's filter takes the contacts that prefer it.
 */
const FROZEN_CONFIG = join(FIXTURES, 'canary-frozen-config.json');
const FROZEN_RULES = join(FIXTURES, 'canary-frozen-rules.json');
/**
 * The salt of the Frozen dataset's pseudonyms when the run is given none: the
 * records are synthetic, and the same salt freezes the same dataset every week.
 */
const FROZEN_SALT = 'sandforge-canary';
const AUTOPILOT_CLI = 'packages/extension/cli/sandforge-autopilot.ts';
/**
 * What Autopilot carries: the source's leads, copied whole, which no flow of
 * the target sends an email for. Its real run is held to `--max-total`: a plan
 * grown past it is refused before anything is written.
 */
const AUTOPILOT_OBJECT = 'Lead';
const AUTOPILOT_MAX_TOTAL = 25;
const SEED_CLI = 'packages/extension/cli/sandforge-seed.ts';
/**
 * The Seed steps' draws: two accounts and one to three contacts under each,
 * the same every week.
 */
const SEED_DRAWS = '4242';
const DATAOPS_CLI = 'packages/extension/cli/sandforge-dataops.ts';
const DATAOPS_TEMPLATE = 'tpl-gdpr-standard';
/** The contact fields the template masks: what the checksums are taken over. */
const DATAOPS_FIELDS = [
  'FirstName',
  'LastName',
  'Email',
  'Phone',
  'MailingStreet',
  'MailingCity',
  'MailingPostalCode',
];
/** Contacts the DataOps steps create in the source, mask and put back. */
const DATAOPS_RECORDS = 3;
/**
 * The DataOps steps' contacts carry this in `Department`, which the template
 * leaves alone: masked, their names no longer tell them, and the filter of
 * the masking and the cleanup find them by it.
 */
const DATAOPS_TAG = `CANARY-DATAOPS-${Date.now().toString(36).toUpperCase()}`;

const args = new Set(process.argv.slice(2));
const startedAt = Date.now();
const work = mkdtempSync(join(tmpdir(), 'sandforge-canary-'));

/** One line per step: its name, whether it held, and what it counted. */
const steps = [];
/** The counts compared with the baseline, by step. */
const counts = {};

function record(name, ok, detail, measured) {
  steps.push({ name, ok, detail: maskIds(detail) });
  if (measured) counts[name] = measured;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${maskIds(detail)}`);
  return ok;
}

/** A command, its output kept in the work directory rather than printed. */
function run(label, command, commandArgs, env = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096', ...env },
  });
  writeFileSync(join(work, `${label}.out`), result.stdout ?? '');
  writeFileSync(join(work, `${label}.err`), result.stderr ?? '');
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const tsx = (label, cli, cliArgs, env) => run(label, 'npx', ['tsx', cli, ...cliArgs], env);

/** `sf … --json`, parsed; undefined when it failed. */
function sfJson(label, sfArgs) {
  const { status, stdout } = run(label, 'sf', [...sfArgs, '--json']);
  try {
    const parsed = JSON.parse(stdout);
    return status === 0 ? parsed.result : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON document a command printed on stdout, or undefined. */
function jsonOf(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** The last line of a command's error output that says something, masked. */
const why = (stderr) =>
  maskIds(
    stderr
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? 'no output',
  );

function probes() {
  if (args.has('--skip-probes')) return record('trap probes', true, 'skipped');
  const { status, stdout, stderr } = run('probes', 'bash', ['test/scripts/trap-org.sh', 'verify']);
  const unexpected = `${stdout}\n${stderr}`
    .split('\n')
    .filter((line) => line.includes('UNEXPECTED'));
  return record(
    'trap probes',
    status === 0,
    status === 0
      ? 'every probe answered as expected'
      : `${unexpected.length} unexpected: ${unexpected.map((line) => line.trim()).join(' | ') || why(stderr)}`,
  );
}

function rootAccount() {
  const result = sfJson('root', [
    'data',
    'query',
    '--query',
    `SELECT Id FROM Account WHERE Name = '${ROOT_ACCOUNT}' ORDER BY CreatedDate LIMIT 1`,
    '--target-org',
    SOURCE,
  ]);
  return result?.records?.[0]?.Id;
}

const cloneBase = (root) => [
  '--record',
  root,
  '--source',
  SOURCE,
  '--target',
  TARGET,
  '--depth',
  'direct',
  '--skip-preflight',
  '--max-nodes',
  '120',
  '--config',
  CLONE_CONFIG,
  '--json',
];

/** What a summary says the run created in the target: object → target ids. */
function createdInTarget(summaryPath) {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const remap = summary.result?.remapTable ?? {};
  const byObject = new Map();
  for (const { objectApiName, sourceIds } of summary.result?.createdByObject ?? []) {
    const ids = sourceIds.map((id) => remap[id]).filter(Boolean);
    if (ids.length > 0) byObject.set(objectApiName, ids);
  }
  return byObject;
}

/** How many of the records a run created the target still holds. */
function leftInTarget(byObject) {
  let left = 0;
  for (const [objectApiName, ids] of byObject) {
    for (let i = 0; i < ids.length; i += 200) {
      const inList = ids
        .slice(i, i + 200)
        .map((id) => `'${id}'`)
        .join(',');
      const result = sfJson(`left-${objectApiName}-${i}`, [
        'data',
        'query',
        '--query',
        `SELECT COUNT() FROM ${objectApiName} WHERE Id IN (${inList})`,
        '--target-org',
        TARGET,
      ]);
      if (result === undefined) return undefined;
      left += result.totalSize ?? 0;
    }
  }
  return left;
}

/**
 * Remove what the clone wrote, the trap included: the target's before-delete
 * flow refuses an item until `Trap_Allow_Delete__c` is checked (trap 8), so
 * the first removal is expected to leave those, and the second, once they are
 * let go, everything. Then the sweep takes what the target's automation
 * created as the clone wrote (`sweepClone`).
 */
function removeClone(summaryPath, user, { quiet = false } = {}) {
  const first = tsx('forge-remove', CLONE_CLI, [
    '--remove',
    summaryPath,
    '--target',
    TARGET,
    '--accept-automation',
    '--json',
  ]);
  const firstResult = jsonOf(first.stdout)?.result;
  const refusedItems = (firstResult?.objects ?? [])
    .filter((o) => o.objectApiName === 'Trap_Item__c')
    .reduce((sum, o) => sum + (o.refused ?? 0), 0);

  const created = createdInTarget(summaryPath);
  for (const id of created.get('Trap_Item__c') ?? []) {
    run(`let-go-${id.slice(-4)}`, 'sf', [
      'data',
      'update',
      'record',
      '--sobject',
      'Trap_Item__c',
      '--record-id',
      id,
      '--values',
      'Trap_Allow_Delete__c=true',
      '--target-org',
      TARGET,
    ]);
  }
  const second = tsx('forge-remove-rest', CLONE_CLI, [
    '--remove',
    summaryPath,
    '--target',
    TARGET,
    '--include-changed',
    '--accept-automation',
    '--json',
  ]);
  const left = leftInTarget(created);
  if (quiet) {
    sweepClone(summaryPath, user, { quiet });
    return left;
  }
  record(
    'forge remove',
    left === 0,
    `first pass ${firstResult?.status ?? `exit ${first.status}`} (${refusedItems} item(s) held by the before-delete flow), ` +
      `second pass ${jsonOf(second.stdout)?.result?.status ?? `exit ${second.status}`}, ` +
      `${left ?? 'unknown'} record(s) left in the target`,
    { firstStatus: firstResult?.status ?? null, refusedItems, left: left ?? null },
  );
  return sweepClone(summaryPath, user) ? left : undefined;
}

/**
 * How far around the run's writes a sweep looks: `SWEEP_LEAD_MS` and
 * `SWEEP_TRAIL_MS` in ForgeRunSweep.ts.
 */
const SWEEP_LEAD_MS = 1_000;
const SWEEP_TRAIL_MS = 60_000;
/** The subject trap 18's flow gives each task it opens. */
const FOLLOW_UP_SUBJECT = 'Trap follow-up: ';

/**
 * What the target's automation created as the clone wrote, taken back by the
 * sweep: trap 18's flow opens a task for each contact created under an
 * account, pointing at no record, so the removal leaves every one of them.
 * Counted by the run's window and user once the removal is through, listed
 * by `--sweep-list`, taken by `--sweep`, and counted again: none is left. A
 * task of the flow the sweep left is deleted all the same, so that nothing of
 * the canary's stays in the target; the step then fails.
 *
 * @returns Whether no task of the run's window and user is left.
 */
function sweepClone(summaryPath, user, { quiet = false } = {}) {
  const written = JSON.parse(readFileSync(summaryPath, 'utf8')).result?.writtenBetween;
  const first = Date.parse(written?.first ?? '');
  const last = Date.parse(written?.last ?? '');
  if (!user || !Number.isFinite(first) || !Number.isFinite(last)) {
    if (!quiet) record('forge sweep', false, 'the run did not say when it wrote, or as whom');
    return false;
  }
  const from = soqlDate(Math.floor((first - SWEEP_LEAD_MS) / 1000) * 1000);
  const to = soqlDate(Math.ceil((last + SWEEP_TRAIL_MS) / 1000) * 1000);
  const inWindow = `CreatedById = '${user}' AND CreatedDate >= ${from} AND CreatedDate <= ${to}`;
  const tasks = (label) => rows(label, TARGET, `SELECT Id, Subject FROM Task WHERE ${inWindow}`);

  const leftByRemoval = tasks('sweep-before')?.length;
  const list = tsx('forge-sweep-list', CLONE_CLI, [
    '--remove',
    summaryPath,
    '--target',
    TARGET,
    '--sweep-list',
    '--json',
  ]);
  const listing = jsonOf(list.stdout)?.listing;
  const listed = (listing?.found ?? []).find((found) => found.objectApiName === 'Task')?.count ?? 0;
  const sweep = tsx('forge-sweep', CLONE_CLI, [
    '--remove',
    summaryPath,
    '--target',
    TARGET,
    '--sweep',
    '--accept-automation',
    '--json',
  ]);
  const swept = jsonOf(sweep.stdout)?.result?.sweep;
  const after = tasks('sweep-after');
  const strays = (after ?? []).filter((task) => String(task.Subject).startsWith(FOLLOW_UP_SUBJECT));
  if (strays.length > 0)
    destroy(
      'sweep-strays',
      TARGET,
      strays.map((task) => task.Id),
    );
  const left = after?.length;
  if (quiet) return left === 0;
  return record(
    'forge sweep',
    (leftByRemoval ?? 0) > 0 &&
      listed === leftByRemoval &&
      swept?.status === 'success' &&
      left === 0,
    `${leftByRemoval ?? 'unknown'} task(s) the target's flow created left by the removal, ` +
      `${listed} listed, sweep ${swept?.status ?? `exit ${sweep.status}`}` +
      (swept?.refusal ? ` (${swept.refusal})` : '') +
      `, ${left ?? 'unknown'} left in the window` +
      (strays.length > 0 ? ` (${strays.length} deleted after it)` : ''),
    {
      leftByRemoval: leftByRemoval ?? null,
      listed,
      sweepStatus: swept?.status ?? null,
      left: left ?? null,
    },
  );
}

function forge() {
  const root = rootAccount();
  if (!root) return record('forge root', false, `no account named ${ROOT_ACCOUNT} in the source`);

  const dry = tsx('forge-dry', CLONE_CLI, [...cloneBase(root), '--dry-run']);
  const dryDoc = jsonOf(dry.stdout);
  const nodes = dryDoc?.graph?.nodes ?? 0;
  // The welcome flow (trap 9) is quiet for a holder of Trap_Bypass_Flow: the
  // dry run must name that permission and the set that grants it.
  const namesBypass = (dryDoc?.targetAutomation?.bypassGrants ?? []).some(
    (grant) =>
      grant.permission === BYPASS_PERMISSION &&
      (grant.permissionSets ?? []).some((set) => set.name === BYPASS_SET),
  );
  record(
    'forge dry run',
    dry.status === 0 && nodes > 0 && namesBypass,
    dry.status === 0
      ? `${nodes} object(s) reached, ${namesBypass ? 'names' : 'does NOT name'} the ${BYPASS_SET} bypass`
      : why(dry.stderr),
    { nodes },
  );

  const user = targetUser();
  if (!user) return record('forge bypass', false, 'the target would not say who runs the clone');
  return withBypass('forge', user, () => cloneAndRemove(root, user));
}

/** The user the canary writes to the target as, read once. */
let runningUser;
function targetUser() {
  runningUser ??= sfJson('running-user', ['org', 'display', 'user', '--target-org', TARGET])?.id;
  return runningUser;
}

/**
 * The lease the canary holds the bypass under (scripts/trap-bypass.mjs): a
 * name of its own run, and an end past its longest step.
 */
const BYPASS_RUN = `canary-${Date.now().toString(36)}`;
const BYPASS_MINUTES = 60;
const bypassOrg = trapOrg(TARGET, (label, sfArgs) => run(label, 'sf', sfArgs));

/**
 * Run a step's writes to the target as a holder of the bypass. A Developer
 * Edition sends 15 single emails a day and the welcome flow sends two per
 * contact: a step that writes contacts runs as a holder of the bypass the
 * Forge dry run names, as a user would, and gives it back so that the probes
 * find the set assigned to nobody (trap 3). Another run may hold it as well,
 * as the same user: the canary takes a lease on the set, and giving it back
 * leaves it assigned while another run's lease is live.
 */
function withBypass(step, user, writes) {
  const taken = acquireBypass(bypassOrg, {
    runId: BYPASS_RUN,
    assignee: user,
    minutes: BYPASS_MINUTES,
  });
  if (!taken.ok) return record(`${step} bypass`, false, `${BYPASS_SET} not held: ${taken.why}`);
  try {
    return writes();
  } finally {
    const given = releaseBypass(bypassOrg, { runId: BYPASS_RUN, assignee: user });
    record(
      `${step} bypass given back`,
      given.ok,
      !given.ok
        ? given.why
        : given.held
          ? `${BYPASS_SET} kept for ${given.keptFor} other live lease(s)`
          : `${BYPASS_SET} assigned to nobody again`,
    );
  }
}

function cloneAndRemove(root, user) {
  const rehearse = tsx('forge-rehearse', CLONE_CLI, [
    ...cloneBase(root),
    '--rehearse',
    '--accept-automation',
  ]);
  const rehearsal = jsonOf(rehearse.stdout)?.rehearsal;
  record(
    'forge rehearsal',
    rehearse.status === 0 &&
      rehearsal !== undefined &&
      rehearsal.judged + rehearsal.notJudged === rehearsal.rows,
    rehearsal
      ? `${rehearsal.rows} row(s), ${rehearsal.judged} judged, ${rehearsal.passed} passed, ` +
          `${rehearsal.linked ?? 0} linked to a record the target holds, nothing kept`
      : why(rehearse.stderr),
    rehearsal
      ? {
          rows: rehearsal.rows,
          judged: rehearsal.judged,
          passed: rehearsal.passed,
          linked: rehearsal.linked ?? 0,
        }
      : undefined,
  );

  const summaryPath = join(work, 'summary.json');
  const clone = tsx('forge-clone', CLONE_CLI, [
    ...cloneBase(root),
    '--accept-automation',
    '--summary',
    summaryPath,
  ]);
  const cloned = jsonOf(clone.stdout)?.result;
  const wrote = existsSync(summaryPath);
  try {
    record(
      'forge clone',
      clone.status === 0 && cloned?.failedCount === 0 && (cloned?.successCount ?? 0) > 0,
      cloned
        ? `${cloned.successCount} written, ${cloned.failedCount} failed, ${cloned.skippedCount} skipped`
        : why(clone.stderr),
      cloned ? { written: cloned.successCount, failed: cloned.failedCount } : undefined,
    );
    if (!wrote) return false;

    const verify = tsx('forge-verify', CLONE_CLI, [
      '--verify',
      summaryPath,
      '--target',
      TARGET,
      '--source',
      SOURCE,
      '--json',
    ]);
    const verdict = jsonOf(verify.stdout)?.result?.verdict;
    record('forge verify', verdict === 'verified', verdict ?? why(verify.stderr));

    return removeClone(summaryPath, user) === 0;
  } catch (error) {
    // Whatever broke, what was written goes.
    if (wrote) removeClone(summaryPath, user, { quiet: true });
    return record('forge', false, error instanceof Error ? error.message : String(error));
  }
}

/** Run a step; what it throws is recorded as its failure, and the steps after it run. */
function guarded(name, step) {
  try {
    return step();
  } catch (error) {
    return record(name, false, error instanceof Error ? error.message : String(error));
  }
}

/** The ids of `ids` as a SOQL list, two hundred at a time. */
function* idLists(ids) {
  for (let i = 0; i < ids.length; i += 200) {
    yield [
      i,
      ids
        .slice(i, i + 200)
        .map((id) => `'${id}'`)
        .join(','),
    ];
  }
}

/**
 * The window of trap 18's tasks for contacts a step wrote: the seconds the
 * contacts were created in, by the target's clock — the flow opens each task
 * in its contact's transaction. Read while the contacts are still there.
 */
function followUpWindow(label, contactIds) {
  const dates = [];
  for (const [i, inList] of idLists(contactIds)) {
    const found = rows(
      `${label}-${i}`,
      TARGET,
      `SELECT CreatedDate FROM Contact WHERE Id IN (${inList})`,
    );
    if (!found) return undefined;
    dates.push(...found.map((row) => row.CreatedDate));
  }
  return windowAround(dates, 1_000, 1_000);
}

/** The tasks of trap 18's flow the canary's user created in `window`; undefined when unread. */
const followUpTasks = (label, user, window) =>
  window
    ? rows(
        label,
        TARGET,
        `SELECT Id FROM Task WHERE CreatedById = '${user}' AND CreatedDate >= ${window.from} ` +
          `AND CreatedDate <= ${window.to} AND Subject LIKE '${FOLLOW_UP_SUBJECT}%'`,
      )
    : [];

// ─── Frozen ──────────────────────────────────────────────────────────────────

/**
 * A Frozen Dataset, as a user builds and replays one from the command line:
 * one root of the trap fixture selected, extracted with the source's own
 * graph reused, a dry run of the load, the load, its verification, and the
 * removal with the sweep, which takes the tasks trap 18's flow opens for each
 * contact the load writes. What the load created is read from the sas before
 * the removal, and counted by id after it.
 */
function frozenRun(user) {
  const sasDir = join(work, 'frozen-sas');
  mkdirSync(sasDir, { recursive: true });
  copyFileSync(FROZEN_RULES, join(sasDir, 'rules.json'));
  const configFile = join(work, 'frozen-config.json');
  writeFileSync(
    configFile,
    JSON.stringify({ ...JSON.parse(readFileSync(FROZEN_CONFIG, 'utf8')), sasDir }, null, 2),
  );
  const env = { SANDFORGE_FROZEN_SALT: process.env.SANDFORGE_FROZEN_SALT || FROZEN_SALT };
  const step = (label, stepArgs) => {
    const ran = tsx(label, FROZEN_CLI, [...stepArgs, '--config', configFile, '--json'], env);
    const doc = jsonOf(ran.stdout);
    return { ...ran, doc, error: postedError(doc) ?? why(ran.stderr) };
  };

  const select = step('frozen-select', ['select', '--source', SOURCE]);
  const selection = postedOf(select.doc, 'frozen:select:response')?.payload?.selection;
  const roots = selection?.combinations?.length ?? 0;
  const measured = selection?.volumetry?.total ?? 0;
  const uncovered = selection?.uncovered?.length ?? 0;
  record(
    'frozen select',
    select.status === 0 && roots === 1 && uncovered === 0 && measured > 0,
    selection
      ? `${roots} root(s) selected, ${uncovered} uncovered, ${measured} record(s) of a budget of ${selection.volumetry.budgetMax}`
      : select.error,
    selection ? { roots, records: measured } : undefined,
  );
  if (!selection) return false;

  const extract = step('frozen-extract', ['extract', '--source', SOURCE, '--author', 'canary']);
  const extracted = postedOf(extract.doc, 'frozen:extract:response')?.payload;
  const control = postedOf(extract.doc, 'frozen:control:result')?.payload?.report;
  const reused = extracted?.discovery?.reusedFrom;
  record(
    'frozen extract',
    extract.status === 0 && extracted?.recordCount === measured && control?.passed === true,
    extracted
      ? `${extracted.recordCount} record(s) frozen, non-reidentification control ` +
          `${control?.passed ? 'passed' : 'FAILED'}, graph ${reused ? `reused from ${reused}` : 'discovered again'}`
      : extract.error,
    extracted
      ? { records: extracted.recordCount, control: control?.passed ?? null, graph: reused ?? null }
      : undefined,
  );
  if (!extracted) return false;

  const dry = step('frozen-load-dry', ['load', '--target', TARGET, '--dry-run']);
  const plan = postedOf(dry.doc, 'frozen:load:preview:response')?.payload?.plan;
  const preview = frozenPreviewCounts(plan);
  record(
    'frozen load dry run',
    dry.status === 0 &&
      plan !== undefined &&
      preview.fromFiles === extracted.recordCount &&
      preview.toInsert > 0,
    plan
      ? `${preview.toInsert} to insert, ${preview.toLink} to link, ${preview.notSent} not sent, ` +
          `of ${preview.fromFiles}; nothing written`
      : dry.error,
    plan
      ? { toInsert: preview.toInsert, toLink: preview.toLink, notSent: preview.notSent }
      : undefined,
  );
  if (!plan) return false;

  const load = step('frozen-load', ['load', '--target', TARGET, '--yes']);
  const report = postedOf(load.doc, 'frozen:load:response')?.payload?.report;
  const mappingFile = readdirSync(sasDir).find((name) =>
    /^referenceid-mapping\..+\.json$/.test(name),
  );
  // Read before the removal, which makes the mapping forget what it deletes.
  const created = mappingFile
    ? frozenCreated(JSON.parse(readFileSync(join(sasDir, mappingFile), 'utf8')))
    : new Map();
  const window = followUpWindow('frozen-contacts', created.get('Contact') ?? []);
  let removing = false;
  try {
    const loaded = frozenLoadCounts(report);
    record(
      'frozen load',
      load.status === 0 &&
        report !== undefined &&
        loaded.inserted === preview.toInsert &&
        loaded.refused === 0 &&
        loaded.heldBack === 0 &&
        idCount(created) === loaded.inserted,
      report
        ? `${report.status}: ${loaded.inserted} inserted (${loaded.withoutFields} written again ` +
            `without a field the target refused), ${loaded.linked} linked, ${loaded.refused} refused, ` +
            `${loaded.heldBack} held back for a refused parent, as the dry run counted ` +
            `${preview.toInsert} to insert`
        : load.error,
      report
        ? {
            inserted: loaded.inserted,
            withoutFields: loaded.withoutFields,
            linked: loaded.linked,
            refused: loaded.refused,
            heldBack: loaded.heldBack,
          }
        : undefined,
    );
    if (created.size === 0) return false;

    const verify = step('frozen-verify', ['verify', '--target', TARGET]);
    const verdict = postedOf(verify.doc, 'frozen:verify:result')?.payload?.verdict;
    const failing = (verdict?.checks ?? []).filter((check) => !check.passed);
    record(
      'frozen verify',
      verdict?.status === 'passed',
      verdict
        ? `${verdict.status}, ${(verdict.checks ?? []).length - failing.length} of ` +
            `${(verdict.checks ?? []).length} check(s) held` +
            (failing.length > 0 ? `: ${failing.map((check) => check.detail).join(' | ')}` : '')
        : verify.error,
      verdict ? { verdict: verdict.status } : undefined,
    );

    removing = true;
    return frozenRemove(step, created, user, window);
  } finally {
    // Whatever broke before the removal, what was written goes.
    if (!removing && created.size > 0) frozenRemove(step, created, user, window, { quiet: true });
  }
}

/**
 * Remove the load with the sweep, then count by id what the target holds of
 * it, and the tasks of trap 18's flow left in the seconds its contacts were
 * created. What the removal left is deleted all the same, so that nothing of
 * the canary's stays in the target; the step then fails.
 */
function frozenRemove(step, created, user, window, { quiet = false } = {}) {
  const opened = followUpTasks('frozen-tasks-before', user, window)?.length;
  const remove = step(quiet ? 'frozen-remove-again' : 'frozen-remove', [
    'remove',
    '--target',
    TARGET,
    '--sweep',
    '--yes',
  ]);
  const removal = postedOf(remove.doc, 'frozen:remove:response')?.payload?.result;
  const swept =
    (removal?.sweep?.objects ?? []).find((o) => o.objectApiName === 'Task')?.deleted ?? 0;
  const left = leftInTarget(created);
  const tasksLeft = followUpTasks('frozen-tasks-after', user, window);
  const strays = [
    ...['Contact', 'Case', 'Account'].flatMap((object) => created.get(object) ?? []),
    ...[...created.keys()]
      .filter((object) => !['Contact', 'Case', 'Account'].includes(object))
      .flatMap((object) => created.get(object) ?? []),
  ];
  if ((left ?? 1) > 0) destroy('frozen-strays', TARGET, strays);
  if ((tasksLeft ?? []).length > 0) {
    destroy(
      'frozen-task-strays',
      TARGET,
      tasksLeft.map((task) => task.Id),
    );
  }
  if (quiet) return left === 0;
  return record(
    'frozen remove',
    removal?.status === 'success' &&
      removal?.sweep?.status === 'success' &&
      left === 0 &&
      tasksLeft?.length === 0 &&
      swept === opened,
    removal
      ? `removal ${removal.status}, sweep ${removal.sweep?.status ?? 'not run'}` +
          (removal.sweep?.refusal ? ` (${removal.sweep.refusal})` : '') +
          `: ${opened ?? 'unknown'} task(s) trap 18's flow opened, ${swept} swept; ` +
          `${left ?? 'unknown'} record(s) and ${tasksLeft?.length ?? 'unknown'} task(s) left in the target` +
          ((left ?? 1) > 0 || (tasksLeft ?? []).length > 0 ? ' (deleted after it)' : '')
      : remove.error,
    removal
      ? {
          status: removal.status,
          flowTasks: opened ?? null,
          swept,
          left: left ?? null,
        }
      : undefined,
  );
}

// ─── Autopilot ───────────────────────────────────────────────────────────────

/**
 * Autopilot, bounded: a `--plan-only` held to one lookup and three objects,
 * then the run, under `--max-total`, and the records it created deleted by
 * the ids its summary prints. The target holds two of the source's lead
 * emails and blocks a duplicate of either (trap 4): those leads are refused,
 * and the run says so.
 */
function autopilotRun() {
  const base = [
    '--source',
    SOURCE,
    '--target',
    TARGET,
    '--object',
    AUTOPILOT_OBJECT,
    '--max-depth',
    '1',
    '--max-objects',
    '3',
    '--max-total',
    String(AUTOPILOT_MAX_TOTAL),
    '--json',
  ];
  const planned = tsx('autopilot-plan', AUTOPILOT_CLI, [...base, '--plan-only']);
  const planDoc = jsonOf(planned.stdout);
  const objects = new Set((planDoc?.plan?.waves ?? []).flatMap((wave) => wave.objects)).size;
  const records = planDoc?.writeGate?.records ?? 0;
  const refusals = planDoc?.writeGate?.refusals ?? [];
  const planOk =
    planned.status === 0 &&
    objects === 1 &&
    records > 0 &&
    records <= AUTOPILOT_MAX_TOTAL &&
    refusals.length === 0;
  record(
    'autopilot plan',
    planOk,
    planDoc
      ? `${objects} object(s) in ${(planDoc.plan?.waves ?? []).length} wave(s), ${records} record(s) ` +
          `to write under --max-total ${AUTOPILOT_MAX_TOTAL}; ` +
          (refusals.length > 0
            ? `a run would be refused: ${refusals.join(' ')}`
            : 'nothing written')
      : why(planned.stderr),
    planDoc ? { objects, records } : undefined,
  );
  if (!planOk) return false;

  const ran = tsx('autopilot-run', AUTOPILOT_CLI, base);
  const doc = jsonOf(ran.stdout);
  const created = autopilotCreated(doc);
  try {
    const result = doc?.result;
    const written = result?.totalSuccess ?? 0;
    const linked = result?.totalLinked ?? 0;
    const refused = result?.totalFailure ?? 0;
    const codes = Object.values(result?.objectOutcomes ?? {})
      .flatMap((outcome) => outcome.refusals ?? [])
      .map((refusal) => `${refusal.statusCode} x${refusal.count}`);
    record(
      'autopilot run',
      ran.status === 0 &&
        result !== undefined &&
        !result.fatalError &&
        written > 0 &&
        written + linked + refused === records &&
        idCount(created) === written,
      result
        ? `${written} written, ${linked} linked, ${refused} refused` +
            (codes.length > 0 ? ` (${codes.join(', ')})` : '') +
            `, of the ${records} the plan counted`
        : why(ran.stderr),
      result ? { written, linked, refused } : undefined,
    );
  } finally {
    // The run's own records, by the ids it printed: never one the target held.
    const ids = [...created.values()].flat();
    const failed = destroy('autopilot-remove', TARGET, ids);
    const left = leftInTarget(created);
    record(
      'autopilot remove',
      left === 0,
      `${ids.length - failed} of the ${ids.length} record(s) the run created deleted by the ids its ` +
        `summary printed, ${left ?? 'unknown'} left in the target`,
      { removed: ids.length - failed, left: left ?? null },
    );
  }
  return true;
}

// ─── Seed ────────────────────────────────────────────────────────────────────

/**
 * Seed, as a user fills a sandbox from the command line: a dry run with
 * fixed draws, the run with the same draws, which plans and writes the same
 * numbers, and its removal from the summary it printed. Trap 3 refuses the
 * phone Seed draws: the contacts go in without it, with a note. Trap 18's
 * flow opens a task for each contact, which no Seed removal takes: the canary
 * deletes them after it.
 */
function seedRun(user) {
  const base = [
    '--target',
    TARGET,
    '--object',
    'Account:2',
    '--object',
    'Contact:1',
    '--relation',
    'Contact.AccountId=Account',
    '--between',
    '1-3',
    '--seed',
    SEED_DRAWS,
    '--json',
  ];
  const plannedLine = (planned) =>
    Object.entries(planned)
      .map(([object, count]) => `${object} ${count}`)
      .join(', ');

  const dry = tsx('seed-dry', SEED_CLI, [...base, '--dry-run']);
  const dryDoc = jsonOf(dry.stdout);
  const planned = seedPlanned(dryDoc?.result);
  const total = Object.values(planned).reduce((sum, count) => sum + count, 0);
  record(
    'seed dry run',
    dry.status === 0 && dryDoc?.dryRun === true && String(dryDoc.seed) === SEED_DRAWS && total > 0,
    dryDoc
      ? `seed ${dryDoc.seed}: ${plannedLine(planned)} planned; nothing written`
      : why(dry.stderr),
    dryDoc ? planned : undefined,
  );
  if (total === 0) return false;

  const summaryPath = join(work, 'seed-summary.json');
  const ran = tsx('seed-run', SEED_CLI, base);
  const doc = jsonOf(ran.stdout);
  if (doc) writeFileSync(summaryPath, ran.stdout);
  const created = seedCreated(doc?.result);
  const window = followUpWindow('seed-contacts', created.get('Contact') ?? []);
  try {
    const wrote = seedPlanned(doc?.result);
    const refused = doc?.result?.totalRecordsFailed ?? 0;
    const same = Object.keys({ ...planned, ...wrote }).every(
      (object) => planned[object] === wrote[object],
    );
    const withoutFields = seedWrittenAgain(doc?.result);
    record(
      'seed run',
      ran.status === 0 && same && refused === 0 && idCount(created) === total,
      doc
        ? `seed ${doc.seed}: ${plannedLine(wrote)}, ${same ? 'as' : 'NOT as'} the dry run planned, ` +
            `${idCount(created)} written (${withoutFields} written again without a field the ` +
            `target refused), ${refused} refused`
        : why(ran.stderr),
      doc ? { written: idCount(created), withoutFields, refused, sameAsDryRun: same } : undefined,
    );
  } finally {
    seedRemove(summaryPath, created, user, window);
  }
  return true;
}

/** Remove a Seed run from its summary, then the tasks trap 18's flow opened for its contacts. */
function seedRemove(summaryPath, created, user, window) {
  if (created.size === 0) return;
  const opened = followUpTasks('seed-tasks-before', user, window);
  const remove = existsSync(summaryPath)
    ? tsx('seed-remove', SEED_CLI, [
        '--remove',
        summaryPath,
        '--target',
        TARGET,
        '--accept-automation',
        '--json',
      ])
    : undefined;
  const removal = remove ? jsonOf(remove.stdout)?.result : undefined;
  let left = leftInTarget(created);
  if ((left ?? 1) > 0) {
    // What the removal left goes all the same, the last object written first.
    destroy('seed-strays', TARGET, [...created.values()].reverse().flat());
    left = `${left ?? 'unknown'} (deleted after it)`;
  }
  destroy(
    'seed-tasks',
    TARGET,
    (opened ?? []).map((task) => task.Id),
  );
  const tasksLeft = followUpTasks('seed-tasks-after', user, window)?.length;
  record(
    'seed remove',
    removal?.status === 'success' && left === 0 && tasksLeft === 0,
    `removal ${removal?.status ?? (remove ? why(remove.stderr) : 'not run: no summary')}, ` +
      `${removal?.planned ?? 0} planned, ${left ?? 'unknown'} of the run's record(s) left; ` +
      `${opened?.length ?? 'unknown'} task(s) trap 18's flow opened, which Seed's removal does ` +
      `not take, deleted after it, ${tasksLeft ?? 'unknown'} left`,
    {
      status: removal?.status ?? null,
      left: typeof left === 'number' ? left : null,
      flowTasks: opened?.length ?? null,
    },
  );
}

// ─── DataOps ─────────────────────────────────────────────────────────────────

function dataopsBackup() {
  const count = sfJson('contact-count', [
    'data',
    'query',
    '--query',
    'SELECT COUNT() FROM Contact',
    '--target-org',
    SOURCE,
  ])?.totalSize;
  const backup = tsx('dataops-backup', BACKUP_CLI, [
    '--org',
    SOURCE,
    '--object',
    'Contact',
    '--store',
    join(work, 'backups'),
    '--json',
  ]);
  // `--json` prints every message the panel would have received.
  const response = (jsonOf(backup.stdout)?.posted ?? []).find(
    (m) => m.type === 'dataops:backup:response',
  );
  const contact = response?.payload?.objects?.find((o) => o.objectApiName === 'Contact');
  return record(
    'dataops backup',
    backup.status === 0 &&
      contact !== undefined &&
      contact.recordCount === count &&
      !contact.truncated,
    contact
      ? `${contact.recordCount} of ${count} contact(s) held, every page read`
      : why(backup.stderr),
    contact ? { held: contact.recordCount, orgCount: count } : undefined,
  );
}

/**
 * DataOps masking, as a user scrubs a sandbox from the command line, on
 * contacts the canary creates in the source for itself, never a seeded one: a
 * dry run, the masking with its snapshot, the values read back changed, the
 * snapshot restored, and the values read back as they were, compared by a
 * checksum of the masked fields. The contacts are deleted at the end, found
 * by their ids and by the tag they carry in a field the template leaves alone.
 */
function dataopsAnonymize() {
  const contact = (n) => ({
    attributes: { type: 'Contact' },
    FirstName: `Canary ${n}`,
    LastName: `DataOps ${DATAOPS_TAG}`,
    Email: `canary.dataops.${n}@example.invalid`,
    Phone: `+33 6 39 98 00 0${n}`,
    MailingStreet: `${n} rue de la Forge`,
    MailingCity: 'Canary City',
    MailingPostalCode: `7500${n}`,
    Department: DATAOPS_TAG,
  });
  const created = rest('dataops-seed', SOURCE, 'POST', 'composite/sobjects', {
    allOrNone: true,
    records: Array.from({ length: DATAOPS_RECORDS }, (_, i) => contact(i + 1)),
  });
  const ids = Array.isArray(created) ? created.filter((r) => r.success).map((r) => r.id) : [];
  try {
    if (ids.length !== DATAOPS_RECORDS) {
      return record(
        'dataops anonymize',
        false,
        `${ids.length} of ${DATAOPS_RECORDS} contact(s) created in the source`,
      );
    }
    const inList = ids.map((id) => `'${id}'`).join(',');
    const read = (label) =>
      rows(
        label,
        SOURCE,
        `SELECT Id, ${DATAOPS_FIELDS.join(', ')} FROM Contact WHERE Id IN (${inList})`,
      ) ?? [];
    const before = read('dataops-before');
    const was = fieldsChecksum(before, DATAOPS_FIELDS);
    const store = join(work, 'dataops-store');
    const base = ['anonymize', '--org', SOURCE, '--store', store, '--json'];
    const scope = [
      '--object',
      'Contact',
      '--template',
      DATAOPS_TEMPLATE,
      '--where',
      `Department = '${DATAOPS_TAG}'`,
    ];

    const dry = tsx('dataops-dry', DATAOPS_CLI, [...base, ...scope, '--dry-run']);
    const dryDoc = jsonOf(dry.stdout);
    const counted = postedOf(dryDoc, 'dataops:anonymize:coverage:response')?.payload?.objects?.[0]
      ?.count;
    const fields = postedOf(dryDoc, 'dataops:anonymize:preview:response')?.payload?.objects?.[0]
      ?.fields;
    const untouched = fieldsChecksum(read('dataops-after-dry'), DATAOPS_FIELDS) === was;
    record(
      'dataops anonymize dry run',
      dry.status === 0 &&
        counted === DATAOPS_RECORDS &&
        (fields ?? []).length === DATAOPS_FIELDS.length &&
        untouched,
      dryDoc && counted !== undefined
        ? `${counted} contact(s) to mask on ${(fields ?? []).length} field(s), ` +
            `${untouched ? 'nothing written' : 'values CHANGED by a dry run'}`
        : (postedError(dryDoc) ?? why(dry.stderr)),
      dryDoc ? { records: counted ?? null, fields: (fields ?? []).length } : undefined,
    );

    const masking = tsx('dataops-anonymize', DATAOPS_CLI, [...base, ...scope, '--yes']);
    const maskDoc = jsonOf(masking.stdout);
    const answer = postedOf(maskDoc, 'dataops:anonymize:response')?.payload;
    const object = answer?.objects?.[0];
    const snapshot = answer?.snapshot;
    const masked = read('dataops-masked');
    const changed = changedRows(before, masked, DATAOPS_FIELDS);
    record(
      'dataops anonymize',
      masking.status === 0 &&
        object?.processed === DATAOPS_RECORDS &&
        object?.failed === 0 &&
        snapshot?.totalRecords === DATAOPS_RECORDS &&
        changed === DATAOPS_RECORDS,
      object
        ? `${object.processed} masked, ${object.failed} refused, ${changed} of ${before.length} ` +
            `read back changed, snapshot of ${snapshot?.totalRecords ?? 'no'} record(s) taken first`
        : (postedError(maskDoc) ?? why(masking.stderr)),
      object
        ? {
            masked: object.processed,
            refused: object.failed,
            changed,
            snapshot: snapshot?.totalRecords ?? null,
          }
        : undefined,
    );
    if (!snapshot?.operationId) return false;

    const restore = tsx('dataops-restore', DATAOPS_CLI, [
      'anonymize',
      '--org',
      SOURCE,
      '--restore',
      snapshot.operationId,
      '--store',
      store,
      '--yes',
      '--json',
    ]);
    const restoreDoc = jsonOf(restore.stdout);
    const restored = postedOf(restoreDoc, 'dataops:rollback:response')?.payload;
    const equal = fieldsChecksum(read('dataops-restored'), DATAOPS_FIELDS) === was;
    return record(
      'dataops restore',
      restore.status === 0 &&
        restored?.totalRestored === DATAOPS_RECORDS &&
        restored?.totalFailed === 0 &&
        equal,
      restored
        ? `${restored.totalRestored} restored, ${restored.totalFailed} failed, checksum of the ` +
            `masked fields ${equal ? 'equal to' : 'DIFFERENT from'} the one taken before the masking`
        : (postedError(restoreDoc) ?? why(restore.stderr)),
      restored
        ? { restored: restored.totalRestored, failed: restored.totalFailed, checksumsEqual: equal }
        : undefined,
    );
  } finally {
    dataopsCleanup(ids);
  }
}

/** Delete the DataOps steps' contacts from the source, by id and by their tag. */
function dataopsCleanup(ids) {
  const byId = ids.length > 0 ? ` OR Id IN (${ids.map((id) => `'${id}'`).join(',')})` : '';
  const tagged = (label) =>
    (
      rows(label, SOURCE, `SELECT Id FROM Contact WHERE Department = '${DATAOPS_TAG}'${byId}`) ?? []
    ).map((row) => row.Id);
  destroy('dataops-clean', SOURCE, [...new Set([...ids, ...tagged('dataops-held')])]);
  const left = tagged('dataops-left').length;
  record('dataops cleanup', left === 0, `${left} of the canary's contact(s) left in the source`);
}

// ─── Sync ────────────────────────────────────────────────────────────────────

/** Block for `ms`: the canary runs its steps one after the other, and waits between two. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));

/**
 * One REST call through `sf`, so that no token passes through the canary: the
 * parsed body, or undefined when the call failed. sf 2.152 refuses a DELETE
 * without a body (see test/fixtures/trap-org/README.md), so one goes with a
 * request file whose raw body is empty.
 */
function rest(label, org, method, path, body) {
  const args = ['api', 'request', 'rest', `/services/data/${API}/${path}`, '--method', method];
  args.push('--target-org', org, '--header', 'Content-Type: application/json');
  if (body !== undefined) {
    const file = join(work, `${label}.body.json`);
    writeFileSync(file, JSON.stringify(body));
    args.push('--body', `@${file}`);
  } else if (method !== 'GET') {
    const file = join(work, 'no-body.json');
    writeFileSync(file, '{"body":{"mode":"raw"}}');
    args.push('--file', file);
  }
  const { status, stdout } = run(label, 'sf', args);
  return status === 0 ? jsonOf(stdout) : undefined;
}

/** The rows a query answers in `org`, or undefined when it failed. */
const rows = (label, org, query) =>
  sfJson(label, ['data', 'query', '--query', query, '--target-org', org])?.records;

/** Delete records by id in `org`, two hundred a call; the ones it could not, counted. */
function destroy(label, org, ids) {
  let failed = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const answer = rest(
      `${label}-${i}`,
      org,
      'DELETE',
      `composite/sobjects?allOrNone=false&ids=${batch.join(',')}`,
    );
    failed += Array.isArray(answer) ? answer.filter((r) => !r.success).length : batch.length;
  }
  return failed;
}

/**
 * The source records the Sync steps run on, created first so that the five
 * minutes a delta read reaches back past its watermark have gone by when the
 * steps run: four accounts, two files on the first two, and a marker account
 * outside the configuration's filter, whose change later stamps the object
 * past them (see `syncClock`). Ids only, kept for the cleanup.
 */
function syncSeed() {
  const seed = { seededAt: Date.now(), accounts: [], marker: undefined, documents: [] };
  const account = (key, name, description) => ({
    attributes: { type: 'Account' },
    Name: `Canary Sync ${SYNC_TAG} ${name}`,
    [SYNC_KEY]: `${SYNC_TAG}-${key}`,
    Description: description,
  });
  const records = Array.from({ length: SYNC_RECORDS }, (_, i) =>
    account(`R${i + 1}`, String(i + 1), 'seeded by the canary'),
  );
  const created = rest('sync-seed', SOURCE, 'POST', 'composite/sobjects', {
    allOrNone: true,
    records: [...records, account('MARK', 'marker', 'the clock of the delta step')],
  });
  const ids = Array.isArray(created) ? created.filter((r) => r.success).map((r) => r.id) : [];
  seed.accounts = ids.slice(0, SYNC_RECORDS);
  seed.marker = ids[SYNC_RECORDS];
  for (let i = 0; i < SYNC_FILES && i < seed.accounts.length; i++) {
    rest(`sync-seed-file-${i + 1}`, SOURCE, 'POST', 'sobjects/ContentVersion', {
      Title: `${SYNC_TAG}-file-${i + 1}`,
      PathOnClient: `${SYNC_TAG}-file-${i + 1}.txt`,
      VersionData: Buffer.from(
        `A file of the canary's Sync steps, ${i + 1} of ${SYNC_FILES}.\n`,
      ).toString('base64'),
      FirstPublishLocationId: seed.accounts[i],
    });
  }
  seed.documents = (
    rows(
      'sync-seed-documents',
      SOURCE,
      `SELECT ContentDocumentId FROM ContentVersion WHERE Title LIKE '${SYNC_TAG}%'`,
    ) ?? []
  ).map((row) => row.ContentDocumentId);
  const ok =
    seed.accounts.length === SYNC_RECORDS &&
    seed.marker !== undefined &&
    seed.documents.length === SYNC_FILES;
  record(
    'sync seed',
    ok,
    `${seed.accounts.length} account(s), ${seed.documents.length} file(s) and ${seed.marker ? 'a' : 'no'} marker created in the source, the canary's own`,
  );
  return { ...seed, ok };
}

/**
 * Stamp the source's accounts past the overlap of a delta read: the marker is
 * changed once the seeded accounts are more than five minutes older than it,
 * by the org's own clock, so that the watermark the first run reads — the
 * object's latest stamp — leaves them out of the next delta read, which then
 * reads the changed rows alone. The marker is outside the filter.
 */
function syncClock(seed) {
  sleep(seed.seededAt + DELTA_OVERLAP_MS + 15_000 - Date.now());
  for (let attempt = 1; attempt <= 3; attempt++) {
    rest(`sync-clock-${attempt}`, SOURCE, 'PATCH', `sobjects/Account/${seed.marker}`, {
      Description: `the clock of the delta step, ${attempt}`,
    });
    const stamps = rows(
      `sync-clock-read-${attempt}`,
      SOURCE,
      `SELECT ${SYNC_KEY}, SystemModstamp FROM Account WHERE ${SYNC_KEY} LIKE '${SYNC_TAG}-%'`,
    );
    if (!stamps) return false;
    const at = (row) => Date.parse(row.SystemModstamp);
    const marker = stamps.find((row) => row[SYNC_KEY] === `${SYNC_TAG}-MARK`);
    const newest = Math.max(...stamps.filter((row) => row !== marker).map(at));
    if (!marker) return false;
    const ahead = at(marker) - newest;
    if (ahead > DELTA_OVERLAP_MS + 5_000) return true;
    sleep(DELTA_OVERLAP_MS + 10_000 - ahead);
  }
  return false;
}

/** The saved configuration the Sync steps run: the canary's accounts, their files, delta mode. */
function syncConfig() {
  const direct = (field) => ({ sourceField: field, targetField: field, type: 'direct' });
  return {
    id: 'canary-sync',
    name: 'Canary Sync',
    description: "The canary's own accounts and their files, synced in delta mode",
    sourceOrgId: SOURCE,
    targetOrgId: TARGET,
    direction: 'source_to_target',
    mode: 'delta',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        externalIdField: SYNC_KEY,
        where: `${SYNC_KEY} LIKE '${SYNC_TAG}-R%'`,
        fieldMappings: ['Name', SYNC_KEY, 'Description'].map(direct),
        transformRules: [],
        excludedFields: [],
        // Required in the target and absent from the source (trap 6).
        addOnFields: [
          {
            fieldApiName: 'Trap_Target_Only__c',
            value: 'synced by SandForge',
            overwriteExisting: true,
          },
        ],
        batchSize: 200,
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    files: { maxFileSizeMB: 10, maxRunMB: 100 },
  };
}

/** What a run summary says the run created in the target: object → ids. */
function syncCreated(summaryPath) {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  return new Map(
    (summary.created?.objects ?? [])
      .filter(({ ids }) => ids.length > 0)
      .map(({ objectApiName, ids }) => [objectApiName, ids]),
  );
}

/**
 * The removal of the first run, as a user takes one back: the records the
 * delta run changed since are kept by the first pass, then taken with
 * `--include-changed`, and the configuration's store is told both times.
 */
function syncRemove(summaryPath, store, { quiet = false } = {}) {
  const base = [
    '--remove',
    summaryPath,
    '--target',
    TARGET,
    '--store',
    store,
    '--accept-automation',
    '--json',
  ];
  const first = tsx('sync-remove', SYNC_CLI, base);
  const firstResult = jsonOf(first.stdout)?.result;
  const keptChanged = (firstResult?.objects ?? []).reduce(
    (sum, o) => sum + (o.keptChanged ?? 0),
    0,
  );
  const second = tsx('sync-remove-rest', SYNC_CLI, [...base, '--include-changed']);
  const left = leftInTarget(syncCreated(summaryPath));
  if (quiet) return left;
  record(
    'sync remove',
    left === 0 && keptChanged === SYNC_CHANGED,
    `first pass ${firstResult?.status ?? `exit ${first.status}`} (${keptChanged} kept, changed by the delta run since; ` +
      `${(firstResult?.readWhole ?? []).join(', ') || 'nothing'} read whole next), ` +
      `second pass ${jsonOf(second.stdout)?.result?.status ?? `exit ${second.status}`}, ` +
      `${left ?? 'unknown'} record(s) and file(s) left in the target`,
    { firstStatus: firstResult?.status ?? null, keptChanged, left: left ?? null },
  );
  return left;
}

/** The first object result of a Sync summary or simulation. */
const firstObject = (doc, key) => doc?.[key]?.objects?.[0] ?? doc?.[key]?.objectResults?.[0];

/**
 * Sync, as a user runs a saved delta configuration from the command line: a
 * dry run, a first run that reads the canary's accounts whole and copies
 * their files, a change in the source and a delta run that moves exactly the
 * changed rows, then the first run's removal, counted by id.
 */
function sync(seed) {
  if (!seed.ok) return record('sync', false, 'the source records were not all created');
  if (!syncClock(seed)) {
    return record('sync clock', false, 'the source would not stamp the marker past the overlap');
  }
  const configFile = join(work, 'sync-config.json');
  writeFileSync(configFile, JSON.stringify(syncConfig(), null, 2));
  const store = join(work, 'sync-store');
  const base = [
    '--config-file',
    configFile,
    '--store',
    store,
    '--source',
    SOURCE,
    '--target',
    TARGET,
    '--json',
  ];

  const dry = tsx('sync-dry', SYNC_CLI, [...base, '--dry-run']);
  const simulated = firstObject(jsonOf(dry.stdout), 'simulation');
  record(
    'sync simulation',
    dry.status === 0 &&
      simulated?.insert === SYNC_RECORDS &&
      simulated?.update === 0 &&
      simulated?.files?.copied === SYNC_FILES,
    simulated
      ? `would insert ${simulated.insert}, update ${simulated.update}, copy ${simulated.files?.copied ?? 0} file(s); nothing written`
      : why(dry.stderr),
    simulated
      ? { insert: simulated.insert, update: simulated.update, files: simulated.files?.copied ?? 0 }
      : undefined,
  );

  const summaryPath = join(work, 'sync-first.json');
  const first = tsx('sync-first', SYNC_CLI, base);
  const wrote = first.stdout.trim().startsWith('{');
  if (wrote) writeFileSync(summaryPath, first.stdout);
  try {
    const firstDoc = jsonOf(first.stdout);
    const ran = firstObject(firstDoc, 'result');
    const created = wrote ? syncCreated(summaryPath) : new Map();
    record(
      'sync first run',
      first.status === 0 &&
        firstDoc?.result?.status === 'success' &&
        ran?.delta?.read === 'full' &&
        ran?.delta?.recorded !== undefined &&
        (created.get('Account') ?? []).length === SYNC_RECORDS &&
        (created.get('ContentDocument') ?? []).length === SYNC_FILES,
      ran
        ? `read whole (${ran.delta?.reason ?? 'not a delta'}), ${ran.success} written, ${ran.failed} failed, ` +
            `${ran.files?.copied ?? 0} file(s) copied, watermark ${ran.delta?.recorded ? 'recorded' : 'NOT recorded'}`
        : why(first.stderr),
      ran
        ? {
            written: ran.success,
            failed: ran.failed,
            files: ran.files?.copied ?? 0,
            created: [...created.values()].reduce((sum, ids) => sum + ids.length, 0),
          }
        : undefined,
    );
    if (!wrote) return false;

    const changed = rest('sync-change', SOURCE, 'PATCH', 'composite/sobjects', {
      allOrNone: true,
      records: seed.accounts.slice(0, SYNC_CHANGED).map((id) => ({
        attributes: { type: 'Account' },
        id,
        Description: SYNC_CHANGE,
      })),
    });
    const changedOk = Array.isArray(changed) && changed.every((r) => r.success);

    const delta = tsx('sync-delta', SYNC_CLI, base);
    const deltaDoc = jsonOf(delta.stdout);
    const moved = firstObject(deltaDoc, 'result');
    const deltaCreated = (deltaDoc?.created?.objects ?? []).reduce(
      (sum, o) => sum + o.ids.length,
      0,
    );
    // Read and counted here: a long text area cannot be filtered on in SOQL.
    const arrived = rows(
      'sync-arrived',
      TARGET,
      `SELECT Description FROM Account WHERE ${SYNC_KEY} LIKE '${SYNC_TAG}-R%'`,
    )?.filter((row) => row.Description === SYNC_CHANGE).length;
    record(
      'sync delta run',
      changedOk &&
        delta.status === 0 &&
        moved?.delta?.read === 'delta' &&
        moved?.delta?.changed === SYNC_CHANGED &&
        moved?.processed === SYNC_CHANGED &&
        moved?.success === SYNC_CHANGED &&
        deltaCreated === 0 &&
        (moved?.files?.copied ?? 0) === 0 &&
        arrived === SYNC_CHANGED,
      moved
        ? `${changedOk ? SYNC_CHANGED : 'NOT'} changed in the source; read ${moved.delta?.read ?? 'whole'}, ` +
            `${moved.delta?.changed ?? moved.processed} changed row(s) read, ${moved.success} written, ` +
            `${deltaCreated} created, ${moved.files?.copied ?? 0} file(s) copied; ${arrived ?? 'unknown'} changed in the target`
        : why(delta.stderr),
      moved
        ? {
            read: moved.delta?.read ?? null,
            changed: moved.delta?.changed ?? null,
            written: moved.success,
            created: deltaCreated,
            files: moved.files?.copied ?? 0,
          }
        : undefined,
    );

    return syncRemove(summaryPath, store) === 0;
  } catch (error) {
    // Whatever broke, what was written goes.
    if (wrote) syncRemove(summaryPath, store, { quiet: true });
    return record('sync', false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Remove the canary's own Sync records, however the run ended, found by the
 * key and the title only they carry: in the source, the accounts, the marker
 * and the files it created; in the target, anything of the canary's a run
 * left behind, once the removal under test has been counted. Files first: an
 * account deleted before them takes their links and leaves them.
 */
function syncCleanup() {
  const held = (org, label) => ({
    files: (
      rows(
        `${label}-files`,
        org,
        `SELECT Id FROM ContentDocument WHERE Title LIKE '${SYNC_TAG}%'`,
      ) ?? []
    ).map((row) => row.Id),
    accounts: (
      rows(
        `${label}-accounts`,
        org,
        `SELECT Id FROM Account WHERE ${SYNC_KEY} LIKE '${SYNC_TAG}-%'`,
      ) ?? []
    ).map((row) => row.Id),
  });
  const strayed = held(TARGET, 'sync-strays');
  for (const [org, label, found] of [
    [TARGET, 'sync-clean-target', strayed],
    [SOURCE, 'sync-clean-source', held(SOURCE, 'sync-held-source')],
  ]) {
    destroy(`${label}-files`, org, found.files);
    destroy(`${label}-accounts`, org, found.accounts);
  }
  const count = (org, label) => {
    const left = held(org, label);
    return left.files.length + left.accounts.length;
  };
  const leftSource = count(SOURCE, 'sync-left-source');
  const leftTarget = count(TARGET, 'sync-left-target');
  const stray = strayed.files.length + strayed.accounts.length;
  record(
    'sync cleanup',
    leftSource === 0 && leftTarget === 0,
    `${leftSource} of the canary's record(s) and file(s) left in the source, ${leftTarget} in the target` +
      (stray > 0 ? ` (${stray} found there after the removal, and deleted)` : ''),
  );
}

/** Steps whose counts differ from the baseline, said as `step.count: was → now`. */
function baselineDrift() {
  if (!existsSync(BASELINE)) return [];
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const drift = [];
  for (const [step, measured] of Object.entries(counts)) {
    for (const [key, value] of Object.entries(measured)) {
      const was = baseline[step]?.[key];
      if (was !== undefined && was !== value) drift.push(`${step}.${key}: ${was} → ${value}`);
    }
  }
  return drift;
}

// The Sync steps' source records first: the steps run last, once a delta
// read's overlap has gone by.
const syncSeeded = syncSeed();
try {
  probes();
  forge();
  const user = targetUser();
  if (!user) {
    record('target user', false, 'the target would not say who the canary writes as');
  } else {
    // Frozen and Seed write contacts: as a holder of the bypass, as the clone.
    guarded('frozen', () => withBypass('frozen', user, () => frozenRun(user)));
    guarded('autopilot', autopilotRun);
    guarded('seed', () => withBypass('seed', user, () => seedRun(user)));
  }
  dataopsBackup();
  // After the backup, which counts the source's contacts: the masking adds its own for a while.
  guarded('dataops anonymize', dataopsAnonymize);
  sync(syncSeeded);
} finally {
  syncCleanup();
}

const drift = baselineDrift();
if (drift.length > 0) record('baseline', false, drift.join('; '));
if (args.has('--update-baseline')) {
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`baseline written: ${Object.keys(counts).length} step(s)`);
}

const failed = steps.filter((s) => !s.ok);
// Said beside the verdict: the CI job has a time limit, and each step added runs within it.
const ran = `ran in ${Math.round((Date.now() - startedAt) / 60_000)} min`;
console.log(ran);
const report = [
  `## Canary: ${failed.length === 0 ? 'every step held' : `${failed.length} step(s) failed`}, ${ran}`,
  '',
  '| Step | Verdict | Detail |',
  '| --- | --- | --- |',
  ...steps.map((s) => `| ${s.name} | ${s.ok ? 'pass' : '**fail**'} | ${tableCell(s.detail)} |`),
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
writeFileSync(join(work, 'report.md'), report);
console.log(`\nfull output kept in ${work} (not printed: it can hold ids)`);
process.exit(failed.length === 0 ? 0 : 1);
