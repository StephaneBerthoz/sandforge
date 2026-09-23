import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { OrgManagerPage } from './OrgManagerPage';

/**
 * JWT and device-flow sign-in from the Org Manager. The bridge hooks are
 * stood in for: the device sign-in is told apart from the other connect
 * requests by the longer wait it is created with.
 */

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: { orgId: string; status: string } | null;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
  requestId: string | null;
}

const idle = (): MutationState => ({
  mutate: vi.fn(),
  data: null,
  loading: false,
  error: null,
  reset: vi.fn(),
  requestId: null,
});

let connectState: MutationState = idle();
let deviceState: MutationState = idle();
const connectTimeouts: number[] = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { timeoutMs?: number }) => {
    if (type !== 'org:connect') return idle();
    connectTimeouts.push(options?.timeoutMs ?? 30_000);
    return (options?.timeoutMs ?? 0) > 180_000 ? deviceState : connectState;
  },
}));

const sent: Array<{ type: string; payload: unknown }> = [];
vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload: unknown) => {
    sent.push({ type, payload });
  },
}));

/** Deliver a message from the host, as the webview receives it. */
function fromHost(message: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

const DEVICE_CODE = {
  id: 'host-1',
  type: 'org:device-code',
  timestamp: 0,
  correlationId: 'req-device',
  payload: {
    userCode: 'AB12CD34',
    verificationUri: 'https://test.salesforce.com/setup/connect',
    expiresAt: Date.UTC(2026, 8, 23, 10, 10, 0),
  },
};

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

/** Open the device form, fill it and ask for a code; the device request is then in flight. */
function startDeviceSignIn(rerender: (ui: React.ReactElement) => void): void {
  fireEvent.click(screen.getByTestId('org-auth-oauth_device'));
  type('inline-alias-input', 'uat');
  type('inline-client-id-input', '3MVG9FakeConsumerKey.ForTests_Only');
  fireEvent.click(screen.getByTestId('org-inline-connect'));
  deviceState = { ...deviceState, loading: true, requestId: 'req-device' };
  rerender(<OrgManagerPage />);
}

beforeEach(() => {
  useOrgStore.setState({ orgs: [], selectedOrgId: null });
  connectState = idle();
  deviceState = idle();
  // As the real hook: a reset ends the request at once, in the same render
  // as whatever the page changed alongside it.
  deviceState.reset.mockImplementation(() => {
    deviceState = { ...deviceState, loading: false, error: null, data: null, requestId: null };
  });
  connectTimeouts.length = 0;
  sent.length = 0;
});

describe('signing in with JWT', () => {
  it('asks for the alias, username, consumer key and key file before it can connect', () => {
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-jwt'));

    const connect = screen.getByTestId('org-inline-connect') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    type('inline-alias-input', 'ci-sandbox');
    type('inline-username-input', 'integration@example.com');
    type('inline-client-id-input', '3MVG9FakeConsumerKey.ForTests_Only');
    expect(connect.disabled).toBe(true);
    type('inline-key-file-input', '/home/someone/keys/server.key');

    expect(connect.disabled).toBe(false);
  });

  it('sends the key file path, never its content, on the regular connect request', () => {
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-jwt'));
    fireEvent.change(screen.getByLabelText('Login URL'), {
      target: { value: 'https://test.salesforce.com' },
    });
    type('inline-alias-input', ' ci-sandbox ');
    type('inline-username-input', 'integration@example.com ');
    type('inline-client-id-input', ' 3MVG9FakeConsumerKey.ForTests_Only');
    type('inline-key-file-input', ' /home/someone/keys/server key.key ');
    fireEvent.click(screen.getByTestId('org-inline-connect'));

    expect(deviceState.mutate).not.toHaveBeenCalled();
    expect(connectState.mutate).toHaveBeenCalledWith({
      orgId: '',
      authMethod: 'jwt',
      alias: 'ci-sandbox',
      loginUrl: 'https://test.salesforce.com',
      username: 'integration@example.com',
      password: undefined,
      securityToken: undefined,
      clientId: '3MVG9FakeConsumerKey.ForTests_Only',
      jwtKeyFile: '/home/someone/keys/server key.key',
    });
  });

  it('tells the user, next to the field, that SandForge never opens the key file', () => {
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-jwt'));

    const keyFile = screen.getByLabelText('Private key file');
    const hint = document.getElementById(keyFile.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe(
      'Absolute path. The Salesforce CLI reads the key; SandForge never opens the file.',
    );
  });

  it('collapses once the org is connected', () => {
    const { rerender } = render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-jwt'));
    connectState = { ...connectState, loading: true, requestId: 'req-jwt' };
    rerender(<OrgManagerPage />);

    connectState = {
      ...connectState,
      loading: false,
      data: { orgId: '00D1', status: 'connected' },
    };
    rerender(<OrgManagerPage />);

    expect(screen.queryByTestId('org-inline-form')).toBeNull();
  });
});

describe('signing in with the device flow', () => {
  it('waits on a request of its own, longer than the ten minutes a code lasts', () => {
    render(<OrgManagerPage />);

    expect(Math.max(...connectTimeouts)).toBeGreaterThan(10 * 60_000);
  });

  it('asks for the consumer key of the user’s own app, then for a code', () => {
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-oauth_device'));

    const start = screen.getByTestId('org-inline-connect') as HTMLButtonElement;
    expect(start.textContent).toBe('Get a code');
    expect(
      screen.getByText(/Salesforce blocks this flow for the Salesforce CLI's own app/),
    ).toBeDefined();
    type('inline-alias-input', 'uat');
    expect(start.disabled).toBe(true);
    type('inline-client-id-input', '3MVG9FakeConsumerKey.ForTests_Only');
    fireEvent.click(start);

    expect(connectState.mutate).not.toHaveBeenCalled();
    expect(deviceState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: '',
        authMethod: 'oauth_device',
        alias: 'uat',
        loginUrl: 'https://login.salesforce.com',
        clientId: '3MVG9FakeConsumerKey.ForTests_Only',
        jwtKeyFile: undefined,
      }),
    );
  });

  it('shows the code and its page in place of the form once the host sends them', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);

    fromHost(DEVICE_CODE);

    expect(screen.getByTestId('org-device-user-code').textContent).toBe('AB12CD34');
    expect(
      screen.getByRole('link', { name: 'https://test.salesforce.com/setup/connect' }),
    ).toBeDefined();
    expect(screen.queryByTestId('inline-client-id-input')).toBeNull();
  });

  it('ignores a code sent for another request', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);

    fromHost({ ...DEVICE_CODE, correlationId: 'req-other-panel' });

    expect(screen.queryByTestId('org-device-code')).toBeNull();
    expect(screen.getByTestId('inline-client-id-input')).toBeDefined();
  });

  it('cancels the sign-in it started and gives the filled form back', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);
    fromHost(DEVICE_CODE);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' }));

    expect(sent).toEqual([{ type: 'org:connect:cancel', payload: { requestId: 'req-device' } }]);
    expect(deviceState.reset).toHaveBeenCalled();
    expect(screen.queryByTestId('org-device-code')).toBeNull();
    expect((screen.getByTestId('inline-client-id-input') as HTMLInputElement).value).toBe(
      '3MVG9FakeConsumerKey.ForTests_Only',
    );
    // Focus comes back to the button that starts a new attempt.
    expect(document.activeElement).toBe(screen.getByTestId('org-inline-connect'));
  });

  it('cancels a sign-in still waiting when its panel is closed', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);
    fromHost(DEVICE_CODE);

    fireEvent.click(
      within(screen.getByTestId('org-inline-form')).getByRole('button', { name: 'Close' }),
    );

    expect(sent).toEqual([{ type: 'org:connect:cancel', payload: { requestId: 'req-device' } }]);
    expect(screen.queryByTestId('org-inline-form')).toBeNull();
  });

  it('collapses once the org is connected', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);
    fromHost(DEVICE_CODE);

    deviceState = {
      ...deviceState,
      loading: false,
      data: { orgId: '00D000000000001AAA', status: 'connected' },
    };
    rerender(<OrgManagerPage />);

    expect(screen.queryByTestId('org-inline-form')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('says why when the sign-in fails after the code was shown, and offers the form again', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);
    fromHost(DEVICE_CODE);

    deviceState = {
      ...deviceState,
      loading: false,
      error: 'The code expired before it was approved. Start the sign-in again for a new one.',
    };
    rerender(<OrgManagerPage />);

    expect(screen.getByTestId('org-connect-error').textContent).toContain(
      'The code expired before it was approved.',
    );
    expect(screen.queryByTestId('org-device-code')).toBeNull();
    expect((screen.getByTestId('inline-alias-input') as HTMLInputElement).value).toBe('uat');
  });

  it('keeps the empty state, not a loading spinner, while the code waits for approval', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);
    fromHost(DEVICE_CODE);

    expect(screen.queryByTestId('org-list-loading')).toBeNull();
    expect(screen.getByText('No organizations connected')).toBeDefined();
  });

  it('stops a device sign-in still waiting when an import is started from the empty state', () => {
    const { rerender } = render(<OrgManagerPage />);
    startDeviceSignIn(rerender);
    fromHost(DEVICE_CODE);

    // The banner's own import button is disabled while a sign-in runs; the
    // empty state's is not.
    const importButtons = screen.getAllByRole('button', { name: 'Import from SF CLI' });
    const enabled = importButtons.filter((button) => !(button as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(1);
    fireEvent.click(enabled[0]);

    expect(sent).toEqual([{ type: 'org:connect:cancel', payload: { requestId: 'req-device' } }]);
    expect(connectState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: 'sfdx_import' }),
    );
  });

  it('clears an earlier failure of the other request when a new sign-in starts', () => {
    connectState = { ...connectState, error: 'JWT sign-in failed earlier' };
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-oauth_device'));
    type('inline-alias-input', 'uat');
    type('inline-client-id-input', '3MVG9FakeConsumerKey.ForTests_Only');

    fireEvent.click(screen.getByTestId('org-inline-connect'));

    expect(connectState.reset).toHaveBeenCalled();
    expect(deviceState.mutate).toHaveBeenCalled();
  });
});
