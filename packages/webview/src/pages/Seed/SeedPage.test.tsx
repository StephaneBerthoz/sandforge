import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg, SeedTemplate } from '@sandforge/shared';
import type { QuickSeedOptions, QuickSeedState } from './useQuickSeed';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { SeedPage } from './SeedPage';

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
  {
    id: 'org-2',
    alias: 'dev2',
    username: 'user@dev2.com',
    instanceUrl: 'https://dev2.salesforce.com',
    orgId: '00D000000000002',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockDescribeGlobalRefetch = vi.fn();
const mockDescribeFieldsMutate = vi.fn();
const mockDescribeFieldsReset = vi.fn();
const mockExecuteSeedMutate = vi.fn();
const mockExecuteSeedReset = vi.fn();
const mockCloneDescribeMutate = vi.fn();
const mockCloneExecuteMutate = vi.fn();
const mockSaveTemplateMutate = vi.fn();

/** Mutable query state for describe-global. */
let mockDescribeGlobalState = {
  data: null as {
    objects: Array<{ apiName: string; label: string; recordCount: number; dependencies: string[] }>;
  } | null,
  loading: false,
  error: null as string | null,
  refetch: mockDescribeGlobalRefetch,
};

/** Mutable mutation state for describe-fields. */
let mockDescribeFieldsState = {
  mutate: mockDescribeFieldsMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockDescribeFieldsReset,
};

/** Mutable mutation state for seed:execute. */
let mockExecuteSeedState = {
  mutate: mockExecuteSeedMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteSeedReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'seed:describe-global') {
      return mockDescribeGlobalState;
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'seed:describe-object') {
      return mockDescribeFieldsState;
    }
    if (type === 'seed:execute') {
      return mockExecuteSeedState;
    }
    if (type === 'seed:clone:describe-source') {
      return {
        mutate: mockCloneDescribeMutate,
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    }
    if (type === 'seed:template:save') {
      return {
        mutate: mockSaveTemplateMutate,
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    }
    if (type === 'seed:clone:execute') {
      return {
        mutate: mockCloneExecuteMutate,
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
        requestId: null,
      };
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/* Mock PersonaGallery to avoid bridge hooks in unit tests */
vi.mock('./Persona/PersonaGallery', () => ({
  PersonaGallery: ({ onPersonaSelected }: { onPersonaSelected: (p: unknown) => void }) => (
    <div data-testid="persona-gallery">
      <button
        data-testid="mock-persona-select"
        onClick={() =>
          onPersonaSelected({
            id: 'test',
            name: 'Test',
            description: 'Test',
            industry: 'tech',
            locale: 'en_US',
            dataPatterns: {},
          })
        }
      >
        Select Persona
      </button>
    </div>
  ),
}));

/* The quick seed flow reads the same seed:execute double as the wizard, so the
   one test that drives that double to a finished run keeps quick seed idle;
   every other test exercises the real hook. */
const quickSeed = vi.hoisted(() => ({ forceIdle: false }));

vi.mock('./useQuickSeed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useQuickSeed')>();
  return {
    useQuickSeed: (options: QuickSeedOptions = {}): QuickSeedState =>
      quickSeed.forceIdle
        ? {
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
            execute: vi.fn(),
            reset: vi.fn(),
            setError: vi.fn(),
          }
        : actual.useQuickSeed(options),
  };
});

/* jsdom has no layout, so the real virtual list would render no object row. */
vi.mock('../../components/ui/VirtualList', () => ({
  VirtualList: <T,>({
    items,
    renderItem,
    keyExtractor,
  }: {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    keyExtractor: (item: T, index: number) => string;
  }) => (
    <div data-testid="virtual-list">
      {items.map((item, index) => (
        <div key={keyExtractor(item, index)}>{renderItem(item, index)}</div>
      ))}
    </div>
  ),
}));

/* Mock TemplateGallery: picking a template is the only part exercised here, and
   the real gallery loads its catalogue over the bridge. */
vi.mock('./TemplateGallery', () => ({
  TemplateGallery: ({
    onSelectTemplate,
  }: {
    onSelectTemplate: (template: unknown, counts: Record<string, number>) => void;
  }) => (
    <div data-testid="template-gallery">
      <button
        data-testid="mock-template-select"
        onClick={() =>
          onSelectTemplate(
            {
              id: 'prebuilt-minimal-demo',
              name: 'Minimal Demo',
              description: 'A minimal demo template',
              version: 1,
              strategy: 'faker',
              objects: [
                {
                  objectApiName: 'Account',
                  recordCount: 10,
                  fieldRules: [],
                  excludedFields: [],
                  insertOrder: 0,
                  batchSize: 200,
                },
              ],
              tags: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            {},
          )
        }
      >
        Use this template
      </button>
    </div>
  ),
}));

/* Mock InfoTooltip to simplify DOM assertions */
vi.mock('../../components/ui/InfoTooltip', () => ({
  InfoTooltip: ({ id }: { id: string; content: string }) => (
    <span data-testid={`info-tooltip-${id}`} />
  ),
}));

/** A createable field as `seed:describe-object` reports it. */
function describedField(
  fieldApiName: string,
  type: string,
  extra: {
    required?: boolean;
    length?: number;
    referenceTo?: string[];
    picklistValues?: string[];
  } = {},
): Record<string, unknown> {
  return {
    fieldApiName,
    label: fieldApiName,
    type,
    required: false,
    picklistValues: [],
    referenceTo: [],
    length: 0,
    ...extra,
  };
}

/** Answer the describe of one object, as the extension does, and let the page take it. */
function answerDescribe(
  rerender: (ui: React.ReactElement) => void,
  objectApiName: string,
  fields: Record<string, unknown>[],
): void {
  mockDescribeFieldsState = {
    ...mockDescribeFieldsState,
    data: { objectApiName, objectLabel: objectApiName, fields },
  };
  rerender(<SeedPage />);
}

/** The objects `seed:describe-global` lists for the wizard runs below. */
function listObjects(names: string[]): void {
  mockDescribeGlobalState = {
    data: {
      objects: names.map((apiName) => ({
        apiName,
        label: apiName,
        recordCount: 0,
        dependencies: [],
      })),
    },
    loading: false,
    error: null,
    refetch: mockDescribeGlobalRefetch,
  };
}

/** Open the wizard on org-1, pick `names` and leave the select step. */
function pickAndMoveOn(names: string[]): ReturnType<typeof render> {
  const view = render(<SeedPage />);
  fireEvent.click(screen.getByTestId('mode-card-ai'));
  fireEvent.click(screen.getByTestId('fork-card-scratch'));
  fireEvent.change(screen.getByTestId('org-selector'), { target: { value: 'org-1' } });
  for (const name of names) fireEvent.click(screen.getByTestId(`obj-${name}`));
  fireEvent.click(screen.getByTestId('seed-wizard-next'));
  return view;
}

/** Account, Contact and Opportunity as a sandbox describes their required fields. */
const THREE_OBJECT_DESCRIBES: Record<string, Record<string, unknown>[]> = {
  Account: [describedField('Name', 'string', { required: true, length: 255 })],
  Contact: [
    describedField('LastName', 'string', { required: true, length: 80 }),
    describedField('AccountId', 'reference', { referenceTo: ['Account'], length: 18 }),
  ],
  Opportunity: [
    describedField('Name', 'string', { required: true, length: 120 }),
    describedField('CloseDate', 'date', { required: true }),
    describedField('StageName', 'picklist', {
      required: true,
      picklistValues: ['Prospecting', 'Closed Won'],
    }),
  ],
};

describe('SeedPage', () => {
  beforeEach(() => {
    quickSeed.forceIdle = false;
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useAppStore.setState({ navigationIntent: null });
    mockCloneDescribeMutate.mockClear();
    mockCloneExecuteMutate.mockClear();
    mockDescribeGlobalRefetch.mockClear();
    mockDescribeFieldsMutate.mockClear();
    mockExecuteSeedMutate.mockClear();
    mockSaveTemplateMutate.mockClear();
    // Reset to default idle state
    mockDescribeGlobalState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockDescribeGlobalRefetch,
    };
    mockDescribeFieldsState = {
      mutate: mockDescribeFieldsMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockDescribeFieldsReset,
    };
    mockExecuteSeedState = {
      mutate: mockExecuteSeedMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteSeedReset,
    };
  });

  it('should show empty state when no orgs', () => {
    render(<SeedPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-seed')).toBeDefined();
    expect(screen.getByText('Fill your sandbox with realistic test data')).toBeDefined();
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect an org via SFDX import',
    );
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Connect an Org');
  });

  it('should render seed page with mode selector', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('seed-page')).toBeDefined();
    expect(screen.getByTestId('seed-mode-selector')).toBeDefined();
  });

  it('should show title in page header', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Seed Data')).toBeDefined();
  });

  it('should render 3 mode cards in selector', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('mode-card-ai')).toBeDefined();
    expect(screen.getByTestId('mode-card-csv')).toBeDefined();
    expect(screen.getByTestId('mode-card-clone')).toBeDefined();
  });

  it('should show AI fork selector when clicking AI card', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    expect(screen.getByTestId('ai-fork-selector')).toBeDefined();
    expect(screen.getByTestId('fork-card-persona')).toBeDefined();
    expect(screen.getByTestId('fork-card-scratch')).toBeDefined();
    expect(screen.queryByTestId('seed-mode-selector')).toBeNull();
  });

  it('should show CsvUploadWizard when clicking CSV card', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-csv'));
    expect(screen.getByTestId('csv-upload-wizard')).toBeDefined();
    expect(screen.queryByTestId('seed-mode-selector')).toBeNull();
  });

  it('should show CloneWizard when clicking Clone card', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-clone'));
    expect(screen.getByTestId('clone-wizard-container')).toBeDefined();
    expect(screen.queryByTestId('seed-mode-selector')).toBeNull();
  });

  it('should return to mode selector when clicking back', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-csv'));
    expect(screen.getByTestId('csv-upload-wizard')).toBeDefined();

    fireEvent.click(screen.getByTestId('back-to-modes'));
    expect(screen.getByTestId('seed-mode-selector')).toBeDefined();
  });

  it('should show wizard with org selector after navigating AI > Start from Scratch', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));
    expect(screen.getByTestId('seed-step-select-content')).toBeDefined();
    expect(screen.getByTestId('org-selector')).toBeDefined();
  });

  it('should show PersonaGallery after navigating AI > Choose a Persona', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-persona'));
    expect(screen.getByTestId('persona-gallery')).toBeDefined();
  });

  it('should navigate back from AI sub-mode to fork selector', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));
    expect(screen.getByTestId('seed-wizard')).toBeDefined();

    fireEvent.click(screen.getByTestId('back-to-modes'));
    expect(screen.getByTestId('ai-fork-selector')).toBeDefined();
  });

  it('should display error from bridge query', () => {
    mockDescribeGlobalState = {
      data: null,
      loading: false,
      error: 'Connection failed',
      refetch: mockDescribeGlobalRefetch,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    // Switch to AI scratch mode to trigger error display
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));

    expect(screen.getByTestId('seed-error')).toBeDefined();
    expect(screen.getByText('Connection failed')).toBeDefined();
  });

  it('should show InfoTooltip on the Select step header', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));
    expect(screen.getByTestId('info-tooltip-help.seed.selectObjects')).toBeDefined();
  });

  it('should switch to wizard when persona is selected from gallery', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-persona'));
    fireEvent.click(screen.getByTestId('mock-persona-select'));
    // After persona selection, should switch to ai-scratch mode (wizard)
    expect(screen.getByTestId('seed-wizard')).toBeDefined();
  });

  it('opens the clone wizard with the recommended source org selected when Home sends it here', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    useAppStore.setState({
      navigationIntent: { route: 'seed', seedMode: 'clone', sourceOrgId: 'org-2' },
    });

    render(<SeedPage />);

    expect(screen.getByTestId('clone-wizard-container')).toBeDefined();
    expect((screen.getByTestId('clone-source-select') as HTMLSelectElement).value).toBe('org-2');
    expect(mockCloneDescribeMutate).toHaveBeenCalledWith({ sourceOrgId: 'org-2' });
    // Nothing runs: the preview and the production guard still come first.
    expect(mockCloneExecuteMutate).not.toHaveBeenCalled();
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });

  it('opens the template gallery when Home recommends a quick seed', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    useAppStore.setState({ navigationIntent: { route: 'seed', seedMode: 'quick-seed' } });

    render(<SeedPage />);

    expect(screen.queryByTestId('seed-mode-selector')).toBeNull();
    expect(screen.queryByTestId('clone-wizard-container')).toBeNull();
    expect(screen.getByTestId('back-to-modes')).toBeDefined();
  });

  it('selects the recommended org once a template is picked', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    useAppStore.setState({
      navigationIntent: { route: 'seed', seedMode: 'quick-seed', targetOrgId: 'org-2' },
    });

    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mock-template-select'));

    const selector = screen.getByTestId('quick-seed-org-selector') as HTMLSelectElement;
    expect(selector.value).toBe('org-2');
  });

  it('asks for the org when the recommendation named none', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    useAppStore.setState({ navigationIntent: { route: 'seed', seedMode: 'quick-seed' } });

    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mock-template-select'));

    const selector = screen.getByTestId('quick-seed-org-selector') as HTMLSelectElement;
    expect(selector.value).toBe('');
  });

  it('opens on the mode selector when it was reached without a recommendation', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });

    render(<SeedPage />);

    expect(screen.getByTestId('seed-mode-selector')).toBeDefined();
  });
  it('saves the template the run was sent when Save as template is clicked on the results', () => {
    quickSeed.forceIdle = true;
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    mockDescribeGlobalState = {
      data: {
        objects: [{ apiName: 'Account', label: 'Account', recordCount: 0, dependencies: [] }],
      },
      loading: false,
      error: null,
      refetch: mockDescribeGlobalRefetch,
    };
    const { rerender } = render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));
    fireEvent.change(screen.getByTestId('org-selector'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByTestId('obj-Account'));
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    answerDescribe(rerender, 'Account', [describedField('Name', 'string', { length: 255 })]);
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    fireEvent.click(screen.getByTestId('seed-wizard-finish'));

    expect(mockExecuteSeedMutate).toHaveBeenCalledOnce();
    const sent = (mockExecuteSeedMutate.mock.calls[0][0] as { template: SeedTemplate }).template;

    mockExecuteSeedState = {
      ...mockExecuteSeedState,
      data: {
        templateId: sent.id,
        operationId: 'op-1',
        status: 'success',
        objectResults: [],
        totalRecordsCreated: 100,
        totalRecordsFailed: 0,
        duration: 10,
        timestamp: '2026-01-01T00:00:00Z',
      },
    };
    rerender(<SeedPage />);

    const save = screen.getByTestId('btn-save-template') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(mockSaveTemplateMutate).toHaveBeenCalledOnce();
    const saved = (mockSaveTemplateMutate.mock.calls[0][0] as { template: SeedTemplate }).template;
    expect(saved.id).toBeUndefined();
    expect(saved.objects).toEqual(sent.objects);
    expect(saved.objects.map((o) => o.objectApiName)).toEqual(['Account']);
  });

  describe('a run that skips the configure step', () => {
    const THREE = ['Account', 'Contact', 'Opportunity'];

    beforeEach(() => {
      quickSeed.forceIdle = true;
      useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
      listObjects(THREE);
    });

    it('sends three objects with the rules their describes gave, where it sent none', () => {
      // Below five objects the configure step is skipped, and the describes
      // only happened there: every such run went out with `fieldRules: []`
      // and the extension refused it.
      const { rerender } = pickAndMoveOn(THREE);

      expect(screen.getByTestId('seed-step-execute-content')).toBeDefined();
      for (const name of THREE) answerDescribe(rerender, name, THREE_OBJECT_DESCRIBES[name]);
      // Each object is asked for once, the next when the last has answered.
      const asked = mockDescribeFieldsMutate.mock.calls.map(
        (call) => (call[0] as { objectApiName: string }).objectApiName,
      );
      expect(asked).toEqual(THREE);

      fireEvent.click(screen.getByTestId('seed-wizard-next'));
      fireEvent.click(screen.getByTestId('seed-wizard-finish'));

      expect(mockExecuteSeedMutate).toHaveBeenCalledOnce();
      const sent = (mockExecuteSeedMutate.mock.calls[0][0] as { template: SeedTemplate }).template;
      expect(
        Object.fromEntries(
          sent.objects.map((o) => [o.objectApiName, o.fieldRules.map((r) => r.ruleType)]),
        ),
      ).toEqual({
        Account: ['faker'],
        Contact: ['faker', 'reference'],
        Opportunity: ['faker', 'faker', 'picklist_random'],
      });
    });

    it('waits for every describe before it lets the run go, and says so', () => {
      const { rerender } = pickAndMoveOn(THREE);
      /** Whether Next says it cannot be used yet. */
      const nextUnavailable = (): boolean =>
        screen.getByTestId('seed-wizard-next').getAttribute('aria-disabled') === 'true';

      expect(screen.getByTestId('seed-fields-status').textContent).toBe(
        'Reading the fields of the selected objects...',
      );
      expect(nextUnavailable()).toBe(true);

      answerDescribe(rerender, 'Account', THREE_OBJECT_DESCRIBES.Account);
      answerDescribe(rerender, 'Contact', THREE_OBJECT_DESCRIBES.Contact);
      expect(nextUnavailable()).toBe(true);

      answerDescribe(rerender, 'Opportunity', THREE_OBJECT_DESCRIBES.Opportunity);
      expect(screen.getByTestId('seed-fields-status').textContent).toBe(
        'Using default field rules.',
      );
      expect(nextUnavailable()).toBe(false);
    });

    it('offers the relations on the execute step, and sends the one added there', () => {
      const { rerender } = pickAndMoveOn(THREE);
      for (const name of THREE) answerDescribe(rerender, name, THREE_OBJECT_DESCRIBES[name]);

      fireEvent.click(screen.getByTestId('add-relation-btn'));
      expect(screen.getByTestId('relation-0-planned').textContent).toBe(
        'Contact: up to 300 records — parents: 100 × Account, created by this run.',
      );
      fireEvent.click(screen.getByTestId('seed-wizard-next'));
      fireEvent.click(screen.getByTestId('seed-wizard-finish'));

      const sent = (mockExecuteSeedMutate.mock.calls[0][0] as { template: SeedTemplate }).template;
      expect(sent.relations).toEqual([
        {
          childObject: 'Contact',
          lookupField: 'AccountId',
          parentObject: 'Account',
          parents: { kind: 'generated' },
          distribution: { mode: 'perParent', count: 3 },
        },
      ]);
      const contact = sent.objects.find((o) => o.objectApiName === 'Contact');
      expect(contact?.recordCount).toBe(300);
      expect(contact?.fieldRules.map((r) => r.fieldApiName)).toEqual(['LastName']);
    });

    it('says why the fields could not be read, and asks again on Retry', () => {
      const { rerender } = pickAndMoveOn(THREE);
      mockDescribeFieldsState = { ...mockDescribeFieldsState, error: 'INVALID_SESSION_ID' };
      rerender(<SeedPage />);

      expect(screen.getByTestId('seed-fields-status').textContent).toBe(
        'The fields of the selected objects could not be read: INVALID_SESSION_ID',
      );
      expect(screen.getByTestId('seed-wizard-next').getAttribute('aria-disabled')).toBe('true');

      mockDescribeFieldsMutate.mockClear();
      // As the mutation does: a reset clears the failure it holds.
      mockDescribeFieldsReset.mockImplementationOnce(() => {
        mockDescribeFieldsState = { ...mockDescribeFieldsState, error: null };
      });
      fireEvent.click(screen.getByTestId('seed-fields-retry'));

      expect(mockDescribeFieldsMutate).toHaveBeenCalledWith({
        orgId: 'org-1',
        objectApiName: 'Account',
      });
    });
  });
});
