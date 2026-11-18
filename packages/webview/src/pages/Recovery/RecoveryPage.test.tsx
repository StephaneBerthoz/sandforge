import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import { useAppStore } from '../../stores/useAppStore';
import { useOrgStore } from '../../stores/useOrgStore';
import {
  fakeHost,
  productionOrg,
  refreshedStatus,
  uatOrg,
  unrefreshedStatus,
  type FakeHost,
} from './testing/recoveryFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { RecoveryPage } from './RecoveryPage';

/** Answer the page's last `recovery:status`. */
function answerStatus(status = refreshedStatus()): void {
  act(() => host.current?.answer('recovery:status', 'recovery:status:response', { status }));
}

beforeEach(() => {
  host.current = fakeHost();
  useAppStore.setState({ currentRoute: 'recovery', navigationIntent: null });
});

afterEach(async () => {
  useOrgStore.setState({ orgs: [], selectedOrgId: null });
  await i18n.changeLanguage('en');
});

describe('RecoveryPage', () => {
  it('is titled after the sandbox it brings back into service', () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);

    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading').textContent).toBe(
      en.recovery.title.replace('{{alias}}', 'UAT'),
    );
    expect(screen.getByTestId('how-to-recovery')).toBeInTheDocument();
  });

  it('is titled by its name in the navigation while no org is selected, and asks for one', () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: null });
    render(<RecoveryPage />);
    expect(within(screen.getByTestId('page-header')).getByRole('heading').textContent).toBe(
      en.nav.recovery,
    );
    expect(screen.getByTestId('recovery-no-org').textContent).toBe(en.recovery.noOrg);
    expect(host.current?.sent('recovery:status')).toEqual([]);
  });

  it('with no org at all, leads to Organizations to connect one', () => {
    render(<RecoveryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect an org' }));
    expect(useAppStore.getState().currentRoute).toBe('orgs');
  });

  it('refuses a production org before it asks anything of it', () => {
    useOrgStore.setState({ orgs: [productionOrg()], selectedOrgId: 'org-prod' });
    render(<RecoveryPage />);
    expect(screen.getByTestId('recovery-production').textContent).toBe(
      en.recovery.production.replace(/{{alias}}/g, 'PROD'),
    );
    expect(host.current?.sent()).toEqual([]);
  });

  it('asks where the sandbox stands, then says it: refreshed when, n of N steps, and the warning', () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);
    expect(screen.getByTestId('recovery-loading').textContent).toBe('Reading where UAT stands…');
    expect(host.current?.lastPayload('recovery:status')).toEqual({ orgId: 'org-uat' });

    answerStatus();
    expect(screen.getByTestId('recovery-refreshed').textContent).toMatch(/^Refreshed on /);
    expect(screen.getByTestId('recovery-count').textContent).toBe('1/10 steps');
    expect(
      screen.getByRole('progressbar', { name: 'Steps of UAT done or skipped' }),
    ).toHaveAttribute('aria-valuetext', '1/10 steps');
    expect(screen.getByTestId('recovery-org-type').textContent).toBe('SANDBOX');
    expect(screen.getByTestId('recovery-not-proven')).toHaveTextContent(
      'Not yet proven on a refreshed sandbox',
    );
  });

  it('lists the ten steps in their order, numbered, each with its status', () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);
    answerStatus();

    const rows = Array.from(
      screen.getByTestId('recovery-steps').querySelectorAll<HTMLElement>(':scope > li'),
    );
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'recovery-step-refresh',
      'recovery-step-users',
      'recovery-step-masking',
      'recovery-step-replay',
      'recovery-step-frozen',
      'recovery-step-testersCheckpoint',
      'recovery-step-deliverability',
      'recovery-step-scheduledJobs',
      'recovery-step-endpoints',
      'recovery-step-handoff',
    ]);
    expect(
      screen.getByRole('heading', { name: '4. Replay the checkpoint of before' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('recovery-step-refresh-status').textContent).toBe('Done');
    expect(screen.getByTestId('recovery-step-masking-status').textContent).toBe('To do');
  });

  it('without a refresh noticed, says so and puts what to keep before the next one first', () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);
    answerStatus(unrefreshedStatus());

    expect(screen.getByTestId('recovery-refreshed').textContent).toBe('No refresh noticed');
    expect(screen.getByTestId('recovery-no-refresh').textContent).toBe(
      'SandForge noticed no refresh of UAT. The steps below work all the same, and what to keep before the next refresh comes first.',
    );
    const before = screen.getByTestId('recovery-before-next');
    const steps = screen.getByTestId('recovery-steps');
    expect(before.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('recovery-finish')).toBeNull();
  });

  it('with a refresh, lists what to keep after the steps, and offers Finish', () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);
    answerStatus();

    const before = screen.getByTestId('recovery-before-next');
    const steps = screen.getByTestId('recovery-steps');
    expect(steps.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('recovery-finish')).toBeInTheDocument();
  });

  it('words a refusal of the extension by its code, and asks again on Try again', () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: 'org-uat' });
    render(<RecoveryPage />);
    act(() =>
      host.current?.fail('recovery:status', {
        code: 'NOT_CONNECTED',
        message: 'The org UAT is not connected',
      }),
    );

    const error = screen.getByTestId('recovery-status-error');
    expect(error).toHaveTextContent(
      'UAT is not connected: reconnect it on the Organizations page, then try again.',
    );
    expect(error).not.toHaveTextContent('The org UAT is not connected');
    fireEvent.click(screen.getByTestId('recovery-status-error-retry'));
    expect(host.current?.sent('recovery:status')).toHaveLength(2);
  });

  it('speaks the language of the panel', async () => {
    useOrgStore.setState({ orgs: [uatOrg()], selectedOrgId: 'org-uat' });
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    render(<RecoveryPage />);
    answerStatus();

    expect(within(screen.getByTestId('page-header')).getByRole('heading').textContent).toBe(
      'Remettre UAT en service',
    );
    expect(screen.getByTestId('recovery-count').textContent).toBe('1/10 étapes');
    expect(screen.getByTestId('recovery-not-proven')).toHaveTextContent(
      'Pas encore prouvé sur une sandbox rafraîchie',
    );
  });
});
