import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import '../../i18n';
import de from '../../i18n/locales/de.json';
import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';
import fr from '../../i18n/locales/fr.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
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

  it('says an empty org is empty, whatever its kind: a Developer Edition is no sandbox', () => {
    useOrgStore.setState({ orgs: [createOrg({ orgType: 'Developer' })] });
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('smart-action-card').textContent).toContain(
      'Your org is empty — fill it with demo data',
    );
    for (const locale of [en, fr, de, es, ptBR, ja]) {
      expect(locale.home.smartAction.reasonEmpty).not.toMatch(/sandbox/i);
    }
  });

  it('should return null when action is none', () => {
    const { container } = render(
      <SmartActionCard
        recommendation={createRecommendation({ action: 'none', reasonKey: '' })}
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
        recommendation={createRecommendation({ action: 'clone' })}
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
        recommendation={createRecommendation({ action: 'sync' })}
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
 * One act, filling an org with demo data, read "Set it up", then "Open Quick
 * Seed for <org>?": the side panel, Organizations and Home's Quick actions say
 * "Fill <org> with demo data" and open Seed's gallery at once.
 */
describe('SmartActionCard names a fill as every other surface does', () => {
  afterEach(() => {
    useOrgStore.setState({ orgs: [] });
  });

  it('labels the fill with the org, and opens the gallery on the click, without a second question', () => {
    useOrgStore.setState({ orgs: [createOrg()] });
    const onConfirm = vi.fn();
    const onExecute = vi.fn();
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={onExecute}
        showConfirmation={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const button = screen.getByTestId('smart-action-execute-btn');
    expect(button.textContent).toBe('Fill Dev Sandbox with demo data');
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.queryByText(/Quick Seed/)).toBeNull();
  });

  it('keeps "Set it up" and its question for a clone, which opens a wizard on two orgs', () => {
    render(
      <SmartActionCard
        recommendation={createRecommendation({ action: 'clone' })}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('smart-action-execute-btn').textContent).toBe('Set it up');
  });
});

/*
 * The card showed "90% confidence", a fixed number per rule, and a tooltip in
 * English in every language, repeating the line under it.
 */
describe('SmartActionCard says why from what it counted', () => {
  afterEach(() => {
    useOrgStore.setState({ orgs: [] });
  });

  /** Hover the "Why?" button and read the tooltip it shows. */
  async function readWhy(): Promise<string> {
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(screen.getByTestId('smart-action-why-btn'));
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      return screen.getByRole('tooltip').textContent ?? '';
    } finally {
      vi.useRealTimers();
    }
  }

  it('shows no confidence score', () => {
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('smart-action-card').textContent).not.toMatch(/confidence|%/);
  });

  it('lists each object counted in the org, and says sample data is under the ceiling', async () => {
    useOrgStore.setState({ orgs: [createOrg()] });
    render(
      <SmartActionCard
        recommendation={createRecommendation({
          reasonKey: 'home.smartAction.reasonSampleOnly',
          details: {
            targetOrgId: 'org-1',
            recordCounts: { Account: 13, Contact: 1, Opportunity: 31, Case: 0, Lead: 22 },
          },
        })}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(await readWhy()).toBe(
      'Dev Sandbox: 13 accounts, 1 contact, 31 opportunities, 0 cases, 22 leads, fewer than 50 of each',
    );
  });

  it('names both orgs a clone was read from, the source with the counts that make it one', async () => {
    useOrgStore.setState({
      orgs: [createOrg(), createOrg({ id: 'org-2', alias: 'UAT' })],
    });
    render(
      <SmartActionCard
        recommendation={createRecommendation({
          action: 'clone',
          reasonKey: 'home.smartAction.reasonClone',
          details: {
            targetOrgId: 'org-1',
            sourceOrgId: 'org-2',
            recordCounts: { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 },
            sourceRecordCounts: {
              Account: 900,
              Contact: 2000,
              Opportunity: 400,
              Case: 300,
              Lead: 120,
            },
          },
        })}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((await readWhy()).split('\n')).toEqual([
      'Dev Sandbox: 0 accounts, 0 contacts, 0 opportunities, 0 cases, 0 leads',
      'UAT: 900 accounts, 2000 contacts, 400 opportunities, 300 cases, 120 leads',
    ]);
  });

  it('says it in the panel’s language', async () => {
    useOrgStore.setState({ orgs: [createOrg()] });
    // Handed to the card through the provider alone: `initReactI18next` would
    // make it every later render's instance, in French.
    const instance: I18n = createInstance();
    await instance.init({
      resources: { en: { translation: en }, fr: { translation: fr } },
      lng: 'fr',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
    act(() => {
      render(
        <I18nextProvider i18n={instance}>
          <SmartActionCard
            recommendation={createRecommendation({
              details: {
                targetOrgId: 'org-1',
                recordCounts: { Account: 1, Contact: 2, Opportunity: 0, Case: 3, Lead: 4 },
              },
            })}
            onExecute={vi.fn()}
            showConfirmation={false}
            onConfirm={vi.fn()}
            onCancel={vi.fn()}
          />
        </I18nextProvider>,
      );
    });

    expect(await readWhy()).toBe(
      'Dev Sandbox : 1 compte, 2 contacts, 0 opportunité, 3 requêtes, 4 pistes, moins de 50 de chaque',
    );
    expect(screen.getByTestId('smart-action-execute-btn').textContent).toBe(
      'Remplir Dev Sandbox de données de démonstration',
    );
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
        recommendation={createRecommendation({ action: 'clone' })}
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
            recommendation={createRecommendation({ action: 'clone' })}
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
