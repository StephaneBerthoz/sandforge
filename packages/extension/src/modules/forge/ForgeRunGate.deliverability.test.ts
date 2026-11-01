import { describe, it, expect } from 'vitest';
import type { EmailSender } from '@sandforge/shared';

import {
  EMAILS_NOT_ACCEPTED,
  ForgeRunGateError,
  apiBudgetCheckOf,
  apiBudgetRefusal,
  deliverabilityAfterLeaseStop,
  deliverabilityGate,
  deliverabilityPartOf,
  sendersUnreadOf,
  type DeliverabilityGateInput,
  type DeliverabilityRun,
} from './ForgeRunGate.js';

const WELCOME_RULE: EmailSender = {
  objectApiName: 'Contact',
  kind: 'workflowRule',
  name: 'Welcome rule',
  why: 'email',
};
const WELCOME_EMAIL: EmailSender = {
  objectApiName: 'Contact',
  kind: 'flow',
  name: 'Welcome email',
  why: 'email',
};
const PACKAGED: EmailSender = {
  objectApiName: 'Contact',
  kind: 'flow',
  name: 'Packaged',
  why: 'notRead',
};
const ROUTING: EmailSender = {
  objectApiName: 'Case',
  kind: 'assignmentRule',
  name: 'Support queue',
  why: 'assignment',
};

/** A Forge run's gate on its emails, two senders left, the accord not given. */
function input(overrides: Partial<DeliverabilityGateInput> = {}): DeliverabilityGateInput {
  return {
    senders: [WELCOME_RULE, WELCOME_EMAIL],
    reading: { level: 'all' },
    accepted: false,
    target: 'TGT',
    run: 'clone',
    ...overrides,
  };
}

describe('deliverabilityGate', () => {
  it('says nothing, keeps nothing and asks nothing when nothing that still runs sends an email', () => {
    expect(deliverabilityGate(input({ senders: [], reading: undefined }))).toEqual({
      verdict: 'nothingSends',
      confirmation: {},
    });
  });

  it('lets a run through on an org that delivers none of them, with a line and no question', () => {
    const gate = deliverabilityGate(input({ reading: { level: 'withheld' } }));

    expect(gate.verdict).toBe('withheld');
    expect(gate.stop).toBeUndefined();
    expect(gate.confirmation).toEqual({});
    expect(gate.deliverability).toEqual({
      reading: { level: 'withheld' },
      senders: [WELCOME_RULE, WELCOME_EMAIL],
    });
    expect(gate.audit).toBe('withheld');
    expect(gate.line).toBe(
      'deliverability: System email only or No access — none of the emails its flows, ' +
        'processes, workflow rules and Apex send goes out (read with one line of anonymous ' +
        'Apex that sends nothing)',
    );
  });

  it('asks on All email, and refuses without the accord, under its own code', () => {
    const gate = deliverabilityGate(input());

    expect(gate.verdict).toBe('asks');
    expect(gate.stop?.code).toBe(EMAILS_NOT_ACCEPTED);
    expect(gate.confirmation).toEqual({
      deliverability: { reading: { level: 'all' }, senders: [WELCOME_RULE, WELCOME_EMAIL] },
    });
    expect(gate.audit).toBe('all');
    expect(gate.line).toBe(
      'deliverability: All email — the emails of what still runs go out (read with one line of ' +
        'anonymous Apex that sends nothing)',
    );
  });

  it('asks when the org would not say, as on All email, the reason in its words', () => {
    const reason = 'the org answered: System.HandledException: The daily limit';
    const gate = deliverabilityGate(input({ reading: { unread: reason } }));

    expect(gate.verdict).toBe('asks');
    expect(gate.stop?.code).toBe(EMAILS_NOT_ACCEPTED);
    expect(gate.stop?.message).toContain(`could not be read (${reason})`);
    expect(gate.audit).toBe('unread');
    expect(gate.line).toBe(
      `deliverability: not read (${reason}) — the run is refused without --accept-emails, as on ` +
        'All email',
    );
  });

  it('takes a sender left with no reading for one the org would not say of', () => {
    const gate = deliverabilityGate(input({ reading: undefined }));

    expect(gate.verdict).toBe('asks');
    expect(gate.deliverability?.reading).toEqual({ unread: 'the run did not read it' });
  });

  it('asks when what sends could not all be read, though it lists no sender', () => {
    const gate = deliverabilityGate(
      input({ senders: [], sendersUnread: "the target's flows: INSUFFICIENT_ACCESS" }),
    );

    expect(gate.verdict).toBe('asks');
    expect(gate.stop?.message).toContain(
      "what runs as this clone writes its records could not all be read (the target's flows: " +
        'INSUFFICIENT_ACCESS), so it may send some.',
    );
  });

  it('lets the run through once given the accord, and still puts the emails to its question', () => {
    const gate = deliverabilityGate(input({ accepted: true }));

    expect(gate.verdict).toBe('asks');
    expect(gate.stop).toBeUndefined();
    expect(gate.confirmation.deliverability?.senders).toEqual([WELCOME_RULE, WELCOME_EMAIL]);
  });

  it('is a code of the command line’s own, which the page words by none of its stops', () => {
    expect(new ForgeRunGateError(EMAILS_NOT_ACCEPTED, 'refused').stop).toBeUndefined();
  });
});

describe('the refusal of a run for its emails', () => {
  it('says the org delivers them, who sends them object by object, where they go and what lets the run through', () => {
    const message = deliverabilityGate(input({ senders: [WELCOME_RULE, WELCOME_EMAIL, ROUTING] }))
      .stop?.message;

    expect(message).toBe(
      'TGT delivers every email its automation sends (Setup > Deliverability: All email), and ' +
        'what still runs as this clone writes its records sends some: workflow rule "Welcome ' +
        'rule" and flow "Welcome email" on Contact; assignment rule "Support queue" (applied: it ' +
        'can mail the owner it assigns) on Case. They go to the addresses the records and the ' +
        "alerts name: those this clone writes are under .invalid, but not the records' owners, " +
        'the records already in TGT, nor an address an alert names. Nothing was written. Add ' +
        "--accept-emails to clone all the same, set the org's deliverability to System email " +
        'only, or turn off what sends them.',
    );
  });

  it('does not say the records are under .invalid when the run keeps their addresses', () => {
    const message = deliverabilityGate(input({ keepsAddresses: true, run: 'rewind' })).stop
      ?.message;

    expect(message).not.toContain('.invalid');
    expect(message).toContain(
      "those of the records this rewind writes, as they hold them, the records' owners",
    );
    expect(message).toContain('Add --accept-emails to rewind all the same');
  });

  it('says on a read the org would not answer how to see for oneself, and nothing of where they go', () => {
    const message = deliverabilityGate(
      input({ reading: { unread: 'the org did not answer within 30 s' }, senders: [PACKAGED] }),
    ).stop?.message;

    expect(message).toBe(
      'Whether TGT delivers the emails its automation sends could not be read (the org did not ' +
        'answer within 30 s), and what still runs as this clone writes its records sends some: ' +
        'flow "Packaged" (its definition was not read) on Contact. Nothing was written. Add ' +
        '--accept-emails to clone all the same, or check Setup > Deliverability: on System ' +
        'email only or No access, none of them goes out.',
    );
  });

  it('names each run as its command does', () => {
    const said = (run: DeliverabilityRun): string | undefined =>
      deliverabilityGate(input({ run })).stop?.message;

    expect(said('sync')).toContain('as this sync writes');
    expect(said('sync')).toContain('--accept-emails to sync all the same');
    expect(said('seed')).toContain('--accept-emails to seed all the same');
    expect(said('autopilot')).toContain('as this Autopilot run writes');
    expect(said('autopilot')).toContain('--accept-emails to run it all the same');
    expect(said('undo')).toContain('--accept-emails to undo all the same');
  });

  it('suggests the mute for the senders it quiets, names those it cannot, and says nothing of it otherwise', () => {
    const quieting = deliverabilityGate(
      input({ senders: [WELCOME_RULE, WELCOME_EMAIL, PACKAGED], muteQuiets: [WELCOME_RULE] }),
    ).stop?.message;
    expect(quieting).toContain(
      '--mute-automation keeps quiet workflow rule "Welcome rule" on Contact, which tests a ' +
        'bypass a permission set of TGT holds; it cannot quiet flow "Welcome email" and flow ' +
        '"Packaged" (its definition was not read) on Contact.',
    );

    const all = deliverabilityGate(input({ muteQuiets: [WELCOME_RULE, WELCOME_EMAIL] })).stop
      ?.message;
    expect(all).toMatch(/Contact, which test a bypass a permission set of TGT holds\.$/);
    expect(all).not.toContain('cannot quiet');

    expect(deliverabilityGate(input({ muteQuiets: [] })).stop?.message).not.toContain(
      '--mute-automation',
    );
  });

  it('names ten senders of an object and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, i): EmailSender => ({
      ...WELCOME_EMAIL,
      name: `Flow ${i + 1}`,
    }));
    const message = deliverabilityGate(input({ senders: many })).stop?.message ?? '';

    expect(message).toContain('flow "Flow 10" and 2 more on Contact');
    expect(message).not.toContain('Flow 11');
  });
});

describe('sendersUnreadOf', () => {
  it('names the parts that send emails the read could not take, and the assignment rules only when applied', () => {
    const unread = [
      { part: 'flows' as const, reason: 'INSUFFICIENT_ACCESS' },
      { part: 'triggers' as const, reason: 'refused' },
      { part: 'conditions' as const, reason: 'past the bound' },
      { part: 'assignmentRules' as const, reason: 'no access' },
    ];

    expect(sendersUnreadOf(unread)).toBe("the target's flows: INSUFFICIENT_ACCESS");
    expect(sendersUnreadOf(unread, { applyAssignmentRules: true })).toBe(
      "the target's flows: INSUFFICIENT_ACCESS; the target's assignment rules: no access",
    );
    expect(sendersUnreadOf([{ part: 'triggers', reason: 'refused' }])).toBeUndefined();
  });
});

describe('the deliverability part of a run’s API requests', () => {
  it('counts the requests the read sent, and nothing for a run that read none', () => {
    expect(deliverabilityPartOf(undefined)).toEqual({});
    expect(deliverabilityPartOf({})).toEqual({});
    expect(deliverabilityPartOf({ read: { requests: 1 } })).toEqual({ deliverability: 1 });
    expect(deliverabilityPartOf({ read: { requests: 2 } })).toEqual({ deliverability: 2 });
  });

  it('is counted in the sum a run is refused on, and named by the refusal', () => {
    const check = apiBudgetCheckOf(
      { run: 4, ...deliverabilityPartOf({ read: { requests: 2 } }) },
      { max: 15_000, remaining: 5 },
    );

    expect(check.verdict).toBe('exceeds');
    expect(check.estimate).toBe(6);
    expect(apiBudgetRefusal(check, 'TGT')).toContain(
      'about 6 API requests (2 of them to read whether the target delivers its emails)',
    );
  });
});

describe('deliverabilityAfterLeaseStop', () => {
  const after = (overrides: Partial<Parameters<typeof deliverabilityAfterLeaseStop>[0]> = {}) =>
    deliverabilityAfterLeaseStop({
      planned: [],
      held: [WELCOME_EMAIL],
      reading: { level: 'all' },
      accepted: false,
      target: 'TGT',
      run: 'clone',
      ...overrides,
    });

  it('refuses before the first write a sender the lease left running that no one was asked about', () => {
    const stop = after();

    expect(stop?.code).toBe(EMAILS_NOT_ACCEPTED);
    expect(stop?.relit).toEqual([WELCOME_EMAIL]);
    expect(stop?.message).toBe(
      "The mute's lease does not hold every permission set it was to assign, and what they " +
        'were to keep quiet still runs for this clone: flow "Welcome email" on Contact may send ' +
        "emails, and TGT delivers every one of them (All email). The run's question did not ask " +
        'about them. Nothing was written. Add --accept-emails to clone all the same, or run it ' +
        'again once the lease can assign them.',
    );
  });

  it('takes an org not read, nothing that sent having been planned to run, for one that delivers them', () => {
    expect(after({ reading: undefined })?.message).toContain(
      'whether TGT delivers them was not read, as nothing that sends one was to run',
    );
    expect(after({ reading: { unread: 'refused' } })?.message).toContain(
      'whether TGT delivers them could not be read (refused)',
    );
  });

  it('lets through a run whose lease held what it planned, one given the accord, and one on a closed org', () => {
    expect(after({ planned: [WELCOME_EMAIL] })).toBeUndefined();
    expect(after({ accepted: true })).toBeUndefined();
    expect(after({ reading: { level: 'withheld' } })).toBeUndefined();
  });
});
