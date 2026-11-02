import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import {
  mutePlanOf,
  removalStepsWrites,
  type EmailSender,
  type ForgeRemovalSteps,
  type ForgeTargetAutomation,
  type RunDeliverability,
} from '@sandforge/shared';
import { RewindDeliverability, rewindEmailsAskOf } from './RewindDeliverability';

/** What the default preview's rewind writes: it deletes contacts and accounts, gives them values back, brings an account back. */
const STEPS: ForgeRemovalSteps = {
  delete: ['Contact', 'Account'],
  giveBack: ['Contact', 'Account'],
  bringBack: ['Account'],
};

/**
 * The trap org's two senders, on the contact a rewind gives its values back
 * to: a flow whose start condition tests a bypass a permission set of the org
 * holds, as the trap's welcome email does, and an alert on the account's
 * delete that tests none.
 */
const SENDING: ForgeTargetAutomation = {
  objectsRead: ['Contact', 'Account'],
  objects: [
    {
      objectApiName: 'Contact',
      flows: [
        {
          apiName: 'Contact_Welcome_Email',
          label: 'Contact Welcome Email',
          timing: 'afterSave',
          startsOn: 'update',
          condition: 'read',
          permissions: [{ name: 'Bypass_Flow', bypass: true, held: false }],
          messages: [{ kind: 'email', name: 'Welcome', limit: 'SingleEmail' }],
        },
      ],
      triggers: [],
    },
    {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_Gone_Alert',
          label: 'Account Gone Alert',
          timing: 'beforeDelete',
          startsOn: 'delete',
          condition: 'read',
          permissions: [],
          messages: [{ kind: 'email', name: 'Owner alert', limit: 'DailyWorkflowEmails' }],
        },
      ],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Bypass_Flow',
      permissionSets: [{ name: 'Flow_Bypass', label: 'Flow bypass', grants: 1 }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

const WELCOME: EmailSender = {
  objectApiName: 'Contact',
  kind: 'flow',
  name: 'Contact Welcome Email',
  why: 'email',
};
const ALERT: EmailSender = {
  objectApiName: 'Account',
  kind: 'flow',
  name: 'Account Gone Alert',
  why: 'email',
};

/** What the extension answered of the emails: the org's reading, and what it named as sending. */
function delivering(
  reading: RunDeliverability['reading'],
  senders: EmailSender[] = [WELCOME, ALERT],
): RunDeliverability {
  return { reading, senders };
}

/** The plan of the mute the preview offers for the rewind's writes. */
const MUTE = mutePlanOf(SENDING, removalStepsWrites(STEPS));

describe('rewindEmailsAskOf', () => {
  it('asks for what the extension named, on an org that delivers them all', () => {
    expect(
      rewindEmailsAskOf({
        deliverability: delivering({ level: 'all' }),
        automation: SENDING,
        steps: STEPS,
      }),
    ).toEqual({ verdict: 'asks', senders: [WELCOME, ALERT], unlisted: false });
  });

  it('asks on an org that would not say, as on All email', () => {
    expect(
      rewindEmailsAskOf({
        deliverability: delivering({ unread: 'the user cannot run anonymous Apex' }),
        automation: SENDING,
        steps: STEPS,
      }).verdict,
    ).toBe('asks');
  });

  it('says, and asks nothing, where the org delivers none of them', () => {
    expect(
      rewindEmailsAskOf({
        deliverability: delivering({ level: 'withheld' }),
        automation: SENDING,
        steps: STEPS,
      }).verdict,
    ).toBe('withheld');
  });

  it('says nothing where nothing sends', () => {
    expect(
      rewindEmailsAskOf({ deliverability: undefined, automation: SENDING, steps: STEPS }),
    ).toEqual({ verdict: 'none', senders: [], unlisted: false });
  });

  it('takes off what the mute keeps quiet, and still asks for what tests no bypass', () => {
    const ask = rewindEmailsAskOf({
      deliverability: delivering({ level: 'all' }),
      automation: SENDING,
      steps: STEPS,
      mute: MUTE,
    });
    expect(ask).toEqual({ verdict: 'asks', senders: [ALERT], unlisted: false });
  });

  it('asks nothing of a muted rewind whose every sender tests a bypass the mute holds', () => {
    expect(
      rewindEmailsAskOf({
        deliverability: delivering({ level: 'all' }, [WELCOME]),
        automation: SENDING,
        steps: STEPS,
        mute: MUTE,
      }),
    ).toEqual({ verdict: 'quiet', senders: [], unlisted: false });
  });

  it('keeps asking a muted rewind for what could not be read of the automation', () => {
    const blind: ForgeTargetAutomation = {
      ...SENDING,
      unread: [{ part: 'workflowRules', reason: 'INSUFFICIENT_ACCESS' }],
    };
    expect(
      rewindEmailsAskOf({
        deliverability: delivering({ level: 'all' }, [WELCOME]),
        automation: blind,
        steps: STEPS,
        mute: MUTE,
      }),
    ).toEqual({ verdict: 'asks', senders: [], unlisted: true });
  });

  it('asks for what could not be read when the extension named no sender', () => {
    expect(
      rewindEmailsAskOf({
        deliverability: delivering({ level: 'all' }, []),
        automation: SENDING,
        steps: STEPS,
        mute: MUTE,
      }),
    ).toEqual({ verdict: 'asks', senders: [], unlisted: true });
  });

  it('never takes off a sender the mute does not keep quiet, whatever the page cannot place', () => {
    const elsewhere: EmailSender = {
      objectApiName: 'Case',
      kind: 'workflowRule',
      name: 'Case Closed',
      why: 'email',
    };
    expect(
      rewindEmailsAskOf({
        deliverability: delivering({ level: 'all' }, [WELCOME, elsewhere]),
        automation: SENDING,
        steps: STEPS,
        mute: MUTE,
      }).senders,
    ).toEqual([elsewhere]);
  });

  it('asks whenever the refusal is the emails’, even with nothing read of them', () => {
    expect(
      rewindEmailsAskOf({
        deliverability: undefined,
        automation: SENDING,
        steps: STEPS,
        refused: true,
      }).verdict,
    ).toBe('asks');
  });
});

describe('RewindDeliverability', () => {
  afterEach(cleanup);

  it('names who sends as the extension named them, what the org delivers and where the emails go', () => {
    render(
      <RewindDeliverability
        ask={{
          verdict: 'asks',
          senders: [WELCOME, { ...ALERT, why: 'notRead' }],
          unlisted: false,
        }}
        reading={{ level: 'all' }}
        orgName="DEV-SB"
        testId="emails"
      />,
    );
    expect(screen.getByTestId('emails-reading').textContent).toBe(
      'DEV-SB delivers every email its automation sends (Setup > Deliverability: All email), ' +
        'and what still runs as the rewind writes may send some: Flow “Contact Welcome Email” ' +
        'on Contact and Flow “Account Gone Alert” on Account (its definition was not read).',
    );
    // A rewind writes the org's own values back: the addresses are the records', never .invalid.
    expect(screen.getByTestId('emails-addresses').textContent).toBe(
      "They go to the addresses the records hold, to the records' owners and to the addresses " +
        "an alert names: a rewind writes back DEV-SB's own values, never put under .invalid.",
    );
  });

  it('gives the org’s own reason when it would not say, and names what could not be read', () => {
    render(
      <RewindDeliverability
        ask={{ verdict: 'asks', senders: [], unlisted: true }}
        reading={{ unread: 'System.CalloutException: Read timed out' }}
        orgName="DEV-SB"
        testId="emails"
      />,
    );
    expect(screen.getByTestId('emails-reading').textContent).toBe(
      'Whether DEV-SB delivers the emails its automation sends could not be read ' +
        '(System.CalloutException: Read timed out), and what still runs as the rewind writes ' +
        'may send some: what of its automation could not be read. On System email only or No ' +
        'access (Setup > Deliverability), none of them goes out.',
    );
  });

  it('names ten senders and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...WELCOME, name: `Flow ${i + 1}` }));
    render(
      <RewindDeliverability
        ask={{ verdict: 'asks', senders: many, unlisted: false }}
        reading={{ level: 'all' }}
        orgName="DEV-SB"
        testId="emails"
      />,
    );
    const reading = screen.getByTestId('emails-reading').textContent ?? '';
    expect(reading).toContain('Flow “Flow 10” on Contact and 2 more.');
    expect(reading).not.toContain('Flow 11');
  });

  it('says in one line that none goes out, or that the mute keeps them quiet, and nothing where nothing sends', () => {
    render(
      <RewindDeliverability
        ask={{ verdict: 'withheld', senders: [WELCOME], unlisted: false }}
        reading={{ level: 'withheld' }}
        orgName="DEV-SB"
        testId="emails"
      />,
    );
    expect(screen.getByTestId('emails-withheld').textContent).toContain(
      'DEV-SB delivers none of the emails',
    );
    cleanup();
    render(
      <RewindDeliverability
        ask={{ verdict: 'quiet', senders: [], unlisted: false }}
        reading={{ level: 'all' }}
        orgName="DEV-SB"
        testId="emails"
      />,
    );
    expect(screen.getByTestId('emails-quiet').textContent).toContain('muted, none of it sends');
    cleanup();
    const { container } = render(
      <RewindDeliverability
        ask={{ verdict: 'none', senders: [], unlisted: false }}
        reading={undefined}
        orgName="DEV-SB"
        testId="emails"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
