import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SeedAutomationPreview } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { SeedAutomationNotice } from './SeedAutomationNotice';
import type { SeedAutomationState } from './useSeedAutomation';

/**
 * What a Developer Edition runs as contacts are created: a workflow rule and
 * a flow that email each one unless the user holds the bypass, and a flow
 * that opens a task; its single emails untouched today.
 */
function trapPreview(overrides: Partial<SeedAutomationPreview> = {}): SeedAutomationPreview {
  const bypass = [{ name: 'Trap_Bypass_Flow', held: false }];
  return {
    org: 'my-dev-org',
    objectsRead: ['Account', 'Contact', 'Case'],
    objects: [
      {
        objectApiName: 'Contact',
        entries: [
          {
            kind: 'workflowRule',
            name: 'Contact_Welcome',
            when: 'after',
            emails: 1,
            messages: [],
            creates: [],
            afterCommit: false,
            bypasses: bypass,
            keptQuiet: false,
            unread: false,
          },
          {
            kind: 'flow',
            name: 'Follow Up Task',
            when: 'after',
            emails: 0,
            messages: [],
            creates: ['Task'],
            afterCommit: false,
            bypasses: [],
            keptQuiet: false,
            unread: false,
          },
          {
            kind: 'flow',
            name: 'Welcome Email',
            when: 'after',
            emails: 2,
            messages: [],
            creates: [],
            afterCommit: true,
            bypasses: bypass,
            keptQuiet: false,
            unread: false,
          },
        ],
      },
    ],
    emailsPerRecord: [
      {
        objectApiName: 'Contact',
        limit: 'DailyWorkflowEmails',
        perRecord: 1,
        sentBy: ['Contact_Welcome'],
      },
      {
        objectApiName: 'Contact',
        limit: 'SingleEmail',
        perRecord: 3,
        sentBy: ['Contact_Welcome', 'Welcome Email'],
      },
    ],
    limits: {
      SingleEmail: { max: 15, remaining: 15 },
      DailyWorkflowEmails: { max: 8040, remaining: 8040 },
    },
    alertsAsSingle: true,
    bypasses: [{ permission: 'Trap_Bypass_Flow', permissionSet: 'Trap_Bypass' }],
    bypassesHeld: [],
    unread: [],
    blinded: false,
    conditionsNotRead: 0,
    ...overrides,
  };
}

const read = (preview: SeedAutomationPreview | null, more: Partial<SeedAutomationState> = {}) => ({
  preview,
  loading: false,
  error: null,
  readAgain: vi.fn(),
  ...more,
});

const CRM = { Account: 25, Contact: 75, Case: 50 };

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('SeedAutomationNotice', () => {
  it('says the org is being read, and holds nothing back meanwhile', () => {
    render(
      <SeedAutomationNotice
        automation={read(null, { loading: true })}
        orgName="my-dev-org"
        records={CRM}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe(
      'Reading what my-dev-org runs as these records are created…',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a read that failed, and reads again when asked', () => {
    const automation = read(null, { error: 'INVALID_SESSION_ID' });
    render(<SeedAutomationNotice automation={automation} orgName="my-dev-org" records={CRM} />);

    expect(screen.getByTestId('seed-automation-unread').textContent).toBe(
      'What my-dev-org runs as these records are created could not be read (INVALID_SESSION_ID). ' +
        'The seed is not held back, but the emails it makes the org send are not known.',
    );
    fireEvent.click(screen.getByTestId('seed-automation-read-again'));
    expect(automation.readAgain).toHaveBeenCalledOnce();
  });

  it('says what fires on each object, what it sends or creates, and the bypass that quiets it', () => {
    render(
      <SeedAutomationNotice automation={read(trapPreview())} orgName="my-dev-org" records={CRM} />,
    );

    expect(screen.getByRole('heading').textContent).toBe(
      'What my-dev-org runs as these records are created',
    );
    const flow = screen.getByTestId('seed-automation-entry-Contact-Welcome Email');
    expect(flow.textContent).toBe(
      'Flow “Welcome Email”2 emails per recordalso runs after the savenot for a user with Trap_Bypass_Flow',
    );
    expect(screen.getByTestId('seed-automation-entry-Contact-Contact_Welcome').textContent).toBe(
      'Workflow rule “Contact_Welcome”1 email per recordnot for a user with Trap_Bypass_Flow',
    );
    expect(screen.getByTestId('seed-automation-entry-Contact-Follow Up Task').textContent).toBe(
      'Flow “Follow Up Task”creates Task',
    );
    expect(screen.getByTestId('seed-automation-bypass-Trap_Bypass_Flow').textContent).toBe(
      'Assigned to you, Trap_Bypass_Flow keeps quiet what names it: the permission set ' +
        'Trap_Bypass holds it.',
    );
    expect(screen.getByTestId('seed-automation-alerts-as-single').textContent).toBe(
      'my-dev-org counts its email alerts against its single emails too, as a Developer Edition does.',
    );
  });

  it('says the seed would be refused past the emails left today, with the figures and the ways out', () => {
    render(
      <SeedAutomationNotice automation={read(trapPreview())} orgName="my-dev-org" records={CRM} />,
    );

    const refused = screen.getByRole('alert');
    expect(refused.getAttribute('data-testid')).toBe('seed-automation-refused-SingleEmail');
    const lines = within(refused)
      .getAllByText(/./, { selector: 'p' })
      .map((p) => p.textContent);
    expect(lines).toEqual([
      'The seed would be refused before it writes anything. Single emails these records make ' +
        'my-dev-org send: about 225, with 15 of 15 left today. Past them, a flow that sends in ' +
        "the save refuses its record, and the org's own emails stop for the rest of the day.",
      'To seed it, lower the record counts, set Contact to 0, or turn off “Contact_Welcome” and ' +
        '“Welcome Email”.',
      'Or give yourself the permission set Trap_Bypass: its Trap_Bypass_Flow keeps ' +
        '“Contact_Welcome” and “Welcome Email” quiet.',
    ]);
    expect(screen.getByTestId('seed-automation-emails-DailyWorkflowEmails').textContent).toBe(
      'Workflow emails these records make my-dev-org send: about 75, with 8,040 of 8,040 left today.',
    );
  });

  it('lets the seed through once the counts fit, counted without reading the org again', () => {
    const automation = read(trapPreview());
    render(
      <SeedAutomationNotice
        automation={automation}
        orgName="my-dev-org"
        records={{ Account: 25, Contact: 5 }}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('seed-automation-emails-SingleEmail').textContent).toBe(
      'Single emails these records make my-dev-org send: about 15, with 15 of 15 left today.',
    );
  });

  it('leaves out an object set to 0, and says nothing runs once nothing written fires', () => {
    render(
      <SeedAutomationNotice
        automation={read(trapPreview())}
        orgName="my-dev-org"
        records={{ Account: 25, Contact: 0 }}
      />,
    );
    expect(screen.queryByTestId('seed-automation-object-Contact')).toBeNull();
    expect(screen.getByTestId('seed-automation-nothing').textContent).toBe(
      'Nothing runs in my-dev-org as these records are created: no flow, Apex trigger, process or ' +
        'workflow rule.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says what a bypass the user holds keeps quiet, and counts no email of it', () => {
    const quiet = trapPreview();
    for (const entry of quiet.objects[0].entries) {
      entry.bypasses = entry.bypasses.map((b) => ({ ...b, held: true }));
      entry.keptQuiet = entry.bypasses.length > 0;
    }
    render(
      <SeedAutomationNotice
        automation={read({
          ...quiet,
          emailsPerRecord: [],
          limits: undefined,
          bypasses: [],
          bypassesHeld: ['Trap_Bypass_Flow'],
        })}
        orgName="my-dev-org"
        records={CRM}
      />,
    );
    expect(screen.getByTestId('seed-automation-entry-Contact-Welcome Email').textContent).toBe(
      'Flow “Welcome Email”quiet for this seed: you hold Trap_Bypass_Flow',
    );
    expect(screen.getByTestId('seed-automation-bypass-held').textContent).toBe(
      'You hold Trap_Bypass_Flow: what names it stays quiet for this seed.',
    );
    expect(screen.queryByTestId('seed-automation-emails-SingleEmail')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns and does not refuse when what the org has left could not be read, or part of it', () => {
    render(
      <SeedAutomationNotice
        automation={read(
          trapPreview({
            limits: undefined,
            limitsUnread: 'INSUFFICIENT_ACCESS',
            alertsAsSingle: false,
            unread: [{ part: 'triggers', reason: 'INSUFFICIENT_ACCESS' }],
            blinded: true,
            conditionsNotRead: 2,
          }),
        )}
        orgName="my-dev-org"
        records={CRM}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('seed-automation-emails-SingleEmail').textContent).toBe(
      'Single emails these records make my-dev-org send: about 225. What it has left today could ' +
        'not be read (INSUFFICIENT_ACCESS): the seed is not held back.',
    );
    expect(screen.getByTestId('seed-automation-part-unread').textContent).toBe(
      'Part of what my-dev-org runs could not be read (INSUFFICIENT_ACCESS): what it sends may ' +
        'not be counted.',
    );
    expect(screen.getByTestId('seed-automation-conditions-not-read')).toBeDefined();
  });

  it('says it in the language the panel is set to', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(
      <SeedAutomationNotice automation={read(trapPreview())} orgName="my-dev-org" records={CRM} />,
    );
    expect(screen.getByRole('heading').textContent).toBe(
      'Ce que my-dev-org exécute à la création de ces enregistrements',
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'mettez Contact à 0, ou désactivez « Contact_Welcome » et « Welcome Email ».',
    );
  });
});
