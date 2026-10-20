import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { OrgManagerPage } from './OrgManagerPage';

/**
 * The Organizations page for someone connecting a first org: what it says
 * before a click about the Salesforce CLI, what an import that finds nothing
 * leads to, what the first connection is followed by, and what the launcher's
 * first card opens it on.
 */

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: { orgId: string; status: string } | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  reset: ReturnType<typeof vi.fn>;
  requestId: string | null;
}

const idle = (): MutationState => ({
  mutate: vi.fn(),
  data: null,
  loading: false,
  error: null,
  errorCode: null,
  reset: vi.fn(),
  requestId: null,
});

let connectState: MutationState = idle();
let cliStatus: { available: boolean; orgCount: number } | null = null;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data: type === 'org:cli-status' ? cliStatus : null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { timeoutMs?: number }) =>
    type === 'org:connect' && (options?.timeoutMs ?? 0) <= 180_000 ? connectState : idle(),
}));

vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: vi.fn(),
}));

const devEdition: SalesforceOrg = {
  id: 'org-de',
  alias: 'my-dev-org',
  username: 'trailblazer@example.com',
  instanceUrl: 'https://example-dev-ed.my.salesforce.com',
  orgId: 'org-de',
  orgType: 'Developer',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
  status: 'connected',
  lastConnected: '2026-10-20T00:00:00Z',
  tags: [],
};

beforeEach(() => {
  useOrgStore.setState({ orgs: [], selectedOrgId: null });
  useAppStore.setState({ navigationIntent: null, currentRoute: 'orgs' });
  connectState = idle();
  cliStatus = null;
});

describe('the Salesforce CLI, said before a click', () => {
  it('says the CLI does not answer as the page opens, with where to get it', () => {
    cliStatus = { available: false, orgCount: 0 };
    render(<OrgManagerPage />);

    const notice = screen.getByTestId('org-cli-missing');
    expect(notice.textContent).toContain('The Salesforce CLI (sf) does not answer');
    expect(notice.querySelector('a')?.getAttribute('href')).toContain('salesforcecli');
  });

  it('offers the browser sign-in, not an import, when the CLI holds no org', () => {
    cliStatus = { available: true, orgCount: 0 };
    render(<OrgManagerPage />);

    expect(screen.getByTestId('org-cli-empty').textContent).toContain('OAuth (Web)');
    fireEvent.click(screen.getByTestId('empty-action-button'));

    expect(connectState.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-inline-form')).toBeDefined();
    expect(screen.getByTestId('org-inline-connect').textContent).toBe('Open Browser');
  });

  it('says nothing about the CLI while it answers and holds orgs', () => {
    cliStatus = { available: true, orgCount: 3 };
    render(<OrgManagerPage />);

    expect(screen.queryByTestId('org-cli-missing')).toBeNull();
    expect(screen.queryByTestId('org-cli-empty')).toBeNull();
  });
});

describe('an import that finds no org in the CLI', () => {
  it('opens the browser sign-in and says why, in place of a terminal command', () => {
    connectState = {
      ...idle(),
      error: 'The Salesforce CLI holds no connected org yet. Sign in with OAuth (Web)…',
      errorCode: 'NO_CLI_ORGS',
    };
    render(<OrgManagerPage />);

    expect(screen.getByTestId('org-inline-form')).toBeDefined();
    expect(screen.getByTestId('org-connect-error').textContent).toContain(
      'The Salesforce CLI holds no org yet. Sign in with OAuth (Web)',
    );
    expect(screen.getByTestId('org-connect-error').textContent).not.toContain('sf org login');
  });
});

describe('the browser sign-in', () => {
  it('starts with no alias typed: the CLI names the org after its username', () => {
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-oauth_web'));

    const connect = screen.getByTestId('org-inline-connect') as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);

    expect(connectState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: 'oauth_web', alias: '' }),
    );
  });
});

describe('after the first org is connected', () => {
  /** Connect from the browser form, then let the host answer with the org connected. */
  function connectFirstOrg(rerender: (ui: React.ReactElement) => void, org: SalesforceOrg): void {
    fireEvent.click(screen.getByTestId('org-auth-oauth_web'));
    fireEvent.click(screen.getByTestId('org-inline-connect'));
    connectState = { ...connectState, loading: true };
    rerender(<OrgManagerPage />);
    act(() => useOrgStore.setState({ orgs: [org] }));
    connectState = {
      ...connectState,
      loading: false,
      data: { orgId: org.id, status: 'connected' },
    };
    rerender(<OrgManagerPage />);
  }

  it('says it is connected and offers to fill it with demo data, or to clone into it', () => {
    const { rerender } = render(<OrgManagerPage />);
    connectFirstOrg(rerender, devEdition);

    const card = screen.getByTestId('org-connected-next');
    expect(card.textContent).toContain('my-dev-org is connected');

    fireEvent.click(screen.getByTestId('org-connected-next-fill'));
    expect(useAppStore.getState().currentRoute).toBe('seed');
    expect(useAppStore.getState().navigationIntent).toMatchObject({
      seedMode: 'quick-seed',
      targetOrgId: 'org-de',
    });
  });

  it('offers no seed of a production org, only the clone', () => {
    const { rerender } = render(<OrgManagerPage />);
    connectFirstOrg(rerender, {
      ...devEdition,
      orgType: 'Production',
      metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    });

    expect(screen.queryByTestId('org-connected-next-fill')).toBeNull();
    fireEvent.click(screen.getByTestId('org-connected-next-clone'));
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('shows nothing of the kind when an org was connected already', () => {
    useOrgStore.setState({ orgs: [devEdition] });
    const { rerender } = render(<OrgManagerPage />);
    connectFirstOrg(rerender, { ...devEdition, id: 'org-second', alias: 'second' });

    expect(screen.queryByTestId('org-connected-next')).toBeNull();
  });
});

describe('what the page is opened to start', () => {
  it('imports from the CLI when the launcher asks for it, once', () => {
    useAppStore.setState({ navigationIntent: { route: 'orgs', orgAction: 'import-cli' } });
    const { rerender } = render(<OrgManagerPage />);
    rerender(<OrgManagerPage />);

    expect(connectState.mutate).toHaveBeenCalledTimes(1);
    expect(connectState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: 'sfdx_import' }),
    );
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });

  it('opens the browser sign-in when the launcher asks for it', () => {
    render(<OrgManagerPage />);
    act(() => {
      useAppStore.setState({ navigationIntent: { route: 'orgs', orgAction: 'login-web' } });
    });

    expect(screen.getByTestId('org-inline-form')).toBeDefined();
    expect(connectState.mutate).not.toHaveBeenCalled();
  });

  it("runs an org's Reconnect when a run met its expired session", () => {
    useOrgStore.setState({ orgs: [{ ...devEdition, status: 'expired' }] });
    useAppStore.setState({ navigationIntent: { route: 'orgs', reconnectOrgId: 'org-de' } });
    render(<OrgManagerPage />);

    // A browser-login org reopens its form with the alias filled in.
    expect(screen.getByTestId('org-inline-form')).toBeDefined();
    expect((screen.getByTestId('inline-alias-input') as HTMLInputElement).value).toBe('my-dev-org');
  });
});
