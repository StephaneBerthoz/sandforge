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
 * target and, in the source, only the records the Sync steps create for
 * themselves, never a seeded one, and removes what it wrote, however the run
 * ends. It prints counts and verdicts, never an id, a username or a token:
 * its log is public when it runs in CI.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskIds, tableCell } from './canary-mask.mjs';

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
  const base = ['--remove', summaryPath, '--target', TARGET, '--store', store, '--json'];
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
  dataopsBackup();
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
const report = [
  `## Canary: ${failed.length === 0 ? 'every step held' : `${failed.length} step(s) failed`}`,
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
