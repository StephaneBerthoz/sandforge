import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { BridgeProvider } from './BridgeProvider';
import { useOrgStore } from '../stores/useOrgStore';
import { useAppStore } from '../stores/useAppStore';
import { useNotificationStore } from '../stores/useNotificationStore';
import type { SalesforceOrg } from '@sandforge/shared';
import { resetMessageCounter } from './messageHelpers';

const mockPostMessage = vi.fn();

vi.mock('../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
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
    safetyTier: 'low' as const,
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
    const calls = mockPostMessage.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
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
    useOrgStore.setState({ selectedOrgId: 'existing' });

    render(
      <BridgeProvider>
        <div />
      </BridgeProvider>,
    );

    fireMessage({
      id: 'ext-auto-2',
      type: 'org:list:response',
      timestamp: Date.now(),
      payload: { orgs: [createTestOrg('1')] },
    });

    expect(useOrgStore.getState().selectedOrgId).toBe('existing');
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
});
