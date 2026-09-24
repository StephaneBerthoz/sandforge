import { describe, it, expect, beforeEach } from 'vitest';
import { useForgeStore } from './useForgeStore';
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
    getState().setResult(createMockResult());
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

  it('should set result and prepend to history via setResult', () => {
    const result = createMockResult();
    getState().setResult(result);

    expect(getState().result).toEqual(result);
    expect(getState().history).toHaveLength(1);
    expect(getState().history[0]).toEqual(result);
  });

  it('should prepend newer results to history', () => {
    const result1 = createMockResult({ forgeId: 'exec-001' });
    const result2 = createMockResult({ forgeId: 'exec-002' });

    getState().setResult(result1);
    getState().setResult(result2);

    expect(getState().history).toHaveLength(2);
    expect(getState().history[0].forgeId).toBe('exec-002');
    expect(getState().history[1].forgeId).toBe('exec-001');
  });

  it('should cap history at 50 entries', () => {
    for (let i = 0; i < 55; i++) {
      getState().setResult(createMockResult({ forgeId: `exec-${String(i).padStart(3, '0')}` }));
    }

    expect(getState().history).toHaveLength(50);
    expect(getState().history[0].forgeId).toBe('exec-054');
  });

  it('should reset config, graph, result, and phase to initial values', () => {
    getState().setConfig(createMockConfig());
    getState().setGraph(createMockGraph());
    getState().setPhase('execution');
    getState().setResult(createMockResult());

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

  describe('addLog / clearLogs', () => {
    it('should add a log entry', () => {
      const { addLog } = useForgeStore.getState();
      addLog({ id: 'log-1', timestamp: Date.now(), level: 'info', message: 'Test log' });
      expect(useForgeStore.getState().logs).toHaveLength(1);
      expect(useForgeStore.getState().logs[0].message).toBe('Test log');
    });

    it('should clear all log entries', () => {
      const { addLog, clearLogs } = useForgeStore.getState();
      addLog({ id: 'log-1', timestamp: Date.now(), level: 'info', message: 'Test' });
      addLog({ id: 'log-2', timestamp: Date.now(), level: 'error', message: 'Error' });
      clearLogs();
      expect(useForgeStore.getState().logs).toHaveLength(0);
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
      store.setResult({
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
