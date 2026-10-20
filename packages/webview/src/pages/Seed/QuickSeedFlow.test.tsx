import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import { QuickSeedFlow } from './QuickSeedFlow';
import type { QuickSeedState } from './useQuickSeed';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg, SeedTemplate, SeedExecutionResult } from '@sandforge/shared';

/* ------------------------------------------------------------------ */
/* Bridge double: what the results post                                */
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

/* What a removal would take is asked of the extension on its own: covered elsewhere. */
vi.mock('./SeedRunRemoval', () => ({ SeedRunRemoval: () => null }));

/** The messages the flow posted, unwrapped from their envelope. */
function posted(type: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      ([envelope]) =>
        (envelope as { payload: { type: string; payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/* ------------------------------------------------------------------ */
/* Test fixtures                                                       */
/* ------------------------------------------------------------------ */

const mockTemplate: SeedTemplate = {
  id: 'prebuilt-minimal-demo',
  name: 'seed.templates.minimalDemo.name',
  description: 'seed.templates.minimalDemo.description',
  version: 1,
  strategy: 'faker',
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 50,
      fieldRules: [],
      excludedFields: [],
      insertOrder: 0,
      batchSize: 200,
    },
    {
      objectApiName: 'Contact',
      recordCount: 100,
      fieldRules: [],
      excludedFields: [],
      insertOrder: 1,
      batchSize: 200,
    },
  ],
  tags: ['prebuilt', 'demo'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.sf.com',
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

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const mockExecutionResult: SeedExecutionResult = {
  templateId: 'prebuilt-minimal-demo',
  operationId: 'op-1',
  status: 'success',
  objectResults: [
    {
      objectApiName: 'Contact',
      recordsCreated: 100,
      recordsFailed: 0,
      createdIds: [fakeId('003', 1)],
      errors: [],
    },
    {
      objectApiName: 'Account',
      recordsCreated: 50,
      recordsFailed: 0,
      createdIds: [fakeId('001', 1), fakeId('001', 2)],
      errors: [],
    },
  ],
  totalRecordsCreated: 150,
  totalRecordsFailed: 0,
  duration: 5000,
  timestamp: '2026-03-26T00:00:00Z',
};

const baseQuickSeed: QuickSeedState = {
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
  operationId: null,
  startQuickSeed: vi.fn(),
  setCount: vi.fn(),
  selectOrg: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
  setError: vi.fn(),
};

/* Mock GrappeProgressPanel used inside Step7Execute */
vi.mock('../../stores/useGrappeStore', () => ({
  useGrappeStore: () => ({ active: false, operationId: null }),
}));

describe('QuickSeedFlow', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  describe('the one confirmation of a template', () => {
    it('asks for the counts and the org on one card, with one Start', () => {
      // The counts were set in a dialog whose "Start Seeding" started nothing,
      // then a second step asked for the org under a second "Start Seeding".
      const quickSeed: QuickSeedState = {
        ...baseQuickSeed,
        phase: 'confirm',
        selectedTemplate: mockTemplate,
        customizedCounts: { Contact: 20 },
      };

      render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);

      const card = screen.getByTestId('quick-seed-confirm');
      expect((screen.getByTestId('quick-seed-count-Account') as HTMLInputElement).value).toBe('50');
      expect((screen.getByTestId('quick-seed-count-Contact') as HTMLInputElement).value).toBe('20');
      expect(screen.getByTestId('quick-seed-org-selector')).toBeDefined();
      expect(within(card).getByText('70 records')).toBeDefined();
      expect(screen.getAllByRole('button', { name: 'Start Seeding' })).toHaveLength(1);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('sets the count typed for an object', () => {
      const setCount = vi.fn();
      const quickSeed: QuickSeedState = {
        ...baseQuickSeed,
        phase: 'confirm',
        selectedTemplate: mockTemplate,
        setCount,
      };

      render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);
      fireEvent.change(screen.getByTestId('quick-seed-count-Account'), {
        target: { value: '7' },
      });

      expect(setCount).toHaveBeenCalledWith('Account', 7);
    });

    it('starts the run on Start once an org is chosen, and not before', () => {
      const execute = vi.fn();
      const quickSeed: QuickSeedState = {
        ...baseQuickSeed,
        phase: 'confirm',
        selectedTemplate: mockTemplate,
        execute,
      };

      const { rerender } = render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);
      expect((screen.getByTestId('btn-quick-seed-start') as HTMLButtonElement).disabled).toBe(true);

      rerender(
        <QuickSeedFlow quickSeed={{ ...quickSeed, selectedOrgId: 'org-1' }} orgs={mockOrgs} />,
      );
      fireEvent.click(screen.getByTestId('btn-quick-seed-start'));

      expect(execute).toHaveBeenCalledOnce();
    });

    it('offers each org under the type the org badges give it, a scratch org as one', () => {
      // Every org but a production one used to be offered as [SBX].
      const scratch: SalesforceOrg = {
        ...mockOrgs[0],
        id: 'org-2',
        alias: 'feature',
        orgType: 'Scratch',
      };
      const quickSeed: QuickSeedState = {
        ...baseQuickSeed,
        phase: 'confirm',
        selectedTemplate: mockTemplate,
      };

      render(<QuickSeedFlow quickSeed={quickSeed} orgs={[...mockOrgs, scratch]} />);

      expect(screen.getByRole('option', { name: 'dev1 [SANDBOX]' })).toBeDefined();
      expect(screen.getByRole('option', { name: 'feature [SCRATCH]' })).toBeDefined();
      expect(screen.queryByText(/\[SBX\]/)).toBeNull();
    });
  });

  describe('the run', () => {
    const running: QuickSeedState = {
      ...baseQuickSeed,
      phase: 'executing',
      selectedTemplate: mockTemplate,
      isRunning: true,
      /* Figures from operation:progress: Account written, Contact under way. */
      objectProgress: [
        { objectApiName: 'Account', total: 50, completed: 50, failed: 0, status: 'done' },
        { objectApiName: 'Contact', total: 100, completed: 40, failed: 0, status: 'running' },
      ],
      overallPercent: 60,
      elapsedMs: 2000,
    };

    it('shows the progress the extension reports', () => {
      render(<QuickSeedFlow quickSeed={running} orgs={mockOrgs} />);

      expect(screen.getByTestId('quick-seed-executing')).toBeDefined();
      expect(screen.getByTestId('step-execute')).toBeDefined();
      expect(screen.getAllByRole('progressbar')[0].getAttribute('aria-valuenow')).toBe('60');
    });

    it('can be stopped once it has reported progress, after the typed confirmation', () => {
      // The one-click path had no Cancel: a seed started by mistake ran to its end.
      const cancel = vi.fn();
      render(
        <QuickSeedFlow quickSeed={{ ...running, operationId: 'op-1', cancel }} orgs={mockOrgs} />,
      );

      fireEvent.click(screen.getByTestId('btn-quick-seed-cancel'));
      expect(cancel).not.toHaveBeenCalled();
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Cancel' } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(cancel).toHaveBeenCalledOnce();
    });

    it('offers no Cancel before the run has reported progress, nor once it has ended', () => {
      const { rerender } = render(<QuickSeedFlow quickSeed={running} orgs={mockOrgs} />);
      expect(screen.queryByTestId('btn-quick-seed-cancel')).toBeNull();

      rerender(
        <QuickSeedFlow
          quickSeed={{ ...running, isRunning: false, operationId: 'op-1' }}
          orgs={mockOrgs}
        />,
      );
      expect(screen.queryByTestId('btn-quick-seed-cancel')).toBeNull();
    });
  });

  describe('the results', () => {
    const results: QuickSeedState = {
      ...baseQuickSeed,
      phase: 'results',
      selectedTemplate: mockTemplate,
      selectedOrgId: 'org-1',
      executionResult: mockExecutionResult,
      overallPercent: 100,
    };

    it('renders the summary and its actions', () => {
      render(<QuickSeedFlow quickSeed={results} orgs={mockOrgs} />);

      expect(screen.getByTestId('quick-seed-results')).toBeDefined();
      expect(screen.getByTestId('quick-seed-result-summary')).toBeDefined();
      expect(screen.getByText('150')).toBeDefined();
      expect(screen.getByTestId('btn-back-to-gallery')).toBeDefined();
      expect(screen.getByTestId('btn-seed-again-quick')).toBeDefined();
    });

    it('opens first a created account in the org the run wrote to, naming the run and the record', () => {
      // The payoff was one step away and not offered: nothing led to the data.
      render(<QuickSeedFlow quickSeed={results} orgs={mockOrgs} />);

      const actions = screen.getByTestId('quick-seed-result-actions');
      const open = within(actions).getAllByRole('button')[0];
      expect(open.textContent).toBe('Open a created Account in dev1');
      fireEvent.click(open);

      expect(posted('seed:open-record').map((m) => m.payload)).toEqual([
        { runId: 'op-1', recordId: fakeId('001', 1) },
      ]);
    });

    it('groups the refusals of an object by reason, with a count, in place of a line each', () => {
      const refused: SeedExecutionResult = {
        ...mockExecutionResult,
        status: 'partial',
        objectResults: [
          {
            objectApiName: 'Contact',
            recordsCreated: 47,
            recordsFailed: 53,
            createdIds: [],
            errors: [
              ...Array.from(
                { length: 50 },
                () => 'REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]',
              ),
              'DUPLICATES_DETECTED: Use one of these records?',
              'DUPLICATES_DETECTED: Use one of these records?',
              'DUPLICATES_DETECTED: Use one of these records?',
            ],
          },
        ],
      };

      render(
        <QuickSeedFlow quickSeed={{ ...results, executionResult: refused }} orgs={mockOrgs} />,
      );

      const errors = screen.getByTestId('seed-result-errors-Contact');
      expect(within(errors).getAllByRole('group')).toHaveLength(2);
      expect(screen.getByTestId('seed-result-error-group-Contact-0').textContent).toContain(
        '50 × REQUIRED_FIELD_MISSING (LastName)',
      );
      expect(screen.getByTestId('seed-result-error-group-Contact-1').textContent).toContain(
        '3 × DUPLICATES_DETECTED',
      );
      expect(within(errors).queryAllByText(/Required fields are missing/)).toHaveLength(1);
    });

    it('calls a quick seed a cancel stopped cancelled, not partially complete', () => {
      render(
        <QuickSeedFlow
          quickSeed={{
            ...results,
            executionResult: { ...mockExecutionResult, status: 'partial', cancelled: true },
          }}
          orgs={mockOrgs}
        />,
      );

      const summary = screen.getByTestId('quick-seed-result-summary');
      expect(summary.textContent).toContain('Cancelled');
      expect(summary.textContent).not.toContain('Partially Complete');
    });
  });

  it('shows error banner when error is set', () => {
    const quickSeed: QuickSeedState = {
      ...baseQuickSeed,
      phase: 'confirm',
      selectedTemplate: mockTemplate,
      error: 'Connection failed',
    };

    render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);

    expect(screen.getByText('Connection failed')).toBeDefined();
  });
});
