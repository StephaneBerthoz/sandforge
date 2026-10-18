#!/usr/bin/env node
/**
 * Trap 9's bypass, held as a lease.
 *
 * The flow of trap 9 sends two emails per contact and a Developer Edition
 * sends fifteen a day: whatever writes contacts to SANDFORGE-TRAP does it as a
 * holder of `Trap_Bypass`, and trap 3 wants the set assigned to nobody the rest
 * of the time. Every run writes as the same user of the org, and each used to
 * give the set back by assignee once done: a run that ended took the bypass
 * from under another still writing, and a dry run of the other failed on the
 * emails.
 *
 * So a run records that it holds the bypass, in a `Trap_Bypass_Lease__c`
 * record (deployed with `test/scripts/trap-org.sh deploy target`) named after
 * the run, with the user and the time the lease ends, and assigns the set when
 * the user lacks it. Giving it back removes the run's lease, and drops the
 * assignment only when no other live lease is left. A lease past its end holds
 * nothing: a run that crashed keeps the bypass from nobody for longer than its
 * lease.
 *
 *   node scripts/trap-bypass.mjs acquire <run> [--minutes <n>]
 *   node scripts/trap-bypass.mjs release <run>
 *   node scripts/trap-bypass.mjs status
 *
 * It touches no org but SANDFORGE-TRAP, refuses it unless the org says it is a
 * Developer Edition, and prints no id, username or token. The canary imports
 * the lease logic and holds the bypass through it.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TRAP_ORG = 'SANDFORGE-TRAP';
export const BYPASS_SET = 'Trap_Bypass';
export const LEASE_OBJECT = 'Trap_Bypass_Lease__c';
const ASSIGNEE = 'Trap_Assignee__c';
const EXPIRES = 'Trap_Expires_At__c';
/**
 * How long a lease holds unless told otherwise: longer than any one step of
 * the canary, short enough that a crashed run's lease is soon past.
 */
export const LEASE_MINUTES = 60;

/** A run's name: what a lease is recorded under, and goes into SOQL and `--values` as it is. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** Why a run name or a user id cannot be used, or undefined when both can. */
export function refusalOf(runId, assignee) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    return 'a run is named by 1 to 80 letters, digits, dots, colons, dashes or underscores';
  }
  if (assignee !== undefined && (typeof assignee !== 'string' || !USER_ID.test(assignee))) {
    return 'the assignee is not a user id';
  }
  return undefined;
}

/**
 * A date as Salesforce writes it back (`2026-10-18T12:00:00.000+0000`) or as
 * JSON does, as an epoch; NaN for anything else, which no time is after.
 */
export const epochOf = (value) =>
  Date.parse(String(value ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

/** The leases among `leases` still live at `now`, but those of `runId`. */
export const othersLive = (leases, runId, now) =>
  leases.filter((lease) => lease.runId !== runId && epochOf(lease.expiresAt) > now);

/**
 * Take the bypass for a run: record its lease, or push back the end of the one
 * it holds, then assign the set when the user lacks it. The lease goes first,
 * so that a run giving the set back meanwhile sees it.
 *
 * `org` reads and writes the leases and the assignments (see `sfOrg`).
 * Answers `{ ok, assigned, renewed, expiresAt }`, or `{ ok: false, why }`.
 */
export function acquireBypass(org, { runId, assignee, now = Date.now(), minutes = LEASE_MINUTES }) {
  const refusal =
    refusalOf(runId, assignee) ??
    (Number.isFinite(minutes) && minutes > 0 ? undefined : 'a lease lasts a number of minutes');
  if (refusal) return { ok: false, why: refusal };
  const leases = org.leases(assignee);
  if (!leases) return { ok: false, why: `the leases on ${BYPASS_SET} could not be read` };
  const expiresAt = new Date(now + minutes * 60_000).toISOString();
  const own = leases.filter((lease) => lease.runId === runId);
  const recorded =
    own.length > 0
      ? own.every((lease) => org.renewLease(lease.id, expiresAt))
      : org.addLease({ runId, assignee, expiresAt }) !== undefined;
  if (!recorded) return { ok: false, why: `the lease on ${BYPASS_SET} could not be recorded` };
  const taken = { ok: true, renewed: own.length > 0, expiresAt };

  const held = org.assignments(assignee);
  if (held && held.length > 0) return { ...taken, assigned: false };
  if (held && org.assign(assignee)) return { ...taken, assigned: true };
  // Another run may have assigned it between the read and the write.
  if ((org.assignments(assignee) ?? []).length > 0) return { ...taken, assigned: false };
  // Without the set the lease holds nothing, and would keep it from no one.
  for (const lease of org.leases(assignee) ?? []) {
    if (lease.runId === runId) org.removeLease(lease.id);
  }
  return { ok: false, why: `${BYPASS_SET} could not be assigned` };
}

/**
 * Give the bypass back for a run: remove its lease, and any lease past its
 * end, then drop the assignment unless another run's lease is still live. A
 * run that took its lease while this one was dropping the set counted on the
 * set being there: once dropped, the leases are read again, and the set
 * assigned again for it.
 *
 * Answers `{ ok, held, keptFor }` — whether the user still holds the set, and
 * for how many other live leases — or `{ ok: false, why }`.
 */
export function releaseBypass(org, { runId, assignee, now = Date.now() }) {
  const refusal = refusalOf(runId, assignee);
  if (refusal) return { ok: false, why: refusal };
  const leases = org.leases(assignee);
  if (!leases) return { ok: false, why: `the leases on ${BYPASS_SET} could not be read` };
  const gone = leases.filter((lease) => lease.runId === runId || !(epochOf(lease.expiresAt) > now));
  const kept = gone.filter((lease) => !org.removeLease(lease.id));
  if (kept.some((lease) => lease.runId === runId)) {
    return { ok: false, why: `the lease on ${BYPASS_SET} could not be removed` };
  }
  const others = othersLive(leases, runId, now);
  if (others.length > 0) return { ok: true, held: true, keptFor: others.length };

  const held = org.assignments(assignee);
  if (!held) return { ok: false, why: `the assignments of ${BYPASS_SET} could not be read` };
  const left = held.filter((id) => !org.unassign(id));
  const after = othersLive(org.leases(assignee) ?? [], runId, now);
  if (after.length > 0) {
    const holds = left.length > 0 || org.assign(assignee);
    return holds
      ? { ok: true, held: true, keptFor: after.length }
      : { ok: false, why: `${BYPASS_SET} could not be assigned again for a lease taken meanwhile` };
  }
  return left.length === 0
    ? { ok: true, held: false, keptFor: 0 }
    : { ok: false, why: `${left.length} assignment(s) of ${BYPASS_SET} could not be removed` };
}

/** What `status` says of the leases at `now`: live ones by run and end, and how many are past. */
export function statusLine(leases, assigned, now) {
  const live = leases.filter((lease) => epochOf(lease.expiresAt) > now);
  const past = leases.length - live.length;
  const runs = live.map(
    (lease) => `${lease.runId} until ${new Date(epochOf(lease.expiresAt)).toISOString()}`,
  );
  return (
    `${BYPASS_SET} ${assigned ? 'assigned' : 'assigned to nobody'}; ` +
    `${live.length} live lease(s)${runs.length > 0 ? `: ${runs.join(', ')}` : ''}` +
    (past > 0 ? `; ${past} past their end` : '')
  );
}

/** `sf` run quietly: its output is kept from the terminal, as it can name the org's user. */
const quietSf = (_label, args) => {
  const result = spawnSync('sf', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

/**
 * The leases and the assignments of `org`, read and written through `sf`,
 * which keeps the org's session: the script opens none, and prints nothing
 * `sf` answers. `exec(label, args)` runs `sf`; the canary hands its own, which
 * keeps each output in its work folder.
 */
export function sfOrg(org, exec = quietSf) {
  let calls = 0;
  const json = (label, args) => {
    const { status, stdout } = exec(`${label}-${(calls += 1)}`, [...args, '--json']);
    try {
      const doc = JSON.parse(stdout);
      return status === 0 ? (doc.result ?? {}) : undefined;
    } catch {
      return undefined;
    }
  };
  const query = (label, soql) =>
    json(label, ['data', 'query', '--query', soql, '--target-org', org])?.records;
  const create = (label, sobject, values) =>
    json(label, [
      'data',
      'create',
      'record',
      '--sobject',
      sobject,
      '--values',
      values,
      '--target-org',
      org,
    ])?.id;
  const destroy = (label, sobject, id) =>
    json(label, [
      'data',
      'delete',
      'record',
      '--sobject',
      sobject,
      '--record-id',
      id,
      '--target-org',
      org,
    ]) !== undefined;
  let setId;
  return {
    leases: (assignee) =>
      query(
        'bypass-leases',
        `SELECT Id, Name, ${EXPIRES} FROM ${LEASE_OBJECT} WHERE ${ASSIGNEE} = '${assignee}'`,
      )?.map((row) => ({ id: row.Id, runId: row.Name, expiresAt: row[EXPIRES] })),
    addLease: ({ runId, assignee, expiresAt }) =>
      create(
        'bypass-lease-add',
        LEASE_OBJECT,
        `Name=${runId} ${ASSIGNEE}=${assignee} ${EXPIRES}=${expiresAt}`,
      ),
    renewLease: (id, expiresAt) =>
      json('bypass-lease-renew', [
        'data',
        'update',
        'record',
        '--sobject',
        LEASE_OBJECT,
        '--record-id',
        id,
        '--values',
        `${EXPIRES}=${expiresAt}`,
        '--target-org',
        org,
      ]) !== undefined,
    removeLease: (id) => destroy('bypass-lease-remove', LEASE_OBJECT, id),
    assignments: (assignee) =>
      query(
        'bypass-held',
        `SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = '${BYPASS_SET}' AND AssigneeId = '${assignee}'`,
      )?.map((row) => row.Id),
    assign: (assignee) => {
      setId ??= query(
        'bypass-set',
        `SELECT Id FROM PermissionSet WHERE Name = '${BYPASS_SET}'`,
      )?.[0]?.Id;
      return (
        setId !== undefined &&
        create(
          'bypass-assign',
          'PermissionSetAssignment',
          `AssigneeId=${assignee} PermissionSetId=${setId}`,
        ) !== undefined
      );
    },
    unassign: (id) => destroy('bypass-drop', 'PermissionSetAssignment', id),
    /** The id of the user the alias logs in as: the one every run writes as. */
    user: () => json('bypass-user', ['org', 'display', 'user', '--target-org', org])?.id,
    /** Whether the org says it is a Developer Edition and no sandbox, as `trap-org.sh` checks. */
    isDeveloperEdition: () => {
      const row = query('bypass-org', 'SELECT OrganizationType, IsSandbox FROM Organization')?.[0];
      return row?.OrganizationType === 'Developer Edition' && row?.IsSandbox === false;
    },
  };
}

const USAGE =
  'usage: node scripts/trap-bypass.mjs acquire <run> [--minutes <n>] | release <run> | status';

/** The command line: one line said, an exit code back. Exported so it can be tested. */
export function main(
  argv,
  org,
  { now = Date.now(), say = console.log, warn = console.error } = {},
) {
  const [action, runId, ...rest] = argv;
  const minutesAt = rest.indexOf('--minutes');
  const minutes = minutesAt >= 0 ? Number(rest[minutesAt + 1]) : LEASE_MINUTES;
  if (!['acquire', 'release', 'status'].includes(action) || (action !== 'status' && !runId)) {
    warn(USAGE);
    return 2;
  }
  const refusal =
    action === 'status'
      ? undefined
      : (refusalOf(runId) ?? (minutes > 0 ? undefined : '--minutes takes a number above 0'));
  if (refusal) {
    warn(`trap-bypass: ${refusal}`);
    return 2;
  }
  if (!org.isDeveloperEdition()) {
    warn(`trap-bypass: refusing ${TRAP_ORG}: it does not answer as a Developer Edition`);
    return 1;
  }
  const assignee = org.user();
  if (!assignee) {
    warn(`trap-bypass: ${TRAP_ORG} would not say who its runs write as`);
    return 1;
  }
  if (action === 'status') {
    const leases = org.leases(assignee);
    const held = org.assignments(assignee);
    if (!leases || !held) {
      warn(`trap-bypass: the leases or the assignments of ${BYPASS_SET} could not be read`);
      return 1;
    }
    say(statusLine(leases, held.length > 0, now));
    return 0;
  }
  if (action === 'acquire') {
    const taken = acquireBypass(org, { runId, assignee, now, minutes });
    if (!taken.ok) {
      warn(`trap-bypass: ${taken.why}`);
      return 1;
    }
    say(
      `${BYPASS_SET} held for ${runId} until ${taken.expiresAt}` +
        ` (${taken.assigned ? 'assigned now' : 'already assigned'}${taken.renewed ? ', lease renewed' : ''})`,
    );
    return 0;
  }
  const given = releaseBypass(org, { runId, assignee, now });
  if (!given.ok) {
    warn(`trap-bypass: ${given.why}`);
    return 1;
  }
  say(
    given.held
      ? `${runId} gave its lease back; ${BYPASS_SET} kept for ${given.keptFor} other live lease(s)`
      : `${runId} gave its lease back; ${BYPASS_SET} assigned to nobody again`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), sfOrg(TRAP_ORG)));
}
