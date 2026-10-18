import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BYPASS_SET,
  LEASE_MINUTES,
  LEASE_OBJECT,
  acquireBypass,
  epochOf,
  main,
  othersLive,
  refusalOf,
  releaseBypass,
  sfOrg,
  statusLine,
} from './trap-bypass.mjs';

const USER = '005000000000001AAA';
const OTHER_USER = '005000000000002AAA';
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const MINUTE = 60_000;

/**
 * The trap org as the lease logic sees it: lease records and assignments of
 * the set, each with an id, and a log of every write. `onAfter` runs a step
 * of another run right after a call, to put that run between two of this
 * one's calls.
 */
function fakeOrg({ leases = [], assigned = [], refuse = {}, onAfter = {} } = {}) {
  let next = 1;
  const id = (prefix) => `${prefix}${String(next++).padStart(12, '0')}AAA`;
  const state = {
    leases: leases.map((lease) => ({ id: id('a01'), ...lease })),
    assignments: assigned.map((assignee) => ({ id: id('0Pa'), assignee })),
    writes: [],
  };
  const after = (name, value) => {
    onAfter[name]?.(state);
    return value;
  };
  const org = {
    state,
    leases: (assignee) =>
      after(
        'leases',
        refuse.leases
          ? undefined
          : state.leases
              .filter((lease) => lease.assignee === assignee)
              .map((lease) => ({ ...lease })),
      ),
    addLease: (lease) => {
      if (refuse.addLease) return after('addLease', undefined);
      const added = { id: id('a01'), ...lease };
      state.leases.push(added);
      state.writes.push(`add lease ${lease.runId}`);
      return after('addLease', added.id);
    },
    renewLease: (leaseId, expiresAt) => {
      const lease = state.leases.find((l) => l.id === leaseId);
      if (lease) lease.expiresAt = expiresAt;
      state.writes.push(`renew lease ${lease?.runId}`);
      return after('renewLease', lease !== undefined);
    },
    removeLease: (leaseId) => {
      if (refuse.removeLease) return after('removeLease', false);
      const lease = state.leases.find((l) => l.id === leaseId);
      state.leases = state.leases.filter((l) => l.id !== leaseId);
      state.writes.push(`remove lease ${lease?.runId}`);
      return after('removeLease', true);
    },
    assignments: (assignee) =>
      after(
        'assignments',
        refuse.assignments
          ? undefined
          : state.assignments.filter((a) => a.assignee === assignee).map((a) => a.id),
      ),
    assign: (assignee) => {
      if (refuse.assign) return after('assign', false);
      state.assignments.push({ id: id('0Pa'), assignee });
      state.writes.push('assign');
      return after('assign', true);
    },
    unassign: (assignmentId) => {
      state.assignments = state.assignments.filter((a) => a.id !== assignmentId);
      state.writes.push('unassign');
      return after('unassign', true);
    },
    isDeveloperEdition: () => true,
    user: () => USER,
  };
  return org;
}

const at = (minutesFromNow) => new Date(NOW + minutesFromNow * MINUTE).toISOString();
const held = (org, assignee = USER) =>
  org.state.assignments.filter((a) => a.assignee === assignee).length;

test('a run that takes the bypass records its lease and assigns the set the user lacks', () => {
  const org = fakeOrg();
  const taken = acquireBypass(org, { runId: 'canary-1', assignee: USER, now: NOW, minutes: 30 });

  assert.deepEqual(taken, { ok: true, renewed: false, expiresAt: at(30), assigned: true });
  assert.deepEqual(org.state.writes, ['add lease canary-1', 'assign']);
  assert.equal(org.state.leases[0].assignee, USER);
  assert.equal(held(org), 1);
});

test('a run that takes the bypass another run holds adds its lease and assigns nothing', () => {
  const org = fakeOrg({
    leases: [{ runId: 'session-a', assignee: USER, expiresAt: at(20) }],
    assigned: [USER],
  });
  const taken = acquireBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.equal(taken.ok, true);
  assert.equal(taken.assigned, false);
  assert.equal(taken.expiresAt, at(LEASE_MINUTES));
  assert.deepEqual(org.state.writes, ['add lease canary-1']);
  assert.equal(held(org), 1);
});

test('taking the bypass again under the same run pushes back the end of its lease instead of adding one', () => {
  const org = fakeOrg({
    leases: [{ runId: 'canary-1', assignee: USER, expiresAt: at(5) }],
    assigned: [USER],
  });
  const taken = acquireBypass(org, { runId: 'canary-1', assignee: USER, now: NOW, minutes: 45 });

  assert.equal(taken.renewed, true);
  assert.deepEqual(org.state.writes, ['renew lease canary-1']);
  assert.equal(org.state.leases.length, 1);
  assert.equal(org.state.leases[0].expiresAt, at(45));
});

test('a run whose lease could not be recorded neither assigns the set nor says it holds it', () => {
  const org = fakeOrg({ refuse: { addLease: true } });
  const taken = acquireBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.equal(taken.ok, false);
  assert.match(taken.why, /could not be recorded/);
  assert.equal(held(org), 0);
});

test('a run that could not assign the set lets its lease go, so it keeps the set from no one', () => {
  const org = fakeOrg({ refuse: { assign: true } });
  const taken = acquireBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.equal(taken.ok, false);
  assert.match(taken.why, /could not be assigned/);
  assert.deepEqual(org.state.leases, []);
});

test('a run whose assignment another run made between its read and its write still holds the set', () => {
  const org = fakeOrg({
    refuse: { assign: true },
    onAfter: {
      // The org refuses this run's assignment as a duplicate: the other run's
      // went in after this one found none.
      assign: (state) => state.assignments.push({ id: '0Pa000000000099AAA', assignee: USER }),
    },
  });
  const taken = acquireBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.equal(taken.ok, true);
  assert.equal(taken.assigned, false);
  assert.equal(org.state.leases.length, 1);
});

test('giving the bypass back with no other lease removes the lease and the assignment', () => {
  const org = fakeOrg({
    leases: [{ runId: 'canary-1', assignee: USER, expiresAt: at(30) }],
    assigned: [USER],
  });
  const given = releaseBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.deepEqual(given, { ok: true, held: false, keptFor: 0 });
  assert.deepEqual(org.state.writes, ['remove lease canary-1', 'unassign']);
  assert.equal(held(org), 0);
});

test('giving the bypass back keeps the assignment while another run holds a live lease', () => {
  const org = fakeOrg({
    leases: [
      { runId: 'canary-1', assignee: USER, expiresAt: at(30) },
      { runId: 'session-a', assignee: USER, expiresAt: at(10) },
    ],
    assigned: [USER],
  });
  const given = releaseBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.deepEqual(given, { ok: true, held: true, keptFor: 1 });
  assert.deepEqual(org.state.writes, ['remove lease canary-1']);
  assert.equal(held(org), 1);
  assert.deepEqual(
    org.state.leases.map((lease) => lease.runId),
    ['session-a'],
  );
});

test('a lease past its end holds nothing: the set is dropped, and the lease removed with it', () => {
  const org = fakeOrg({
    leases: [
      { runId: 'canary-1', assignee: USER, expiresAt: at(30) },
      { runId: 'crashed', assignee: USER, expiresAt: at(-1) },
    ],
    assigned: [USER],
  });
  const given = releaseBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.deepEqual(given, { ok: true, held: false, keptFor: 0 });
  assert.deepEqual(org.state.leases, []);
  assert.equal(held(org), 0);
});

test("another user's lease keeps nothing of this user's assignment", () => {
  const org = fakeOrg({
    leases: [
      { runId: 'canary-1', assignee: USER, expiresAt: at(30) },
      { runId: 'elsewhere', assignee: OTHER_USER, expiresAt: at(30) },
    ],
    assigned: [USER, OTHER_USER],
  });
  const given = releaseBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.equal(given.held, false);
  assert.equal(held(org), 0);
  assert.equal(held(org, OTHER_USER), 1);
});

test('a run that took its lease while the set was being dropped gets the set assigned again', () => {
  const org = fakeOrg({
    leases: [{ runId: 'canary-1', assignee: USER, expiresAt: at(30) }],
    assigned: [USER],
    onAfter: {
      // The other run records its lease, and finds the set still there, as
      // this run removes the assignment.
      unassign: (state) =>
        state.leases.push({
          id: 'a01000000000099AAA',
          runId: 'session-b',
          assignee: USER,
          expiresAt: at(15),
        }),
    },
  });
  const given = releaseBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.deepEqual(given, { ok: true, held: true, keptFor: 1 });
  assert.equal(held(org), 1);
});

test('a run whose lease could not be removed says so and drops nothing', () => {
  const org = fakeOrg({
    leases: [{ runId: 'canary-1', assignee: USER, expiresAt: at(30) }],
    assigned: [USER],
    refuse: { removeLease: true },
  });
  const given = releaseBypass(org, { runId: 'canary-1', assignee: USER, now: NOW });

  assert.equal(given.ok, false);
  assert.equal(held(org), 1);
});

test('two runs that overlap leave the set assigned until the last of them gives it back', () => {
  const org = fakeOrg();
  acquireBypass(org, { runId: 'session-a', assignee: USER, now: NOW });
  acquireBypass(org, { runId: 'canary-1', assignee: USER, now: NOW + MINUTE });

  const first = releaseBypass(org, { runId: 'session-a', assignee: USER, now: NOW + 2 * MINUTE });
  assert.equal(first.held, true);
  assert.equal(held(org), 1);

  const last = releaseBypass(org, { runId: 'canary-1', assignee: USER, now: NOW + 3 * MINUTE });
  assert.equal(last.held, false);
  assert.equal(held(org), 0);
  assert.deepEqual(org.state.leases, []);
});

test('a run name that could break a query, or a user that is not one, is refused before any call', () => {
  assert.equal(refusalOf('canary-1', USER), undefined);
  assert.match(refusalOf("x' OR Name != '", USER), /run is named/);
  assert.match(refusalOf('two words', USER), /run is named/);
  assert.match(refusalOf('canary-1', 'not-a-user'), /not a user id/);

  const org = fakeOrg();
  assert.equal(acquireBypass(org, { runId: 'a b', assignee: USER, now: NOW }).ok, false);
  assert.equal(releaseBypass(org, { runId: 'a b', assignee: USER, now: NOW }).ok, false);
  assert.equal(acquireBypass(org, { runId: 'ok', assignee: USER, now: NOW, minutes: 0 }).ok, false);
  assert.deepEqual(org.state.writes, []);
});

test('reads the end of a lease as Salesforce writes it back, and nothing else as a time', () => {
  assert.equal(epochOf('2026-10-18T12:00:00.000+0000'), NOW);
  assert.equal(epochOf('2026-10-18T14:00:00.000+0200'), NOW);
  assert.equal(epochOf('2026-10-18T12:00:00.000Z'), NOW);
  assert.ok(Number.isNaN(epochOf(undefined)));
  assert.deepEqual(
    othersLive(
      [
        { runId: 'mine', expiresAt: at(5) },
        { runId: 'live', expiresAt: '2026-10-18T12:01:00.000+0000' },
        { runId: 'past', expiresAt: at(-1) },
        { runId: 'unread', expiresAt: null },
      ],
      'mine',
      NOW,
    ).map((lease) => lease.runId),
    ['live'],
  );
});

test('says the live leases by run and end, and counts those past theirs', () => {
  assert.equal(
    statusLine(
      [
        { runId: 'session-a', expiresAt: at(10) },
        { runId: 'crashed', expiresAt: at(-3) },
      ],
      true,
      NOW,
    ),
    `${BYPASS_SET} assigned; 1 live lease(s): session-a until ${at(10)}; 1 past their end`,
  );
  assert.equal(statusLine([], false, NOW), `${BYPASS_SET} assigned to nobody; 0 live lease(s)`);
});

/** `sf` as the adapter calls it: each call answered from `answers` by its first words. */
function fakeSf(answers) {
  const calls = [];
  const exec = (label, args) => {
    calls.push({ label, args });
    const key = Object.keys(answers).find((words) => args.join(' ').startsWith(words));
    const answer = key === undefined ? { status: 1, result: undefined } : answers[key](args);
    return {
      status: answer.status ?? 0,
      stdout: JSON.stringify({ result: answer.result }),
      stderr: '',
    };
  };
  return { exec, calls };
}

test('reads and writes the leases and the assignments through sf, on the org it is given alone', () => {
  const { exec, calls } = fakeSf({
    'data query --query SELECT Id, Name': () => ({
      result: {
        records: [
          {
            Id: 'a01000000000001AAA',
            Name: 'canary-1',
            Trap_Expires_At__c: '2026-10-18T13:00:00.000+0000',
          },
        ],
      },
    }),
    'data query --query SELECT Id FROM PermissionSetAssignment': () => ({
      result: { records: [] },
    }),
    'data query --query SELECT Id FROM PermissionSet ': () => ({
      result: { records: [{ Id: '0PS000000000001AAA' }] },
    }),
    'data create record --sobject PermissionSetAssignment': () => ({
      result: { id: '0Pa000000000001AAA' },
    }),
    'data create record --sobject Trap_Bypass_Lease__c': () => ({
      result: { id: 'a01000000000002AAA' },
    }),
    'data update record': () => ({ result: { id: 'a01000000000001AAA' } }),
    'data delete record': () => ({ result: { id: 'a01000000000001AAA' } }),
  });
  const org = sfOrg('SANDFORGE-TRAP', exec);

  assert.deepEqual(org.leases(USER), [
    { id: 'a01000000000001AAA', runId: 'canary-1', expiresAt: '2026-10-18T13:00:00.000+0000' },
  ]);
  assert.equal(
    org.addLease({ runId: 'canary-2', assignee: USER, expiresAt: at(30) }),
    'a01000000000002AAA',
  );
  assert.equal(org.renewLease('a01000000000001AAA', at(40)), true);
  assert.equal(org.removeLease('a01000000000001AAA'), true);
  assert.deepEqual(org.assignments(USER), []);
  assert.equal(org.assign(USER), true);

  for (const { args } of calls) {
    assert.equal(args.at(-1), '--json');
    assert.equal(args[args.indexOf('--target-org') + 1], 'SANDFORGE-TRAP');
  }
  const valueOf = (flag) =>
    calls.filter(({ args }) => args.includes(flag)).map(({ args }) => args[args.indexOf(flag) + 1]);
  const soql = valueOf('--query');
  assert.ok(soql[0].includes(`FROM ${LEASE_OBJECT} WHERE Trap_Assignee__c = '${USER}'`));
  assert.ok(
    soql.some((q) => q.includes(`PermissionSet.Name = '${BYPASS_SET}' AND AssigneeId = '${USER}'`)),
  );
  assert.deepEqual(valueOf('--values'), [
    `Name=canary-2 Trap_Assignee__c=${USER} Trap_Expires_At__c=${at(30)}`,
    `Trap_Expires_At__c=${at(40)}`,
    `AssigneeId=${USER} PermissionSetId=0PS000000000001AAA`,
  ]);
  // Every call has a label of its own, so a caller that keeps outputs keeps each.
  assert.equal(new Set(calls.map(({ label }) => label)).size, calls.length);
});

test('a call sf failed reads as nothing read and nothing written', () => {
  const { exec } = fakeSf({ data: () => ({ status: 1, result: { records: [] } }) });
  const org = sfOrg('SANDFORGE-TRAP', exec);

  assert.equal(org.leases(USER), undefined);
  assert.equal(org.addLease({ runId: 'canary-1', assignee: USER, expiresAt: at(1) }), undefined);
  assert.equal(org.removeLease('a01000000000001AAA'), false);
  assert.equal(org.assign(USER), false);
});

test('the command line takes and gives back a lease, saying it in one line without an id', () => {
  const org = fakeOrg();
  const said = [];
  const io = { now: NOW, say: (line) => said.push(line), warn: (line) => said.push(`! ${line}`) };

  assert.equal(main(['acquire', 'session-a', '--minutes', '90'], org, io), 0);
  assert.equal(main(['status'], org, io), 0);
  assert.equal(main(['release', 'session-a'], org, io), 0);

  assert.deepEqual(said, [
    `${BYPASS_SET} held for session-a until ${at(90)} (assigned now)`,
    `${BYPASS_SET} assigned; 1 live lease(s): session-a until ${at(90)}`,
    `session-a gave its lease back; ${BYPASS_SET} assigned to nobody again`,
  ]);
  for (const line of said) assert.doesNotMatch(line, /005[A-Za-z0-9]{12}/);
});

test('the command line refuses a missing run, a bad duration and an org that is not a Developer Edition', () => {
  const said = [];
  const io = { now: NOW, say: (line) => said.push(line), warn: (line) => said.push(line) };
  assert.equal(main(['acquire'], fakeOrg(), io), 2);
  assert.equal(main(['acquire', 'session-a', '--minutes', 'soon'], fakeOrg(), io), 2);
  assert.equal(main(['take', 'session-a'], fakeOrg(), io), 2);

  const production = { ...fakeOrg(), isDeveloperEdition: () => false };
  assert.equal(main(['release', 'session-a'], production, io), 1);
  assert.match(said.at(-1), /does not answer as a Developer Edition/);
});
