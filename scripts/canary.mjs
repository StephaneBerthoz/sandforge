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
 * It touches no org but SANDFORGE-SOURCE and SANDFORGE-TRAP, writes only to
 * the target, and removes what it wrote, however the run ends. It prints
 * counts and verdicts, never an id, a username or a token: its log is public
 * when it runs in CI.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskIds } from './canary-mask.mjs';

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

const args = new Set(process.argv.slice(2));
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
function run(label, command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
  });
  writeFileSync(join(work, `${label}.out`), result.stdout ?? '');
  writeFileSync(join(work, `${label}.err`), result.stderr ?? '');
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const tsx = (label, cli, cliArgs) => run(label, 'npx', ['tsx', cli, ...cliArgs]);

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
 * let go, everything.
 */
function removeClone(summaryPath, { quiet = false } = {}) {
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
  if (quiet) return left;
  record(
    'forge remove',
    left === 0,
    `first pass ${firstResult?.status ?? `exit ${first.status}`} (${refusedItems} item(s) held by the before-delete flow), ` +
      `second pass ${jsonOf(second.stdout)?.result?.status ?? `exit ${second.status}`}, ` +
      `${left ?? 'unknown'} record(s) left in the target`,
    { firstStatus: firstResult?.status ?? null, refusedItems, left: left ?? null },
  );
  return left;
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

  // A Developer Edition sends 15 single emails a day and the welcome flow
  // sends two per contact: the clone runs as a holder of the bypass the dry
  // run named, as a user would, and gives it back so that the probes find the
  // set assigned to nobody (trap 3).
  const user = sfJson('running-user', ['org', 'display', 'user', '--target-org', TARGET])?.id;
  if (!user) return record('forge bypass', false, 'the target would not say who runs the clone');
  const assigned = run('bypass-assign', 'sf', [
    'org',
    'assign',
    'permset',
    '--name',
    BYPASS_SET,
    '--target-org',
    TARGET,
  ]);
  if (assigned.status !== 0 && !/duplicate|already/i.test(`${assigned.stdout}${assigned.stderr}`)) {
    return record('forge bypass', false, `${BYPASS_SET} not assigned: ${why(assigned.stderr)}`);
  }
  try {
    return cloneAndRemove(root);
  } finally {
    const given = dropBypass(user);
    record(
      'forge bypass given back',
      given,
      given ? `${BYPASS_SET} assigned to nobody again` : 'still assigned',
    );
  }
}

/** Remove the bypass assignment the canary made; true once none is left. */
function dropBypass(user) {
  const query = (label) =>
    sfJson(label, [
      'data',
      'query',
      '--query',
      `SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = '${BYPASS_SET}' AND AssigneeId = '${user}'`,
      '--target-org',
      TARGET,
    ])?.records ?? [];
  for (const { Id } of query('bypass-held')) {
    run(`bypass-drop-${Id.slice(-4)}`, 'sf', [
      'data',
      'delete',
      'record',
      '--sobject',
      'PermissionSetAssignment',
      '--record-id',
      Id,
      '--target-org',
      TARGET,
    ]);
  }
  return query('bypass-left').length === 0;
}

function cloneAndRemove(root) {
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
      ? `${rehearsal.rows} row(s), ${rehearsal.judged} judged, ${rehearsal.passed} passed, nothing kept`
      : why(rehearse.stderr),
    rehearsal
      ? { rows: rehearsal.rows, judged: rehearsal.judged, passed: rehearsal.passed }
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

    return removeClone(summaryPath) === 0;
  } catch (error) {
    // Whatever broke, what was written goes.
    if (wrote) removeClone(summaryPath, { quiet: true });
    return record('forge', false, error instanceof Error ? error.message : String(error));
  }
}

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

probes();
forge();
dataopsBackup();

const drift = baselineDrift();
if (drift.length > 0) record('baseline', false, drift.join('; '));
if (args.has('--update-baseline')) {
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`baseline written: ${Object.keys(counts).length} step(s)`);
}

const failed = steps.filter((s) => !s.ok);
const report = [
  `## Canary: ${failed.length === 0 ? 'every step held' : `${failed.length} step(s) failed`}`,
  '',
  '| Step | Verdict | Detail |',
  '| --- | --- | --- |',
  ...steps.map(
    (s) => `| ${s.name} | ${s.ok ? 'pass' : '**fail**'} | ${s.detail.replace(/\|/g, '\\|')} |`,
  ),
  '',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
writeFileSync(join(work, 'report.md'), report);
console.log(`\nfull output kept in ${work} (not printed: it can hold ids)`);
process.exit(failed.length === 0 ? 0 : 1);
