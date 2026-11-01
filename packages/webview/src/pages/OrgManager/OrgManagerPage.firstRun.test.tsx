import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
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

    expect(screen.getByTestId('org-cli-empty').textContent).toContain('Log in with your browser');
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Log in with your browser');
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
  /** As the request hook words the host's English by its code. */
  const noCliOrgs = (): MutationState => ({
    ...idle(),
    error:
      'The Salesforce CLI holds no org yet. Log in with your browser instead: it opens the Salesforce login page.',
    errorCode: 'NO_CLI_ORGS',
  });

  it('opens the browser sign-in and says why, in place of a terminal command', () => {
    connectState = noCliOrgs();
    render(<OrgManagerPage />);

    expect(screen.getByTestId('org-inline-form')).toBeDefined();
    const notice = screen.getByTestId('org-cli-empty');
    expect(notice.textContent).toBe(
      'The Salesforce CLI holds no org yet. Log in with your browser instead: it opens the Salesforce login page.',
    );
    expect(notice.textContent).not.toContain('sf org login');
  });

  it('says it as information, not as a red connection error', () => {
    // A CLI with no org yet is how a first run starts: it read "Connection
    // error —" in red, and the neutral line was hidden exactly then.
    connectState = noCliOrgs();
    render(<OrgManagerPage />);

    expect(screen.queryByTestId('org-connect-error')).toBeNull();
    expect(screen.queryByText('Connection error')).toBeNull();
    const notice = screen.getByTestId('org-cli-empty');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.className).not.toContain('text-status-error');
  });

  it('says it when orgs are connected already, which the CLI-status line does not', () => {
    useOrgStore.setState({ orgs: [devEdition] });
    connectState = noCliOrgs();
    render(<OrgManagerPage />);
    expect(screen.getByTestId('org-cli-empty')).toBeDefined();
  });
});

describe('the two ways to connect, by one name each', () => {
  it('names the import and the browser login as the side panel and Home do, OAuth in the tooltip', () => {
    render(<OrgManagerPage />);
    const importButton = screen.getByTestId('org-auth-sfdx_import');
    const loginButton = screen.getByTestId('org-auth-oauth_web');
    expect(importButton.textContent).toBe('Import from Salesforce CLI');
    expect(loginButton.textContent).toBe('Log in with your browser');
    expect(loginButton.getAttribute('title')).toContain('OAuth');
    expect(screen.queryByText('OAuth (Web)')).toBeNull();
    expect(screen.queryByText('Import from SF CLI')).toBeNull();
  });
});

describe('a login URL on a My Domain', () => {
  /** Open the browser sign-in and choose a custom domain. */
  function chooseMyDomain(): HTMLInputElement {
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-oauth_web'));
    fireEvent.change(screen.getByTestId('inline-login-url-select'), {
      target: { value: 'custom' },
    });
    return screen.getByTestId('inline-my-domain-input') as HTMLInputElement;
  }

  it('offers a My Domain beside the two Salesforce login hosts', () => {
    // An org that blocks login.salesforce.com and test.salesforce.com could
    // not be connected from the page, though the host accepts its My Domain.
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-oauth_web'));
    const options = [
      ...(screen.getByTestId('inline-login-url-select') as HTMLSelectElement).options,
    ].map((option) => option.textContent);
    expect(options).toEqual(['Production / Developer', 'Sandbox', 'Custom domain (My Domain)…']);
    expect(screen.queryByTestId('inline-my-domain-input')).toBeNull();
  });

  it('sends the My Domain typed in, reduced to its origin', () => {
    const input = chooseMyDomain();
    fireEvent.change(input, {
      target: { value: ' https://Acme--UAT.sandbox.my.salesforce.com/ ' },
    });
    fireEvent.click(screen.getByTestId('org-inline-connect'));

    expect(connectState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        authMethod: 'oauth_web',
        loginUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      }),
    );
  });

  it.each([
    ['a host outside Salesforce', 'https://login.example.com', 'Not a Salesforce login domain'],
    ['a plain http address', 'http://acme.my.salesforce.com', 'must start with https://'],
    ['a path after the domain', 'https://acme.my.salesforce.com/home', 'Give the domain alone'],
    ['no address at all', 'acme', 'This is not a web address.'],
  ])('refuses %s in the field, with why, and sends nothing', (_label, value, reason) => {
    const input = chooseMyDomain();
    fireEvent.change(input, { target: { value } });

    expect(screen.getByText(new RegExp(reason))).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const connect = screen.getByTestId('org-inline-connect') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.click(connect);
    expect(connectState.mutate).not.toHaveBeenCalled();
  });

  it('starts nothing while the field is empty, and says nothing against it yet', () => {
    const input = chooseMyDomain();
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect((screen.getByTestId('org-inline-connect') as HTMLButtonElement).disabled).toBe(true);
  });

  it('serves every method that asks for a login URL', () => {
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-usernamePassword'));
    fireEvent.change(screen.getByTestId('inline-login-url-select'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByTestId('inline-my-domain-input'), {
      target: { value: 'https://acme.my.salesforce.com' },
    });
    fireEvent.change(screen.getByTestId('inline-alias-input'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByTestId('inline-username-input'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.change(screen.getByTestId('inline-password-input'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('org-inline-connect'));

    expect(connectState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        authMethod: 'usernamePassword',
        loginUrl: 'https://acme.my.salesforce.com',
      }),
    );
  });
});

describe('a connection the org refuses for its API', () => {
  it('says the org’s edition has no API, and what to connect instead', () => {
    // Professional and Essentials editions without the API add-on answer the
    // first call with API_DISABLED_FOR_ORG: the banner said the code alone.
    connectState = {
      ...idle(),
      error:
        'Connection failed for "Dev": API_DISABLED_FOR_ORG: API is not enabled for this Organization or Partner',
      errorCode: 'AUTH_FAILED',
    };
    render(<OrgManagerPage />);

    const banner = screen.getByTestId('org-connect-error');
    expect(within(banner).getByTestId('error-hint').textContent).toContain(
      'Connect an org whose edition includes the API',
    );
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
