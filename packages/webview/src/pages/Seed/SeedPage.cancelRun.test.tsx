import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { SeedPage } from './SeedPage';

/* ------------------------------------------------------------------ */
/* Bridge doubles                                                      */
/* ------------------------------------------------------------------ */
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

/* Only the Execute step is exercised here; its internals are covered elsewhere. */
vi.mock('./SeedExecuteStep', () => ({
  SeedExecuteStep: () => <div data-testid="seed-step-execute-content" />,
}));

vi.mock('./useQuickSeed', () => ({
  useQuickSeed: () => ({
    phase: 'idle',
    selectedTemplate: null,
    customizedCounts: {},
    selectedOrgId: '',
    isRunning: false,
    executionResult: undefined,
    objectProgress: [],
    overallPercent: 0,
    elapsedMs: 0,
    error: null,
    startQuickSeed: vi.fn(),
    selectOrg: vi.fn(),
  }),
}));

/** Wizard facade pinned on the Execute step with a run in flight. */
let mockIsRunning = true;
vi.mock('./useSeedWizardState', () => ({
  useSeedWizardState: () => ({
    currentStep: 2,
    setCurrentStep: vi.fn(),
    canGoNext: false,
    isFinished: false,
    selectedOrg: undefined,
    error: null,
    setError: vi.fn(),
    isRunning: mockIsRunning,
    executionResult: undefined,
    handleExecute: vi.fn(),
    objectProgress: [],
    overallPercent: 42,
    elapsedMs: 1000,
  }),
}));

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

/** Navigate the mode selector down to the AI-from-scratch wizard. */
function openWizard(): void {
  render(<SeedPage />);
  fireEvent.click(screen.getByTestId('mode-card-ai'));
  fireEvent.click(screen.getByTestId('fork-card-scratch'));
}

/** Emit the `operation:progress` event the run's id is carried on. */
function emitProgress(operationId: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'progress-1',
          type: 'operation:progress',
          timestamp: Date.now(),
          payload: {
            operationId,
            percentage: 42,
            processedRecords: 42,
            totalRecords: 100,
            currentStep: 'Bulk insert Account',
          },
        },
      }),
    );
  });
}

describe('SeedPage — cancelling a running seed', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    mockIsRunning = true;
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
  });

  it('offers no cancel control until a run reports an operation id', () => {
    openWizard();
    expect(screen.getByTestId('seed-step-execute-content')).toBeDefined();
    expect(screen.queryByTestId('seed-wizard-cancel')).toBeNull();
  });

  it('offers no cancel control when nothing is running', () => {
    mockIsRunning = false;
    openWizard();
    emitProgress('op-123');
    expect(screen.queryByTestId('seed-wizard-cancel')).toBeNull();
  });

  it('sends execution:abort for the streamed operation id once confirmed', () => {
    openWizard();
    emitProgress('op-123');

    fireEvent.click(screen.getByTestId('seed-wizard-cancel'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Cancel' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const envelope = mockPostMessage.mock.calls[0][0] as {
      payload: { type: string; payload: { operationId: string } };
    };
    expect(envelope.payload.type).toBe('execution:abort');
    expect(envelope.payload.payload.operationId).toBe('op-123');
  });

  it('sends nothing when the confirmation is dismissed', () => {
    openWizard();
    emitProgress('op-123');

    fireEvent.click(screen.getByTestId('seed-wizard-cancel'));
    expect(screen.getByTestId('danger-title')).toBeDefined();
    fireEvent.click(screen.getByTestId('danger-overlay'));

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
