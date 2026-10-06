import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '../../i18n';
import { ForgeReview } from './ForgeReview';
import type { ForgeGraphNode, ForgeGraph } from '../../stores/useForgeStore';
import { FORGE_GRAPH_MAX_OBJECTS, useForgeViewStore } from '../../stores/useForgeViewStore';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';
import type { ForgeAnonymizationCategory, AnonymizationMethod } from '@sandforge/shared';
import { useForgeRunGateStore } from './runGate';

/* ---- Mocks ---- */

const mockSetPhase = vi.fn();
const mockToggleNodeIncluded = vi.fn();
const mockSendBridgeMessage = vi.fn();
const mockSetExecutionRequestId = vi.fn();
const mockSetPlan = vi.fn();
const mockFillPersonalFields = vi.fn();
const mockSetMetadataDiffs = vi.fn();
const mockSetGaps = vi.fn();

vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (...args: unknown[]) => mockSendBridgeMessage(...args),
}));

function makeNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

const defaultGraph: ForgeGraph = {
  nodes: [
    makeNode({ objectApiName: 'Account', piiFields: ['Email'] }),
    makeNode({ objectApiName: 'Contact', piiFields: ['Phone', 'FirstName'] }),
  ],
  edges: [],
  totalRecords: 200,
  estimatedSizeMB: 2,
  estimatedDurationSeconds: 10,
};

/** Only the ForgeConfig fields ForgeReview reads. */
interface MockConfig {
  anonymizePII: boolean;
  sourceOrgId: string;
  targetOrgId: string;
  applyAssignmentRules?: boolean;
}

const defaultConfig: MockConfig = {
  anonymizePII: true,
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
};

let mockGraph: ForgeGraph | null = defaultGraph;
let mockConfig: MockConfig | null = { ...defaultConfig };
let mockMetadataDiffs: MetadataDiffEntry[] = [];
/** The file choice Review holds. */
const NO_FILES = { enabled: false, maxFileSizeMB: 10, acceptedAsIs: false };
let mockFileCopy = { ...NO_FILES };
const mockAnonymizationRules: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
  email: 'fake',
  phone: 'mask',
  name: 'fake',
  address: 'fake',
  ssn_id: 'redact',
  financial: 'hash',
  other: 'nullify',
};

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    get graph() {
      return mockGraph;
    },
    get config() {
      return mockConfig;
    },
    get metadataDiffs() {
      return mockMetadataDiffs;
    },
    get anonymizationRules() {
      return mockAnonymizationRules;
    },
    get fileCopy() {
      return mockFileCopy;
    },
    setFileCopy: vi.fn(),
    plan: null,
    complianceReport: null,
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    setExecutionRequestId: (...args: unknown[]) => mockSetExecutionRequestId(...args),
    resetNodeStatuses: vi.fn(),
    toggleNodeIncluded: (...args: unknown[]) => mockToggleNodeIncluded(...args),
    setPlan: (...args: unknown[]) => mockSetPlan(...args),
    fillPersonalFields: (...args: unknown[]) => mockFillPersonalFields(...args),
    setMetadataDiffs: (...args: unknown[]) => mockSetMetadataDiffs(...args),
    setGaps: (...args: unknown[]) => mockSetGaps(...args),
    setAnonymizationRule: vi.fn(),
    updateNodeBatchStrategy: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );
  return { useForgeStore: store };
});

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: ({ onIncludeToggle }: { onIncludeToggle?: (name: string) => void }) => (
    <div data-testid="live-graph">
      <button data-testid="mock-toggle-Account" onClick={() => onIncludeToggle?.('Account')}>
        Toggle Account
      </button>
    </div>
  ),
}));

/* ---- Tests ---- */

describe('ForgeReview', () => {
  beforeEach(() => {
    mockSetPhase.mockClear();
    mockToggleNodeIncluded.mockClear();
    // Reset, not cleared: a test may give the requests an id to answer.
    mockSendBridgeMessage.mockReset();
    mockSetGaps.mockClear();
    mockSetPlan.mockClear();
    mockFillPersonalFields.mockClear();
    mockSetMetadataDiffs.mockClear();
    mockGraph = defaultGraph;
    mockConfig = { ...defaultConfig };
    mockMetadataDiffs = [];
    mockFileCopy = { ...NO_FILES };
    useForgeViewStore.setState({ setting: 'auto', choice: null });
  });

  /** Deliver an extension -> webview message the way the real bus does. */
  function sendFromExtension(type: string, payload: Record<string, unknown>): void {
    // act(): the listener sets React state, so the re-render has to be
    // flushed before asserting on the DOM.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type, id: `resp-${type}`, timestamp: Date.now(), payload },
          origin: '',
        }),
      );
    });
  }

  it('should render with data-testid="forge-review"', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('forge-review')).toBeDefined();
  });

  it('should have 5 tabs (plan, anonymization, compliance, metadata, automation)', () => {
    render(<ForgeReview />);
    expect(screen.getAllByRole('tab').map((tab) => tab.id)).toEqual([
      'tab-plan',
      'tab-anonymization',
      'tab-compliance',
      'tab-metadata',
      'tab-automation',
    ]);
  });

  it('should have Plan tab active by default', () => {
    render(<ForgeReview />);
    // ReviewPlanTab renders plan-loading when plan is null
    expect(screen.getByTestId('plan-loading')).toBeDefined();
  });

  it('should render execute button', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('execute-button')).toBeDefined();
  });

  it('should call setPhase("discovery") when back button clicked', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('back-button'));
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
  });

  it('should send forge:execute with the graph and config when execute button clicked', () => {
    mockSendBridgeMessage.mockImplementation((type: unknown) =>
      type === 'forge:execute' ? 'wv-forge-request' : 'wv-other-request',
    );
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('execute-button'));
    // The phase switch alone is not the behaviour under test: without this
    // request the extension never starts the run (regression guard for the
    // wiring gap where the button only ever called setPhase).
    expect(mockSendBridgeMessage).toHaveBeenCalledWith('forge:execute', {
      graph: defaultGraph,
      config: mockConfig,
      anonymizationRules: mockAnonymizationRules,
    });
    expect(mockSetPhase).toHaveBeenCalledWith('execution');
    // Mission control reads it to ignore messages answering another run.
    expect(mockSetExecutionRequestId).toHaveBeenCalledWith('wv-forge-request');
  });

  it('sends the method chosen for each PII category with the run', () => {
    mockAnonymizationRules.phone = 'redact';
    try {
      render(<ForgeReview />);
      fireEvent.click(screen.getByTestId('execute-button'));

      const [, payload] = mockSendBridgeMessage.mock.calls.find(
        ([type]) => type === 'forge:execute',
      ) as [string, { anonymizationRules: Record<string, string> }];
      expect(payload.anonymizationRules.phone).toBe('redact');
    } finally {
      mockAnonymizationRules.phone = 'mask';
    }
  });

  it('says why the last run stopped at its gate, and forgets it once the next run starts', () => {
    act(() => useForgeRunGateStore.getState().setStop({ code: 'WRITE_DECLINED' }));
    render(<ForgeReview />);

    expect(screen.getByTestId('forge-run-gate-notice').textContent).toContain(
      'You cancelled the run before it wrote anything.',
    );

    fireEvent.click(screen.getByTestId('execute-button'));

    expect(useForgeRunGateStore.getState().stop).toBeNull();
    expect(screen.queryByTestId('forge-run-gate-notice')).toBeNull();
  });

  it('says before the run what the objects the user left out cost it', () => {
    mockGraph = {
      ...defaultGraph,
      nodes: [
        makeNode({ objectApiName: 'Opportunity' }),
        makeNode({ objectApiName: 'OpportunityLineItem', level: 1 }),
        makeNode({
          objectApiName: 'PricebookEntry',
          level: 2,
          included: false,
          leftOutByUser: true,
        }),
      ],
      edges: [
        {
          sourceObject: 'PricebookEntry',
          targetObject: 'OpportunityLineItem',
          relationshipName: 'PricebookEntry',
          type: 'lookup',
          required: true,
        },
      ],
    };
    render(<ForgeReview />);

    expect(screen.getByTestId('forge-left-out-cost-row').textContent).toBe(
      'OpportunityLineItem: records that need a record of PricebookEntry are not written, unless the target already holds it.',
    );
  });

  it('says nothing of a cost while the user left nothing out', () => {
    render(<ForgeReview />);
    expect(screen.queryByTestId('forge-left-out-cost')).toBeNull();
  });

  it('should not send forge:execute when the graph is missing', () => {
    mockGraph = null;
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(mockSendBridgeMessage).not.toHaveBeenCalled();
    expect(mockSetPhase).not.toHaveBeenCalledWith('execution');
  });

  describe('the graph or its table', () => {
    /** A graph of `count` objects, as a wide discovery answers. */
    function graphOf(count: number): ForgeGraph {
      return {
        ...defaultGraph,
        nodes: Array.from({ length: count }, (_, i) =>
          makeNode({ objectApiName: `Object${String(i)}__c` }),
        ),
      };
    }

    it('lists a graph of more objects than auto draws, each box leaving out its own object', () => {
      mockGraph = graphOf(FORGE_GRAPH_MAX_OBJECTS + 1);
      render(<ForgeReview />);

      expect(screen.getByTestId('forge-table-view')).toBeDefined();
      expect(screen.queryByTestId('live-graph')).toBeNull();
      expect(screen.getAllByTestId('forge-table-row')).toHaveLength(FORGE_GRAPH_MAX_OBJECTS + 1);

      fireEvent.click(screen.getByTestId('forge-table-include-Object3__c'));
      expect(mockToggleNodeIncluded).toHaveBeenCalledWith('Object3__c');
    });

    it('draws a graph of that many objects, and follows the setting and the switch', () => {
      mockGraph = graphOf(FORGE_GRAPH_MAX_OBJECTS);
      const { unmount } = render(<ForgeReview />);
      expect(screen.getByTestId('live-graph')).toBeDefined();
      unmount();

      useForgeViewStore.getState().adoptSetting('table');
      render(<ForgeReview />);
      expect(screen.getByTestId('forge-table-view')).toBeDefined();

      fireEvent.click(screen.getByTestId('forge-view-graph'));
      expect(screen.getByTestId('live-graph')).toBeDefined();
      expect(useForgeViewStore.getState().choice).toBe('graph');
    });
  });

  describe('the files of the cloned records', () => {
    /** What the run was sent, once Execute was clicked. */
    function executePayload(): Record<string, unknown> | undefined {
      const call = mockSendBridgeMessage.mock.calls.find(([type]) => type === 'forge:execute');
      return call?.[1] as Record<string, unknown> | undefined;
    }

    it('offers the choice with the run, off', () => {
      render(<ForgeReview />);

      expect(screen.getByTestId('forge-files-toggle')).toHaveProperty('checked', false);
      fireEvent.click(screen.getByTestId('execute-button'));
      expect(executePayload()).not.toHaveProperty('files');
    });

    it('sends the size and the acceptance with a run that copies files', () => {
      mockConfig = { ...defaultConfig, anonymizePII: false };
      mockFileCopy = { enabled: true, maxFileSizeMB: 4, acceptedAsIs: false };
      render(<ForgeReview />);

      fireEvent.click(screen.getByTestId('execute-button'));

      expect(executePayload()?.files).toEqual({ maxFileSizeMB: 4, acceptedAsIs: false });
    });

    it('holds Execute while the run anonymizes and the files were not accepted as they are', () => {
      mockFileCopy = { enabled: true, maxFileSizeMB: 10, acceptedAsIs: false };
      render(<ForgeReview />);

      const execute = screen.getByTestId('execute-button');
      expect(execute).toHaveProperty('disabled', true);
      expect(execute.getAttribute('aria-describedby')).toBe('forge-files-execute-hint');
      expect(screen.getByTestId('forge-files-execute-hint').textContent).toContain(
        'copied as they are',
      );
      fireEvent.click(execute);
      expect(executePayload()).toBeUndefined();
    });

    it('lets a run that anonymizes go once the files were accepted as they are', () => {
      mockFileCopy = { enabled: true, maxFileSizeMB: 10, acceptedAsIs: true };
      render(<ForgeReview />);

      fireEvent.click(screen.getByTestId('execute-button'));

      expect(executePayload()?.files).toEqual({ maxFileSizeMB: 10, acceptedAsIs: true });
      expect(screen.queryByTestId('forge-files-execute-hint')).toBeNull();
    });
  });

  describe('plan channel', () => {
    it('should store the plan when forge:plan:response arrives', () => {
      render(<ForgeReview />);
      // useForgeForm sends forge:plan:request and the extension answers, but
      // nothing consumed the reply — the Plan tab showed "Generating execution
      // plan…" for the rest of the session.
      const plan = { waves: [], cycleResolutions: [] };
      sendFromExtension('forge:plan:response', { plan });

      expect(mockSetPlan).toHaveBeenCalledWith(plan);
      expect(mockFillPersonalFields).not.toHaveBeenCalled();
    });

    it('takes the personal fields a starter template’s graph comes back with', () => {
      render(<ForgeReview />);
      const plan = { waves: [], cycleResolutions: [] };
      const graph = {
        ...defaultGraph,
        nodes: [makeNode({ objectApiName: 'Contact', piiFields: ['LastName'] })],
      };
      sendFromExtension('forge:plan:response', { plan, graph });

      expect(mockSetPlan).toHaveBeenCalledWith(plan);
      expect(mockFillPersonalFields).toHaveBeenCalledWith(graph);
    });

    it('should surface forge:plan:error instead of loading forever', () => {
      render(<ForgeReview />);
      sendFromExtension('forge:plan:error', { message: 'Describe failed on Account' });

      expect(screen.getByTestId('plan-error').textContent).toContain('Describe failed on Account');
      expect(screen.queryByTestId('plan-loading')).toBeNull();
    });
  });

  describe('metadata-diff channel', () => {
    /** The metadata-diff requests recorded on the mocked transport. */
    function diffRequests(): unknown[][] {
      return mockSendBridgeMessage.mock.calls.filter(
        (call) => call[0] === 'forge:metadata-diff:request',
      );
    }

    it('should request the diff on mount with the org ids and graph objects', () => {
      render(<ForgeReview />);
      // The channel was routed and implemented on the extension side but never
      // sent, so metadataDiffs had no writer at all.
      expect(mockSendBridgeMessage).toHaveBeenCalledWith('forge:metadata-diff:request', {
        sourceOrgId: 'src-org',
        targetOrgId: 'tgt-org',
        objectApiNames: ['Account', 'Contact'],
      });
    });

    it('should request the diff only once when the graph identity changes', () => {
      const { rerender } = render(<ForgeReview />);
      // Toggling a node replaces the graph object in the store, which is a
      // dependency of the request effect. The handler emits an
      // operation:started per request, so every toggle would otherwise push a
      // phantom operation into the activity feed.
      mockGraph = { ...defaultGraph, nodes: [...defaultGraph.nodes] };
      rerender(<ForgeReview />);
      mockGraph = { ...defaultGraph, nodes: [...defaultGraph.nodes] };
      rerender(<ForgeReview />);

      expect(diffRequests()).toHaveLength(1);
    });

    it('should cap the requested objects at the 100 the extension schema accepts', () => {
      mockGraph = {
        ...defaultGraph,
        nodes: Array.from({ length: 120 }, (_, i) => makeNode({ objectApiName: `Obj${i}__c` })),
      };
      render(<ForgeReview />);

      const payload = diffRequests()[0][1] as { objectApiNames: string[] };
      expect(payload.objectApiNames).toHaveLength(100);
    });

    it('should not request the diff when the config is missing', () => {
      mockConfig = null;
      render(<ForgeReview />);
      expect(diffRequests()).toHaveLength(0);
    });

    it('should store the diffs when forge:metadata-diff:response arrives', () => {
      render(<ForgeReview />);
      const diffs = [
        {
          objectApiName: 'Account',
          fieldApiName: 'CustomField__c',
          issue: 'missing',
          severity: 'error',
          details: 'Field does not exist in target org',
        },
      ];
      sendFromExtension('forge:metadata-diff:response', { diffs });

      expect(mockSetMetadataDiffs).toHaveBeenCalledWith(diffs);
    });

    it('should show the metadata tab as pending until the response lands', () => {
      render(<ForgeReview />);
      fireEvent.click(screen.getByTestId('tab-metadata'));
      // An empty diff list means "not compared yet" while the request is in
      // flight; "no differences" there would be a lie.
      expect(screen.getByTestId('metadata-loading')).toBeDefined();
      expect(screen.queryByTestId('no-diffs')).toBeNull();

      sendFromExtension('forge:metadata-diff:response', { diffs: [] });
      expect(screen.getByTestId('no-diffs')).toBeDefined();
    });

    it('should surface forge:metadata-diff:error instead of loading forever', () => {
      render(<ForgeReview />);
      fireEvent.click(screen.getByTestId('tab-metadata'));
      sendFromExtension('forge:metadata-diff:error', {
        message: 'Metadata diff service not configured',
      });

      expect(screen.getByTestId('metadata-error').textContent).toContain(
        'Metadata diff service not configured',
      );
      expect(screen.queryByTestId('metadata-loading')).toBeNull();
    });
  });

  describe('gaps channel', () => {
    /** The gaps requests recorded on the mocked transport. */
    function gapsRequests(): unknown[][] {
      return mockSendBridgeMessage.mock.calls.filter((call) => call[0] === 'forge:gaps:request');
    }

    it('asks, as Review opens, what the target holds against the rows, with the graph and the config', () => {
      mockSendBridgeMessage.mockReturnValue('gaps-request-1');
      render(<ForgeReview />);
      expect(gapsRequests()).toEqual([
        ['forge:gaps:request', { graph: defaultGraph, config: defaultConfig }],
      ]);
      expect(screen.getByTestId('forge-gaps-read').textContent).toBe(
        'Reading what the target org holds against the rows…',
      );
    });

    it('asks it once, however often the graph changes, and keeps the answer as the metadata gaps', () => {
      mockSendBridgeMessage.mockReturnValue('gaps-request-1');
      const { rerender } = render(<ForgeReview />);
      mockGraph = { ...defaultGraph, nodes: [...defaultGraph.nodes] };
      rerender(<ForgeReview />);
      expect(gapsRequests()).toHaveLength(1);

      const gaps = { gaps: [], unread: [], requests: 5 };
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'forge:gaps:response',
              id: 'resp-gaps',
              timestamp: Date.now(),
              correlationId: 'gaps-request-1',
              payload: { gaps },
            },
            origin: '',
          }),
        );
      });
      expect(mockSetGaps).toHaveBeenCalledWith('metadata', []);
      expect(screen.getByTestId('forge-gaps-read-found').textContent).toBe(
        "0 gaps read from the target org's metadata. Read in 5 requests to the target org.",
      );
    });
  });

  describe('automation channel', () => {
    /** The automation requests recorded on the mocked transport. */
    function automationRequests(): unknown[][] {
      return mockSendBridgeMessage.mock.calls.filter(
        (call) => call[0] === 'forge:automation:request',
      );
    }

    /** A flow of the target that starts after a record of `objectApiName` is created. */
    const createdFlow = (objectApiName: string) => ({
      objectApiName,
      flows: [
        {
          apiName: `${objectApiName}_Welcome`,
          label: `${objectApiName} welcome`,
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
        },
      ],
      triggers: [{ name: `${objectApiName}Trigger`, events: ['afterUpdate'] }],
    });

    const automation = {
      objectsRead: ['Account', 'Contact'],
      objects: [createdFlow('Account'), createdFlow('Contact')],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 4,
    };

    it('asks, as Review opens, what the target runs on the objects the run writes, with the graph', () => {
      render(<ForgeReview />);
      expect(automationRequests()).toEqual([
        ['forge:automation:request', { targetOrgId: 'tgt-org', graph: defaultGraph }],
      ]);
    });

    it('asks it once, however often the graph changes', () => {
      const { rerender } = render(<ForgeReview />);
      mockGraph = { ...defaultGraph, nodes: [...defaultGraph.nodes] };
      rerender(<ForgeReview />);
      expect(automationRequests()).toHaveLength(1);
    });

    it('asks it for an object the user left out too, so taking it back in needs no second read', () => {
      mockGraph = {
        ...defaultGraph,
        nodes: [
          defaultGraph.nodes[0],
          makeNode({ objectApiName: 'Contact', included: false, leftOutByUser: true }),
          makeNode({ objectApiName: 'Note', included: false, recordCount: 0 }),
        ],
      };
      render(<ForgeReview />);

      const { graph } = automationRequests()[0][1] as { graph: ForgeGraph };
      expect(graph.nodes.map((n) => [n.objectApiName, n.included])).toEqual([
        ['Account', true],
        ['Contact', true],
        // An empty table discovery left out stays out.
        ['Note', false],
      ]);
    });

    it('shows what fires once the answer lands, and counts on the tab what fires as the run inserts', () => {
      render(<ForgeReview />);
      fireEvent.click(screen.getByTestId('tab-automation'));
      expect(screen.getByTestId('automation-loading')).toBeDefined();

      sendFromExtension('forge:automation:response', { automation });

      expect(screen.getByTestId('automation-object-Account')).toBeDefined();
      expect(screen.getByTestId('automation-object-Contact')).toBeDefined();
      // One flow on each object fires at insert; the triggers run on update.
      expect(screen.getByTestId('tab-automation').textContent).toBe('Automation2');
    });

    it('stops counting and showing what fires on an object the user leaves out after the read', () => {
      const { rerender } = render(<ForgeReview />);
      sendFromExtension('forge:automation:response', { automation });
      fireEvent.click(screen.getByTestId('tab-automation'));

      mockGraph = {
        ...defaultGraph,
        nodes: [
          defaultGraph.nodes[0],
          makeNode({ objectApiName: 'Contact', included: false, leftOutByUser: true }),
        ],
      };
      rerender(<ForgeReview />);

      expect(screen.queryByTestId('automation-object-Contact')).toBeNull();
      expect(screen.getByTestId('tab-automation').textContent).toBe('Automation1');
    });

    it('says the assignment rules apply when the run is set to apply them, and not otherwise', () => {
      const ruled = {
        ...automation,
        objectsRead: ['Lead'],
        objects: [
          {
            objectApiName: 'Lead',
            flows: [],
            triggers: [],
            assignmentRules: [{ name: 'Lead routing' }],
          },
        ],
      };
      const applied = () =>
        within(screen.getByTestId('automation-Lead-rules')).getByRole('listitem').textContent;

      const { unmount } = render(<ForgeReview />);
      sendFromExtension('forge:automation:response', { automation: ruled });
      fireEvent.click(screen.getByTestId('tab-automation'));
      expect(applied()).toContain('Not applied');
      unmount();

      mockConfig = { ...defaultConfig, applyAssignmentRules: true };
      render(<ForgeReview />);
      sendFromExtension('forge:automation:response', { automation: ruled });
      fireEvent.click(screen.getByTestId('tab-automation'));
      expect(applied()).toContain('Applied: this run asks the target org to apply it');
    });

    it('shows forge:automation:error instead of reading forever', () => {
      render(<ForgeReview />);
      fireEvent.click(screen.getByTestId('tab-automation'));
      sendFromExtension('forge:automation:error', {
        message: 'Target automation reader not configured',
      });
      expect(screen.getByTestId('automation-error').textContent).toBe(
        'Target automation reader not configured',
      );
    });

    it('never holds back the run while the read is on its way', () => {
      render(<ForgeReview />);
      expect((screen.getByTestId('execute-button') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('should disable anonymization tab when anonymizePII is false', () => {
    mockConfig = { ...defaultConfig, anonymizePII: false };
    render(<ForgeReview />);
    const anonTab = screen.getByTestId('tab-anonymization');
    expect(anonTab).toHaveProperty('disabled', true);
  });

  it('should show PII badge on anonymization tab', () => {
    render(<ForgeReview />);
    const anonTab = screen.getByTestId('tab-anonymization');
    // 1 PII from Account + 2 from Contact = 3
    expect(anonTab.textContent).toContain('3');
  });

  it('should show metadata badge when diffs are present', () => {
    mockMetadataDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'X',
        issue: 'missing',
        severity: 'error',
        details: 'x',
      },
    ];
    render(<ForgeReview />);
    const metaTab = screen.getByTestId('tab-metadata');
    expect(metaTab.textContent).toContain('1');
  });

  it('should switch tabs on click', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('tab-compliance'));
    // ReviewComplianceTab renders no-compliance by default
    expect(screen.getByTestId('review-compliance-tab')).toBeDefined();
  });

  it('should render live graph and support include toggle', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('live-graph')).toBeDefined();
    fireEvent.click(screen.getByTestId('mock-toggle-Account'));
    expect(mockToggleNodeIncluded).toHaveBeenCalledWith('Account');
  });

  /* ---- A11Y: Tab ARIA roles ---- */

  it('should have role="tablist" on the tab container', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('review-tabs').getAttribute('role')).toBe('tablist');
  });

  it('should have role="tab" and aria-selected on each tab button', () => {
    render(<ForgeReview />);
    const planTab = screen.getByTestId('tab-plan');
    const complianceTab = screen.getByTestId('tab-compliance');
    expect(planTab.getAttribute('role')).toBe('tab');
    expect(planTab.getAttribute('aria-selected')).toBe('true');
    expect(complianceTab.getAttribute('role')).toBe('tab');
    expect(complianceTab.getAttribute('aria-selected')).toBe('false');
  });

  it('should update aria-selected when switching tabs', () => {
    render(<ForgeReview />);
    const planTab = screen.getByTestId('tab-plan');
    const complianceTab = screen.getByTestId('tab-compliance');
    expect(planTab.getAttribute('aria-selected')).toBe('true');
    expect(complianceTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(complianceTab);
    expect(planTab.getAttribute('aria-selected')).toBe('false');
    expect(complianceTab.getAttribute('aria-selected')).toBe('true');
  });

  it('should have role="tabpanel" with aria-labelledby on tab content', () => {
    render(<ForgeReview />);
    const tabpanel = screen.getByRole('tabpanel');
    expect(tabpanel.getAttribute('id')).toBe('tabpanel-plan');
    expect(tabpanel.getAttribute('aria-labelledby')).toBe('tab-plan');
  });
});
