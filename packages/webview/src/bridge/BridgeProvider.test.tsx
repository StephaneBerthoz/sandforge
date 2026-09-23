import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, waitFor } from '@testing-library/react';
import { BridgeProvider } from './BridgeProvider';
import { sendBridgeMessage } from './sendBridgeMessage';
import { useBridgeMutation } from '../hooks/useBridgeMutation';
import { useOrgStore } from '../stores/useOrgStore';
import { useAppStore } from '../stores/useAppStore';
import { useNotificationStore } from '../stores/useNotificationStore';
import i18n, { changeLanguageLazy } from '../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { answerCapturedLocaleRequests } from '../i18n/testing/mockLocaleBridge';

const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  // Also consumed by the i18n module (language persistence boot + recovery).
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

function fireMessage(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

function createTestOrg(id: string): SalesforceOrg {
  return {
    id,
    alias: `org-${id}`,
    username: `user@${id}.test`,
    instanceUrl: `https://${id}.salesforce.com`,
    orgId: `00D${id}`,
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#00ff00', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: new Date().toISOString(),
    tags: [],
  };
}

describe('BridgeProvider', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [], selectedOrgId: null, isConnecting: false });
    useAppStore.setState({ extensionReady: false, isLoading: false });
    useNotificationStore.setState({ notifications: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send org:list and settings:get on mount', () => {
    render(
      <BridgeProvider>
        <div>child</div>
      </BridgeProvider>,
    );

    expect(mockPostMessage).toHaveBeenCalledTimes(3);
    // Outbound messages are enveloped — inspect envelope.payload.type.
    const calls = mockPostMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { payload: { type: string } }).payload.type,
    );
    expect(calls).toContain('org:list');
    expect(calls).toContain('settings:get');
    expect(calls).toContain('ai:status');
  });

  it('should update orgStore on org:list:response', () => {
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    const org = createTestOrg('1');
    fireMessage({
      id: 'ext-1',
      type: 'org:list:response',
      timestamp: Date.now(),
      payload: { orgs: [org] },
    });

    expect(useOrgStore.getState().orgs).toHaveLength(1);
    expect(useOrgStore.getState().orgs[0].id).toBe('1');
  });

  it('should update stores on state:sync', () => {
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-2',
      type: 'state:sync',
      timestamp: Date.now(),
      payload: {
        orgs: [createTestOrg('2')],
        extensionReady: true,
      },
    });

    expect(useOrgStore.getState().orgs).toHaveLength(1);
    expect(useAppStore.getState().extensionReady).toBe(true);
  });

  it('should add notification on notification message', () => {
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-3',
      type: 'notification',
      timestamp: Date.now(),
      payload: {
        level: 'info',
        title: 'Test',
        message: 'Hello',
      },
    });

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0].title).toBe('Test');
  });

  it('follows the visibility VS Code gives the panel', () => {
    useAppStore.setState({ panelVisible: true });
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-vis-1',
      type: 'panel:visibility',
      timestamp: Date.now(),
      payload: { visible: false },
    });
    expect(useAppStore.getState().panelVisible).toBe(false);

    fireMessage({
      id: 'ext-vis-2',
      type: 'panel:visibility',
      timestamp: Date.now(),
      payload: { visible: true },
    });
    expect(useAppStore.getState().panelVisible).toBe(true);
  });

  it('keeps the actions a host notification carries', () => {
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    const actions = [{ label: 'Install', command: 'install', url: 'https://example.com' }];
    fireMessage({
      id: 'ext-actions',
      type: 'notification',
      timestamp: Date.now(),
      payload: { level: 'error', title: 'CLI', message: 'Missing', actions },
    });

    expect(useNotificationStore.getState().notifications[0].actions).toEqual(actions);
  });

  it('should surface a bridge:error as an error notification', () => {
    // The broker drops the offending message, so nothing else will ever
    // report it — without this listener the sender just waits out a timeout.
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'bridge-err-1',
      type: 'bridge:error',
      timestamp: Date.now(),
      payload: { reason: 'invalid-payload', details: 'payload.orgId: Required' },
    });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe('error');
    expect(notifications[0].message).toBe(i18n.t('bridge.dropped.unreadable'));
  });

  it('tells a dropped request in the language of the page, not in the broker code', async () => {
    // The toast read "Bridge error" over "invalid-payload: payload: Expected
    // object", in English whatever the language picked.
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );
    const drop = (id: string, reason: string, details: string): void =>
      fireMessage({
        id,
        type: 'bridge:error',
        timestamp: Date.now(),
        payload: { reason, details },
      });

    drop('drop-1', 'invalid-payload', 'payload: Expected object');
    drop('drop-2', 'rate-limited', '"sync:run" was dropped');
    drop('drop-3', 'unhandled-type', 'no handler for "sync:new"');
    drop('drop-4', 'a-reason-from-a-later-broker', 'details');

    const told = useNotificationStore
      .getState()
      .notifications.map((n) => [n.title, n.message])
      .reverse();
    expect(told).toEqual([
      ['Request dropped', i18n.t('bridge.dropped.unreadable')],
      ['Request dropped', i18n.t('bridge.dropped.rateLimited')],
      ['Request dropped', i18n.t('bridge.dropped.unhandled')],
      ['Request dropped', i18n.t('bridge.dropped.other')],
    ]);
    expect(new Set(told.map(([, message]) => message)).size).toBe(4);
    for (const [, message] of told) {
      expect(message).not.toMatch(/invalid-payload|rate-limited|unhandled-type|Expected|"sync:/);
    }

    // French is a lazy locale: its bundle crosses the (mocked) bridge first.
    const switched = changeLanguageLazy('fr');
    await act(async () => {
      await answerCapturedLocaleRequests(mockPostMessage);
      expect(await switched).toBe(true);
    });
    drop('drop-5', 'invalid-payload', 'payload: Expected object');
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      title: 'Requête abandonnée',
      message: expect.stringContaining('canal de sortie'),
    });

    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('leaves a bridge:error that answers a request to the panel that made it', () => {
    // bridge:error reaches every open panel. A refusal carrying a
    // correlationId the panel never sent belongs to another panel, so it
    // raises nothing here; the panel that sent it raises it once.
    render(
      <>
        <BridgeProvider>
          <div />
        </BridgeProvider>
        <BridgeProvider>
          <div />
        </BridgeProvider>
      </>,
    );

    fireMessage({
      id: 'bridge-err-correlated',
      type: 'bridge:error',
      timestamp: Date.now(),
      correlationId: 'req-1',
      payload: { reason: 'invalid-payload', details: 'payload.config.mode: Required' },
    });

    expect(useNotificationStore.getState().notifications).toHaveLength(0);

    // An uncorrelated one answers nobody, so it is still raised here — once
    // per mounted panel, since no panel owns it.
    fireMessage({
      id: 'bridge-err-broadcast',
      type: 'bridge:error',
      timestamp: Date.now(),
      payload: { reason: 'invalid-payload', details: 'payload: Expected object' },
    });

    expect(useNotificationStore.getState().notifications).toHaveLength(2);
  });

  it('raises a refusal of a request this panel sent from outside a request hook', () => {
    // Stores and fire-and-forget senders have no hook to show a refusal in;
    // leaving every correlated bridge:error to the hooks showed theirs nowhere.
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );
    const id = sendBridgeMessage('sync:schedule:list');

    fireMessage({
      id: 'bridge-err-unclaimed',
      type: 'bridge:error',
      timestamp: Date.now(),
      correlationId: id,
      payload: { reason: 'invalid-payload', details: 'payload: Expected object' },
    });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe(i18n.t('bridge.dropped.unreadable'));
  });

  it('raises a refusal of a request made through a request hook once, and sets the hook error', () => {
    // Many screens never render their hook's error, so the panel that sent
    // the request still raises the refusal.
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );
    const { result } = renderHook(() =>
      useBridgeMutation('sync:config:save', { responseType: 'sync:config:save:response' }),
    );
    mockPostMessage.mockClear();
    act(() => {
      result.current.mutate({ config: {} });
    });
    const sent = mockPostMessage.mock.calls[0][0] as { payload: { id: string } };

    fireMessage({
      id: 'bridge-err-claimed',
      type: 'bridge:error',
      timestamp: Date.now(),
      correlationId: sent.payload.id,
      payload: { reason: 'invalid-payload', details: 'payload.config.id: Required' },
    });

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(result.current.error).toContain('sync:config:save');
  });

  it('should set loading on operation:started and clear on operation:completed', () => {
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-4',
      type: 'operation:started',
      timestamp: Date.now(),
      payload: { operationId: 'op-1', module: 'seed', description: 'test' },
    });

    expect(useAppStore.getState().isLoading).toBe(true);

    fireMessage({
      id: 'ext-5',
      type: 'operation:completed',
      timestamp: Date.now(),
      payload: { operationId: 'op-1', result: {} },
    });

    expect(useAppStore.getState().isLoading).toBe(false);
  });

  it('should render children', () => {
    const { getByText } = render(
      <BridgeProvider>
        <span>content</span>
      </BridgeProvider>,
    );

    expect(getByText('content')).toBeDefined();
  });

  it('should auto-select first connected org when none selected', () => {
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    const org1 = { ...createTestOrg('1'), status: 'expired' as const };
    const org2 = createTestOrg('2');

    fireMessage({
      id: 'ext-auto-1',
      type: 'org:list:response',
      timestamp: Date.now(),
      payload: { orgs: [org1, org2] },
    });

    expect(useOrgStore.getState().selectedOrgId).toBe('2');
  });

  it('should not auto-select when an org is already selected', () => {
    useOrgStore.setState({ selectedOrgId: '1' });

    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-auto-2',
      type: 'org:list:response',
      timestamp: Date.now(),
      payload: { orgs: [createTestOrg('1'), createTestOrg('2')] },
    });

    expect(useOrgStore.getState().selectedOrgId).toBe('1');
  });

  it('should clear a stale selection when the selected org is gone from the list', () => {
    // The webview persists selectedOrgId across reloads; if the org vanished
    // from the extension config (reset, removed org, new profile), keeping it
    // makes every module query an org that no longer exists.
    useOrgStore.setState({ selectedOrgId: 'ghost-org' });

    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-stale-1',
      type: 'org:list:response',
      timestamp: Date.now(),
      payload: { orgs: [createTestOrg('1')] },
    });

    // Stale id cleared, then auto-select kicks in on the connected org
    expect(useOrgStore.getState().selectedOrgId).toBe('1');
  });

  it('should clear a stale selection to null when no org remains', () => {
    useOrgStore.setState({ selectedOrgId: 'ghost-org' });

    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-stale-2',
      type: 'org:list:response',
      timestamp: Date.now(),
      payload: { orgs: [] },
    });

    expect(useOrgStore.getState().selectedOrgId).toBeNull();
  });

  it('should not auto-select when no connected orgs exist', () => {
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    const expired = { ...createTestOrg('1'), status: 'expired' as const };

    fireMessage({
      id: 'ext-auto-3',
      type: 'org:list:response',
      timestamp: Date.now(),
      payload: { orgs: [expired] },
    });

    expect(useOrgStore.getState().selectedOrgId).toBeNull();
  });

  it('should recover the language from the settings blob when the webview state has none', async () => {
    // The mocked getState() returns undefined → no persisted language, so the
    // blob value must be adopted (and re-persisted by the i18n module).
    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-settings-lang',
      type: 'settings:response',
      timestamp: Date.now(),
      // Current blob layout: the whole settings object under the 'settings' key.
      payload: { settings: { settings: { language: 'de' } } },
    });

    // 'de' is a lazy locale: its bundle crosses the (mocked) bridge as an
    // `i18n:locale` request — answer it, then the language flips.
    await waitFor(() =>
      expect(
        mockPostMessage.mock.calls.some(
          (call) =>
            (call[0] as { payload?: { type?: string } } | undefined)?.payload?.type ===
            'i18n:locale',
        ),
      ).toBe(true),
    );
    await answerCapturedLocaleRequests(mockPostMessage);
    await waitFor(() => expect(i18n.language).toBe('de'));

    // Restore the shared i18n instance for the rest of the suite.
    await i18n.changeLanguage('en');
  });

  /**
   * One failure must cost one resolution.
   *
   * `operation:failed` is broadcast by the broker to every open SandForge
   * panel, and each panel mounts its own BridgeProvider. A provider that asks
   * the model about the failure it just received turns one failed operation
   * into one request, one org error text sent out and one toast *per open
   * panel*. Mounting several providers over the same window models that
   * fan-out: they all receive the single dispatched message, exactly as
   * separate panels would.
   */
  it('should not ask the assistant about a failure it merely received', () => {
    useAppStore.setState({ aiAvailable: true });

    render(
      <>
        <BridgeProvider>
          <div />
        </BridgeProvider>
        <BridgeProvider>
          <div />
        </BridgeProvider>
        <BridgeProvider>
          <div />
        </BridgeProvider>
      </>,
    );

    // Only the mount-time requests have gone out so far; anything counted
    // after this point was sent because of the failure.
    mockPostMessage.mockClear();

    fireMessage({
      id: 'ext-op-failed',
      type: 'operation:failed',
      timestamp: Date.now(),
      payload: {
        operationId: 'op-42',
        error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Amount must be positive',
        retryable: false,
      },
    });

    // The extension resolves the failure once, where it is raised: a panel
    // sends nothing at all on receiving one.
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(useAppStore.getState().isLoading).toBe(false);
  });

  describe('AI availability', () => {
    it('follows the availability the host pushes, on and then off', () => {
      render(
        <BridgeProvider>
          <div />
        </BridgeProvider>,
      );

      // The host pushes availability on its own when a setting changes — no
      // request is behind it, so the message carries no correlationId.
      fireMessage({
        id: 'ai-status-1',
        type: 'ai:status:response',
        timestamp: Date.now(),
        payload: { enabled: true, provider: 'anthropic', model: 'm' },
      });
      expect(useAppStore.getState().aiAvailable).toBe(true);

      fireMessage({
        id: 'ai-status-2',
        type: 'ai:status:response',
        timestamp: Date.now(),
        payload: { enabled: false, provider: 'none', model: '' },
      });
      expect(useAppStore.getState().aiAvailable).toBe(false);
    });
  });
});
