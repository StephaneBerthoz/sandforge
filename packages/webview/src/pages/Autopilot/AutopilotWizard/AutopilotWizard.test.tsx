import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AutopilotGraph, AutopilotObjectListing, ExecutionPlan } from '@sandforge/shared';
import { AUTOPILOT_COUNTS_PER_REQUEST } from '@sandforge/shared';
import '../../../i18n';
import en from '../../../i18n/locales/en.json';
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

/** Fixture listing returned by list-objects responses. */
const LISTING: AutopilotObjectListing[] = [
  { apiName: 'Account', label: 'Account', custom: false },
  { apiName: 'Contact', label: 'Contact', custom: false },
  { apiName: 'Invoice__c', label: 'Invoice', custom: true },
];

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

/** Mock bridge mutations (list + count + scan + plan) — state driven per test. */
const mockListMutate = vi.fn();
const mockCountMutate = vi.fn();
const mockScanMutate = vi.fn();
const mockPlanMutate = vi.fn();

interface MutationState {
  mutate: ReturnType<typeof vi.fn>;
  data: unknown;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
}

let listState: MutationState;
let countState: MutationState;
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
  useBridgeMutation: (type: string) =>
    type === 'autopilot:list-objects'
      ? listState
      : type === 'autopilot:count-objects'
        ? countState
        : type === 'autopilot:scan-schema'
          ? scanState
          : planState,
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
  // A new element each time: rendered again with the same one, React skips it.
  const wizard = (): React.ReactElement => (
    <AutopilotWizard onExecute={onExecute} isExecuting={false} />
  );

  beforeEach(() => {
    vi.clearAllMocks();
    listState = idleMutation(mockListMutate);
    countState = idleMutation(mockCountMutate);
    scanState = idleMutation(mockScanMutate);
    planState = idleMutation(mockPlanMutate);
    useAutopilotStore.getState().reset();
  });

  /** Select both orgs and click Next — posts the listing request. */
  const connectOrgs = (): void => {
    fireEvent.click(screen.getByTestId('source-org-org-1'));
    fireEvent.click(screen.getByTestId('target-org-org-2'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
  };

  /** Connect, answer the listing, and land on the object step. */
  const toObjects = (rerender: (ui: React.ReactElement) => void): void => {
    connectOrgs();
    listState = { ...listState, data: { objects: LISTING } };
    rerender(wizard());
  };

  /** From the object step: pick Account and Contact, Next, answer the scan. */
  const toCompliance = (rerender: (ui: React.ReactElement) => void): void => {
    toObjects(rerender);
    fireEvent.click(screen.getByTestId('object-Account'));
    fireEvent.click(screen.getByTestId('object-Contact'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(wizard());
  };

  it('should render step 1 (Connect) by default', () => {
    render(wizard());
    expect(screen.getByTestId('autopilot-wizard')).toBeDefined();
    expect(screen.getByTestId('step1-connect')).toBeDefined();
  });

  it('should disable next when no orgs are selected', () => {
    render(wizard());
    expect(screen.getByTestId('seed-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('asks for the listing of the objects, not a scan, when both orgs are chosen', () => {
    // A scan with nothing selected described every object of the org and
    // counted every table before the user had picked one.
    render(wizard());
    connectOrgs();
    expect(mockListMutate).toHaveBeenCalledWith({
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      includeStandardObjects: true,
    });
    expect(mockScanMutate).not.toHaveBeenCalled();
    expect(mockCountMutate).not.toHaveBeenCalled();
  });

  it('lists the objects by label on the object step, none picked and none counted', () => {
    const { rerender } = render(wizard());
    toObjects(rerender);

    expect(useAutopilotStore.getState().step).toBe('objects');
    expect(screen.getByTestId('object-Invoice__c').textContent).toBe('Invoice(Invoice__c)');
    expect(useAutopilotStore.getState().selectedObjects).toEqual([]);
    expect(mockCountMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('seed-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('counts an object once it is picked, and shows the count when it comes', () => {
    const { rerender } = render(wizard());
    toObjects(rerender);

    fireEvent.click(screen.getByTestId('object-Invoice__c'));
    expect(mockCountMutate).toHaveBeenCalledWith({
      sourceOrgId: 'org-1',
      objectApiNames: ['Invoice__c'],
    });

    countState = { ...countState, data: { counts: { Invoice__c: 61635 } } };
    rerender(wizard());
    expect(screen.getByTestId('object-Invoice__c').textContent).toContain('61');
    expect(screen.getByTestId('object-Account').textContent).toBe('Account(Account)');

    // Unpicked and picked again: counted once.
    fireEvent.click(screen.getByTestId('object-Invoice__c'));
    fireEvent.click(screen.getByTestId('object-Invoice__c'));
    expect(mockCountMutate).toHaveBeenCalledTimes(1);
  });

  it('counts nothing "select all" picks on an org of six hundred and seventy objects, and a page of those shown when asked', () => {
    // The box set every object counting, fifty at a time, until the whole org
    // had been counted: fourteen requests and 670 counts for one click.
    const many: AutopilotObjectListing[] = Array.from({ length: 670 }, (_, n) => ({
      apiName: `Obj${String(n).padStart(3, '0')}__c`,
      label: `Obj ${n}`,
      custom: true,
    }));
    const { rerender } = render(wizard());
    connectOrgs();
    listState = { ...listState, data: { objects: many } };
    rerender(wizard());

    fireEvent.click(screen.getByTestId('select-all-checkbox'));
    expect(useAutopilotStore.getState().selectedObjects).toHaveLength(670);
    expect(mockCountMutate).not.toHaveBeenCalled();

    // One click, one page: the first fifty objects shown.
    fireEvent.click(screen.getByTestId('count-shown-button'));
    expect(mockCountMutate).toHaveBeenCalledTimes(1);
    expect(mockCountMutate.mock.calls[0][0].objectApiNames).toEqual(
      many.slice(0, AUTOPILOT_COUNTS_PER_REQUEST).map((o) => o.apiName),
    );

    countState = { ...countState, loading: true };
    rerender(wizard());
    const counted = Object.fromEntries(
      many.slice(0, AUTOPILOT_COUNTS_PER_REQUEST).map((o, n) => [o.apiName, n]),
    );
    countState = { ...countState, loading: false, data: { counts: counted } };
    rerender(wizard());
    // Answered, nothing more is asked until the user asks again.
    expect(mockCountMutate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('count-shown-button'));
    expect(mockCountMutate).toHaveBeenCalledTimes(2);
    expect(mockCountMutate.mock.calls[1][0].objectApiNames).toEqual(
      many
        .slice(AUTOPILOT_COUNTS_PER_REQUEST, 2 * AUTOPILOT_COUNTS_PER_REQUEST)
        .map((o) => o.apiName),
    );
  });

  it('does not let an object the target lacks be picked, by itself or by "select all"', () => {
    const { rerender } = render(wizard());
    connectOrgs();
    listState = {
      ...listState,
      data: {
        objects: [
          ...LISTING,
          { apiName: 'Ghost__c', label: 'Ghost', custom: true, missingInTarget: true },
        ],
      },
    };
    rerender(wizard());

    fireEvent.click(screen.getByTestId('object-Ghost__c'));
    expect(useAutopilotStore.getState().selectedObjects).toEqual([]);

    fireEvent.click(screen.getByTestId('select-all-checkbox'));
    expect(useAutopilotStore.getState().selectedObjects).toEqual([
      'Account',
      'Contact',
      'Invoice__c',
    ]);
    expect((screen.getByTestId('select-all-checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('should show an error banner when the listing fails', () => {
    const { rerender } = render(wizard());
    connectOrgs();

    listState = { ...listState, loading: false, error: 'boom' };
    rerender(wizard());

    expect(screen.getByTestId('autopilot-scan-error')).toBeDefined();
    expect(useAutopilotStore.getState().step).toBe('connect');
  });

  it('scans the objects picked, and lands on compliance with the selection as picked', () => {
    const { rerender } = render(wizard());
    toObjects(rerender);

    fireEvent.click(screen.getByTestId('object-Account'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    expect(mockScanMutate).toHaveBeenCalledTimes(1);
    expect(mockScanMutate).toHaveBeenLastCalledWith({
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      selectedObjects: ['Account'],
      includeStandardObjects: true,
    });

    scanState = { ...scanState, data: { graph: GRAPH } };
    rerender(wizard());
    expect(useAutopilotStore.getState().step).toBe('compliance');
    // The scan's parents are not picked for the user.
    expect(useAutopilotStore.getState().selectedObjects).toEqual(['Account']);
  });

  it('scans even when every listed object is picked: no earlier scan covers them', () => {
    const { rerender } = render(wizard());
    toObjects(rerender);

    fireEvent.click(screen.getByTestId('select-all-checkbox'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    expect(mockScanMutate).toHaveBeenCalledWith(
      expect.objectContaining({ selectedObjects: ['Account', 'Contact', 'Invoice__c'] }),
    );
    expect(useAutopilotStore.getState().step).toBe('objects');
  });

  it('keeps what was picked when the user goes back and the orgs are listed again', () => {
    const { rerender } = render(wizard());
    toObjects(rerender);
    fireEvent.click(screen.getByTestId('object-Contact'));

    fireEvent.click(screen.getByTestId('seed-wizard-back'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    listState = { ...listState, data: { objects: LISTING.slice(1) } };
    rerender(wizard());

    expect(mockListMutate).toHaveBeenCalledTimes(2);
    expect(useAutopilotStore.getState().selectedObjects).toEqual(['Contact']);
  });

  it('should post autopilot:generate-plan on next from compliance', () => {
    const { rerender } = render(wizard());
    toCompliance(rerender);

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
    const { rerender } = render(wizard());
    toCompliance(rerender);
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    planState = { ...planState, data: { plan: PLAN, graph: GRAPH } };
    rerender(wizard());

    expect(useAutopilotStore.getState().step).toBe('review');
    expect(screen.getByTestId('step4-review')).toBeDefined();
    expect(screen.getByTestId('stat-waves').textContent).toContain('2');
    expect(screen.getByTestId('stat-records').textContent).toContain('180');
  });

  it('should call onExecute when the execute button is clicked', () => {
    const { rerender } = render(wizard());
    toCompliance(rerender);
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    planState = { ...planState, data: { plan: PLAN, graph: GRAPH } };
    rerender(wizard());

    fireEvent.click(screen.getByTestId('execute-button'));
    expect(onExecute).toHaveBeenCalled();
  });

  it('says why Next waits while the objects are listed, as a status a screen reader reads out', () => {
    // Next is unavailable while the listing runs, and the line saying why was
    // drawn alone: a screen reader on Next heard nothing of it.
    const { rerender } = render(wizard());
    connectOrgs();

    listState = { ...listState, loading: true };
    rerender(wizard());

    expect(screen.getByRole('status').textContent).toBe(en.autopilot.status.listing);
    expect(screen.getByTestId('seed-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('says why Next waits while the selection is scanned, as a status a screen reader reads out', () => {
    const { rerender } = render(wizard());
    toObjects(rerender);
    fireEvent.click(screen.getByTestId('object-Account'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    scanState = { ...scanState, loading: true };
    rerender(wizard());

    expect(screen.getByRole('status').textContent).toBe(en.autopilot.status.scanning);
    expect(screen.getByTestId('seed-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('says why Next waits while the plan is built, as a status a screen reader reads out', () => {
    const { rerender } = render(wizard());
    toCompliance(rerender);
    fireEvent.click(screen.getByTestId('seed-wizard-next'));

    planState = { ...planState, loading: true };
    rerender(wizard());

    expect(screen.getByRole('status').textContent).toBe(en.autopilot.status.planning);
    expect(screen.getByTestId('seed-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('should go back to step 1 from step 2 (store-backed navigation)', () => {
    const { rerender } = render(wizard());
    toObjects(rerender);

    fireEvent.click(screen.getByTestId('seed-wizard-back'));
    expect(screen.getByTestId('step1-connect')).toBeDefined();
  });
});
