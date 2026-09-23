import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('says on the canvas which steps run and which are refused, before anyone runs a pipeline', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    const notice = screen.getByTestId('automation-steps-soon');
    expect(notice.textContent).toContain('Coming soon');
    expect(notice.textContent).toContain(
      'Script, Approval, Loop and Parallel steps cannot run in a pipeline yet',
    );
    expect(notice.textContent).toContain(
      'Seed, Sync, Restore, Anonymize and Delete write to an org, so they run only from their own pages',
    );
    expect(notice.textContent).toContain(
      'Backup, Compare, Pre-Check, Notification, Delay and Condition steps run',
    );
    // The refused steps are refused; nothing reports a success it did not earn.
    expect(notice.textContent).not.toMatch(/report success/i);
  });

  it('says on the Marketplace tab that the steps of a template cannot run yet', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByText('Marketplace'));
    const notice = screen.getByTestId('automation-marketplace-steps-soon');
    expect(notice.textContent).toContain('Coming soon');
    expect(notice.textContent).toContain('cannot run in a pipeline yet');
    expect(notice.textContent).not.toMatch(/report success/i);
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
        { id: 's-seed', name: 'Load Target', type: 'seed', config: {}, continueOnError: true },
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
      // Seed writes to an org: it runs from the Seed page, where Production
      // Guard asks first, and never unattended in a pipeline.
      expect(screen.getByTestId('pipeline-blocked-s-seed').textContent).toBe(
        'Load Target (Seed) — This step writes to an org, so a pipeline does not run it: ' +
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
            stepTypes: ['anonymize', 'seed', 'notification', 'seed'],
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
        'Cannot run as a pipeline. These step types do not run in one: Anonymize, Seed.',
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
});
