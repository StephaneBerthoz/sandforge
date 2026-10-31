import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import type { MutedAutomation } from '@sandforge/shared';
import i18n from '../../i18n';
import ja from '../../i18n/locales/ja.json';
import { formatStoredDate } from '../../utils/formatters';
import { MutedAutomationResult } from './MutedAutomationResult';

/** What a run that muted says once it ended, as the lease answers it. */
const MUTED: MutedAutomation = {
  state: 'muted',
  assigned: ['Bypass_Automation'],
  held: ['Bypass_Validation'],
  permissions: ['Bypass_Flows'],
  silenced: [
    { objectApiName: 'Account', kind: 'flow', name: 'Welcome email', permission: 'Bypass_Flows' },
  ],
  stillRan: [
    { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger', why: 'noBypass' },
    { objectApiName: 'Case', kind: 'process', name: 'Escalate', why: 'notRead' },
  ],
  released: true,
};

describe('MutedAutomationResult', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('says nothing for a run that was not asked to mute', () => {
    const { container } = render(
      <MutedAutomationResult muted={undefined} org="dev" testId="muted" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('says what the run assigned, what it held already, that it was taken back, what it silenced and what still ran', () => {
    render(<MutedAutomationResult muted={MUTED} org="dev-sandbox" testId="muted" />);

    expect(
      screen.queryByRole('heading', { name: "Muting the target's automation" }),
    ).not.toBeNull();
    expect(screen.getByTestId('muted').dataset.state).toBe('muted');
    expect(screen.getByTestId('muted-said').textContent).toBe(
      'Bypass_Automation was assigned to the user the run wrote as in dev-sandbox, for the run alone.',
    );
    expect(screen.getByTestId('muted-held').textContent).toBe(
      'Already held, neither assigned nor taken back: Bypass_Validation.',
    );
    expect(screen.getByTestId('muted-released').textContent).toBe('Taken back as the run ended.');
    expect(screen.getByTestId('muted-silenced-Account').textContent).toBe(
      'Account: Flow: Welcome email · bypass Bypass_Flows',
    );
    expect(screen.getByTestId('muted-still-ran-Account').textContent).toBe(
      'Account: Apex trigger: AccountTrigger · nothing in it tests a bypass',
    );
    expect(screen.getByTestId('muted-still-ran-Case').textContent).toBe(
      "Case: Process: Escalate · its condition couldn't be read",
    );
  });

  it('says what the set lifted beside what it silenced, and a set whose grants could not be read', () => {
    render(
      <MutedAutomationResult
        muted={{
          ...MUTED,
          alsoLifted: [
            {
              objectApiName: 'Contact',
              kind: 'validationRule',
              name: 'Lead_Source_Locked',
              permission: 'Bypass_VR',
              permissionSet: 'Bypass_Automation',
            },
          ],
          liftsUnread: [{ part: 'grants', permissionSet: 'Bypass_Other' }],
        }}
        org="dev-sandbox"
        testId="muted"
      />,
    );

    const lifted = screen.getByTestId('muted-also-lifted');
    expect(within(lifted).getByText('Also lifted, by what else these sets grant:')).toBeDefined();
    expect(screen.getByTestId('muted-also-lifted-Contact').textContent).toBe(
      'Contact: Validation rule: Lead_Source_Locked · Bypass_VR, in Bypass_Automation',
    );
    expect(
      within(lifted).getByText(
        "What Bypass_Other grants couldn't be read: what else it lifts isn't known.",
      ),
    ).toBeDefined();
  });

  it('says what was left assigned, and when the next run takes it back, when the org refused to take it back', () => {
    const leaseEndsAt = '2026-10-31T09:00:00.000Z';
    render(
      <MutedAutomationResult
        muted={{ ...MUTED, released: false, leaseEndsAt }}
        org="dev"
        testId="muted"
      />,
    );

    expect(screen.queryByTestId('muted-released')).toBeNull();
    expect(screen.getByTestId('muted-not-released').textContent).toBe(
      `Not all taken back yet: the next run on this machine that mutes dev takes back what is left once the lease ends (${formatStoredDate(leaseEndsAt, 'yyyy-MM-dd HH:mm')}).`,
    );
  });

  it('says a run that found nothing to mute went as without the option', () => {
    render(
      <MutedAutomationResult
        muted={{
          state: 'nothing',
          assigned: [],
          held: [],
          permissions: [],
          silenced: [],
          stillRan: [],
          reason: 'nothing found can be muted',
        }}
        org="dev"
        testId="muted"
      />,
    );

    expect(screen.getByTestId('muted-said').textContent).toBe(
      'Nothing could be muted in dev: the run went ahead as without the option.',
    );
    expect(screen.queryByTestId('muted-released')).toBeNull();
    expect(screen.queryByTestId('muted-silenced')).toBeNull();
  });

  it('says a user who held every set was assigned nothing', () => {
    render(
      <MutedAutomationResult
        muted={{ ...MUTED, assigned: [], held: ['Bypass_Automation'] }}
        org="dev"
        testId="muted"
      />,
    );

    expect(screen.getByTestId('muted-said').textContent).toBe(
      'Nothing was assigned: the user the run wrote as in dev already held every permission set it needed.',
    );
    // Nothing assigned, nothing to take back.
    expect(screen.queryByTestId('muted-released')).toBeNull();
    expect(screen.queryByTestId('muted-held')).toBeNull();
  });

  it('says what a real run would assign of a run that assigned nothing', () => {
    render(
      <MutedAutomationResult
        muted={{ ...MUTED, state: 'planned', assigned: [], held: [], released: undefined }}
        org="dev"
        testId="muted"
      />,
    );

    expect(screen.getByTestId('muted-said').textContent).toBe(
      'A real run would assign the user it writes as in dev the permission set holding Bypass_Flows, for the run alone; this one assigned nothing.',
    );
    expect(screen.getByTestId('muted-silenced').textContent).toContain('Silenced for the run:');
  });

  it('is written in the interface language', async () => {
    i18n.addResourceBundle('ja', 'translation', ja);
    await act(async () => {
      await i18n.changeLanguage('ja');
    });
    render(<MutedAutomationResult muted={MUTED} org="dev" testId="muted" />);

    expect(screen.getByTestId('muted-said').textContent).toBe(
      'dev で実行が書き込みに使ったユーザーに、実行の間だけ Bypass_Automation を割り当てました。',
    );
    expect(screen.getByTestId('muted-released').textContent).toBe('実行の終了時に取り消しました。');
  });
});
