import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useOrgStore } from '../../stores/useOrgStore';
import { SandboxBanner } from './SandboxBanner';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

/* In-memory mock of the webview state persistence layer. */
const mockPersistedState = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    store,
    reset(): void {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
  };
});

vi.mock('../../utils/webviewStorage', () => ({
  getPersistedItem: (key: string): string | null => mockPersistedState.store[key] ?? null,
  setPersistedItem: (key: string, value: string): void => {
    mockPersistedState.store[key] = value;
  },
  removePersistedItem: (key: string): void => {
    delete mockPersistedState.store[key];
  },
}));

function createSandboxOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'admin@dev.sandbox',
    instanceUrl: 'https://dev-sandbox.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#3B82F6', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('SandboxBanner', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    useOrgStore.setState({ orgs: [] });
    onNavigate.mockClear();
    mockPersistedState.reset();
  });

  it('should not render when no sandbox orgs', () => {
    useOrgStore.setState({ orgs: [createSandboxOrg({ orgType: 'Production' })] });
    const { container } = render(<SandboxBanner onNavigate={onNavigate} />);
    expect(container.innerHTML).toBe('');
  });

  it('should render when sandbox org exists', () => {
    useOrgStore.setState({ orgs: [createSandboxOrg()] });
    render(<SandboxBanner onNavigate={onNavigate} />);
    expect(screen.getByTestId('sandbox-banner')).toBeDefined();
    expect(screen.getByText('onboarding.sandboxBanner')).toBeDefined();
  });

  it('should call onNavigate with seed when seed button clicked', () => {
    useOrgStore.setState({ orgs: [createSandboxOrg()] });
    render(<SandboxBanner onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('sandbox-banner-seed-btn'));
    expect(onNavigate).toHaveBeenCalledWith('seed');
  });

  it('should call onNavigate with sync when sync button clicked', () => {
    useOrgStore.setState({ orgs: [createSandboxOrg()] });
    render(<SandboxBanner onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('sandbox-banner-sync-btn'));
    expect(onNavigate).toHaveBeenCalledWith('sync');
  });

  it('should dismiss and persist to the webview state', () => {
    useOrgStore.setState({ orgs: [createSandboxOrg()] });
    render(<SandboxBanner onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('sandbox-banner-dismiss'));
    expect(screen.queryByTestId('sandbox-banner')).toBeNull();
    expect(mockPersistedState.store['sandforge-sandbox-banner-dismissed']).toBe('true');
  });

  it('should not render when previously dismissed', () => {
    mockPersistedState.store['sandforge-sandbox-banner-dismissed'] = 'true';
    useOrgStore.setState({ orgs: [createSandboxOrg()] });
    const { container } = render(<SandboxBanner onNavigate={onNavigate} />);
    expect(container.querySelector('[data-testid="sandbox-banner"]')).toBeNull();
  });
});
