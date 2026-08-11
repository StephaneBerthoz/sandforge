import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { BridgeProvider } from './BridgeProvider';
import { useOrgStore } from '../stores/useOrgStore';
import { useAppStore } from '../stores/useAppStore';
import { useNotificationStore } from '../stores/useNotificationStore';
import i18n from '../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { resetMessageCounter } from './messageHelpers';
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
    resetMessageCounter();
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

    expect(mockPostMessage).toHaveBeenCalledTimes(4);
    // Outbound messages are enveloped — inspect envelope.payload.type.
    const calls = mockPostMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { payload: { type: string } }).payload.type,
    );
    expect(calls).toContain('org:list');
    expect(calls).toContain('settings:get');
    expect(calls).toContain('ai:status');
    expect(calls).toContain('connectivity:status');
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
});
