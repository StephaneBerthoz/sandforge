import { describe, it, expect } from 'vitest';
import {
  emailSendersOf,
  mutePlanOf,
  stillRunningOf,
  type ForgeAutomationWrite,
  type ForgeTargetAutomation,
  type ForgeTargetFlow,
  type ForgeTargetObjectAutomation,
} from '@sandforge/shared';
import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';
import { deliverabilityAfterLeaseStop, deliverabilityGate } from './ForgeRunGate.js';
import {
  DELIVERABILITY_APEX,
  EMAIL_NOT_PERMITTED,
  NO_APEX_IN_PRODUCTION,
  deliverabilityOfRun,
  readEmailDeliverability,
  runEmailsOf,
  sendersTheMuteQuiets,
  type DeliverabilityRead,
} from './targetDeliverability.js';

/** What the org answers its anonymous Apex with, as the probes read it. */
const OPEN = {
  line: -1,
  column: -1,
  compiled: true,
  success: true,
  compileProblem: null,
  exceptionStackTrace: null,
  exceptionMessage: null,
};
const refusedWith = (exceptionMessage: string) => ({
  line: 1,
  column: 1,
  compiled: true,
  success: false,
  compileProblem: null,
  exceptionStackTrace: 'AnonymousBlock: line 1, column 1',
  exceptionMessage,
});
/** System email only and No access: the same exception, the same words. */
const CLOSED = refusedWith(EMAIL_NOT_PERMITTED);
const holdsSendEmail = (held: boolean) => ({
  totalSize: 1,
  done: true,
  records: [{ attributes: { type: 'UserPermissionAccess' }, PermissionsEmailSingle: held }],
});

/**
 * An org in memory that answers the deliverability read: its Apex as told,
 * the Send Email of its user as told, and every request it was sent.
 */
function orgAnswering(
  apex: unknown | (() => Promise<unknown>),
  sendEmail: unknown | (() => Promise<unknown>) = holdsSendEmail(true),
) {
  const urls: string[] = [];
  const answer = (given: unknown): Promise<unknown> =>
    typeof given === 'function' ? (given as () => Promise<unknown>)() : Promise.resolve(given);
  return {
    urls,
    request: ({ url }: { method: 'GET'; url: string }): Promise<unknown> => {
      urls.push(url);
      if (url.startsWith('/tooling/executeAnonymous?')) return answer(apex);
      if (url.startsWith('/query?')) return answer(sendEmail);
      return Promise.reject(new Error(`not answered: ${url}`));
    },
  };
}

/** The anonymous body a request runs, decoded. */
const bodyOf = (url: string): string | null =>
  new URL(url, 'https://org.example').searchParams.get('anonymousBody');

describe('readEmailDeliverability', () => {
  it('reads All email from an answer that succeeded, with one request that runs the one line and no other', async () => {
    const org = orgAnswering(OPEN);

    expect(await readEmailDeliverability(org)).toEqual({
      reading: { level: 'all' },
      requests: 1,
    });
    expect(org.urls).toHaveLength(1);
    expect(bodyOf(org.urls[0])).toBe('Messaging.reserveSingleEmailCapacity(1);');
    expect(DELIVERABILITY_APEX).toBe('Messaging.reserveSingleEmailCapacity(1);');
  });

  it('reads withheld from the exception of a closed org, once the user is known to hold Send Email', async () => {
    const org = orgAnswering(CLOSED, holdsSendEmail(true));

    expect(await readEmailDeliverability(org)).toEqual({
      reading: { level: 'withheld' },
      requests: 2,
    });
    expect(decodeURIComponent(org.urls[1])).toBe(
      '/query?q=SELECT PermissionsEmailSingle FROM UserPermissionAccess',
    );
  });

  it('reads the exception of a closed org with what surrounds it trimmed, and no other words, as withheld', async () => {
    expect(
      (await readEmailDeliverability(orgAnswering(refusedWith(`  ${EMAIL_NOT_PERMITTED}\n`))))
        .reading,
    ).toEqual({ level: 'withheld' });
  });

  it('reads any other exception unread, in the org’s words, and asks nothing of the user', async () => {
    // A Developer Edition past its fifteen single emails refuses a reservation
    // for the day's limit: it is open, and says something else.
    const limit =
      'System.HandledException: The daily limit for the org would be exceeded by this request';
    const org = orgAnswering(refusedWith(limit));

    expect(await readEmailDeliverability(org)).toEqual({
      reading: { unread: `the org answered: ${limit}` },
      requests: 1,
    });
    expect(org.urls).toHaveLength(1);
    // The same exception, other words: not the closed org's answer.
    expect(
      (
        await readEmailDeliverability(
          orgAnswering(refusedWith('System.NoAccessException: Insufficient access')),
        )
      ).reading,
    ).toEqual({ unread: 'the org answered: System.NoAccessException: Insufficient access' });
  });

  it('reads unread what did not compile, what failed without a reason, and an answer of another shape', async () => {
    expect(
      (
        await readEmailDeliverability(
          orgAnswering({ compiled: false, success: false, compileProblem: 'Unexpected token' }),
        )
      ).reading,
    ).toEqual({ unread: 'it did not compile: Unexpected token' });
    expect(
      (await readEmailDeliverability(orgAnswering({ compiled: true, success: false }))).reading,
    ).toEqual({ unread: 'it failed, and the org did not say why' });
    expect(
      (await readEmailDeliverability(orgAnswering([{ errorCode: 'NOT_FOUND' }]))).reading,
    ).toEqual({ unread: 'its answer is not one anonymous Apex gives' });
  });

  it('reads unread a refused request, in the org’s words, and one the org did not answer in time', async () => {
    const refused = orgAnswering(() =>
      Promise.reject(new Error('INSUFFICIENT_ACCESS: user lacks Author Apex')),
    );
    expect(await readEmailDeliverability(refused)).toEqual({
      reading: { unread: 'the org refused it: INSUFFICIENT_ACCESS: user lacks Author Apex' },
      requests: 1,
    });

    const silent = orgAnswering(() => new Promise<unknown>(() => undefined));
    expect(await readEmailDeliverability(silent, { timeoutMs: 5 })).toEqual({
      reading: { unread: 'the org did not answer within 5 ms' },
      requests: 1,
    });
  });

  it('never reads the refusal of a closed org as withheld for a user who may not send email', async () => {
    expect(
      (await readEmailDeliverability(orgAnswering(CLOSED, holdsSendEmail(false)))).reading,
    ).toEqual({
      unread:
        "the user the run writes as may not send email (Send Email), so the org's refusal " +
        'does not say how it is set',
    });
    expect(
      (
        await readEmailDeliverability(
          orgAnswering(CLOSED, () => Promise.reject(new Error('INVALID_FIELD: no such column'))),
        )
      ).reading,
    ).toEqual({
      unread:
        'whether the user the run writes as may send email could not be read (the org refused ' +
        "it: INVALID_FIELD: no such column), so the org's refusal does not say how it is set",
    });
    expect(
      (await readEmailDeliverability(orgAnswering(CLOSED, { totalSize: 0, records: [] }))).reading,
    ).toEqual({
      unread:
        "the org did not say whether the user the run writes as may send email, so the org's " +
        'refusal does not say how it is set',
    });
  });

  it('reads the org again each time it is asked: a level an admin changed between two runs is the one read', async () => {
    let answer: unknown = OPEN;
    const org = orgAnswering(() => Promise.resolve(answer));

    expect((await readEmailDeliverability(org)).reading).toEqual({ level: 'all' });
    answer = CLOSED;
    expect((await readEmailDeliverability(org)).reading).toEqual({ level: 'withheld' });
    expect(org.urls.filter((url) => url.startsWith('/tooling/'))).toHaveLength(2);
  });
});

/** A flow read with its start condition, naming no permission unless told. */
function flow(overrides: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow {
  return {
    apiName: 'Contact_After_Create',
    label: 'Contact after create',
    timing: 'afterSave',
    startsOn: 'create',
    condition: 'read',
    permissions: [],
    ...overrides,
  };
}

/** A read of the target on the objects given, with the permission sets that hold each bypass. */
function automation(
  objects: ForgeTargetObjectAutomation[],
  overrides: Partial<ForgeTargetAutomation> = {},
): ForgeTargetAutomation {
  return {
    objectsRead: objects.map((o) => o.objectApiName),
    objects,
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 1,
    ...overrides,
  };
}

const SEND_WELCOME = [
  { kind: 'email' as const, name: 'Send welcome', limit: 'SingleEmail' as const },
];
const ALERT_OWNER = [
  { kind: 'email' as const, name: 'Alert owner', limit: 'DailyWorkflowEmails' as const },
];
const bypassed = (overrides: Partial<ForgeTargetFlow>): ForgeTargetFlow =>
  flow({ permissions: [{ name: 'Org_Bypass', bypass: true, held: false }], ...overrides });

/**
 * The trap org's shape on Contact: a welcome flow that sends an email and a
 * workflow rule whose alert does, both testing the org's bypass, which one
 * permission set holds.
 */
const TRAP = automation(
  [
    {
      objectApiName: 'Contact',
      flows: [
        bypassed({ label: 'Welcome email', apiName: 'Welcome_Email', messages: SEND_WELCOME }),
      ],
      workflowRules: [bypassed({ label: 'Welcome rule', apiName: 'WR', messages: ALERT_OWNER })],
      triggers: [{ name: 'ContactTrigger', events: ['afterInsert'] }],
    },
  ],
  {
    bypassGrants: [
      {
        permission: 'Org_Bypass',
        permissionSets: [{ name: 'Org_Bypass_Set', label: 'Org bypass', grants: 1 }],
      },
    ],
  },
);
const inserts = (_object: string, write: ForgeAutomationWrite): boolean => write === 'insert';

/** A read that counts how often it is asked, answering as `org` does. */
function countedRead(org: ReturnType<typeof orgAnswering>) {
  const counter = { reads: 0 };
  return {
    counter,
    read: (): Promise<DeliverabilityRead> => {
      counter.reads++;
      return readEmailDeliverability(org);
    },
  };
}

describe('deliverabilityOfRun', () => {
  it('reads nothing when nothing that still runs sends an email', async () => {
    const quiet = automation([
      {
        objectApiName: 'Contact',
        flows: [flow({ label: 'Plain' })],
        triggers: [{ name: 'ContactTrigger', events: ['afterInsert'] }],
      },
    ]);
    const { counter, read } = countedRead(orgAnswering(OPEN));

    expect(
      await deliverabilityOfRun({ running: stillRunningOf(quiet, undefined, inserts), read }),
    ).toEqual({ senders: [] });
    expect(counter.reads).toBe(0);
  });

  it('reads nothing when a bypass the user holds, or the mute’s plan, keeps every sender quiet', async () => {
    const held = automation([
      {
        objectApiName: 'Contact',
        flows: [
          flow({
            label: 'Welcome email',
            permissions: [{ name: 'Org_Bypass', bypass: true, held: true }],
            messages: SEND_WELCOME,
          }),
        ],
        triggers: [],
      },
    ]);
    const { counter, read } = countedRead(orgAnswering(OPEN));

    await deliverabilityOfRun({ running: stillRunningOf(held, undefined, inserts), read });
    const plan = mutePlanOf(TRAP, inserts);
    expect(plan.silenced.map((entry) => entry.name)).toEqual(['Welcome rule', 'Welcome email']);
    const muted = await deliverabilityOfRun({
      running: stillRunningOf(TRAP, plan, inserts),
      writes: inserts,
      read,
    });

    expect(muted).toEqual({ senders: [] });
    expect(counter.reads).toBe(0);
  });

  it('reads once when a sender is left, and hands on the senders, the reading and its requests', async () => {
    const { counter, read } = countedRead(orgAnswering(OPEN));

    expect(
      await deliverabilityOfRun({
        running: stillRunningOf(TRAP, undefined, inserts),
        writes: inserts,
        read,
      }),
    ).toEqual({
      senders: [
        { objectApiName: 'Contact', kind: 'workflowRule', name: 'Welcome rule', why: 'email' },
        { objectApiName: 'Contact', kind: 'flow', name: 'Welcome email', why: 'email' },
      ],
      read: { reading: { level: 'all' }, requests: 1 },
    });
    expect(counter.reads).toBe(1);
  });

  it('reads when the flows could not be read at all, which lists no sender and may hide one', async () => {
    const blind = automation([], {
      unread: [{ part: 'flows', reason: 'INSUFFICIENT_ACCESS: View Setup' }],
    });
    const { counter, read } = countedRead(orgAnswering(OPEN));

    expect(await deliverabilityOfRun({ running: stillRunningOf(blind, undefined), read })).toEqual({
      senders: [],
      sendersUnread: "the target's flows: INSUFFICIENT_ACCESS: View Setup",
      read: { reading: { level: 'all' }, requests: 1 },
    });
    expect(counter.reads).toBe(1);
  });

  it('says a read that throws unread, as the safe side', async () => {
    const result = await deliverabilityOfRun({
      running: stillRunningOf(TRAP, undefined, inserts),
      read: () => Promise.reject(new Error('the connection to the target could not be opened')),
    });

    expect(result.read).toEqual({
      reading: { unread: 'the connection to the target could not be opened' },
      requests: 1,
    });
  });
});

describe('sendersTheMuteQuiets', () => {
  it('names the senders whose bypass a permission set holds, and none the mute cannot quiet', () => {
    const read = automation(
      [
        {
          objectApiName: 'Contact',
          flows: [
            ...TRAP.objects[0].flows,
            flow({ label: 'Follow-up email', apiName: 'Follow_Up', messages: SEND_WELCOME }),
          ],
          workflowRules: TRAP.objects[0].workflowRules,
          triggers: [],
        },
      ],
      { bypassGrants: TRAP.bypassGrants },
    );

    expect(sendersTheMuteQuiets(read, { writes: inserts }).map((s) => s.name)).toEqual([
      'Welcome rule',
      'Welcome email',
    ]);
    expect(
      sendersTheMuteQuiets(automation(read.objects, { bypassGrants: [] }), { writes: inserts }),
    ).toEqual([]);
  });
});

describe('the deliverability read on a run’s write path', () => {
  /**
   * A run as a host makes it, counting what reaches the org: the lease
   * planned, what still runs, the read, the question, the lease taken and
   * read back — holding the sets given — its check, the writes and the
   * lease given back. Refused when the gate or the check after the lease
   * stops it, nothing written.
   */
  async function runPath(input: {
    read: ForgeTargetAutomation;
    mute: boolean;
    acceptEmails: boolean;
    org: ReturnType<typeof orgAnswering>;
    /** The permission sets the lease holds once read back; the plan's when not told. */
    heldSets?: (planned: string[]) => string[];
  }) {
    const events: WritePathStep[] = [];
    const counts = { assignments: 0, deliverabilityReads: 0, writes: 0 };
    events.push('reads');
    const plan = input.mute ? mutePlanOf(input.read, inserts) : undefined;
    events.push('leasePlan');
    const running = stillRunningOf(input.read, plan, inserts);
    events.push('stillRunning');
    const ofRun = await deliverabilityOfRun({
      running,
      writes: inserts,
      read: () => {
        counts.deliverabilityReads++;
        events.push('deliverabilityRead');
        return readEmailDeliverability(input.org);
      },
    });
    const gate = deliverabilityGate({
      senders: ofRun.senders,
      sendersUnread: ofRun.sendersUnread,
      reading: ofRun.read?.reading,
      accepted: input.acceptEmails,
      target: 'TGT',
      run: 'clone',
    });
    events.push('question');
    if (gate.stop) return { events, counts, stop: gate.stop.message, gate };
    let stop: string | undefined;
    if (plan) {
      const planned = plan.assign.map((set) => set.permissionSet);
      const held = input.heldSets ? input.heldSets(planned) : planned;
      counts.assignments += held.length;
      events.push('leaseAcquire');
      const after = deliverabilityAfterLeaseStop({
        planned: ofRun.senders,
        held: emailSendersOf(
          stillRunningOf(
            input.read,
            { assign: plan.assign.filter((set) => held.includes(set.permissionSet)) },
            inserts,
          ),
          { writes: inserts },
        ),
        reading: ofRun.read?.reading,
        accepted: input.acceptEmails,
        target: 'TGT',
        run: 'clone',
      });
      events.push('afterLeaseCheck');
      stop = after?.message;
    }
    if (stop === undefined) {
      counts.writes++;
      events.push('write');
    }
    if (plan) events.push('leaseRelease');
    events.push('result');
    return { events, counts, stop, gate };
  }

  it('reads after the lease is planned and before the question, assigning nothing, then refuses the run with nothing written', async () => {
    const { events, counts, stop } = await runPath({
      read: TRAP,
      mute: false,
      acceptEmails: false,
      org: orgAnswering(OPEN),
    });

    expect(writePathOrderDefects(events)).toEqual([]);
    expect(events.slice(0, 5)).toEqual([
      'reads',
      'leasePlan',
      'stillRunning',
      'deliverabilityRead',
      'question',
    ]);
    expect(counts).toEqual({ assignments: 0, deliverabilityReads: 1, writes: 0 });
    expect(stop).toContain('TGT delivers every email its automation sends');
  });

  it('writes once the emails are accepted, and writes on a closed org with no accord, the read made once', async () => {
    const accepted = await runPath({
      read: TRAP,
      mute: false,
      acceptEmails: true,
      org: orgAnswering(OPEN),
    });
    expect(accepted.counts).toEqual({ assignments: 0, deliverabilityReads: 1, writes: 1 });

    const closed = await runPath({
      read: TRAP,
      mute: false,
      acceptEmails: false,
      org: orgAnswering(CLOSED),
    });
    expect(closed.gate.verdict).toBe('withheld');
    expect(closed.counts).toEqual({ assignments: 0, deliverabilityReads: 1, writes: 1 });
    expect(writePathOrderDefects(closed.events)).toEqual([]);
  });

  it('reads nothing and asks nothing of the emails when the mute keeps every sender quiet, then writes under the lease', async () => {
    const org = orgAnswering(OPEN);
    const { events, counts, gate } = await runPath({
      read: TRAP,
      mute: true,
      acceptEmails: false,
      org,
    });

    expect(gate.verdict).toBe('nothingSends');
    expect(counts).toEqual({ assignments: 1, deliverabilityReads: 0, writes: 1 });
    expect(org.urls).toEqual([]);
    expect(events).not.toContain('deliverabilityRead');
    expect(writePathOrderDefects(events)).toEqual([]);
  });

  it('refuses before its first write a run whose lease did not hold the set that kept the senders quiet, and gives the lease back', async () => {
    const { events, counts, stop } = await runPath({
      read: TRAP,
      mute: true,
      acceptEmails: false,
      org: orgAnswering(OPEN),
      heldSets: () => [],
    });

    expect(counts.writes).toBe(0);
    expect(stop).toContain('flow "Welcome email"');
    expect(events).toContain('leaseRelease');
    expect(writePathOrderDefects(events)).toEqual([]);
  });
});

describe('runEmailsOf', () => {
  /** What a run hands the gate, the org's read counted. */
  const input = (org: ReturnType<typeof orgAnswering>) => {
    const { counter, read } = countedRead(org);
    return {
      counter,
      asked: {
        read: TRAP,
        writes: inserts,
        readDeliverability: read,
        accepted: false,
        target: 'TGT',
        run: 'clone' as const,
      },
    };
  };

  it('says nothing and reads nothing when the mute’s plan keeps every sender quiet', async () => {
    const { counter, asked } = input(orgAnswering(OPEN));

    const emails = await runEmailsOf({ ...asked, plan: mutePlanOf(TRAP, inserts) });

    expect(counter.reads).toBe(0);
    expect(emails.gate).toEqual({ verdict: 'nothingSends', confirmation: {} });
    expect(emails.ofRun).toEqual({ senders: [] });
  });

  it('refuses a run that does not mute on All email, naming the mute for what it can quiet', async () => {
    const { asked } = input(orgAnswering(OPEN));

    const emails = await runEmailsOf({ ...asked, mayMute: true });

    expect(emails.gate.verdict).toBe('asks');
    expect(emails.gate.audit).toBe('all');
    expect(emails.gate.stop?.message).toContain(
      '--mute-automation keeps quiet workflow rule "Welcome rule" and flow "Welcome email" on Contact',
    );
  });

  it('never names the mute for a run that cannot be given it, nor for one that mutes', async () => {
    const withoutIt = await runEmailsOf(input(orgAnswering(OPEN)).asked);
    expect(withoutIt.gate.stop?.message).not.toContain('--mute-automation');

    const running = automation([
      { objectApiName: 'Contact', flows: [flow({ messages: SEND_WELCOME })], triggers: [] },
    ]);
    const muting = await runEmailsOf({
      ...input(orgAnswering(OPEN)).asked,
      read: running,
      plan: { assign: [] },
      mayMute: true,
    });
    expect(muting.gate.verdict).toBe('asks');
    expect(muting.gate.stop?.message).not.toContain('--mute-automation');
  });

  it('says where the emails go by whether the run keeps the addresses it writes', async () => {
    const neutralized = await runEmailsOf(input(orgAnswering(OPEN)).asked);
    expect(neutralized.gate.stop?.message).toContain('those this clone writes are under .invalid');

    const kept = await runEmailsOf({ ...input(orgAnswering(OPEN)).asked, keepsAddresses: true });
    expect(kept.gate.stop?.message).toContain(
      'those of the records this clone writes, as they hold them',
    );
    expect(kept.gate.stop?.message).not.toContain('.invalid');
  });

  it('counts the assignment rules a run applies, and only then', async () => {
    const rules = automation([
      {
        objectApiName: 'Case',
        flows: [],
        triggers: [],
        assignmentRules: [{ name: 'Route cases' }],
      },
    ]);
    const { asked, counter } = input(orgAnswering(OPEN));

    const left = await runEmailsOf({ ...asked, read: rules });
    expect(left.gate.verdict).toBe('nothingSends');
    expect(counter.reads).toBe(0);

    const applied = await runEmailsOf({ ...asked, read: rules, applyAssignmentRules: true });
    expect(applied.ofRun.senders).toEqual([
      { objectApiName: 'Case', kind: 'assignmentRule', name: 'Route cases', why: 'assignment' },
    ]);
    expect(counter.reads).toBe(1);
  });

  it('reads the org and asks when the automation could not be read at all, which lists no sender', async () => {
    const { asked, counter } = input(orgAnswering(OPEN));

    const emails = await runEmailsOf({ ...asked, read: { unread: 'the org did not answer' } });

    expect(counter.reads).toBe(1);
    expect(emails.ofRun.senders).toEqual([]);
    expect(emails.gate.verdict).toBe('asks');
    expect(emails.gate.deliverability?.sendersUnread).toContain(
      "the target's flows: the org did not answer",
    );
    expect(emails.gate.stop?.code).toBe('EMAILS_NOT_ACCEPTED');
  });

  it('asks of an org it was told not to read, sending nothing: no Apex runs in a production org', async () => {
    const org = orgAnswering(OPEN);
    const emails = await runEmailsOf({
      ...input(org).asked,
      readDeliverability: () => Promise.resolve(NO_APEX_IN_PRODUCTION),
    });

    expect(org.urls).toEqual([]);
    expect(emails.gate.verdict).toBe('asks');
    expect(emails.gate.deliverability?.reading).toEqual({
      unread: 'SandForge runs no Apex in a production org',
    });
    expect(emails.ofRun.read?.requests).toBe(0);
  });

  describe('after the lease', () => {
    const plan = mutePlanOf(TRAP, inserts);
    const set = plan.assign[0]?.permissionSet ?? '';
    const held = { assigned: [set], held: [] };

    it('has nothing to say of a lease that holds its plan, or of a run with no plan', async () => {
      const { asked } = input(orgAnswering(OPEN));
      const muted = await runEmailsOf({ ...asked, plan });
      expect(muted.afterLease(held, false)).toBeUndefined();

      const unmuted = await runEmailsOf({ ...asked, accepted: true });
      expect(unmuted.afterLease({ assigned: [], held: [] }, false)).toBeUndefined();
    });

    it('refuses a sender a set not held left running, unless the emails were accepted', async () => {
      const { asked } = input(orgAnswering(OPEN));
      const muted = await runEmailsOf({ ...asked, plan });

      const stop = muted.afterLease({ assigned: [], held: [] }, false);

      expect(stop?.code).toBe('EMAILS_NOT_ACCEPTED');
      expect(stop?.relit.map((sender) => sender.name)).toEqual(['Welcome rule', 'Welcome email']);
      expect(muted.afterLease({ assigned: [], held: [] }, true)).toBeUndefined();
    });

    it('takes a set the user held already for held', async () => {
      const { asked } = input(orgAnswering(OPEN));
      const muted = await runEmailsOf({ ...asked, plan });

      expect(muted.afterLease({ assigned: [], held: [set] }, false)).toBeUndefined();
    });

    it('lets a closed org through: none of what the lease left running goes out', async () => {
      const sending = automation(
        [
          {
            objectApiName: 'Contact',
            flows: [
              bypassed({
                label: 'Welcome email',
                apiName: 'Welcome_Email',
                messages: SEND_WELCOME,
              }),
              flow({ apiName: 'Left', label: 'Left running', messages: SEND_WELCOME }),
            ],
            triggers: [],
          },
        ],
        { bypassGrants: TRAP.bypassGrants ?? [] },
      );
      const emails = await runEmailsOf({
        ...input(orgAnswering(CLOSED)).asked,
        read: sending,
        plan: mutePlanOf(sending, inserts),
      });

      expect(emails.gate.verdict).toBe('withheld');
      expect(emails.afterLease({ assigned: [], held: [] }, false)).toBeUndefined();
    });
  });
});
