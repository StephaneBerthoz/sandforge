import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { AutomationPage } from './AutomationPage';

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

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();
const mockSaveMutate = vi.fn();
const mockSaveReset = vi.fn();

/** Mutable mutation state for pipeline:execute. */
let mockExecuteMutationState = {
  mutate: mockExecuteMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteReset,
};

/** Mutable mutation state for pipeline:save. */
let mockSaveMutationState = {
  mutate: mockSaveMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockSaveReset,
};

/** Mutable mutation state for pipeline:delete. */
const mockDeleteMutate = vi.fn();
const mockDeleteMutationState = {
  mutate: mockDeleteMutate,
  data: null,
  loading: false,
  error: null,
  errorCode: null,
  reset: vi.fn(),
};

/** What the pipeline generator answered, kept across renders as the bridge keeps it. */
let mockGenerateMutationState = {
  mutate: vi.fn(),
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
  requestId: null as string | null,
};

const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** What each query answers, by request type; a type left out answers nothing yet. */
let mockQueryData: Record<string, unknown> = {};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => ({
    data: mockQueryData[type] ?? null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'pipeline:execute') {
      return mockExecuteMutationState;
    }
    if (type === 'pipeline:save') {
      return mockSaveMutationState;
    }
    if (type === 'ai:generate-pipeline') {
      return mockGenerateMutationState;
    }
    if (type === 'pipeline:delete') {
      return mockDeleteMutationState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: mockNavigate, currentRoute: 'automation' }),
}));

describe('AutomationPage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    mockQueryData = {};
    mockNavigate.mockClear();
    mockExecuteMutate.mockClear();
    mockExecuteReset.mockClear();
    mockSaveMutate.mockClear();
    mockSaveReset.mockClear();
    // Reset to default idle state
    mockExecuteMutationState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteReset,
    };
    mockSaveMutationState = {
      mutate: mockSaveMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockSaveReset,
    };
    mockGenerateMutationState = {
      mutate: vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
      requestId: null,
    };
    mockPostMessage.mockClear();
  });

  it('offers Stop while the model writes a draft, and stops it by its request', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    mockGenerateMutationState.loading = true;
    mockGenerateMutationState.requestId = 'gen-7';
    render(<AutomationPage />);

    fireEvent.click(screen.getByTestId('generate-pipeline-stop'));

    const sent = mockPostMessage.mock.calls.map(
      ([envelope]) => (envelope as { payload: { type: string; payload?: unknown } }).payload,
    );
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'ai:tool:cancel', payload: { requestId: 'gen-7' } }),
    );
    expect(mockGenerateMutationState.reset).toHaveBeenCalledTimes(1);
  });

  it('offers no Stop while no draft is being written', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);

    expect(screen.queryByTestId('generate-pipeline-stop')).toBeNull();
  });

  it('says next to a draft what it leaves out and where that work runs', () => {
    // "compare then sync": the draft holds the comparison, and the sync goes
    // to the page that runs it.
    mockGenerateMutationState.data = {
      success: true,
      pipeline: {
        name: 'Pipeline_CompareThenSync',
        steps: [{ name: 'compare_step', type: 'compare', config: {} }],
      },
      suggestions: [
        { code: 'WRITES_TO_ORG', page: 'sync' },
        { code: 'STEP_NOT_RUNNABLE', stepType: 'loop' },
      ],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);

    const note = screen.getByTestId('pipeline-draft-suggestions');
    expect(note.getAttribute('role')).toBe('note');
    expect([...note.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'The draft leaves out the Sync work, which writes to an org: run it from the Sync page, where Production Guard can stop it or ask first.',
      // Loop has no label any more: it is named as the model wrote it.
      'A pipeline cannot run a loop step, so the draft leaves it out.',
    ]);
  });

  it('should show empty state when no orgs', () => {
    useOrgStore.setState({ orgs: [] });
    render(<AutomationPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-automation')).toBeDefined();
    expect(screen.getByTestId('empty-action-button')).toBeDefined();
  });

  it('should navigate to orgs when empty state CTA clicked', () => {
    useOrgStore.setState({ orgs: [] });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('should render the page', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('automation-page')).toBeDefined();
  });

  it('should show title', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Automation')).toBeDefined();
  });

  it('should show create button when no pipeline', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('create-pipeline-btn')).toBeDefined();
  });

  it('names the generate dialog after its heading, keeps Tab inside it and closes it on Escape', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('generate-pipeline-btn'));

    const dialog = screen.getByRole('dialog', { name: 'Generate with AI' });
    const input = screen.getByPlaceholderText(/describe/i);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(input);

    // The submit button is disabled while the description is empty, so Cancel
    // is the last control that can take focus.
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(dialog.isConnected).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives focus back to the generate button when its dialog closes on Escape', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    const opener = screen.getByTestId('generate-pipeline-btn');
    opener.focus();
    fireEvent.click(opener);

    const input = screen.getByPlaceholderText(/describe/i);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('should show run button after creating pipeline', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    expect(screen.getByTestId('run-pipeline-btn')).toBeDefined();
  });

  it('should show tabs', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByRole('tablist')).toBeDefined();
    expect(screen.getAllByRole('tab').length).toBe(5);
  });

  it('should start on canvas tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    expect(screen.getByTestId('pipeline-canvas')).toBeDefined();
  });

  it('should switch to triggers tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    fireEvent.click(screen.getByText('Triggers'));
    expect(screen.getByTestId('trigger-config')).toBeDefined();
  });

  it('should switch to history tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByTestId('pipeline-history')).toBeDefined();
  });

  it('should call pipeline:execute mutation on run click', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    fireEvent.click(screen.getByTestId('run-pipeline-btn'));
    expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
  });

  it('should display error from bridge hook', () => {
    mockExecuteMutationState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: 'Pipeline validation failed',
      reset: mockExecuteReset,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);

    expect(screen.getByTestId('automation-error')).toBeDefined();
    expect(screen.getByText('Pipeline validation failed')).toBeDefined();
  });

  it('puts no "coming soon" over the canvas, whose palette offers only the steps that run', () => {
    // A banner read "Coming soon" above the canvas, about the steps the
    // palette listed disabled beside it.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('step-palette')).toBeDefined();
    expect(screen.queryByTestId('automation-steps-soon')).toBeNull();
    expect(screen.queryByText(/Coming soon/)).toBeNull();
  });

  it('says on the Marketplace tab which steps of a template run, and promises none for later', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByText('Marketplace'));
    const notice = screen.getByTestId('automation-marketplace-steps-note');
    expect(notice.textContent).toContain(
      'Backup, Checkpoint, Compare, Pre-Check, Notification, Delay, Condition, Approval, Sync, Seed, Anonymize and Rewind steps run in a pipeline',
    );
    expect(notice.textContent).toContain(
      'Restore and Delete write to an org, so they run only from their own pages',
    );
    expect(notice.textContent).not.toMatch(/Script|Loop|Parallel/);
    expect(notice.textContent).not.toMatch(/Coming soon|\byet\b|report success/i);
  });

  describe('a pipeline that cannot run', () => {
    const blockedPipeline = {
      id: 'p-1',
      name: 'Refresh QA',
      description: '',
      version: 1,
      steps: [
        {
          id: 's-wait',
          name: 'Wait',
          type: 'delay',
          config: { seconds: 5 },
          continueOnError: false,
        },
        { id: 's-delete', name: 'Clear Target', type: 'delete', config: {}, continueOnError: true },
      ],
      triggers: [],
      variables: [],
      tags: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    it('is marked in the saved list, and cannot be run once loaded: the notice says which step and why', () => {
      mockQueryData = { 'pipeline:list': { pipelines: [blockedPipeline] } };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<AutomationPage />);

      expect(screen.getByTestId('saved-pipeline-blocked-p-1').textContent).toBe('Cannot run');
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));

      const run = screen.getByTestId('run-pipeline-btn');
      expect(run).toHaveProperty('disabled', true);
      const notice = screen.getByTestId('pipeline-blocked');
      expect(run.getAttribute('aria-describedby')).toBe(notice.id);
      expect(notice.textContent).toContain(
        'This pipeline cannot run. Remove or fix these steps first:',
      );
      // Delete writes to an org: it runs from the DataOps page, where
      // Production Guard asks first, and never unattended in a pipeline.
      expect(screen.getByTestId('pipeline-blocked-s-delete').textContent).toBe(
        'Clear Target (Delete) — A pipeline does not run this step: ' +
          'run it from its own page, where Production Guard asks before a write to a production org.',
      );
      // The Delay step has its seconds: it is not what blocks the pipeline.
      expect(screen.queryByTestId('pipeline-blocked-s-wait')).toBeNull();

      fireEvent.click(run);
      expect(mockExecuteMutate).not.toHaveBeenCalled();
    });

    it('keeps the notice in view on every tab, next to the Run button it disables', () => {
      mockQueryData = { 'pipeline:list': { pipelines: [blockedPipeline] } };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));

      fireEvent.click(screen.getByText('Triggers'));

      expect(screen.getByTestId('pipeline-blocked')).toBeDefined();
    });

    it('asks a new Backup step for its org and objects, and runs it once it has them', () => {
      useOrgStore.setState({ orgs: mockOrgs });
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('create-pipeline-btn'));
      fireEvent.click(screen.getByTestId('palette-backup'));

      const run = screen.getByTestId('run-pipeline-btn');
      expect(run).toHaveProperty('disabled', true);
      expect(screen.getByTestId('pipeline-blocked').textContent).toContain(
        'Choose the org this step works on.',
      );

      const [step] = screen.getAllByTestId(/^canvas-step-/);
      fireEvent.click(step);
      fireEvent.change(screen.getByTestId('config-orgId'), { target: { value: 'org-1' } });
      expect(screen.getByTestId('pipeline-blocked').textContent).toContain(
        'List the API names of the objects to back up',
      );
      fireEvent.change(screen.getByTestId('config-objects'), {
        target: { value: 'Account, Contact' },
      });

      expect(screen.queryByTestId('pipeline-blocked')).toBeNull();
      fireEvent.click(run);
      const [payload] = mockExecuteMutate.mock.calls[0] as [
        { pipeline: { steps: Array<{ type: string; config: Record<string, unknown> }> } },
      ];
      expect(payload.pipeline.steps).toEqual([
        expect.objectContaining({
          type: 'backup',
          config: { orgId: 'org-1', objects: ['Account', 'Contact'] },
        }),
      ]);
    });

    it('asks a new Delay step for its seconds before it runs, and runs it once it has them', () => {
      useOrgStore.setState({ orgs: mockOrgs });
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('create-pipeline-btn'));
      fireEvent.click(screen.getByTestId('palette-delay'));

      const run = screen.getByTestId('run-pipeline-btn');
      expect(run).toHaveProperty('disabled', true);
      expect(screen.getByTestId('pipeline-blocked').textContent).toContain(
        'Set how many seconds this Delay step waits',
      );

      const [step] = screen.getAllByTestId(/^canvas-step-/);
      fireEvent.click(step);
      fireEvent.change(screen.getByTestId('config-seconds'), { target: { value: '3' } });

      expect(screen.queryByTestId('pipeline-blocked')).toBeNull();
      expect(run).toHaveProperty('disabled', false);
      fireEvent.click(run);
      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
      const [payload] = mockExecuteMutate.mock.calls[0] as [
        { pipeline: { steps: Array<{ type: string; config: Record<string, unknown> }> } },
      ];
      expect(payload.pipeline.steps).toEqual([
        expect.objectContaining({ type: 'delay', config: { seconds: 3 } }),
      ]);
    });
  });

  it('marks a Marketplace card whose template holds steps that cannot run, and names their types', () => {
    mockQueryData = {
      'marketplace:list': {
        success: true,
        templates: [
          {
            id: 'tpl-a',
            name: 'Sandbox Refresh Post-Processing',
            description: 'Anonymize, then seed',
            category: 'environment',
            author: 'SandForge',
            stepTypes: ['anonymize', 'restore', 'notification', 'delete', 'restore'],
          },
          {
            id: 'tpl-b',
            name: 'Pause',
            description: 'Wait a little',
            category: 'maintenance',
            author: 'SandForge',
            stepTypes: ['delay'],
          },
          {
            id: 'tpl-c',
            name: 'From an older host',
            description: 'No step types on the card',
            category: 'maintenance',
            author: 'SandForge',
          },
        ],
      },
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByText('Marketplace'));

    // Notification runs now: only the steps that write to an org are named.
    expect(screen.getByTestId('marketplace-template-blocked-tpl-a').textContent).toBe(
      'Cannot run' +
        'Cannot run as a pipeline. These step types do not run in one: Restore, Delete.',
    );
    expect(screen.queryByTestId('marketplace-template-blocked-tpl-b')).toBeNull();
    // A card that does not say what its steps are is not guessed at.
    expect(screen.queryByTestId('marketplace-template-blocked-tpl-c')).toBeNull();
  });

  it('does not describe the empty state as automating seed or sync work', () => {
    useOrgStore.setState({ orgs: [] });
    render(<AutomationPage />);
    const emptyState = screen.getByTestId('empty-state');
    expect(emptyState.textContent).not.toMatch(/automated workflows|seed, sync/i);
  });

  it('should render KPI overview row', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('automation-kpi-row')).toBeDefined();
    expect(screen.getAllByTestId('kpi-card').length).toBe(3);
  });

  it('should render BentoTile content wrapper', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getAllByTestId('bento-tile').length).toBeGreaterThanOrEqual(1);
  });

  it('gives the steps and their configuration a column of 288 pixels', () => {
    // 192 pixels wrapped every label of a step's configuration.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    const side = screen.getByTestId('automation-side');
    expect(side.className).toContain('w-72');
    expect(side.className).not.toContain('w-48');
  });

  it('puts the configuration of the step picked above the list under Steps, and into view', () => {
    // Below the list and its note, the configuration began under the fold:
    // a click on a step seemed to do nothing.
    const scrolled = vi.fn();
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      useOrgStore.setState({ orgs: mockOrgs });
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('palette-delay'));
      const side = screen.getByTestId('automation-side');
      const order = () =>
        Array.from(side.children, (child) =>
          child.querySelector('[data-testid="step-palette"]') ||
          child.matches('[data-testid="step-palette"]')
            ? 'palette'
            : 'config',
        );
      expect(order()).toEqual(['palette', 'config']);
      expect(scrolled).not.toHaveBeenCalled();

      const step = screen.getAllByTestId(/^canvas-step-/)[0];
      fireEvent.click(step);
      expect(order()).toEqual(['config', 'palette']);
      expect(screen.getByTestId('step-config-panel')).toBeDefined();
      expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrolled.mock.contexts[0]).toBe(side.children[0]);
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }
  });

  it('starts a pipeline from a click under Steps before Create Pipeline, and says how on the canvas', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('pipeline-canvas').textContent).toContain('No pipeline open');
    fireEvent.click(screen.getByTestId('palette-delay'));
    expect((screen.getByTestId('pipeline-name-input') as HTMLInputElement).value).toBe(
      'New pipeline',
    );
    expect(screen.getByTestId('pipeline-meta').textContent).toBe('v1 · 1 step');
    // Named after its type, with no badge saying the type again.
    const added = screen.getAllByTestId(/^canvas-step-/)[0].textContent ?? '';
    expect(added).toMatch(/^Delay(?!.*Delay)/);
    expect(added).not.toContain('delay');
  });

  describe('a pipeline renamed, opened, started and deleted', () => {
    /** A saved pipeline, as `pipeline:list` lists it. */
    const saved = (id: string, name: string) => ({
      key: `pipeline:saved:${id}`,
      id,
      name,
      description: '',
      version: 1,
      steps: [
        {
          id: `${id}-s`,
          name: 'Wait',
          type: 'delay',
          config: { seconds: 5 },
          continueOnError: false,
        },
      ],
      triggers: [],
      variables: [],
      tags: [],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });

    const nameField = () => screen.getByTestId('pipeline-name-input') as HTMLInputElement;

    beforeEach(() => {
      mockDeleteMutate.mockClear();
      mockQueryData = {
        'pipeline:list': { pipelines: [saved('p-1', 'Nightly'), saved('p-2', 'Weekly')] },
      };
      useOrgStore.setState({ orgs: mockOrgs });
    });

    it('lists the saved pipelines while none is open, each with its own Delete', () => {
      render(<AutomationPage />);

      expect(screen.getByTestId('saved-pipeline-p-1').textContent).toContain('Nightly');
      expect(screen.getByTestId('saved-pipeline-delete-p-1').textContent).toBe('Delete');
      expect(screen.queryByTestId('saved-pipelines-close')).toBeNull();
      // Two controls side by side: a button cannot hold another.
      expect(
        screen
          .getByTestId('saved-pipeline-p-1')
          .contains(screen.getByTestId('saved-pipeline-delete-p-1')),
      ).toBe(false);
    });

    it('hides the list once a pipeline is open, and Open… shows it again beside that pipeline', () => {
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));
      expect(screen.queryByTestId('saved-pipelines')).toBeNull();
      expect(nameField().value).toBe('Nightly');

      fireEvent.click(screen.getByTestId('open-pipeline-btn'));

      const list = screen.getByTestId('saved-pipelines');
      expect(screen.getByTestId('open-pipeline-btn').getAttribute('aria-controls')).toBe(list.id);
      expect(screen.getByTestId('saved-pipeline-p-1').getAttribute('aria-current')).toBe('true');
      expect(screen.getByTestId('saved-pipeline-p-2').hasAttribute('aria-current')).toBe(false);

      fireEvent.click(screen.getByTestId('saved-pipelines-close'));
      expect(screen.queryByTestId('saved-pipelines')).toBeNull();
    });

    it('closes the list and hands the keyboard to the name of the pipeline it opens', () => {
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));
      fireEvent.click(screen.getByTestId('open-pipeline-btn'));

      const row = screen.getByTestId('saved-pipeline-p-2');
      row.focus();
      fireEvent.click(row);

      expect(screen.queryByTestId('saved-pipelines')).toBeNull();
      expect(nameField().value).toBe('Weekly');
      expect(document.activeElement).toBe(nameField());
    });

    it('takes the list away while a run draws its progress on the pipeline', () => {
      const { rerender } = render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));
      fireEvent.click(screen.getByTestId('open-pipeline-btn'));
      expect(screen.getByTestId('saved-pipelines')).toBeDefined();

      mockExecuteMutationState = { ...mockExecuteMutationState, loading: true };
      rerender(<AutomationPage />);

      expect(screen.queryByTestId('saved-pipelines')).toBeNull();
      expect(screen.getByTestId('open-pipeline-btn').getAttribute('aria-expanded')).toBe('false');
    });

    it('says when Open… finds no saved pipeline', () => {
      mockQueryData = {};
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('create-pipeline-btn'));

      fireEvent.click(screen.getByTestId('open-pipeline-btn'));

      expect(screen.getByTestId('saved-pipelines-none').textContent).toBe(
        'No pipeline is saved yet.',
      );
    });

    it('renames the pipeline from its header, which then says it is not saved, and sends the name with the save', () => {
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));
      expect(screen.queryByTestId('pipeline-unsaved')).toBeNull();

      fireEvent.change(nameField(), { target: { value: 'Nightly refresh' } });
      expect(screen.getByTestId('pipeline-unsaved').textContent).toBe('Unsaved changes');

      fireEvent.click(screen.getByTestId('save-pipeline-btn'));
      expect(mockSaveMutate).toHaveBeenCalledWith({
        id: 'p-1',
        config: expect.objectContaining({ id: 'p-1', name: 'Nightly refresh' }),
      });
    });

    it('asks before New drops unsaved changes, and keeps them on Keep editing', async () => {
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));
      fireEvent.change(nameField(), { target: { value: 'Nightly refresh' } });

      fireEvent.click(screen.getByTestId('new-pipeline-btn'));

      expect((await screen.findByTestId('danger-title')).textContent).toBe(
        'Discard the changes to “Nightly refresh”?',
      );
      expect(screen.getByTestId('danger-dismiss-btn').textContent).toBe('Keep editing');
      fireEvent.click(screen.getByTestId('danger-dismiss-btn'));
      expect(nameField().value).toBe('Nightly refresh');
    });

    it('starts the new pipeline on Discard changes, under a name no saved one has', async () => {
      mockQueryData = {
        'pipeline:list': { pipelines: [saved('p-1', 'New pipeline')] },
      };
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));
      fireEvent.change(nameField(), { target: { value: 'Nightly refresh' } });

      fireEvent.click(screen.getByTestId('new-pipeline-btn'));
      fireEvent.click(await screen.findByTestId('danger-confirm-btn'));

      expect(nameField().value).toBe('New pipeline 2');
      expect(screen.queryAllByTestId(/^canvas-step-/)).toHaveLength(0);
    });

    it('asks nothing of New over a pipeline as saved', () => {
      render(<AutomationPage />);
      fireEvent.click(screen.getByTestId('saved-pipeline-p-1'));

      fireEvent.click(screen.getByTestId('new-pipeline-btn'));

      expect(screen.queryByTestId('danger-title')).toBeNull();
      expect(nameField().value).toBe('New pipeline');
    });

    it('asks before deleting, saying what goes and what stays, and deletes on the named button', async () => {
      render(<AutomationPage />);

      fireEvent.click(screen.getByTestId('saved-pipeline-delete-p-2'));

      expect(mockDeleteMutate).not.toHaveBeenCalled();
      expect((await screen.findByTestId('danger-title')).textContent).toBe('Delete “Weekly”?');
      const dialog = screen.getByRole('dialog');
      expect(dialog.textContent).toContain('Its runs stay in the history.');
      expect(dialog.textContent).toContain('the confirmations of its Rewind steps are taken back');

      fireEvent.click(screen.getByRole('button', { name: 'Delete pipeline' }));

      expect(mockDeleteMutate).toHaveBeenCalledWith({ id: 'p-2' });
      await waitFor(() => expect(screen.queryByTestId('danger-title')).toBeNull());
    });

    it('deletes nothing when the question is cancelled', async () => {
      render(<AutomationPage />);

      fireEvent.click(screen.getByTestId('saved-pipeline-delete-p-2'));
      fireEvent.click(await screen.findByTestId('danger-dismiss-btn'));

      expect(mockDeleteMutate).not.toHaveBeenCalled();
    });
  });
});
