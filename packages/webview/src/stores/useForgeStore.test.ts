import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runElapsedSeconds, settledPercent, useForgeStore } from './useForgeStore';
import type {
  ForgeConfig,
  ForgeGraph,
  ForgeGraphNode,
  ForgeExecutionResult,
  ForgePlan,
  ForgeTemplate,
} from './useForgeStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
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

function createMockGraph(nodes?: ForgeGraphNode[]): ForgeGraph {
  return {
    nodes: nodes ?? [
      createMockNode({ objectApiName: 'Account' }),
      createMockNode({ objectApiName: 'Contact', level: 1 }),
    ],
    edges: [],
    totalRecords: 200,
    estimatedSizeMB: 3.5,
    estimatedDurationSeconds: 30,
  };
}

function createMockConfig(overrides: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    inputMode: 'record',
    depth: 'direct',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...overrides,
  };
}

function createMockResult(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'exec-001',
    status: 'success',
    graph: createMockGraph(),
    duration: 5000,
    timestamp: new Date().toISOString(),
    idRemapCount: 10,
    ...overrides,
  };
}

function createMockPlan(): ForgePlan {
  return {
    waves: [
      {
        order: 0,
        objectApiNames: ['Account'],
        totalRecords: 100,
        estimatedDurationSeconds: 1,
        estimatedApiCalls: 1,
      },
    ],
    totalRecords: 100,
    totalApiCalls: 1,
    estimatedDurationSeconds: 1,
    cycleResolutions: [],
  };
}

function getState(): ReturnType<typeof useForgeStore.getState> {
  return useForgeStore.getState();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useForgeStore', () => {
  beforeEach(() => {
    getState().reset();
  });

  it('should have correct initial defaults', () => {
    const state = getState();
    expect(state.phase).toBe('input');
    expect(state.config).toBeNull();
    expect(state.graph).toBeNull();
    expect(state.result).toBeNull();
    expect(state.templates).toEqual([]);
    expect(state.history).toEqual([]);
  });

  it('should update config via setConfig', () => {
    const config = createMockConfig();
    getState().setConfig(config);
    expect(getState().config).toEqual(config);
  });

  it('should clear stale artifacts when setConfig is called', () => {
    // Set up stale state from a previous run
    getState().setPlan(createMockPlan());
    getState().setComplianceReport({
      id: 'rpt-stale',
    } as unknown as import('@sandforge/shared').ComplianceReport);
    getState().setMetadataDiffs([
      {
        objectApiName: 'Account',
        fieldApiName: 'Custom__c',
        issue: 'missing',
        severity: 'error',
        details: '',
      },
    ]);
    useForgeStore.setState({ result: createMockResult() });
    getState().setGraph(createMockGraph());

    // Now set a new config
    const newConfig = createMockConfig({ recordId: '001NEW' });
    getState().setConfig(newConfig);

    // Stale artifacts should be cleared
    expect(getState().plan).toBeNull();
    expect(getState().complianceReport).toBeNull();
    expect(getState().metadataDiffs).toEqual([]);
    expect(getState().result).toBeNull();

    // Config should be updated
    expect(getState().config).toEqual(newConfig);

    // Graph, templates, and history should NOT be cleared
    expect(getState().graph).not.toBeNull();
  });

  it('should update graph via setGraph', () => {
    const graph = createMockGraph();
    getState().setGraph(graph);
    expect(getState().graph).toEqual(graph);
    expect(getState().graph?.nodes).toHaveLength(2);
  });

  it('should transition phase via setPhase', () => {
    getState().setPhase('discovery');
    expect(getState().phase).toBe('discovery');

    getState().setPhase('review');
    expect(getState().phase).toBe('review');

    getState().setPhase('execution');
    expect(getState().phase).toBe('execution');

    getState().setPhase('results');
    expect(getState().phase).toBe('results');
  });

  it('should update a specific node status via updateNodeStatus', () => {
    getState().setGraph(createMockGraph());

    getState().updateNodeStatus('Contact', 'running', 50);

    const contactNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    const accountNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');

    expect(contactNode?.status).toBe('running');
    expect(contactNode?.progress).toBe(50);
    expect(accountNode?.status).toBe('idle');
    expect(accountNode?.progress).toBe(0);
  });

  it('should keep existing progress when updateNodeStatus is called without progress', () => {
    getState().setGraph(createMockGraph());
    getState().updateNodeStatus('Account', 'running', 30);
    getState().updateNodeStatus('Account', 'done');

    const accountNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(accountNode?.status).toBe('done');
    expect(accountNode?.progress).toBe(30);
  });

  it('should not modify state when updateNodeStatus is called with null graph', () => {
    getState().updateNodeStatus('Account', 'running');
    expect(getState().graph).toBeNull();
  });

  describe('a run starting where the last one left the graph', () => {
    /** Discovery's graph: the org would not count email statuses. */
    function discovered(): ForgeGraph {
      return createMockGraph([
        createMockNode({ objectApiName: 'Account' }),
        createMockNode({
          objectApiName: 'EmailStatus',
          recordCount: 0,
          status: 'error',
          included: false,
          errors: ['Record count unavailable: INVALID_TYPE_FOR_OPERATION'],
        }),
      ]);
    }

    it("puts every node back to idle and keeps discovery's errors", () => {
      getState().setGraph(discovered());
      getState().updateNodeStatus('Account', 'done', 100);

      getState().resetNodeStatuses();

      expect(getState().graph?.nodes).toEqual([
        expect.objectContaining({ objectApiName: 'Account', status: 'idle', progress: 0 }),
        expect.objectContaining({
          objectApiName: 'EmailStatus',
          status: 'idle',
          errors: ['Record count unavailable: INVALID_TYPE_FOR_OPERATION'],
        }),
      ]);
    });

    it('keeps the status of an object the run adds apart from the graph, until the next run', () => {
      getState().setGraph(discovered());

      getState().updateNodeStatus('ProductSellingModelOption', 'running', 0);
      getState().updateNodeStatus('ProductSellingModelOption', 'done', 100);

      expect(getState().statusesBeyondGraph).toEqual({ ProductSellingModelOption: 'done' });
      expect(getState().graph?.nodes.map((n) => n.objectApiName)).toEqual([
        'Account',
        'EmailStatus',
      ]);

      getState().resetNodeStatuses();
      expect(getState().statusesBeyondGraph).toEqual({});

      getState().updateNodeStatus('ProductSellingModelOption', 'error', 100);
      getState().forgeAgain();
      expect(getState().statusesBeyondGraph).toEqual({});
    });
  });

  it('should toggle node included flag via toggleNodeIncluded', () => {
    getState().setGraph(createMockGraph());

    getState().toggleNodeIncluded('Contact');
    const contactOff = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactOff?.included).toBe(false);

    getState().toggleNodeIncluded('Contact');
    const contactOn = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactOn?.included).toBe(true);
  });

  it('should not modify other nodes when toggling included', () => {
    getState().setGraph(createMockGraph());
    getState().toggleNodeIncluded('Contact');

    const accountNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(accountNode?.included).toBe(true);
  });

  it('sets the included flag of the named nodes only, leaving hidden ones as they were', () => {
    getState().setGraph(
      createMockGraph([
        createMockNode({ objectApiName: 'Account', included: false }),
        createMockNode({ objectApiName: 'AccountContactRelation', included: false }),
        createMockNode({ objectApiName: 'Contact', included: false }),
        createMockNode({ objectApiName: 'Case', included: true }),
      ]),
    );

    // What a search for "account" shows.
    getState().setNodesIncluded(['Account', 'AccountContactRelation'], true);
    expect(getState().graph?.nodes.map((n) => [n.objectApiName, n.included])).toEqual([
      ['Account', true],
      ['AccountContactRelation', true],
      ['Contact', false],
      ['Case', true],
    ]);

    getState().setNodesIncluded(['Account', 'AccountContactRelation'], false);
    expect(getState().graph?.nodes.map((n) => n.included)).toEqual([false, false, false, true]);
  });

  it('should not modify state when toggleNodeIncluded is called with null graph', () => {
    getState().toggleNodeIncluded('Account');
    expect(getState().graph).toBeNull();
  });

  describe('a node the user leaves out', () => {
    // Unmarked, a node unchecked on the page reached the run as one discovery
    // left out: skipped, and what could not be written without it sent all
    // the same, for the target to refuse.
    it('is marked as the user left it out, and unmarked when put back', () => {
      getState().setGraph(createMockGraph());

      getState().toggleNodeIncluded('Contact');
      expect(getState().graph?.nodes[1]).toMatchObject({ included: false, leftOutByUser: true });

      getState().toggleNodeIncluded('Contact');
      expect(getState().graph?.nodes[1].included).toBe(true);
      expect(getState().graph?.nodes[1]).not.toHaveProperty('leftOutByUser');
    });

    it('marks under Deselect All only the nodes it takes out, never those discovery left out', () => {
      getState().setGraph(
        createMockGraph([
          createMockNode({ objectApiName: 'Account' }),
          // An empty table discovery left out.
          createMockNode({ objectApiName: 'Asset', included: false, recordCount: 0 }),
        ]),
      );

      getState().setNodesIncluded(['Account', 'Asset'], false);
      expect(getState().graph?.nodes.map((n) => [n.objectApiName, n.leftOutByUser])).toEqual([
        ['Account', true],
        ['Asset', undefined],
      ]);

      getState().setNodesIncluded(['Account', 'Asset'], true);
      expect(getState().graph?.nodes.map((n) => n.leftOutByUser)).toEqual([undefined, undefined]);
    });
  });

  it('should add a field to anonymizeFields via toggleAnonymizeField', () => {
    getState().setGraph(createMockGraph());

    getState().toggleAnonymizeField('Account', 'Email');
    const node = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(node?.anonymizeFields).toEqual(['Email']);
  });

  it('should remove a field from anonymizeFields via toggleAnonymizeField', () => {
    const graph = createMockGraph([
      createMockNode({ objectApiName: 'Account', anonymizeFields: ['Email', 'Phone'] }),
      createMockNode({ objectApiName: 'Contact' }),
    ]);
    getState().setGraph(graph);

    getState().toggleAnonymizeField('Account', 'Email');
    const node = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(node?.anonymizeFields).toEqual(['Phone']);
  });

  it('should not modify other nodes when toggling anonymizeField', () => {
    getState().setGraph(createMockGraph());
    getState().toggleAnonymizeField('Account', 'Email');

    const contactNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactNode?.anonymizeFields).toEqual([]);
  });

  describe('fillPersonalFields', () => {
    /** A starter template's graph: no node knows its fields. */
    const starter = (): ForgeGraph =>
      createMockGraph([
        createMockNode({ objectApiName: 'Account', fieldCount: 0 }),
        createMockNode({ objectApiName: 'Contact', fieldCount: 0, level: 1 }),
      ]);

    it('takes the personal fields read for the nodes that named none, with their selection', () => {
      getState().setGraph(starter());

      getState().fillPersonalFields(
        createMockGraph([
          createMockNode({ objectApiName: 'Account', fieldCount: 0 }),
          createMockNode({
            objectApiName: 'Contact',
            fieldCount: 0,
            piiFields: ['LastName', 'Email'],
            anonymizeFields: ['LastName', 'Email'],
          }),
        ]),
      );

      const contact = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
      expect(contact?.piiFields).toEqual(['LastName', 'Email']);
      expect(contact?.anonymizeFields).toEqual(['LastName', 'Email']);
      expect(getState().graph?.nodes.find((n) => n.objectApiName === 'Account')?.piiFields).toEqual(
        [],
      );
    });

    it('keeps what the user changed on a node while the fields were read', () => {
      getState().setGraph(starter());
      getState().toggleNodeIncluded('Contact');

      getState().fillPersonalFields(
        createMockGraph([
          createMockNode({
            objectApiName: 'Contact',
            fieldCount: 0,
            piiFields: ['Email'],
            anonymizeFields: ['Email'],
          }),
        ]),
      );

      const contact = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
      expect(contact?.included).toBe(false);
      expect(contact?.piiFields).toEqual(['Email']);
    });

    it('leaves a node that already names its personal fields as it is', () => {
      getState().setGraph(
        createMockGraph([
          createMockNode({ objectApiName: 'Contact', piiFields: ['Email'], anonymizeFields: [] }),
        ]),
      );

      getState().fillPersonalFields(
        createMockGraph([
          createMockNode({
            objectApiName: 'Contact',
            piiFields: ['Email', 'Phone'],
            anonymizeFields: ['Email', 'Phone'],
          }),
        ]),
      );

      const contact = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
      expect(contact?.piiFields).toEqual(['Email']);
      expect(contact?.anonymizeFields).toEqual([]);
    });
  });

  it('should not modify state when toggleAnonymizeField is called with null graph', () => {
    getState().toggleAnonymizeField('Account', 'Email');
    expect(getState().graph).toBeNull();
  });

  it('keeps the 50 latest runs answered in its history, newest first', () => {
    for (let i = 0; i < 55; i++) {
      const requestId = `wv-run-${String(i)}`;
      getState().setExecutionRequestId(requestId);
      getState().setPhase('execution');
      getState().finishRun(
        requestId,
        createMockResult({ forgeId: `exec-${String(i).padStart(3, '0')}` }),
      );
    }

    expect(getState().history).toHaveLength(50);
    expect(getState().history[0].forgeId).toBe('exec-054');
    expect(getState().history[1].forgeId).toBe('exec-053');
  });

  it('should reset config, graph, result, and phase to initial values', () => {
    getState().setConfig(createMockConfig());
    getState().setGraph(createMockGraph());
    getState().setPhase('execution');
    useForgeStore.setState({ result: createMockResult() });

    getState().reset();

    const state = getState();
    expect(state.phase).toBe('input');
    expect(state.config).toBeNull();
    expect(state.graph).toBeNull();
    expect(state.result).toBeNull();
    expect(state.templates).toEqual([]);
    expect(state.history).toEqual([]);
  });

  // Review phase state tests

  it('should have correct initial review phase defaults', () => {
    const state = getState();
    expect(state.plan).toBeNull();
    expect(state.complianceReport).toBeNull();
    expect(state.metadataDiffs).toEqual([]);
    expect(state.anonymizationRules.email).toBe('fake');
    expect(state.anonymizationRules.phone).toBe('mask');
    expect(state.anonymizationRules.ssn_id).toBe('redact');
  });

  it('should set plan via setPlan', () => {
    const plan = createMockPlan();
    getState().setPlan(plan);
    expect(getState().plan).toEqual(plan);
  });

  it('should set compliance report via setComplianceReport', () => {
    const report = {
      id: 'rpt-1',
      framework: 'gdpr',
    } as unknown as import('@sandforge/shared').ComplianceReport;
    getState().setComplianceReport(report);
    expect(getState().complianceReport).toEqual(report);
  });

  it('should clear compliance report when set to null', () => {
    const report = { id: 'rpt-1' } as unknown as import('@sandforge/shared').ComplianceReport;
    getState().setComplianceReport(report);
    getState().setComplianceReport(null);
    expect(getState().complianceReport).toBeNull();
  });

  it('should set metadata diffs via setMetadataDiffs', () => {
    const diffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'Custom__c',
        issue: 'missing' as const,
        severity: 'error' as const,
        details: 'missing field',
      },
    ];
    getState().setMetadataDiffs(diffs);
    expect(getState().metadataDiffs).toHaveLength(1);
    expect(getState().metadataDiffs[0].issue).toBe('missing');
  });

  it('should update anonymization rule for a category', () => {
    getState().setAnonymizationRule('email', 'hash');
    expect(getState().anonymizationRules.email).toBe('hash');
    // Other categories unchanged
    expect(getState().anonymizationRules.phone).toBe('mask');
  });

  it('should update node batch strategy', () => {
    getState().setGraph(createMockGraph());
    getState().updateNodeBatchStrategy('Account', 'bulk');
    const node = getState().graph?.nodes.find((n) => n.objectApiName === 'Account');
    expect(node?.batchStrategy).toBe('bulk');
  });

  it('should not modify other nodes when updating batch strategy', () => {
    getState().setGraph(createMockGraph());
    getState().updateNodeBatchStrategy('Account', 'bulk');
    const contactNode = getState().graph?.nodes.find((n) => n.objectApiName === 'Contact');
    expect(contactNode?.batchStrategy).toBe('auto');
  });

  it('should reset review phase state on reset', () => {
    getState().setPlan(createMockPlan());
    getState().setAnonymizationRule('email', 'hash');
    getState().setMetadataDiffs([
      { objectApiName: 'A', fieldApiName: 'B', issue: 'missing', severity: 'error', details: '' },
    ]);
    getState().reset();

    const state = getState();
    expect(state.plan).toBeNull();
    expect(state.complianceReport).toBeNull();
    expect(state.metadataDiffs).toEqual([]);
    expect(state.anonymizationRules.email).toBe('fake');
  });

  describe('saved templates', () => {
    function template(id: string, name: string): ForgeTemplate {
      return {
        id,
        name,
        description: '',
        config: {
          inputMode: 'record',
          recordId: '001000000000001AAA',
          depth: 'direct',
          anonymizePII: false,
          skipEmpty: false,
          batchSize: 'auto',
        },
        objectCount: 3,
        recordCount: 50,
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-01-01T00:00:00.000Z',
      };
    }

    it('takes the list the extension keeps as a whole', () => {
      getState().upsertTemplate(template('local', 'Stale'));
      getState().setTemplates([template('a', 'Accounts'), template('b', 'Cases')]);

      expect(getState().templates.map((t) => t.id)).toEqual(['a', 'b']);
    });

    it('adds a template it does not hold, and replaces the one with the same id', () => {
      getState().setTemplates([template('a', 'Accounts')]);

      getState().upsertTemplate(template('b', 'Cases'));
      getState().upsertTemplate({ ...template('a', 'Accounts renamed'), description: 'weekly' });

      expect(getState().templates.map((t) => [t.id, t.name, t.description])).toEqual([
        ['a', 'Accounts renamed', 'weekly'],
        ['b', 'Cases', ''],
      ]);
    });

    it('removes one template by id, not every template that shares its name', () => {
      getState().setTemplates([template('a', 'Weekly'), template('b', 'Weekly')]);

      getState().removeTemplate('a');

      expect(getState().templates.map((t) => t.id)).toEqual(['b']);
    });
  });

  describe('anonymization a template brings back', () => {
    it('sets the categories a template names and leaves the others alone', () => {
      getState().setAnonymizationRules({ email: 'hash', phone: 'redact' });

      expect(getState().anonymizationRules).toMatchObject({
        email: 'hash',
        phone: 'redact',
        name: 'fake',
        other: 'nullify',
      });
    });

    it('keeps the preset picked in Review across a new run, and clears it on reset', () => {
      getState().setAnonymizationPresetId('preset:gdpr-default');
      getState().forgeAgain();
      expect(getState().anonymizationPresetId).toBe('preset:gdpr-default');

      getState().reset();
      expect(getState().anonymizationPresetId).toBe('');
    });
  });

  describe('addLog', () => {
    it('should add a log entry', () => {
      const { addLog } = useForgeStore.getState();
      addLog({ id: 'log-1', timestamp: Date.now(), level: 'info', message: 'Test log' });
      expect(useForgeStore.getState().logs).toHaveLength(1);
      expect(useForgeStore.getState().logs[0].message).toBe('Test log');
    });
  });

  describe('forgeAgain', () => {
    it('should clear result/graph/plan but preserve config', () => {
      const store = useForgeStore.getState();
      // Set up state
      store.setConfig({
        inputMode: 'record',
        recordId: '001xxx',
        depth: 'direct',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        anonymizePII: false,
        skipEmpty: false,
        batchSize: 'auto',
      });
      store.setGraph({
        nodes: [],
        edges: [],
        totalRecords: 0,
        estimatedSizeMB: 0,
        estimatedDurationSeconds: 0,
      });
      useForgeStore.setState({
        result: {
          forgeId: 'f1',
          status: 'success',
          graph: {
            nodes: [],
            edges: [],
            totalRecords: 0,
            estimatedSizeMB: 0,
            estimatedDurationSeconds: 0,
          },
          duration: 1000,
          timestamp: '2026-01-01',
          idRemapCount: 5,
        },
      });
      store.addLog({ id: 'log-1', timestamp: Date.now(), level: 'info', message: 'test' });

      // Call forgeAgain
      useForgeStore.getState().forgeAgain();
      const state = useForgeStore.getState();

      expect(state.phase).toBe('input');
      expect(state.config).not.toBeNull(); // Config preserved
      expect(state.graph).toBeNull();
      expect(state.result).toBeNull();
      expect(state.plan).toBeNull();
      expect(state.logs).toHaveLength(0);
    });

    it('forgets where the last run stopped, which the next run has not', () => {
      useForgeStore.getState().setStoppedAt(40);
      expect(useForgeStore.getState().stoppedAt).toBe(40);

      useForgeStore.getState().forgeAgain();

      expect(useForgeStore.getState().stoppedAt).toBeNull();
    });
  });

  describe('the answer to a run', () => {
    /** The extension answering `forge:execute` request `correlationId`. */
    function answer(correlationId: string, result?: ForgeExecutionResult): void {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: `host-${correlationId}`,
            type: 'forge:execute:response',
            timestamp: Date.now(),
            correlationId,
            payload: result ? { result, operationId: 'forge-execute-1' } : {},
          },
        }),
      );
    }

    it('keeps the result and shows the results, whatever screen is mounted', () => {
      // Listened for by the store: the execution screen that listened left
      // before the run's last steps, and the answer went nowhere.
      runOnScreen();
      const result = createMockResult({ forgeId: 'forge-answered', createdCount: 4 });

      answer('wv-run-1', result);

      expect(getState().result).toEqual(result);
      expect(getState().phase).toBe('results');
      expect(getState().history.map((r) => r.forgeId)).toEqual(['forge-answered']);
    });

    it('shows the results of a run whose answer carried no result', () => {
      runOnScreen();
      answer('wv-run-1');
      expect(getState().phase).toBe('results');
      expect(getState().result).toBeNull();
    });

    it("never leaves the retried run's result on screen for a retry's answer", () => {
      useForgeStore.setState({ result: createMockResult({ forgeId: 'forge-retried' }) });
      runOnScreen();
      answer('wv-run-1');
      expect(getState().result).toBeNull();
    });

    it("leaves the run alone on another panel's answer", () => {
      // Every panel receives every forge message.
      runOnScreen();
      answer('wv-run-other', createMockResult());
      expect(getState().phase).toBe('execution');
      expect(getState().result).toBeNull();
      expect(getState().history).toEqual([]);
    });

    it('takes no answer once the run was left for the input screen', () => {
      runOnScreen();
      getState().setPhase('input');
      answer('wv-run-1', createMockResult());
      expect(getState().phase).toBe('input');
      expect(getState().result).toBeNull();
    });

    it('takes no answer while no run has been started', () => {
      getState().setPhase('execution');
      answer('wv-run-1', createMockResult());
      expect(getState().result).toBeNull();
    });

    it('ignores an answer from another origin than the webview host', () => {
      runOnScreen();
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://example.invalid',
          data: {
            type: 'forge:execute:response',
            correlationId: 'wv-run-1',
            payload: { result: createMockResult() },
          },
        }),
      );
      expect(getState().phase).toBe('execution');
    });
  });

  /** The extension posting `type` for request `correlationId`, from `origin`. */
  function post(
    type: string,
    correlationId: string,
    payload: Record<string, unknown>,
    origin = '',
  ): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { id: `host-${type}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  }

  /** A run on screen over Account and Contact, started by request `wv-run-1`. */
  function runOnScreen(): void {
    getState().setGraph(createMockGraph());
    getState().setExecutionRequestId('wv-run-1');
    getState().setPhase('execution');
  }

  /** The statuses of the graph's nodes, in order. */
  function statuses(): string[] {
    return getState().graph?.nodes.map((n) => n.status) ?? [];
  }

  /** The error `sendHandlerError` posts for the run on screen. */
  function stopped(message: string, result?: ForgeExecutionResult): void {
    post('forge:execute:error', 'wv-run-1', {
      message,
      code: 'EXECUTE_ERROR',
      retryable: true,
      ...(result ? { result } : {}),
    });
  }

  describe('the progress of a run', () => {
    // Taken by the store: the execution screen that listened left with the
    // page, and the objects stood where they had stood when it was left.
    it('sets the status and counts of the object it reports, and logs the line it wrote', () => {
      runOnScreen();

      post('forge:progress', 'wv-run-1', {
        objectName: 'Contact',
        status: 'running',
        progress: 40,
        recordCount: 12,
        message: 'Writing Contact',
      });

      expect(getState().graph?.nodes[1]).toMatchObject({
        objectApiName: 'Contact',
        status: 'running',
        progress: 40,
        recordCount: 12,
      });
      expect(getState().logs).toEqual([
        expect.objectContaining({ level: 'info', message: 'Writing Contact' }),
      ]);
    });

    it('logs an object that failed as an error, in words of its own when the event has none', () => {
      runOnScreen();
      post('forge:progress', 'wv-run-1', { objectName: 'Contact', status: 'error', progress: 0 });
      expect(getState().logs).toEqual([
        expect.objectContaining({ level: 'error', message: 'Contact: error (0%)' }),
      ]);
    });

    it('gives each line of the log an id of its own', () => {
      runOnScreen();
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'running' });
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'done' });
      const ids = getState().logs.map((line) => line.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
    });

    it("takes nothing of another panel's run", () => {
      // Every panel receives every forge message.
      runOnScreen();
      post('forge:progress', 'wv-run-other', { objectName: 'Account', status: 'done' });
      expect(statuses()).toEqual(['idle', 'idle']);
      expect(getState().logs).toEqual([]);
    });

    it('takes nothing once the run was left for the input screen', () => {
      runOnScreen();
      getState().setPhase('input');
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'done' });
      expect(statuses()).toEqual(['idle', 'idle']);
    });

    it('takes nothing once the run stopped: its last event comes after its error', () => {
      runOnScreen();
      stopped('INVALID_SESSION_ID');
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'running' });
      expect(statuses()).toEqual(['idle', 'idle']);
      expect(getState().logs.map((line) => line.message)).toEqual(['INVALID_SESSION_ID']);
    });

    it('takes no event that names no object, or no status a node can have', () => {
      runOnScreen();
      post('forge:progress', 'wv-run-1', { status: 'done' });
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'finished' });
      expect(statuses()).toEqual(['idle', 'idle']);
      expect(getState().logs).toEqual([]);
    });

    it('ignores an event from another origin than the webview host', () => {
      runOnScreen();
      post(
        'forge:progress',
        'wv-run-1',
        { objectName: 'Account', status: 'done' },
        'https://example.invalid',
      );
      expect(statuses()).toEqual(['idle', 'idle']);
    });
  });

  describe('the error of a run', () => {
    it('keeps why the run stopped and where, and logs it, on the execution screen', () => {
      // The screen that showed the error went with the page, and came back
      // as a run under way.
      runOnScreen();
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'done' });

      stopped('INVALID_SESSION_ID: Session expired or invalid');

      expect(getState().runError).toEqual({
        message: 'INVALID_SESSION_ID: Session expired or invalid',
        stoppedRun: null,
      });
      // One object of two had settled: the page says so.
      expect(getState().stoppedAt).toBe(50);
      expect(getState().logs.at(-1)).toMatchObject({
        level: 'error',
        message: 'INVALID_SESSION_ID: Session expired or invalid',
      });
      expect(getState().phase).toBe('execution');
    });

    it('keeps what the run had written, when its error carries it', () => {
      runOnScreen();
      const kept = createMockResult({
        forgeId: 'forge-stopped',
        status: 'failure',
        createdCount: 3,
      });
      stopped('INVALID_SESSION_ID', kept);
      expect(getState().runError?.stoppedRun).toEqual(kept);
    });

    it('says the run failed when its error has no words', () => {
      runOnScreen();
      post('forge:execute:error', 'wv-run-1', { code: 'EXECUTE_ERROR' });
      expect(getState().runError?.message).toBe('Forge execution failed');
    });

    it("leaves the run alone on another panel's error", () => {
      // One used to mark this run aborted.
      runOnScreen();
      post('forge:execute:error', 'wv-run-other', { message: 'Other run failed' });
      expect(getState().runError).toBeNull();
      expect(getState().stoppedAt).toBeNull();
    });

    it('takes no error once the run was left for the input screen', () => {
      runOnScreen();
      getState().setPhase('input');
      stopped('Forge execution was aborted by user request.');
      expect(getState().runError).toBeNull();
    });

    it('ignores an error from another origin than the webview host', () => {
      runOnScreen();
      post(
        'forge:execute:error',
        'wv-run-1',
        { message: 'INVALID_SESSION_ID' },
        'https://example.invalid',
      );
      expect(getState().runError).toBeNull();
    });
  });

  describe('the way on from a run that stopped', () => {
    it('shows the results of what it had written', () => {
      runOnScreen();
      const kept = createMockResult({
        forgeId: 'forge-stopped',
        status: 'failure',
        createdCount: 3,
      });
      stopped('INVALID_SESSION_ID', kept);

      getState().showStoppedRun();

      expect(getState().phase).toBe('results');
      expect(getState().result).toEqual(kept);
      expect(getState().history.map((r) => r.forgeId)).toEqual(['forge-stopped']);
      // The results say why it stopped.
      expect(getState().runError?.message).toBe('INVALID_SESSION_ID');
    });

    it('shows no results of a run whose error said nothing of what it wrote', () => {
      runOnScreen();
      stopped('INVALID_SESSION_ID');
      getState().showStoppedRun();
      expect(getState().phase).toBe('execution');
      expect(getState().result).toBeNull();
    });

    it("goes back to Review with the graph as discovery left it, keeping discovery's errors", () => {
      runOnScreen();
      getState().setGraph(
        createMockGraph([
          createMockNode({ objectApiName: 'Account' }),
          createMockNode({
            objectApiName: 'EmailStatus',
            status: 'error',
            included: false,
            errors: ['Record count unavailable: INVALID_TYPE_FOR_OPERATION'],
          }),
        ]),
      );
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'running' });
      stopped('INVALID_SESSION_ID');

      getState().reviewAgain();

      expect(getState().phase).toBe('review');
      expect(getState().runError).toBeNull();
      expect(statuses()).toEqual(['idle', 'idle']);
      expect(getState().graph?.nodes[1].errors).toEqual([
        'Record count unavailable: INVALID_TYPE_FOR_OPERATION',
      ]);
    });

    it('leaves a run under way on its screen', () => {
      runOnScreen();
      getState().reviewAgain();
      expect(getState().phase).toBe('execution');
    });

    it("starts the next run with none of the last one's log, error or stop", () => {
      runOnScreen();
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'done' });
      stopped('INVALID_SESSION_ID');

      getState().setExecutionRequestId('wv-run-2');

      expect(getState().logs).toEqual([]);
      expect(getState().runError).toBeNull();
      expect(getState().stoppedAt).toBeNull();
    });

    it('forgets the error on Forge Again', () => {
      runOnScreen();
      stopped('INVALID_SESSION_ID');
      getState().forgeAgain();
      expect(getState().runError).toBeNull();
    });
  });

  describe('an abort asked of the run on screen', () => {
    /** The run as the history keeps it once a cancel stopped it. */
    const cancelled = (): ForgeExecutionResult =>
      createMockResult({
        forgeId: 'forge-cancelled',
        status: 'partial',
        cancelled: true,
        createdCount: 1,
      });

    it('keeps the run on its screen until it answers, then keeps what it wrote', () => {
      // The screen left for the input screen as the abort was sent, and the
      // answer that said what the run had written came to none.
      runOnScreen();
      getState().requestStop();
      expect(getState().stopRequestedAt).not.toBeNull();
      expect(getState().phase).toBe('execution');

      const kept = cancelled();
      stopped('Forge execution was aborted by user request.', kept);

      expect(getState().stopRequestedAt).toBeNull();
      expect(getState().runError?.stoppedRun).toEqual(kept);
      expect(getState().phase).toBe('execution');
    });

    it('shows the results of a run that finished before the abort reached it', () => {
      runOnScreen();
      getState().requestStop();
      post('forge:execute:response', 'wv-run-1', { result: createMockResult() });
      expect(getState().phase).toBe('results');
      expect(getState().stopRequestedAt).toBeNull();
    });

    it('is asked of nothing once the run has ended, or when no run is on screen', () => {
      runOnScreen();
      stopped('INVALID_SESSION_ID');
      getState().requestStop();
      expect(getState().stopRequestedAt).toBeNull();

      getState().reset();
      getState().setPhase('execution');
      getState().requestStop();
      expect(getState().stopRequestedAt).toBeNull();
    });

    it('is forgotten by the next run', () => {
      runOnScreen();
      getState().requestStop();
      getState().setExecutionRequestId('wv-run-2');
      expect(getState().stopRequestedAt).toBeNull();
    });

    it('keeps when it was first asked: its answer is waited for from then', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
        runOnScreen();
        getState().requestStop();
        vi.setSystemTime(new Date('2026-09-24T10:00:30.000Z'));
        getState().requestStop();
        expect(getState().stopRequestedAt).toBe(Date.parse('2026-09-24T10:00:00.000Z'));
      } finally {
        vi.useRealTimers();
      }
    });

    describe('left while it has not answered', () => {
      it('goes to the input screen with nothing of the run left on it', () => {
        // STOPPING... had no way out: a run whose answer never came held the
        // page on it until the panel was closed.
        getState().setConfig(createMockConfig());
        runOnScreen();
        post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'done' });
        getState().requestStop();

        getState().leaveStoppingRun();

        const state = getState();
        expect(state.phase).toBe('input');
        expect(state.stopRequestedAt).toBeNull();
        expect(state.runClock).toBeNull();
        expect(state.logs).toEqual([]);
        expect(state.graph).toBeNull();
        expect(state.config).toEqual(createMockConfig());
      });

      it('takes its answer, should it come, as the end of a run only: the recent runs are read again', () => {
        runOnScreen();
        getState().requestStop();
        getState().leaveStoppingRun();

        stopped('Forge execution was aborted by user request.', cancelled());

        expect(getState().phase).toBe('input');
        expect(getState().runError).toBeNull();
        expect(getState().stoppedAt).toBeNull();
        expect(getState().runsEnded).toBe(1);
      });

      it('leaves no run that was not asked to stop, nor one that answered', () => {
        // One under way has no other screen to be stopped from; one that
        // answered has its own way on, with what it wrote.
        runOnScreen();
        getState().leaveStoppingRun();
        expect(getState().phase).toBe('execution');

        getState().requestStop();
        stopped('Forge execution was aborted by user request.', cancelled());
        getState().leaveStoppingRun();
        expect(getState().phase).toBe('execution');
        expect(getState().runError).not.toBeNull();
      });
    });
  });

  describe('the clock of the run on screen', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A run on screen started at 10:00:00 by this machine's clock. */
    function startedAtTen(): void {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-24T10:00:00.000Z'));
      runOnScreen();
    }

    /** Move this machine's clock `seconds` on. */
    function later(seconds: number): void {
      vi.setSystemTime(Date.now() + seconds * 1000);
    }

    /** How long the run has gone now, by its clock. */
    function elapsed(): number {
      const clock = getState().runClock;
      if (!clock) throw new Error('no clock');
      return runElapsedSeconds(clock, Date.now());
    }

    it('counts from when the run started', () => {
      startedAtTen();
      later(65);
      expect(elapsed()).toBe(65);
    });

    it('stands still while the run is paused, and goes on from there once it is resumed', () => {
      startedAtTen();
      later(10);
      getState().pauseRun();
      later(300);
      expect(elapsed()).toBe(10);
      expect(getState().runClock?.pausedSince).not.toBeNull();

      getState().resumeRun();
      later(5);
      expect(elapsed()).toBe(15);
      expect(getState().runClock?.pausedSince).toBeNull();
    });

    it('stops when the run ends, answered or stopped by its error', () => {
      startedAtTen();
      later(20);
      stopped('INVALID_SESSION_ID');
      later(60);
      expect(elapsed()).toBe(20);

      startedAtTen();
      later(7);
      post('forge:execute:response', 'wv-run-1', { result: createMockResult() });
      later(60);
      expect(elapsed()).toBe(7);
    });

    it('counts no pause that went on past the end of the run', () => {
      startedAtTen();
      later(30);
      getState().pauseRun();
      later(40);
      stopped('INVALID_SESSION_ID');
      later(60);
      expect(elapsed()).toBe(30);
      // Nothing is left to resume.
      getState().resumeRun();
      expect(elapsed()).toBe(30);
    });

    it('is not paused once the run has stopped, nor while an abort is asked of it', () => {
      startedAtTen();
      stopped('INVALID_SESSION_ID');
      getState().pauseRun();
      expect(getState().runClock?.pausedSince).toBeNull();

      startedAtTen();
      getState().requestStop();
      getState().pauseRun();
      expect(getState().runClock?.pausedSince).toBeNull();
    });

    it('starts again with the next run, and goes with Forge Again', () => {
      startedAtTen();
      later(90);
      getState().setExecutionRequestId('wv-run-2');
      expect(elapsed()).toBe(0);
      getState().forgeAgain();
      expect(getState().runClock).toBeNull();
    });
  });

  describe('the runs that end', () => {
    it("counts the end of every run, this panel's or another's, answered or stopped", () => {
      // The recent runs are read again at each: the extension keeps a run in
      // its history before it says it ended.
      runOnScreen();
      post('forge:execute:error', 'wv-run-other', { message: 'Other run failed' });
      post('forge:execute:response', 'wv-run-another', { result: createMockResult() });
      stopped('Forge execution was aborted by user request.');
      expect(getState().runsEnded).toBe(3);
    });

    it('counts nothing a run reports while it goes on, nor a message from another origin', () => {
      runOnScreen();
      post('forge:progress', 'wv-run-1', { objectName: 'Account', status: 'done' });
      post('forge:execute:error', 'wv-run-1', { message: 'x' }, 'https://example.invalid');
      expect(getState().runsEnded).toBe(0);
    });
  });

  describe('the files of the cloned records', () => {
    const accepted = { enabled: true, maxFileSizeMB: 4, acceptedAsIs: true };

    it('copies no file until the user asks, ten megabytes at most', () => {
      expect(getState().fileCopy).toEqual({
        enabled: false,
        maxFileSizeMB: 10,
        acceptedAsIs: false,
      });
    });

    it('takes the acceptance back when the copy is turned off', () => {
      getState().setFileCopy(accepted);
      expect(getState().fileCopy).toEqual(accepted);

      getState().setFileCopy({ enabled: false });
      getState().setFileCopy({ enabled: true });

      expect(getState().fileCopy).toEqual({ ...accepted, acceptedAsIs: false });
    });

    it('starts every new run with no file copied', () => {
      getState().setFileCopy(accepted);
      getState().setConfig(createMockConfig());
      expect(getState().fileCopy.enabled).toBe(false);

      getState().setFileCopy(accepted);
      getState().forgeAgain();
      expect(getState().fileCopy.enabled).toBe(false);
      expect(getState().fileCopy.acceptedAsIs).toBe(false);
    });
  });
});

describe('how far a run has gone', () => {
  it('counts the objects skipped or failed as settled, as the bar does', () => {
    const nodes = [
      createMockNode({ objectApiName: 'Account', status: 'done' }),
      createMockNode({ objectApiName: 'Contact', status: 'skipped' }),
      createMockNode({ objectApiName: 'Case', status: 'error' }),
      createMockNode({ objectApiName: 'Opportunity', status: 'running' }),
    ];
    expect(settledPercent(nodes)).toBe(75);
  });

  it('has gone nowhere on a graph with no object', () => {
    expect(settledPercent([])).toBe(0);
  });
});

describe('counts the run discovers', () => {
  it('fills in what a template graph could not know', () => {
    // A graph built from a template starts every count at zero, and nothing
    // ever filled them in: the cards said "0 records, 0 fields" about objects
    // being cloned at that moment.
    const store = useForgeStore.getState();
    store.setGraph({
      nodes: [{ objectApiName: 'Account', recordCount: 0, fieldCount: 0, createableFieldCount: 0 }],
      edges: [],
    } as never);

    useForgeStore.getState().updateNodeCounts('Account', {
      recordCount: 120,
      fieldCount: 35,
      createableFieldCount: 20,
    });

    const node = useForgeStore.getState().graph?.nodes[0];
    expect(node).toMatchObject({ recordCount: 120, fieldCount: 35, createableFieldCount: 20 });
  });

  it('leaves a node alone when the event carries no count', () => {
    const store = useForgeStore.getState();
    store.setGraph({
      nodes: [{ objectApiName: 'Account', recordCount: 7, fieldCount: 3, createableFieldCount: 2 }],
      edges: [],
    } as never);

    useForgeStore.getState().updateNodeCounts('Account', {});

    expect(useForgeStore.getState().graph?.nodes[0]).toMatchObject({
      recordCount: 7,
      fieldCount: 3,
    });
  });
});
