import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useOrgStore } from '../../stores/useOrgStore';
import { SandboxBanner } from './SandboxBanner';
import type { SalesforceOrg } from '@sandforge/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => { store[key] = value; },
    removeItem: (key: string): void => { delete store[key]; },
    reset: (): void => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

function createSandboxOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'admin@dev.sandbox',
    instanceUrl: 'https://dev-sandbox.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth',
    safetyTier: 'low',
    appearance: { color: '#3B82F6', icon: 'cloud' },
    status: 'connected',
    ...overrides,
  };
}

describe('SandboxBanner', () => {
  const onNavigate = vi.fn();

  beforeEach(() => {
    useOrgStore.setState({ orgs: [] });
    onNavigate.mockClear();
    localStorageMock.reset();
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

  it('should dismiss and persist to localStorage', () => {
    useOrgStore.setState({ orgs: [createSandboxOrg()] });
    render(<SandboxBanner onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('sandbox-banner-dismiss'));
    expect(screen.queryByTestId('sandbox-banner')).toBeNull();
    expect(localStorageMock.getItem('sandforge-sandbox-banner-dismissed')).toBe('true');
  });

  it('should not render when previously dismissed', () => {
    localStorageMock.setItem('sandforge-sandbox-banner-dismissed', 'true');
    useOrgStore.setState({ orgs: [createSandboxOrg()] });
    const { container } = render(<SandboxBanner onNavigate={onNavigate} />);
    expect(container.querySelector('[data-testid="sandbox-banner"]')).toBeNull();
  });
});
