import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { MutePlan } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { AutomationMuteBox } from './AutomationMuteBox';

/** A plan as `mutePlanOf` makes one: a flow and a workflow rule silenced, a trigger and a package's flow left. */
const PLAN: MutePlan = {
  assign: [
    {
      permissionSet: 'Bypass_Automation',
      label: 'Bypass Automation',
      permissions: ['Bypass_Flows'],
    },
  ],
  silenced: [
    { objectApiName: 'Account', kind: 'flow', name: 'Welcome email', permission: 'Bypass_Flows' },
    {
      objectApiName: 'Contact',
      kind: 'workflowRule',
      name: 'Notify owner',
      permission: 'Bypass_Flows',
    },
  ],
  stillRuns: [
    { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger', why: 'noBypass' },
    { objectApiName: 'Contact', kind: 'flow', name: 'Survey invite', why: 'managedPackage' },
  ],
};

/** The same read when the user holds every bypass, or none applies: nothing to silence. */
const NOTHING: MutePlan = { assign: [], silenced: [], stillRuns: PLAN.stillRuns };

describe('AutomationMuteBox', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('offers the box, off, with the permission set it assigns, what it silences and what still runs', () => {
    render(
      <AutomationMuteBox
        offer={PLAN}
        checked={false}
        onChange={vi.fn()}
        org="dev-sandbox"
        testId="mute"
      />,
    );

    const toggle = screen.getByRole('checkbox', {
      name: "Mute the target's automation for this run — through its own bypass",
    });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('mute-assigns').textContent).toBe(
      'Assigns the permission set Bypass_Automation to the user the run writes as in dev-sandbox, for this run alone, and takes it back as the run ends.',
    );
    expect(screen.getByTestId('mute-silenced-Account').textContent).toBe(
      'Account: Flow: Welcome email · bypass Bypass_Flows',
    );
    expect(screen.getByTestId('mute-silenced-Contact').textContent).toBe(
      'Contact: Workflow rule: Notify owner · bypass Bypass_Flows',
    );
    expect(screen.getByTestId('mute-still-runs').textContent).toContain(
      'Account: Apex trigger: AccountTrigger · nothing in it tests a bypass',
    );
    expect(screen.getByTestId('mute-still-runs').textContent).toContain(
      'Contact: Flow: Survey invite · installed by a managed package',
    );
    // Its words describe the box to a screen reader, the label naming it.
    const described = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toMatch(/^Assigns the permission set Bypass_Automation/);
  });

  it('names each rule the set lifts beside what it silences, with the permission and the set, and what of it was not read', () => {
    render(
      <AutomationMuteBox
        offer={{
          ...PLAN,
          alsoLifts: [
            {
              objectApiName: 'Contact',
              kind: 'validationRule',
              name: 'Email_Required',
              permission: 'Bypass_VR',
              permissionSet: 'Bypass_Automation',
            },
          ],
          liftsUnread: [{ part: 'validationRules', rules: 2 }],
        }}
        checked={false}
        onChange={vi.fn()}
        org="dev-sandbox"
        testId="mute"
      />,
    );

    const lifts = screen.getByTestId('mute-also-lifts');
    expect(within(lifts).getByText('Also lifts, by what else these sets grant:')).toBeDefined();
    expect(screen.getByTestId('mute-also-lifts-Contact').textContent).toBe(
      'Contact: Validation rule: Email_Required · Bypass_VR, in Bypass_Automation',
    );
    expect(
      within(lifts).getByText(
        "Not every validation rule could be read: whether the sets lift more isn't known.",
      ).className,
    ).toContain('text-status-warning');
  });

  it('names nothing lifted for a set that grants nothing beyond its bypass', () => {
    render(
      <AutomationMuteBox
        offer={PLAN}
        checked={false}
        onChange={vi.fn()}
        org="dev-sandbox"
        testId="mute"
      />,
    );
    expect(screen.queryByTestId('mute-also-lifts')).toBeNull();
  });

  it('says whether it is ticked, and hands the tick to its owner', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AutomationMuteBox
        offer={PLAN}
        checked={false}
        onChange={onChange}
        org="dev"
        testId="mute"
      />,
    );
    fireEvent.click(screen.getByTestId('mute-toggle'));
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(
      <AutomationMuteBox offer={PLAN} checked onChange={onChange} org="dev" testId="mute" />,
    );
    expect((screen.getByTestId('mute-toggle') as HTMLInputElement).checked).toBe(true);
  });

  it('offers nothing before a read, nor when a bypass silences nothing it read', () => {
    const { rerender } = render(
      <AutomationMuteBox offer={null} checked={false} onChange={vi.fn()} org="dev" testId="mute" />,
    );
    expect(screen.queryByTestId('mute')).toBeNull();

    rerender(
      <AutomationMuteBox
        offer={NOTHING}
        checked={false}
        onChange={vi.fn()}
        org="dev"
        testId="mute"
      />,
    );
    expect(screen.queryByTestId('mute')).toBeNull();
    // Control: the same read with something a bypass silences offers the box.
    rerender(
      <AutomationMuteBox offer={PLAN} checked={false} onChange={vi.fn()} org="dev" testId="mute" />,
    );
    expect(screen.queryByTestId('mute')).not.toBeNull();
  });

  it('unticks a box no longer offered: a read again found nothing to silence', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AutomationMuteBox offer={PLAN} checked onChange={onChange} org="dev" testId="mute" />,
    );
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <AutomationMuteBox offer={NOTHING} checked onChange={onChange} org="dev" testId="mute" />,
    );
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('says, on a page that reads none, that what it silences is read as the run starts', () => {
    render(
      <AutomationMuteBox
        offer="atStart"
        checked={false}
        onChange={vi.fn()}
        org="dev-sandbox"
        testId="mute"
      />,
    );

    expect(screen.getByTestId('mute-at-start').textContent).toMatch(
      /^What it silences is read from dev-sandbox as the run starts/,
    );
    expect(screen.queryByTestId('mute-assigns')).toBeNull();
    expect(screen.getByTestId('mute').textContent).toContain(
      'Refused on a production org and for a user who can',
    );
  });

  it('names several permission sets as the language lists them', () => {
    const two: MutePlan = {
      ...PLAN,
      assign: [
        ...PLAN.assign,
        { permissionSet: 'Bypass_Rules', label: 'Bypass Rules', permissions: ['Bypass_WF'] },
      ],
    };
    render(
      <AutomationMuteBox offer={two} checked={false} onChange={vi.fn()} org="dev" testId="mute" />,
    );

    expect(screen.getByTestId('mute-assigns').textContent).toBe(
      'Assigns the permission sets Bypass_Automation and Bypass_Rules to the user the run writes as in dev, for this run alone, and takes them back as the run ends.',
    );
  });

  it('is written in the interface language', async () => {
    i18n.addResourceBundle('fr', 'translation', fr);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    render(
      <AutomationMuteBox offer={PLAN} checked={false} onChange={vi.fn()} org="dev" testId="mute" />,
    );

    expect(
      screen.queryByRole('checkbox', {
        name: 'Rendre muettes les automatisations de la cible pour cette exécution — par son propre contournement',
      }),
    ).not.toBeNull();
    expect(screen.getByTestId('mute-silenced-Account').textContent).toBe(
      'Account: Flow : Welcome email · contournement Bypass_Flows',
    );
  });
});
