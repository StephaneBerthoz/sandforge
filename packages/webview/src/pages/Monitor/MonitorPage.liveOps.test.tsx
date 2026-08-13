import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { LiveOperationSnapshot, SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { MonitorPage } from './MonitorPage';

/*
 * Live-operation controls.
 *
 * AutomationHandler answers operation:cancel / :pause / :resume with a
 * `notification`, never an `operation:*:response`. These three used to go out
 * through useBridgeMutation, so every click armed a 30 s reply timer on a
 * channel the shared protocol does not even declare — the timer could only
 * ever expire, into state nothing rendered. They are fire-and-forget now.
 */

vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: vi.fn(), currentRoute: 'monitor' }),
}));

vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 400, height: 200 }}>{children}</div>
    ),
  };
});

vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: vi.fn(),
  postEnvelopedMessage: vi.fn(),
}));

const monitorPayload = {
  limits: [{ name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 }],
  jobs: [],
  healthScore: 78,
  lastUpdated: new Date().toISOString(),
};

function makeOperation(overrides: Partial<LiveOperationSnapshot> = {}): LiveOperationSnapshot {
  return {
    operationId: 'op-1',
    module: 'sync',
    description: 'Syncing Account',
    status: 'running',
    percentage: 50,
    processedRecords: 250,
    totalRecords: 500,
    currentStep: 'Processing batch 3/6',
    startedAt: new Date().toISOString(),
    elapsedMs: 15000,
    recordsPerSecond: 17,
    ...overrides,
  };
}

const liveOperations = [
  makeOperation({ operationId: 'op-1', status: 'running' }),
  makeOperation({ operationId: 'op-2', status: 'paused' }),
];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:refresh') {
      return { data: monitorPayload, loading: false, error: null, refetch: vi.fn() };
    }
    if (type === 'monitor:live-operations') {
      return {
        data: { operations: liveOperations },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (type === 'monitor:alerts') {
      return { data: { alerts: [] }, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

/** Records every channel the page opens a request/response cycle on. */
const mutatedChannels: string[] = [];

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    mutatedChannels.push(type);
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockOrg: SalesforceOrg = {
  id: 'org-1',
  alias: 'DevSandbox',
  username: 'admin@dev.sandbox',
  instanceUrl: 'https://dev-sandbox.salesforce.com',
  orgId: '00D000000000001',
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#3B82F6', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2024-01-01T00:00:00Z',
  tags: [],
};

describe('MonitorPage live-operation controls', () => {
  beforeEach(() => {
    vi.mocked(sendBridgeMessage).mockClear();
    mutatedChannels.length = 0;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [mockOrg] });
  });

  it('posts operation:cancel for the clicked operation', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('cancel-op-1'));
    expect(sendBridgeMessage).toHaveBeenCalledWith('operation:cancel', { operationId: 'op-1' });
  });

  it('posts operation:pause for a running operation', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('pause-op-1'));
    expect(sendBridgeMessage).toHaveBeenCalledWith('operation:pause', { operationId: 'op-1' });
  });

  it('posts operation:resume for a paused operation', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('resume-op-2'));
    expect(sendBridgeMessage).toHaveBeenCalledWith('operation:resume', { operationId: 'op-2' });
  });

  it('opens no request/response cycle on an operation channel', () => {
    render(<MonitorPage />);
    fireEvent.click(screen.getByTestId('cancel-op-1'));
    expect(mutatedChannels.filter((c) => c.startsWith('operation:'))).toEqual([]);
  });
});
