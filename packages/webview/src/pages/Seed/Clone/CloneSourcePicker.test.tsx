import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../../i18n';
import en from '../../../i18n/locales/en.json';
import fr from '../../../i18n/locales/fr.json';
import de from '../../../i18n/locales/de.json';
import es from '../../../i18n/locales/es.json';
import ptBR from '../../../i18n/locales/pt-BR.json';
import ja from '../../../i18n/locales/ja.json';
import { CloneSourcePicker } from './CloneSourcePicker';
import type { CloneSourcePickerProps } from './CloneSourcePicker';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-source',
    alias: 'source-dev',
    username: 'user@source.com',
    instanceUrl: 'https://source.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-target',
    alias: 'target-dev',
    username: 'user@target.com',
    instanceUrl: 'https://target.salesforce.com',
    orgId: '00D000000000002',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-other',
    alias: 'other-dev',
    username: 'user@other.com',
    instanceUrl: 'https://other.salesforce.com',
    orgId: '00D000000000003',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 2 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

/** The picker with the orgs above, the target org-target and no source yet. */
function renderPicker(props: Partial<CloneSourcePickerProps> = {}): void {
  render(
    <CloneSourcePicker
      sourceOrgId=""
      targetOrgId="org-target"
      orgs={mockOrgs}
      onSourceSelected={vi.fn()}
      onTargetSelected={vi.fn()}
      {...props}
    />,
  );
}

/** The values a select offers, its placeholder left out. */
function offered(testId: string): string[] {
  const select = screen.getByTestId(testId) as HTMLSelectElement;
  return Array.from(select.querySelectorAll('option'))
    .map((option) => option.value)
    .filter((value) => value !== '');
}

describe('CloneSourcePicker', () => {
  it('should render source and target columns', () => {
    renderPicker();

    expect(screen.getByTestId('clone-source-picker')).toBeDefined();
    expect(screen.getByTestId('clone-source-column')).toBeDefined();
    expect(screen.getByTestId('clone-target-column')).toBeDefined();
    expect(screen.getByTestId('clone-direction-arrow')).toBeDefined();
  });

  it('gives the direction arrow as an image, which its label may name', () => {
    // A label on a bare div is prohibited: axe refused this step for it.
    renderPicker();

    expect(screen.getByRole('img', { name: en.seed.clone.sourcePicker.direction })).toBe(
      screen.getByTestId('clone-direction-arrow'),
    );
  });

  it('should exclude target org from source select options', () => {
    renderPicker();

    expect(offered('clone-source-select')).toEqual(['org-source', 'org-other']);
  });

  it('names each org as every other picker does, with the type its badge gives', () => {
    // It read "source-dev (sandbox)", in English whatever the language, while
    // Sync, Quick Sync and Seed's other flows read "source-dev [SANDBOX]"; and
    // a production org was "(production)" beside the badge's PROD.
    const orgs: SalesforceOrg[] = [
      ...mockOrgs,
      {
        ...mockOrgs[2],
        id: 'org-prod',
        alias: 'live',
        orgType: 'Production',
        metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
      },
      { ...mockOrgs[2], id: 'org-scratch', alias: 'feature', orgType: 'Scratch' },
    ];
    renderPicker({ orgs });

    const select = screen.getByTestId('clone-source-select') as HTMLSelectElement;
    const labels = Array.from(select.querySelectorAll('option'))
      .filter((option) => option.value !== '')
      .map((option) => option.textContent);
    expect(labels).toEqual([
      `source-dev [${en.common.orgType.sandbox}]`,
      `other-dev [${en.common.orgType.sandbox}]`,
      `live [${en.common.orgType.prod}]`,
      `feature [${en.common.orgType.scratch}]`,
    ]);
  });

  it('should call onSourceSelected when selecting an org', () => {
    const onSourceSelected = vi.fn();
    renderPicker({ onSourceSelected });

    fireEvent.change(screen.getByTestId('clone-source-select'), {
      target: { value: 'org-source' },
    });

    expect(onSourceSelected).toHaveBeenCalledWith('org-source');
  });

  it('names the source column once, by its select’s label', () => {
    // "Source Org" was printed twice: a span above the select, and the
    // select's own label.
    renderPicker();

    const column = screen.getByTestId('clone-source-column');
    expect(within(column).getAllByText(en.seed.clone.sourcePicker.sourceLabel)).toHaveLength(1);
    expect(screen.getByLabelText(en.seed.clone.sourcePicker.sourceLabel)).toBe(
      screen.getByTestId('clone-source-select'),
    );
  });

  it('should show OrgBadge for selected source org', () => {
    renderPicker({ sourceOrgId: 'org-source' });

    // Both source and target columns should have org badges
    const badges = screen.getAllByTestId('org-badge');
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  describe('the target', () => {
    it('is picked in place, from every org but the source, with what it is for', () => {
      // It was shown read-only under a title that said to select it, and
      // with none selected the step sent the user to the Organizations page.
      renderPicker({ sourceOrgId: 'org-source' });

      const select = screen.getByLabelText(en.seed.clone.sourcePicker.targetLabel);
      expect(select).toBe(screen.getByTestId('clone-target-select'));
      expect((select as HTMLSelectElement).value).toBe('org-target');
      expect(offered('clone-target-select')).toEqual(['org-target', 'org-other']);
      const hint = document.getElementById(select.getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent).toBe(en.seed.clone.sourcePicker.targetHint);
    });

    it('says what the target is for without shouting, and in French with its accent', () => {
      // "Records will be cloned TO this org", "clones DANS cette org": capitals
      // in five languages, and the French without its accent.
      for (const [language, catalogue] of Object.entries({ en, fr, de, es, 'pt-BR': ptBR, ja })) {
        const hint = catalogue.seed.clone.sourcePicker.targetHint;
        expect(hint, language).not.toMatch(/\b[A-ZÀ-Ý]{2,}\b/);
      }
      expect(fr.seed.clone.sourcePicker.targetHint).toBe(
        'Les enregistrements sont clonés dans cette org',
      );
    });

    it('hands the org picked to the wizard', () => {
      const onTargetSelected = vi.fn();
      renderPicker({ onTargetSelected });

      fireEvent.change(screen.getByTestId('clone-target-select'), {
        target: { value: 'org-other' },
      });

      expect(onTargetSelected).toHaveBeenCalledWith('org-other');
    });

    it('shows the org selected as a badge', () => {
      renderPicker();

      const targetColumn = screen.getByTestId('clone-target-column');
      expect(within(targetColumn).getByTestId('org-badge')).toBeDefined();
    });

    it('offers a choice when no org is selected, and no way out of the wizard', () => {
      renderPicker({ targetOrgId: '' });

      const targetColumn = screen.getByTestId('clone-target-column');
      expect(targetColumn.querySelector('[data-testid="org-badge"]')).toBeNull();
      const select = screen.getByTestId('clone-target-select') as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(select.options[select.selectedIndex]?.textContent).toBe(
        en.seed.clone.sourcePicker.selectTarget,
      );
      expect(targetColumn.textContent).not.toContain('Organizations page');
    });
  });
});
