import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OrgStatus, SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { orgTypeLabel } from '../../utils/orgFormatters';
import { OrgBadge } from './OrgBadge';

/** A sandbox as the store holds it, with what a test changes. */
function org(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'my-sandbox',
    username: 'admin@example.test',
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000001AAA',
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

const typeText = (): string | null => screen.getByTestId('org-badge-type').textContent;
const typeClass = (): string => screen.getByTestId('org-badge-type').className;

describe('OrgBadge', () => {
  it('should render with data-testid on root', () => {
    render(<OrgBadge org={org()} />);
    expect(screen.getByTestId('org-badge')).toBeDefined();
  });

  it('should display the alias text', () => {
    render(<OrgBadge org={org()} />);
    expect(screen.getByTestId('org-badge-alias').textContent).toBe('my-sandbox');
  });

  it('names an org with no alias by its username', () => {
    render(<OrgBadge org={org({ alias: '' })} />);
    expect(screen.getByTestId('org-badge-alias').textContent).toBe('admin@example.test');
  });

  it('writes the type the side panel and the pickers write, not an English abbreviation', () => {
    // It wrote SBX, PROD, SCR and DEV whatever the language, while every other
    // screen named the same org by its catalogue label.
    render(<OrgBadge org={org()} />);
    expect(typeText()).toBe('SANDBOX');
    cleanup();
    render(<OrgBadge org={org({ orgType: 'Production' })} />);
    expect(typeText()).toBe('PROD');
    cleanup();
    render(<OrgBadge org={org({ orgType: 'Scratch' })} />);
    expect(typeText()).toBe('SCRATCH');
    cleanup();
    render(<OrgBadge org={org({ orgType: 'Developer' })} />);
    expect(typeText()).toBe('DEVELOPER');
  });

  it('gives the kind of sandbox and the environment tag the other screens give', () => {
    for (const shown of [
      org({ sandboxType: 'Full' }),
      org({ sandboxType: 'DeveloperPro' }),
      org({ tags: ['uat'] }),
    ]) {
      render(<OrgBadge org={shown} />);
      expect(typeText()).toBe(orgTypeLabel(shown, i18n.t));
      cleanup();
    }
    render(<OrgBadge org={org({ tags: ['uat'] })} />);
    expect(typeText()).toBe('UAT');
  });

  it('never calls a Developer Edition org an earlier build registered as production PROD, nor colours it so', () => {
    const playground = org({
      orgType: 'Production',
      metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
    });
    render(<OrgBadge org={playground} />);
    expect(typeText()).toBe('DEVELOPER');
    expect(typeClass()).toContain('bg-status-info');
    expect(typeClass()).not.toContain('bg-status-error');
  });

  it('says Staging of a sandbox marked so, which Production Guard asks about, and of no other org', () => {
    render(<OrgBadge org={org({ staging: true })} />);
    expect(typeText()).toBe('STAGING');
    expect(typeClass()).toContain('bg-status-warning');
    cleanup();
    render(<OrgBadge org={org({ orgType: 'Production', staging: true })} />);
    expect(typeText()).toBe('PROD');
    expect(typeClass()).toContain('bg-status-error');
  });

  it('keeps the type on one line', () => {
    render(<OrgBadge org={org({ sandboxType: 'DeveloperPro' })} />);
    expect(typeText()).toBe('DEV PRO');
    expect(typeClass()).toContain('whitespace-nowrap');
  });

  it('names the status dot as an image, the role that lets its label be read', () => {
    render(<OrgBadge org={org()} />);
    const name = i18n.t('a11y.orgStatus', { status: i18n.t('common.orgStatus_connected') });
    expect(screen.getByRole('img', { name })).toBe(screen.getByTestId('org-badge-status-dot'));
  });

  it('should apply connected status color on dot', () => {
    render(<OrgBadge org={org({ status: 'connected' })} />);
    expect(screen.getByTestId('org-badge-status-dot').className).toContain('bg-(--sf-success)');
  });

  it('should apply expired status color on dot', () => {
    render(<OrgBadge org={org({ status: 'expired' })} />);
    expect(screen.getByTestId('org-badge-status-dot').className).toContain('bg-(--sf-warning)');
  });

  it('should apply error status color on dot', () => {
    render(<OrgBadge org={org({ status: 'error' })} />);
    expect(screen.getByTestId('org-badge-status-dot').className).toContain('bg-(--sf-error)');
  });

  it('should render truncated instanceUrl when provided', () => {
    render(<OrgBadge org={org({ instanceUrl: 'https://my-sandbox.salesforce.com/' })} />);
    expect(screen.getByTestId('org-badge-url').textContent).toBe('my-sandbox.salesforce.com');
  });

  it('should not render URL element when the org has no instance URL', () => {
    render(<OrgBadge org={org({ instanceUrl: '' })} />);
    expect(screen.queryByTestId('org-badge-url')).toBeNull();
  });

  it('should merge custom className', () => {
    render(<OrgBadge org={org()} className="ml-4" />);
    expect(screen.getByTestId('org-badge').className).toContain('ml-4');
  });

  it('should fallback to error color for unknown status', () => {
    render(<OrgBadge org={org({ status: 'unknown' as OrgStatus })} />);
    expect(screen.getByTestId('org-badge-status-dot').className).toContain('bg-(--sf-error)');
  });

  it('should have Production badge with error background', () => {
    render(<OrgBadge org={org({ orgType: 'Production' })} />);
    expect(typeClass()).toContain('bg-status-error');
  });

  it('should have Sandbox badge with info background', () => {
    render(<OrgBadge org={org()} />);
    expect(typeClass()).toContain('bg-status-info');
  });

  it('should have Scratch badge with success background', () => {
    render(<OrgBadge org={org({ orgType: 'Scratch' })} />);
    expect(typeClass()).toContain('bg-status-success');
  });

  it('reads a status it has no word for as the host wrote it', () => {
    render(<OrgBadge org={org({ status: 'unknown' as OrgStatus })} />);
    expect(screen.getByTestId('org-badge-status-dot').getAttribute('aria-label')).toBe(
      i18n.t('a11y.orgStatus', { status: 'unknown' }),
    );
  });

  describe('in another language', () => {
    afterEach(async () => {
      await i18n.changeLanguage('en');
    });

    it('names its status in the language the panel is set to', async () => {
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await i18n.changeLanguage('fr');
      render(<OrgBadge org={org()} />);
      expect(screen.getByTestId('org-badge-status-dot').getAttribute('aria-label')).toBe(
        fr.a11y.orgStatus.replace('{{status}}', fr.common.orgStatus_connected),
      );
    });

    it('names its type in the language the panel is set to', async () => {
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await i18n.changeLanguage('fr');
      render(<OrgBadge org={org({ sandboxType: 'Full' })} />);
      expect(typeText()).toBe(fr.common.orgType.full);
      cleanup();
      render(<OrgBadge org={org({ staging: true })} />);
      expect(typeText()).toBe(fr.common.orgType.staging);
    });
  });
});
