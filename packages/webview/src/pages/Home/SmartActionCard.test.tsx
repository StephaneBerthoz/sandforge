import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import type { SalesforceOrg, SmartActionRecommendation } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { SmartActionCard } from './SmartActionCard';

function createOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'Dev Sandbox',
    username: 'dev@example.com',
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#000000', icon: 'flask', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: '2026-01-01T00:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

function createRecommendation(
  overrides: Partial<SmartActionRecommendation> = {},
): SmartActionRecommendation {
  return {
    action: 'quick-seed',
    confidence: 0.9,
    reason: 'Your sandbox is empty — seed it with demo data',
    reasonKey: 'home.smartAction.reasonEmpty',
    details: {
      targetOrgId: 'org-1',
      recordCounts: { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 },
    },
    ...overrides,
  };
}

describe('SmartActionCard', () => {
  it('should render recommendation with execute button', () => {
    const onExecute = vi.fn();
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={onExecute}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('smart-action-card')).toBeDefined();
    expect(screen.getByTestId('smart-action-execute-btn')).toBeDefined();
    expect(screen.getByTestId('smart-action-why-btn')).toBeDefined();
  });

  it('should return null when action is none', () => {
    const { container } = render(
      <SmartActionCard
        recommendation={createRecommendation({ action: 'none', confidence: 0, reasonKey: '' })}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('should show confirmation state with confirm and cancel buttons', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={vi.fn()}
        showConfirmation={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByTestId('smart-action-confirm-btn')).toBeDefined();
    expect(screen.getByTestId('smart-action-cancel-btn')).toBeDefined();

    fireEvent.click(screen.getByTestId('smart-action-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('smart-action-cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should call onExecute when Execute button is clicked', () => {
    const onExecute = vi.fn();

    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={onExecute}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('smart-action-execute-btn'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('should show loading skeleton when loading', () => {
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loading={true}
      />,
    );

    expect(screen.getByTestId('smart-action-loading')).toBeDefined();
  });

  it('should render clone recommendation with Copy icon', () => {
    render(
      <SmartActionCard
        recommendation={createRecommendation({
          action: 'clone',
          confidence: 0.85,
          reasonKey: 'home.smartAction.reasonClone',
        })}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('smart-action-card')).toBeDefined();
  });
});

/*
 * The confirmation used to read "About to Quick Seed on org-1. Continue?" —
 * an internal id nobody recognises, in front of a button labelled Execute
 * which only opens a module page. Both halves are asserted here: the org the
 * user knows, and a label that matches what the click does.
 */
describe('SmartActionCard confirmation names the org and the outcome', () => {
  afterEach(() => {
    useOrgStore.setState({ orgs: [] });
  });

  function renderConfirmation(): void {
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={vi.fn()}
        showConfirmation={true}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  }

  it('shows the target org alias, not its id', () => {
    useOrgStore.setState({ orgs: [createOrg()] });

    renderConfirmation();

    const card = screen.getByTestId('smart-action-card');
    expect(card.textContent).toContain('Dev Sandbox');
    expect(card.textContent).not.toContain('org-1');
  });

  it('falls back to the username when the org has no alias', () => {
    useOrgStore.setState({ orgs: [createOrg({ alias: '' })] });

    renderConfirmation();

    expect(screen.getByTestId('smart-action-card').textContent).toContain('dev@example.com');
  });

  it('falls back to the id when the org is not in the store', () => {
    renderConfirmation();

    expect(screen.getByTestId('smart-action-card').textContent).toContain('org-1');
  });

  it('labels the confirm button with the catalogue entry', () => {
    useOrgStore.setState({ orgs: [createOrg()] });

    renderConfirmation();

    expect(screen.getByTestId('smart-action-confirm-btn').textContent).toBe(
      en.home.smartAction.confirm,
    );
  });

  it('reads in French under a French instance', async () => {
    useOrgStore.setState({ orgs: [createOrg()] });
    const instance: I18n = createInstance();
    await instance.use(initReactI18next).init({
      resources: { en: { translation: en }, fr: { translation: fr } },
      lng: 'fr',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });

    act(() => {
      render(
        <I18nextProvider i18n={instance}>
          <SmartActionCard
            recommendation={createRecommendation()}
            onExecute={vi.fn()}
            showConfirmation={true}
            onConfirm={vi.fn()}
            onCancel={vi.fn()}
          />
        </I18nextProvider>,
      );
    });

    const card = screen.getByTestId('smart-action-card');
    expect(card.textContent).toContain('Ouvrir');
    expect(card.textContent).toContain('Dev Sandbox');
  });
});
