import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AutopilotGraph, ExecutionPlan } from '@sandforge/shared';
import '../../../i18n';
import { AutopilotWizard } from './AutopilotWizard';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

/** Fixture graph returned by scan-schema responses. */
const GRAPH: AutopilotGraph = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 100,
      estimatedApiCalls: 1,
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: 0,
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      elapsedMs: 0,
      apiCallsUsed: 0,
    },
    {
      objectApiName: 'Contact',
      recordCount: 80,
      estimatedApiCalls: 1,
      piiFields: [],
      anonymizationRules: [],
      status: 'pending',
      progress: 0,
      insertOrder: 1,
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      elapsedMs: 0,
      apiCallsUsed: 0,
    },
  ],
  edges: [],
  cycles: [],
  stats: {
    totalObjects: 2,
    totalRelationships: 0,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 180,
    totalEstimatedApiCalls: 2,
  },
};

/** Fixture plan returned by generate-plan responses. */
const PLAN: ExecutionPlan = {
  waves: [
    { order: 0, objects: ['Account'], dependsOn: [] },
    { order: 1, objects: ['Contact'], dependsOn: [0] },
  ],
  totalRecords: 180,
  estimatedDurationSec: 120,
  estimatedApiCalls: 4,
  complianceFramework: 'none',
  anonymizationSummary: {
    totalPiiFields: 0,
    totalFieldsToAnonymize: 0,
    methodBreakdown: {} as ExecutionPlan['anonymizationSummary']['methodBreakdown'],
    objectsWithPii: [],
  },
  cycleResolutions: [],
};

/** Mock bridge mutations (scan + plan) — state driven per test. */
const mockScanMutate = vi.fn();
const mockPlanMutate = vi.fn();

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
}

let scanState: MutationState;
let planState: MutationState;

const idleMutation = (mutate: ReturnType<typeof vi.fn>): MutationState => ({
  mutate,
  data: null,
  loading: false,
  error: null,
  reset: vi.fn(),
});

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => (type === 'autopilot:scan-schema' ? scanState : planState),
}));

/** Mock useOrgStore to return test orgs. */
vi.mock('../../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [
        {
          id: 'org-1',
          alias: 'DevSandbox',
          username: 'dev@test.com',
          instanceUrl: 'https://dev.salesforce.com',
          status: 'connected',
          orgType: 'sandbox',
          safetyTier: 'safe',
        },
        {
          id: 'org-2',
          alias: 'QASandbox',
          username: 'qa@test.com',
          instanceUrl: 'https://qa.salesforce.com',
          status: 'connected',
          orgType: 'sandbox',
          safetyTier: 'caution',
        },
      ],
    }),
}));

describe('AutopilotWizard', () => {
  const onExecute = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    scanState = idleMutation(mockScanMutate);
    planState = idleMutation(mockPlanMutate);
    useAutopilotStore.getState().reset();
  });

  /** Select both orgs and click Next — posts the scan request. */
  const connectOrgsAndScan = (): void => {
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    fireEvent.click(screen.getByTestId('target-org-org-2'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
  };

  it('should render step 1 (Connect) by default', () => {
    render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    expect(screen.getByTestId('autopilot-wizard')).toBeDefined();
    expect(screen.getByTestId('step1-connect')).toBeDefined();
  });

  it('should disable next when no orgs are selected', () => {
    render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    expect(screen.getByTestId('seed-wizard-next')).toHaveProperty('disabled', true);
  });

  it('should post autopilot:scan-schema when both orgs selected and next clicked', () => {
    render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();
    expect(mockScanMutate).toHaveBeenCalledWith({
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      selectedObjects: [],
      includeStandardObjects: true,
    });
  });

  it('should advance to objects and list discovered nodes on schema-result', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();

    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);

    expect(useAutopilotStore.getState().step).toBe('objects');
    expect(screen.getByTestId('object-Account')).toBeDefined();
    expect(screen.getByTestId('object-Contact')).toBeDefined();
    // Selection initialized to every discovered object
    expect(useAutopilotStore.getState().selectedObjects).toEqual(['Account', 'Contact']);
  });

  it('should show a scan error banner when the scan fails', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();

    scanState = { ...scanState, loading: false, error: 'boom' };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);

    expect(screen.getByTestId('autopilot-scan-error')).toBeDefined();
    expect(useAutopilotStore.getState().step).toBe('connect');
  });

  it('should go straight to compliance when every object stays selected', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);

    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    // No re-scan needed — the initial scan already covers everything.
    expect(mockScanMutate).toHaveBeenCalledTimes(1);
    expect(useAutopilotStore.getState().step).toBe('compliance');
  });

  it('should re-scan with the narrowed selection when objects were unselected', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);

    // Unselect Contact, then Next → re-scan with the remaining subset.
    fireEvent.click(screen.getByTestId('object-Contact'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    expect(mockScanMutate).toHaveBeenCalledTimes(2);
    expect(mockScanMutate).toHaveBeenLastCalledWith({
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      selectedObjects: ['Account'],
      includeStandardObjects: true,
    });

    // The re-scan response lands on the compliance step.
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    expect(useAutopilotStore.getState().step).toBe('compliance');
    // User subset is preserved (not re-initialized to all nodes).
    expect(useAutopilotStore.getState().selectedObjects).toEqual(['Account']);
  });

  it('should post autopilot:generate-plan on next from compliance', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    fireEvent.click(screen.getByTestId('framework-gdpr'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    expect(mockPlanMutate).toHaveBeenCalledWith({
      complianceFramework: 'gdpr',
      maxRecordsPerObject: 0,
      objectFilters: {},
      overrides: [],
    });
  });

  it('should land on review with plan stats on plan-ready', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    planState = { ...planState, data: { plan: PLAN, graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);

    expect(useAutopilotStore.getState().step).toBe('review');
    expect(screen.getByTestId('step4-review')).toBeDefined();
    expect(screen.getByTestId('stat-waves').textContent).toContain('2');
    expect(screen.getByTestId('stat-records').textContent).toContain('180');
  });

  it('should call onExecute when the execute button is clicked', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    planState = { ...planState, data: { plan: PLAN, graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);

    fireEvent.click(screen.getByTestId('execute-button'));
    expect(onExecute).toHaveBeenCalled();
  });

  it('should go back to step 1 from step 2 (store-backed navigation)', () => {
    const { rerender } = render(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);
    connectOrgsAndScan();
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(<AutopilotWizard onExecute={onExecute} isExecuting={false} />);

    fireEvent.click(screen.getByTestId('seed-wizard-back'));
    expect(screen.getByTestId('step1-connect')).toBeDefined();
  });
});
