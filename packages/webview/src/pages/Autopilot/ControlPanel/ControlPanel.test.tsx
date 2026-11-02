import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import i18n from '../../../i18n';
import en from '../../../i18n/locales/en.json';
import fr from '../../../i18n/locales/fr.json';
import { ControlPanel } from './ControlPanel';
import { useOrgStore } from '../../../stores/useOrgStore';
import { useAppStore } from '../../../stores/useAppStore';
import { developerOrg } from '../../Checkpoint/testing/checkpointFixtures';

/** Captured bridge messages sent by the control panel. */
const mockSendMessage = vi.fn();

vi.mock('../../../hooks/useMessageBus', () => ({
  useSendMessage: () => mockSendMessage,
}));

/** Mutable autopilot store mock (pause/resume flips executionStatus). */
let mockStoreState: Record<string, unknown>;

vi.mock('../../../stores/useAutopilotStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mockStoreState),
    { getState: () => mockStoreState },
  );
  return { useAutopilotStore: store };
});

/** What the panel asks of a rewind's mark, and what it answers. */
const mockMarkOf = vi.fn();
vi.mock('../../../hooks/useRewoundMarks', () => ({
  useRewoundMarks: () => mockMarkOf,
}));

describe('ControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkOf.mockReturnValue(undefined);
    mockStoreState = {
      runEnd: null,
      liveStats: {
        recordsProcessed: 0,
        recordsTotal: 100,
        apiCallsUsed: 0,
        apiCallsEstimated: 50,
        elapsedMs: 0,
        currentWave: 0,
        totalWaves: 3,
      },
      executionStatus: 'executing',
      selectedNodeName: null,
      complianceFramework: 'none',
      rules: [],
      graph: null,
      selectedNode: () => undefined,
      failedCount: () => 0,
      completedCount: () => 0,
      overallProgress: () => 0,
      setExecutionStatus: vi.fn(),
      updateNodeStatus: vi.fn(),
    };
  });

  describe('the checkpoint the run took first', () => {
    const RUN_END = {
      orgId: 'org-dev',
      startedAt: '2026-11-01T10:15:00.000Z',
      endedAt: '2026-11-01T10:25:00.000Z',
      objects: ['Account', 'Contact'],
    };

    beforeEach(() => {
      useOrgStore.setState({ orgs: [developerOrg()], selectedOrgId: 'org-dev' });
    });

    it('names it, and says it is the way back of a run with no removal', () => {
      mockStoreState = {
        ...mockStoreState,
        runEnd: {
          ...RUN_END,
          checkpoint: {
            state: 'taken' as const,
            checkpointId: 'ck-20261101-101540-a1b2',
            name: 'Before Autopilot run 2026-11-01 10:15 UTC',
            takenAt: '2026-11-01T10:15:40.000Z',
            expiresAt: '2026-11-08T10:15:40.000Z',
            objects: ['Account', 'Contact'],
            records: 38,
            bytes: 2_100_000,
            requests: 66,
            added: [],
            notHeld: [],
          },
        },
      };
      render(<ControlPanel />);

      expect(screen.getByTestId('control-checkpoint-taken').textContent).toContain(
        '“Before Autopilot run 2026-11-01 10:15 UTC”, 38 records of Account and Contact.',
      );
      expect(screen.getByTestId('control-checkpoint-beside').textContent).toContain(
        'An Autopilot run has no removal: rewinding to this checkpoint is the way back.',
      );
      expect(screen.getByTestId('control-checkpoint-action').textContent).toBe(
        'Rewind to before this run…',
      );
    });

    it('says a run that wrote nothing deleted it', () => {
      mockStoreState = {
        ...mockStoreState,
        runEnd: { ...RUN_END, checkpoint: { state: 'deleted', deleted: 'nothingWritten' } },
      };
      render(<ControlPanel />);
      expect(screen.getByTestId('control-checkpoint-deleted').textContent).toBe(
        'The checkpoint taken before the run was deleted: the run wrote nothing.',
      );
    });

    it('marks a run a rewind took back, by its own checkpoint', () => {
      mockMarkOf.mockReturnValue({
        kind: 'rewound',
        rewindId: 'rw-20261101-120000-aaaa',
        checkpointId: 'ck-20261101-101540-a1b2',
        checkpointName: 'Before Autopilot run 2026-11-01 10:15 UTC',
        at: '2026-11-01T12:00:00.000Z',
        leftSome: false,
        outside: [],
      });
      mockStoreState = {
        ...mockStoreState,
        runEnd: {
          ...RUN_END,
          checkpoint: {
            state: 'taken' as const,
            checkpointId: 'ck-20261101-101540-a1b2',
            name: 'Before Autopilot run 2026-11-01 10:15 UTC',
            takenAt: '2026-11-01T10:15:40.000Z',
            expiresAt: '2026-11-08T10:15:40.000Z',
            objects: ['Account', 'Contact'],
            records: 38,
            bytes: 2_100_000,
            requests: 66,
            added: [],
            notHeld: [],
          },
        },
      };
      render(<ControlPanel />);

      expect(mockMarkOf).toHaveBeenCalledWith({
        ...RUN_END,
        checkpointId: 'ck-20261101-101540-a1b2',
      });
      expect(screen.getByTestId('control-rewound').getAttribute('data-kind')).toBe('rewound');
    });

    it('opens the preview of a rewind to it with its mute ticked once the run muted, and unticked otherwise', () => {
      const checkpoint = {
        state: 'taken' as const,
        checkpointId: 'ck-20261101-101540-a1b2',
        name: 'Before Autopilot run 2026-11-01 10:15 UTC',
        takenAt: '2026-11-01T10:15:40.000Z',
        expiresAt: '2026-11-08T10:15:40.000Z',
        objects: ['Account', 'Contact'],
        records: 38,
        bytes: 2_100_000,
        requests: 66,
        added: [],
        notHeld: [],
      };
      mockStoreState = { ...mockStoreState, runEnd: { ...RUN_END, checkpoint } };
      useAppStore.setState({ currentRoute: 'autopilot', navigationIntent: null });
      const { unmount } = render(
        <ControlPanel
          mutedAutomation={{
            state: 'muted',
            assigned: ['Data_Load'],
            held: [],
            permissions: ['Load_Data'],
            silenced: [],
            stillRan: [],
            released: true,
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('control-checkpoint-action'));
      expect(useAppStore.getState().navigationIntent).toEqual(
        expect.objectContaining({
          previewCheckpointId: checkpoint.checkpointId,
          previewMuted: true,
        }),
      );
      unmount();

      useAppStore.setState({ currentRoute: 'autopilot', navigationIntent: null });
      render(<ControlPanel />);
      fireEvent.click(screen.getByTestId('control-checkpoint-action'));
      expect(useAppStore.getState().navigationIntent).not.toHaveProperty('previewMuted');
    });

    it('says nothing of a run that took none, and asks no mark before one ended', () => {
      render(<ControlPanel />);
      expect(screen.queryByTestId('control-checkpoint')).toBeNull();
      expect(mockMarkOf).not.toHaveBeenCalled();
    });
  });

  it('says, once the run ended, what it muted of the target’s automation, and nothing before', () => {
    const { rerender } = render(<ControlPanel />);
    expect(screen.queryByTestId('control-muted')).toBeNull();

    rerender(
      <ControlPanel
        mutedAutomation={{
          state: 'muted',
          assigned: ['Data_Load'],
          held: [],
          permissions: ['Load_Data'],
          silenced: [],
          stillRan: [
            { objectApiName: 'Account', kind: 'trigger', name: 'AccountTrigger', why: 'noBypass' },
          ],
          released: true,
        }}
      />,
    );
    expect(screen.getByTestId('control-muted-said').textContent).toMatch(
      /^Data_Load was assigned to the user the run wrote as in .*, for the run alone\.$/,
    );
    expect(screen.getByTestId('control-muted-still-ran-Account').textContent).toBe(
      'Account: Apex trigger: AccountTrigger · nothing in it tests a bypass',
    );
  });

  it('should render without crashing', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-panel')).toBeDefined();
  });

  it('should show control tabs', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-tabs')).toBeDefined();
  });

  it('should show live stats by default', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('live-stats')).toBeDefined();
  });

  it('should show action buttons when executing', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-actions')).toBeDefined();
  });

  it('should post autopilot:pause when pause is clicked', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-pause-resume'));
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'autopilot:pause' }),
    );
  });

  it('should post autopilot:resume when paused and resume is clicked', () => {
    mockStoreState.executionStatus = 'paused';
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-pause-resume'));
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'autopilot:resume' }),
    );
  });

  it('should disable skip when no node is selected', () => {
    render(<ControlPanel />);
    expect(screen.getByTestId('control-skip')).toHaveProperty('disabled', true);
  });

  describe('Stop', () => {
    it('posts execution:abort for the run, and waits for it to end', () => {
      render(<ControlPanel runOperationId="exec-1" />);

      fireEvent.click(screen.getByTestId('control-stop'));

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'execution:abort', payload: { operationId: 'exec-1' } }),
      );
      expect(screen.getByTestId('control-stop')).toHaveProperty('disabled', true);
      expect(screen.getByTestId('control-stop').textContent).toBe('Stopping…');
    });

    it('is offered while the run goes or stands paused, and not once it has ended', () => {
      const { rerender } = render(<ControlPanel runOperationId="exec-1" />);
      expect(screen.getByTestId('control-stop').textContent).toBe('Stop');

      mockStoreState.executionStatus = 'paused';
      rerender(<ControlPanel runOperationId="exec-1" />);
      expect(screen.getByTestId('control-stop')).toBeDefined();

      mockStoreState.executionStatus = 'completed';
      rerender(<ControlPanel runOperationId="exec-1" />);
      expect(screen.queryByTestId('control-stop')).toBeNull();
    });

    it('is not offered before the run has an id to name', () => {
      render(<ControlPanel />);
      expect(screen.queryByTestId('control-stop')).toBeNull();
    });

    it('lists the objects a stopped run did not write whole', () => {
      mockStoreState.executionStatus = 'completed';
      render(<ControlPanel runOperationId="exec-1" notWritten={['Contact', 'Case']} />);

      expect(screen.getByTestId('control-stopped').textContent).toBe(
        'Run stopped: nothing was written after the stop. Not written, or not whole: Contact, Case.',
      );
    });

    it('says what the stop left unfinished in the records it wrote, so the user knows what to fix', () => {
      // The stop sends neither the second pass nor the statuses set aside:
      // nothing said that accounts kept their parent empty, or orders stayed
      // drafts.
      mockStoreState.executionStatus = 'completed';
      render(
        <ControlPanel
          runOperationId="exec-1"
          notWritten={['Contact']}
          leftByStop={[
            { objectApiName: 'Account', lookupsLeftEmpty: 18 },
            { objectApiName: 'Order', lookupsLeftEmpty: 1, statusesNotGivenBack: 8 },
          ]}
        />,
      );

      const items = [...screen.getByTestId('control-stopped-left').querySelectorAll('li')];
      expect(items.map((item) => item.textContent)).toEqual([
        'Account: 18 records keep a lookup empty that the second pass would have filled.',
        'Order: 1 record keeps a lookup empty that the second pass would have filled.',
        'Order: 8 records stay drafts, without the status they had in the source.',
      ]);
    });

    it('lists nothing more when the stop left nothing unfinished', () => {
      mockStoreState.executionStatus = 'completed';
      render(<ControlPanel runOperationId="exec-1" notWritten={['Contact']} leftByStop={[]} />);

      expect(screen.queryByTestId('control-stopped-left')).toBeNull();
      expect(screen.queryByTestId('control-stopped-emails-held')).toBeNull();
    });

    it('says how many emails waiting for their task the stop kept from going', () => {
      // Read, held back until the task each names was in, and never sent:
      // nothing said so, and the email node read as written.
      mockStoreState.executionStatus = 'completed';
      const { rerender } = render(
        <ControlPanel
          runOperationId="exec-1"
          notWritten={['EmailMessage']}
          emailsHeldForTheirTask={3}
        />,
      );

      expect(screen.getByTestId('control-stopped-emails-held').textContent).toBe(
        '3 emails on a case were never sent: they waited for their task to be written, and the run stopped first.',
      );

      rerender(
        <ControlPanel
          runOperationId="exec-1"
          notWritten={['EmailMessage']}
          emailsHeldForTheirTask={1}
        />,
      );
      expect(screen.getByTestId('control-stopped-emails-held').textContent).toBe(
        '1 email on a case was never sent: it waited for its task to be written, and the run stopped first.',
      );
    });
  });

  describe('its tabs, for the keyboard and a screen reader', () => {
    it('are tabs with the open one selected, one stop in the Tab order, its panel named after it', () => {
      // Plain buttons, the open one told by its underline alone.
      render(<ControlPanel />);
      const stats = screen.getByRole('tab', { name: 'Live Stats' });
      const node = screen.getByRole('tab', { name: 'Node Detail' });
      expect(stats.getAttribute('aria-selected')).toBe('true');
      expect(node.getAttribute('aria-selected')).toBe('false');
      expect(stats.tabIndex).toBe(0);
      expect(node.tabIndex).toBe(-1);
      expect(screen.getByRole('tabpanel', { name: 'Live Stats' })).toBeDefined();
    });

    it('walk with the arrows, Home and End, the focus following the tab selected', () => {
      render(<ControlPanel />);
      const stats = screen.getByRole('tab', { name: 'Live Stats' });
      stats.focus();
      fireEvent.keyDown(stats, { key: 'ArrowRight' });
      const node = screen.getByRole('tab', { name: 'Node Detail' });
      expect(node.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(node);
      fireEvent.keyDown(node, { key: 'End' });
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Compliance' }));
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
      expect(document.activeElement).toBe(stats);
    });

    it('open on the details of a node picked on the graph', () => {
      const { rerender } = render(<ControlPanel />);
      mockStoreState = { ...mockStoreState, selectedNodeName: 'Account' };
      rerender(<ControlPanel />);
      expect(screen.getByRole('tab', { name: 'Node Detail' }).getAttribute('aria-selected')).toBe(
        'true',
      );
    });
  });

  it('says on Skip which node it skips', () => {
    mockStoreState.selectedNodeName = 'Account';
    render(<ControlPanel />);
    expect(screen.getByTestId('control-skip').textContent).toBe('Skip Account');
  });

  it('should post autopilot:skip-node with the selected object when skip is clicked', () => {
    mockStoreState.selectedNodeName = 'Account';
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-skip'));
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'autopilot:skip-node',
        payload: { objectApiName: 'Account' },
      }),
    );
  });
});

describe('ControlPanel progress bars', () => {
  beforeEach(() => {
    mockStoreState = {
      liveStats: {
        recordsProcessed: 25,
        recordsTotal: 100,
        apiCallsUsed: 10,
        apiCallsEstimated: 50,
        elapsedMs: 0,
        currentWave: 0,
        totalWaves: 3,
      },
      executionStatus: 'executing',
      selectedNodeName: 'Account',
      complianceFramework: 'none',
      rules: [],
      graph: null,
      selectedNode: () => ({
        objectApiName: 'Account',
        status: 'extracting',
        progress: 60,
        recordCount: 100,
        successCount: 60,
        failureCount: 0,
        errors: [],
      }),
      failedCount: () => 0,
      completedCount: () => 0,
      overallProgress: () => 0,
      setExecutionStatus: vi.fn(),
      updateNodeStatus: vi.fn(),
    };
  });

  it('names the live stats bars after the figure they draw', () => {
    render(<ControlPanel />);
    const records = screen.getByRole('progressbar', { name: 'Records Processed' });
    expect(records.getAttribute('aria-valuetext')).toBe('25%');
    const calls = screen.getByRole('progressbar', { name: 'API Calls' });
    expect(calls.getAttribute('aria-valuetext')).toBe('20%');
  });

  it('counts the calls the run made, and gives the plan’s calls as the estimate they are', () => {
    // The plan puts a call on each batch of the rows the scan counted, before
    // anything is read: "10 / 50" under "API Calls" read the guess as the
    // calls the run would make, where the review had said it was estimated.
    render(<ControlPanel />);
    const calls = screen.getByTestId('live-stats-api-calls');

    expect(within(calls).getByText('10')).toBeDefined();
    expect(within(calls).getByText('50 estimated API calls')).toBeDefined();
    expect(calls.textContent).not.toContain('/');
  });

  it('names the selected node progress bar', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));
    const bar = screen.getByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
  });

  it('tells a screen reader how far the run has got', () => {
    // A run of several minutes updated only silent DOM: nothing was spoken
    // from start to finish.
    render(<ControlPanel />);
    expect(screen.getByTestId('autopilot-progress-status').textContent).toBe(
      'Autopilot progress: 25%',
    );
  });

  it('tells a screen reader the run finished, and what it wrote', () => {
    mockStoreState = { ...mockStoreState, executionStatus: 'completed' };
    render(<ControlPanel />);
    expect(screen.getByTestId('autopilot-progress-status').textContent).toBe(
      'Autopilot finished. Written: 25 of 100.',
    );
  });
});

describe('ControlPanel node detail — what the node came to', () => {
  /** A settled Order node, as the handler reconciles it at the end of a run. */
  function settledOrder(overrides: Record<string, unknown> = {}) {
    return {
      objectApiName: 'Order',
      status: 'completed',
      progress: 100,
      recordCount: 11,
      successCount: 8,
      failureCount: 2,
      linkedCount: 1,
      errors: [],
      refusals: [
        {
          statusCode: 'INVALID_CROSS_REFERENCE_KEY',
          fields: ['Pricebook2Id'],
          count: 2,
          message: 'invalid cross reference id',
        },
      ],
      statusesApplied: 2,
      statusRefusals: [
        {
          statusCode: 'FIELD_INTEGRITY_EXCEPTION',
          fields: [],
          count: 1,
          message: 'Commande sans produit',
        },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    mockStoreState = {
      liveStats: {
        recordsProcessed: 0,
        recordsTotal: 0,
        apiCallsUsed: 0,
        apiCallsEstimated: 0,
        elapsedMs: 0,
        currentWave: 0,
        totalWaves: 0,
      },
      executionStatus: 'completed',
      selectedNodeName: 'Order',
      complianceFramework: 'none',
      rules: [],
      graph: null,
      selectedNode: () => settledOrder(),
      failedCount: () => 0,
      completedCount: () => 0,
      overallProgress: () => 0,
      setExecutionStatus: vi.fn(),
      updateNodeStatus: vi.fn(),
    };
  });

  it('says why records were refused: the code, the fields, how many and the message', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    const refusals = screen.getByTestId('node-refusals');
    expect(refusals.textContent).toContain('INVALID_CROSS_REFERENCE_KEY');
    expect(refusals.textContent).toContain('Pricebook2Id');
    expect(refusals.textContent).toContain('2 records');
    expect(refusals.textContent).toContain('invalid cross reference id');
  });

  it('says under each refusal what it means and what to do, as Forge says it of the same code', () => {
    // The list printed the code and the org's words, with no next step.
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    const hint = within(screen.getByTestId('node-refusals')).getByTestId('error-hint');
    expect(hint.textContent).toContain(en.errors.invalidCrossReferenceKey.explanation);
    expect(hint.textContent).toContain(en.errors.invalidCrossReferenceKey.action);
    expect(within(hint).getByRole('link').textContent).toBe(
      'Search Salesforce Help for INVALID_CROSS_REFERENCE_KEY',
    );
  });

  it('shows the records linked to what the target held, and the statuses given back', () => {
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    expect(screen.getByTestId('node-linked').textContent).toContain('1');
    expect(screen.getByTestId('node-statuses').textContent).toContain('2');
    const statusRefusals = screen.getByTestId('node-status-refusals');
    expect(statusRefusals.textContent).toContain('FIELD_INTEGRITY_EXCEPTION');
    expect(statusRefusals.textContent).toContain('1 record');
  });

  it('shows the records left out because the platform writes them, or what they depend on, itself', () => {
    // A tracked change is never sent — the platform refuses one from a copy —
    // and neither written nor refused, it would count nowhere else.
    mockStoreState.selectedNode = () => settledOrder({ leftToThePlatform: 3 });
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    const leftOut = screen.getByTestId('node-left-to-the-platform');
    expect(leftOut.textContent).toContain('the platform writes them');
    expect(leftOut.textContent).toContain('3');
  });

  it('says the records written in another currency, and what became of their amounts', () => {
    // Said by the command line alone, the panel's node showed nothing of a
    // GBP opportunity written in USD, its amounts converted.
    mockStoreState.selectedNode = () =>
      settledOrder({
        currenciesReplaced: [
          {
            objectApiName: 'Order',
            from: 'GBP',
            to: 'USD',
            chosenBy: 'corporate',
            rows: 2,
            fields: ['TotalAmount'],
          },
        ],
      });
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    expect(screen.getByTestId('forge-results-currencies-row').textContent).toBe(
      "Order — 2 rows in GBP, written in USD, the target org's corporate currency — amounts " +
        "converted at the source org's rates: TotalAmount",
    );
  });

  it('says the prices left out for their own in the currency written, and linked to it', () => {
    // Read with the source's own USD price of the same product, a GBP price
    // went in USD beside it, and the target refused one: DUPLICATE_VALUE.
    mockStoreState.selectedNode = () =>
      settledOrder({
        pricesSettled: [{ from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 2 }],
      });
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    expect(screen.getByTestId('results-price-currencies-row').textContent).toBe(
      "2 prices in GBP, replaced by the source org's own price in USD for the same product and " +
        'price book, and linked to its copy',
    );
  });

  describe('a record held back under a parent the run did not write', () => {
    /** The node of the lines a run held back, as the handler settles it. */
    const heldLines = () =>
      settledOrder({
        objectApiName: 'OpportunityLineItem',
        refusals: [
          {
            statusCode: 'PARENT_NOT_WRITTEN',
            fields: ['OpportunityId'],
            count: 2,
            message:
              'the Opportunity record its OpportunityId names was not written: Opportunity was ' +
              'skipped in this run, and written without it this record would stand without its ' +
              'Opportunity.',
          },
          {
            statusCode: 'PARENT_NOT_WRITTEN',
            fields: ['Product2Id'],
            count: 1,
            message:
              "the Product2 record its Product2Id names was not written: the run's write of " +
              'Product2 failed, and written without it this record would stand without its Product2.',
          },
        ],
        statusRefusals: undefined,
      });

    it('says on its line why the parent was not written, and what to do about each', () => {
      mockStoreState.selectedNode = heldLines;
      render(<ControlPanel />);
      fireEvent.click(screen.getByTestId('control-tab-node'));

      const lines = within(screen.getByTestId('node-refusals')).getAllByRole('listitem');
      expect(lines.map((line) => line.textContent)).toEqual([
        expect.stringContaining('Opportunity was skipped in this run'),
        expect.stringContaining("the run's write of Product2 failed"),
      ]);
      const [skipped, failed] = lines.map((line) => within(line).getByTestId('error-hint'));
      expect(skipped.textContent).toContain(en.errors.parentNotWritten.skipped.explanation);
      expect(skipped.textContent).toContain(en.errors.parentNotWritten.skipped.action);
      expect(failed.textContent).toContain(en.errors.parentNotWritten.failed.explanation);
      expect(failed.textContent).toContain(en.errors.parentNotWritten.failed.action);
      // Its own code: no search of Salesforce Help for it.
      expect(within(skipped).queryByRole('link')).toBeNull();
    });

    it('says it in the panel’s language', async () => {
      mockStoreState.selectedNode = heldLines;
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await act(async () => {
        await i18n.changeLanguage('fr');
      });
      try {
        render(<ControlPanel />);
        fireEvent.click(screen.getByTestId('control-tab-node'));

        const hints = within(screen.getByTestId('node-refusals')).getAllByTestId('error-hint');
        expect(hints[0].textContent).toContain(fr.errors.parentNotWritten.skipped.explanation);
        expect(hints[1].textContent).toContain(fr.errors.parentNotWritten.failed.action);
      } finally {
        await act(async () => {
          await i18n.changeLanguage('en');
        });
      }
    });
  });

  describe('a node that held back records for record types the running user cannot use', () => {
    /** Two of the deals on one closed type, one on another; the others written. */
    const heldDeals = () =>
      settledOrder({
        objectApiName: 'Opportunity',
        recordCount: 3,
        successCount: 3,
        failureCount: 3,
        linkedCount: 0,
        refusals: [
          {
            statusCode: 'RECORD_TYPE_UNAVAILABLE',
            fields: ['RecordTypeId'],
            count: 2,
            message:
              '2 Opportunity records use record type Hidden_Deal, which the running user cannot ' +
              'use in the target org. Give the running user access to record type Hidden_Deal ' +
              'on Opportunity, or map it to one they have.',
          },
          {
            statusCode: 'RECORD_TYPE_UNAVAILABLE',
            fields: ['RecordTypeId'],
            count: 1,
            message:
              '1 Opportunity record uses record type Partner_Deal, which the running user cannot ' +
              'use in the target org. Give the running user access to record type Partner_Deal ' +
              'on Opportunity, or map it to one they have.',
          },
        ],
        statusRefusals: undefined,
      });

    it('says each record type on a line of its own, with its records and what to change', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockStoreState.selectedNode = heldDeals;
      try {
        render(<ControlPanel />);
        fireEvent.click(screen.getByTestId('control-tab-node'));

        const lines = within(screen.getByTestId('node-refusals')).getAllByRole('listitem');
        expect(lines.map((line) => line.textContent)).toEqual([
          expect.stringMatching(/2 records.*record type Hidden_Deal/),
          expect.stringMatching(/1 record.*record type Partner_Deal/),
        ]);
        // Both lines under one code and field: React said two children had
        // the same key, and may keep one line for the other.
        expect(consoleError.mock.calls.map(([first]) => String(first))).not.toContainEqual(
          expect.stringContaining('same key'),
        );
      } finally {
        consoleError.mockRestore();
      }
    });

    it('says under them that the records on the type were held back, not the whole object', () => {
      // The node wrote three of six: the hint said the object was held back
      // before any of its records were written.
      mockStoreState.selectedNode = heldDeals;
      render(<ControlPanel />);
      fireEvent.click(screen.getByTestId('control-tab-node'));

      const [hint] = within(screen.getByTestId('node-refusals')).getAllByTestId('error-hint');
      expect(hint.textContent).toContain(en.errors.recordTypeHeldBack.explanation);
      expect(en.errors.recordTypeHeldBack.explanation).toContain(
        'the records on it were held back',
      );
      expect(hint.textContent).not.toContain('object was held back');
      expect(hint.textContent).toContain(en.errors.recordTypeHeldBack.action);
    });
  });

  it('shows none of it for a node that wrote everything', () => {
    mockStoreState.selectedNode = () =>
      settledOrder({
        failureCount: 0,
        linkedCount: 0,
        refusals: [],
        statusesApplied: undefined,
        statusRefusals: undefined,
      });
    render(<ControlPanel />);
    fireEvent.click(screen.getByTestId('control-tab-node'));

    expect(screen.queryByTestId('node-refusals')).toBeNull();
    expect(screen.queryByTestId('node-linked')).toBeNull();
    expect(screen.queryByTestId('node-statuses')).toBeNull();
    expect(screen.queryByTestId('node-left-to-the-platform')).toBeNull();
    expect(screen.queryByTestId('forge-results-currencies')).toBeNull();
  });
});
