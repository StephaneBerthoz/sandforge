import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { SeedGenerateFlow } from './SeedGenerateFlow';

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

/* The steps' own content is covered by their tests. */
vi.mock('./SeedSelectStep', () => ({
  SeedSelectStep: () => <div data-testid="seed-step-select-content" />,
}));
vi.mock('./SeedExecuteStep', () => ({
  SeedExecuteStep: () => <div data-testid="seed-step-execute-content" />,
}));
vi.mock('./Persona/PersonaGallery', () => ({ PersonaGallery: () => null }));

const ORG: SalesforceOrg = {
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
};

/** The wizard facade, on a step of its own. */
const wizard = vi.hoisted(() => ({
  step: 0,
  error: null as string | null,
  result: undefined as unknown,
  availableObjects: [] as Array<{ apiName: string; label: string }>,
  fieldConfigs: [] as Array<{ objectApiName: string; objectLabel: string; fields: [] }>,
  fitApplied: null as unknown,
  fitProposal: null as unknown,
  seedFitted: vi.fn(),
}));
vi.mock('./useSeedWizardState', () => ({
  useSeedWizardState: () => ({
    currentStep: wizard.step,
    setCurrentStep: vi.fn(),
    canGoNext: false,
    isFinished: false,
    selectedOrg: ORG,
    selectedOrgId: 'org-1',
    selectedObjects: [],
    availableObjects: wizard.availableObjects,
    fieldConfigs: wizard.fieldConfigs,
    error: wizard.error,
    setError: vi.fn(),
    isRunning: false,
    operationId: null,
    executionResult: wizard.result,
    handleExecute: vi.fn(),
    objectProgress: [],
    overallPercent: 0,
    elapsedMs: 0,
    selectedPersona: null,
    fitProposal: wizard.fitProposal,
    fitApplied: wizard.fitApplied,
    seedFitted: wizard.seedFitted,
  }),
}));

describe('SeedGenerateFlow', () => {
  beforeEach(() => {
    wizard.step = 0;
    wizard.error = null;
    wizard.result = undefined;
    wizard.availableObjects = [];
    wizard.fieldConfigs = [];
    wizard.fitApplied = null;
    wizard.fitProposal = null;
    wizard.seedFitted.mockClear();
    mockPostMessage.mockClear();
  });

  it('shows, on the step the run is started from, the counts that fit under its refusal', () => {
    // The run goes from the last step, and its refusal lands there.
    wizard.step = 3;
    wizard.error = 'The seed was refused before it wrote anything.';
    wizard.fitProposal = {
      share: 0.4,
      budget: {
        budgetMB: 0.16,
        remainingMB: 1,
        maxMB: 5,
        share: 0.8,
        roundingMB: 0.5,
        limitedBy: 'storage',
        automationMB: 0,
      },
      objects: [
        { objectApiName: 'Account', before: 100, after: 40 },
        { objectApiName: 'Contact', before: 100, after: 40 },
      ],
      estimateMB: 0.15625,
    };
    render(<SeedGenerateFlow active onBack={vi.fn()} />);

    const card = screen.getByRole('region', { name: 'What fits in dev1' });
    fireEvent.click(within(card).getByRole('button', { name: 'Seed these counts' }));
    expect(wizard.seedFitted).toHaveBeenCalledTimes(1);
  });

  it('says on its results that the counts were fitted, and nothing for a run that was not', () => {
    wizard.step = 3;
    wizard.result = {
      templateId: 'tpl-1',
      operationId: 'op-1',
      status: 'success',
      objectResults: [],
      totalRecordsCreated: 80,
      totalRecordsFailed: 0,
      duration: 100,
      timestamp: '2026-11-01T10:00:00.000Z',
    };
    wizard.fitApplied = {
      counts: { Account: 40, Contact: 40 },
      records: 80,
      fit: { share: 0.4, before: 200 },
    };
    const { rerender } = render(<SeedGenerateFlow active onBack={vi.fn()} />);
    expect(screen.getByTestId('seed-results-fitted').textContent).toBe(
      'Counts fitted to the data storage of dev1: 80 of the 200 records the template asked for, 40% of every count.',
    );

    wizard.fitApplied = null;
    rerender(<SeedGenerateFlow active onBack={vi.fn()} />);
    expect(screen.queryByTestId('seed-results-fitted')).toBeNull();
  });

  it('heads the wizard with its step and the org it writes to, and goes back on request', () => {
    const onBack = vi.fn();
    render(<SeedGenerateFlow active onBack={onBack} />);

    const header = screen.getByTestId('page-header');
    expect(header.textContent).toContain('Seed Data');
    expect(header.textContent).toContain('Seed DataSelect');
    expect(header.textContent).toContain('dev1');
    expect(screen.getByTestId('seed-step-select-content')).toBeDefined();
    expect(screen.getByTestId('seed-persona-choice')).toBeDefined();

    fireEvent.click(screen.getByTestId('back-to-modes'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('says the wizard’s error above it', () => {
    wizard.error = 'Connection failed';
    render(<SeedGenerateFlow active onBack={vi.fn()} />);

    expect(screen.getByTestId('seed-error').textContent).toContain('Connection failed');
  });

  it('stays mounted and hidden while the page shows another way, with no header of its own', () => {
    // A run the wizard started goes on reporting to it: unmounted, its
    // progress and results would be lost on return.
    wizard.step = 2;
    render(<SeedGenerateFlow active={false} onBack={vi.fn()} />);

    const flow = screen.getByTestId('seed-generate-flow');
    expect(flow.parentElement?.hidden).toBe(true);
    expect(screen.getByTestId('seed-step-execute-content')).toBeDefined();
    expect(screen.queryByTestId('page-header')).toBeNull();
    expect(screen.queryByTestId('back-to-modes')).toBeNull();
  });

  it('names the record its results open by the label the describes gave its object', () => {
    // "Open a created Invoice__c in dev1": the object's API name in a sentence.
    wizard.step = 3;
    wizard.result = {
      templateId: 'tpl-1',
      operationId: 'op-1',
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Invoice__c',
          recordsCreated: 1,
          recordsFailed: 0,
          createdIds: ['a01000000000001AAA'],
          errors: [],
        },
      ],
      totalRecordsCreated: 1,
      totalRecordsFailed: 0,
      duration: 100,
      timestamp: '2026-10-01T10:00:00.000Z',
    };
    wizard.availableObjects = [{ apiName: 'Invoice__c', label: 'Invoices list' }];
    wizard.fieldConfigs = [{ objectApiName: 'Invoice__c', objectLabel: 'Invoice', fields: [] }];

    render(<SeedGenerateFlow active onBack={vi.fn()} />);

    expect(screen.getByTestId('btn-seed-open-record').textContent).toBe(
      'Open a created Invoice in dev1',
    );
  });

  it('offers on its results a checkpoint of the org the wizard wrote to, not of the org selected', () => {
    wizard.step = 3;
    wizard.result = {
      templateId: 'tpl-1',
      operationId: 'op-1',
      status: 'success',
      objectResults: [
        {
          objectApiName: 'Account',
          recordsCreated: 2,
          recordsFailed: 0,
          createdIds: [],
          errors: [],
        },
      ],
      totalRecordsCreated: 2,
      totalRecordsFailed: 0,
      duration: 100,
      timestamp: '2026-10-01T10:00:00.000Z',
    };
    useOrgStore.setState({
      orgs: [{ ...ORG, id: 'org-2', alias: 'dev2' }, ORG],
      selectedOrgId: 'org-2',
    });
    useAppStore.setState({ currentRoute: 'seed', navigationIntent: null });

    render(<SeedGenerateFlow active onBack={vi.fn()} />);

    expect(screen.getByTestId('seed-checkpoint-now').textContent).toContain(
      'keep dev1 as it is now',
    );
    fireEvent.click(screen.getByTestId('seed-checkpoint-now-action'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'checkpoint',
      takeCheckpoint: true,
      targetOrgId: 'org-1',
    });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
  });
});
