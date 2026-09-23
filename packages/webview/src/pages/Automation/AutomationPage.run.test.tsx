import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { AutomationPage } from './AutomationPage';

/**
 * A run in progress, seen from the page: the execution view follows what the
 * extension says of each step, and its Cancel button stops the run. The view
 * used to show every step pending until the answer came, and the page gave it
 * no way to cancel, so its Cancel button never rendered.
 */

const mockPostMessage = vi.fn();
const vscodeApi = {
  postMessage: mockPostMessage,
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => vscodeApi,
  getVscodeApi: () => vscodeApi,
}));

/** A saved pipeline of two Delay steps. */
const savedPipeline = {
  id: 'p-run',
  name: 'Wait twice',
  description: '',
  version: 1,
  steps: [
    {
      id: 's-1',
      name: 'First wait',
      type: 'delay',
      config: { seconds: 1 },
      continueOnError: false,
    },
    {
      id: 's-2',
      name: 'Second wait',
      type: 'delay',
      config: { seconds: 1 },
      continueOnError: false,
    },
  ],
  triggers: [],
  variables: [],
  tags: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data: type === 'pipeline:list' ? { pipelines: [savedPipeline] } : null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

/** The run: in flight, under the id of the request that started it. */
const runningExecute = {
  mutate: vi.fn(),
  data: null,
  loading: true,
  error: null,
  reset: vi.fn(),
  requestId: 'wv-run-7',
};

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) =>
    type === 'pipeline:execute'
      ? runningExecute
      : {
          mutate: vi.fn(),
          data: null,
          loading: false,
          error: null,
          reset: vi.fn(),
          requestId: null,
        },
}));

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@example.com',
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000001AAA',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T00:00:00Z',
    tags: [],
  },
];

/** A `pipeline:step` update from the extension. */
function stepUpdate(payload: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `ext-${String(payload.stepId)}-${String(payload.status)}`,
          type: 'pipeline:step',
          timestamp: Date.now(),
          payload,
        },
      }),
    );
  });
}

describe('AutomationPage — a run in progress', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('saved-pipeline-p-run'));
  });

  it('shows each step as the extension reports it', () => {
    expect(screen.getByTestId('exec-step-status-s-1').textContent).toBe('Pending');

    stepUpdate({ operationId: 'wv-run-7', stepId: 's-1', status: 'running' });
    expect(screen.getByTestId('exec-step-status-s-1').textContent).toBe('Running');

    stepUpdate({
      operationId: 'wv-run-7',
      stepId: 's-1',
      status: 'completed',
      duration: 1000,
      summary: 'Waited 1 s.',
    });
    stepUpdate({ operationId: 'wv-run-7', stepId: 's-2', status: 'running' });

    expect(screen.getByTestId('exec-step-status-s-1').textContent).toBe('Completed');
    expect(screen.getByTestId('exec-step-summary-s-1').textContent).toBe('Waited 1 s.');
    expect(screen.getByTestId('exec-step-status-s-2').textContent).toBe('Running');
  });

  it('cancels this run from the execution view', () => {
    fireEvent.click(screen.getByTestId('execution-cancel'));

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const envelope = mockPostMessage.mock.calls[0][0] as {
      payload: { type: string; payload: { operationId: string } };
    };
    expect(envelope.payload.type).toBe('execution:abort');
    expect(envelope.payload.payload.operationId).toBe('wv-run-7');
  });
});
