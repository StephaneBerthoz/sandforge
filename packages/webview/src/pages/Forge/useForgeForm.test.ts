import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeTemplate,
  SalesforceOrg,
} from '@sandforge/shared';

/**
 * Re-running a past Forge run from its stored configuration.
 *
 * The extension keeps the last 20 runs *with* the config that produced each
 * one, and the webview never asked for them: `forge:history:list` had no
 * sender, and the in-session store only holds what `forge:execute:response`
 * returned — a result without its config. So the settings were on disk and
 * the user retyped the whole form every sprint.
 *
 * The fixtures below are whole `ForgeExecutionResult` values, not the three
 * fields an assertion happens to read: a history entry the extension writes
 * carries a full graph, an id-remap table and per-object errors, and a test
 * built from a stub would not notice a shape mismatch.
 */

const mockPostMessage = vi.fn();

/** Stable identity so useSendMessage's useCallback does not re-fire. */
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useForgeForm, recordLimitOptionFor } from './useForgeForm';
import { useForgeStore } from '../../stores/useForgeStore';
import { useOrgStore } from '../../stores/useOrgStore';

/** A discovered graph as the executor leaves it once a run has finished. */
const GRAPH: ForgeGraph = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 120,
      fieldCount: 68,
      status: 'done',
      progress: 100,
      included: true,
      piiFields: ['Phone', 'Website'],
      anonymizeFields: ['Phone'],
      level: 0,
      successCount: 120,
      failureCount: 0,
      errors: [],
      createableFieldCount: 54,
      estimatedSizeMB: 0.4,
      estimatedApiCalls: 2,
      batchStrategy: 'auto',
    },
    {
      objectApiName: 'Contact',
      recordCount: 310,
      fieldCount: 74,
      status: 'done',
      progress: 100,
      included: true,
      piiFields: ['Email', 'MobilePhone'],
      anonymizeFields: ['Email', 'MobilePhone'],
      level: 1,
      successCount: 305,
      failureCount: 5,
      errors: ['REQUIRED_FIELD_MISSING: LastName'],
      createableFieldCount: 61,
      estimatedSizeMB: 1.1,
      estimatedApiCalls: 4,
      batchStrategy: 'bulk',
    },
    {
      objectApiName: 'Opportunity',
      recordCount: 44,
      fieldCount: 51,
      status: 'done',
      progress: 100,
      included: false,
      piiFields: [],
      anonymizeFields: [],
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 40,
      estimatedSizeMB: 0.2,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
    },
  ],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
    {
      sourceObject: 'Account',
      targetObject: 'Opportunity',
      relationshipName: 'Opportunities',
      type: 'lookup',
    },
  ],
  totalRecords: 474,
  estimatedSizeMB: 1.7,
  estimatedDurationSeconds: 96,
  truncated: false,
};

/** A record-scoped run, as ForgeHandler persists it (org ids stripped). */
const RECORD_RUN: ForgeExecutionResult = {
  forgeId: 'forge-2026-03-01-a',
  status: 'partial',
  graph: GRAPH,
  duration: 96_413,
  timestamp: '2026-03-01T09:24:00.000Z',
  idRemapCount: 425,
  idRemapTable: {
    '0011t00000AbCdEAAV': '0015g00000ZzXyWAAV',
    '0031t00000QwErTAAX': '0035g00000MnBvCAAX',
  },
  errors: [
    {
      objectApiName: 'Contact',
      stage: 'insert',
      failedCount: 5,
      attemptedCount: 310,
      samples: [
        {
          recordSummary: 'FirstName=Ada LastName= Email=ada@example.com',
          messages: ['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]'],
        },
      ],
    },
  ],
  config: {
    inputMode: 'record',
    recordId: '0011t00000AbCdEAAV',
    depth: 'custom',
    customDepth: 4,
    anonymizePII: true,
    skipEmpty: true,
    expandOrphanParents: true,
    maxRecordsPerObject: 100,
    batchSize: 'auto',
  },
};

/** A SOQL run — a second entry, so the list is not a single-element special case. */
const SOQL_RUN: ForgeExecutionResult = {
  forgeId: 'forge-2026-02-14-b',
  status: 'success',
  graph: GRAPH,
  duration: 41_002,
  timestamp: '2026-02-14T17:02:00.000Z',
  idRemapCount: 120,
  idRemapTable: {},
  errors: [],
  config: {
    inputMode: 'soql',
    soqlQuery: 'SELECT Id, Name FROM Account',
    depth: 'direct',
    anonymizePII: false,
    skipEmpty: false,
    expandOrphanParents: false,
    maxRecordsPerObject: 200,
    batchSize: 'auto',
  },
};

/** An entry written before configs were persisted — inspectable, not repeatable. */
const LEGACY_RUN: ForgeExecutionResult = {
  forgeId: 'forge-2025-11-30-c',
  status: 'success',
  graph: GRAPH,
  duration: 12_000,
  timestamp: '2025-11-30T08:00:00.000Z',
  idRemapCount: 12,
};

/** Dispatch a simulated extension -> webview message. */
function simulateResponse(type: string, payload: unknown, correlationId?: string): void {
  const message: BaseMessage & { payload: unknown } = {
    id: `resp-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  };
  if (correlationId) {
    message.correlationId = correlationId;
  }
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

/** Answer a request the hook sent, correlated to its id the way a handler does. */
function replyTo(requestType: string, responseType: string, payload: unknown): void {
  const envelope = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage })
    .filter((sent) => sent.payload.type === requestType)
    .pop();
  if (!envelope) throw new Error(`no '${requestType}' message was sent`);
  simulateResponse(responseType, payload, envelope.payload.id);
}

/** Every message type the hook posted through the bridge envelope. */
function sentTypes(): string[] {
  return mockPostMessage.mock.calls.map(
    (call) => (call[0] as { payload: BaseMessage }).payload.type,
  );
}

/** The payload of the last message of `type` the hook posted. */
function lastPayload<T>(type: string): T {
  const envelopes = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage & { payload: T } })
    .filter((envelope) => envelope.payload.type === type);
  const last = envelopes[envelopes.length - 1];
  if (!last) throw new Error(`no '${type}' message was sent`);
  return last.payload.payload;
}

describe('useForgeForm run history', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.setState({ config: null, history: [] });
    useOrgStore.setState({ selectedOrgId: null });
  });

  it('asks the extension for the runs it persisted', () => {
    renderHook(() => useForgeForm());

    expect(sentTypes()).toContain('forge:history:list');
  });

  it('exposes the entries the reply carried, newest first', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      replyTo('forge:history:list', 'forge:history:list:response', {
        history: [RECORD_RUN, SOQL_RUN, LEGACY_RUN],
      });
    });

    expect(result.current.runHistory.map((entry) => entry.forgeId)).toEqual([
      'forge-2026-03-01-a',
      'forge-2026-02-14-b',
      'forge-2025-11-30-c',
    ]);
    // The whole entry survives the trip — the graph is what a re-run displays.
    expect(result.current.runHistory[0].graph.nodes).toHaveLength(3);
    expect(result.current.runHistory[0].errors?.[0].samples[0].messages[0]).toContain(
      'REQUIRED_FIELD_MISSING',
    );
  });

  it('refills every form field from a stored record-mode config', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.applyHistoryConfig(RECORD_RUN.config!);
    });

    expect(result.current.inputMode).toBe('record');
    expect(result.current.recordId).toBe('0011t00000AbCdEAAV');
    expect(result.current.depth).toBe('custom');
    expect(result.current.customDepth).toBe(4);
    expect(result.current.anonymize).toBe(true);
    expect(result.current.skipEmpty).toBe(true);
    expect(result.current.expandOrphanParents).toBe(true);
    expect(result.current.recordLimit).toBe('100');
  });

  it('clears the fields of the modes the stored run did not use', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.handleRecordIdChange('0019999999999999AAA');
    });
    act(() => {
      result.current.applyHistoryConfig(SOQL_RUN.config!);
    });

    expect(result.current.inputMode).toBe('soql');
    expect(result.current.soqlQuery).toBe('SELECT Id, Name FROM Account');
    expect(result.current.recordId).toBe('');
  });

  it('opens a stored AI run on the record tab, which cannot discover without an id', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
    });
    act(() => {
      result.current.applyHistoryConfig({
        ...SOQL_RUN.config!,
        inputMode: 'ai',
        soqlQuery: undefined,
        aiPrompt: 'clone the pipeline',
      });
    });

    // A stored AI run carries a prompt, not the query it ran: reopening it on
    // the AI tab would mean sending the prompt to the model again.
    expect(result.current.inputMode).toBe('record');
    expect(result.current.soqlQuery).toBe('');
    expect(result.current.canDiscover).toBe(false);
  });

  it("does not let the AI mode discover from the SOQL tab's query", () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
      result.current.setSoqlQuery('SELECT Id FROM Account');
    });
    act(() => {
      result.current.setInputMode('ai');
    });

    expect(result.current.canDiscover).toBe(false);
  });

  it('leaves the org pair alone — a replay re-picks its orgs', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
    });
    act(() => {
      result.current.applyHistoryConfig(RECORD_RUN.config!);
    });

    expect(result.current.sourceOrgId).toBe('org-src');
    expect(result.current.targetOrgId).toBe('org-tgt');
  });

  it('rebuilds the discover config the stored run was produced from', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.applyHistoryConfig(RECORD_RUN.config!);
    });
    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
    });
    act(() => {
      result.current.handleDiscover();
    });

    const { config } = lastPayload<{ config: Record<string, unknown> }>('forge:discover');
    expect(config).toMatchObject({
      ...RECORD_RUN.config,
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
    });
  });

  it('maps a stored record cap back onto a dropdown option', () => {
    // Every cap the form can produce is a preset, a smartLimitForCount result
    // or a builtin template cap; the SOQL cap of 200 is the one outlier and
    // rounds up, so the replay never clones less than the run it repeats.
    expect(recordLimitOptionFor(undefined)).toBe('all');
    expect(recordLimitOptionFor(10)).toBe('10');
    expect(recordLimitOptionFor(50)).toBe('50');
    expect(recordLimitOptionFor(100)).toBe('100');
    expect(recordLimitOptionFor(500)).toBe('500');
    expect(recordLimitOptionFor(1000)).toBe('1000');
    expect(recordLimitOptionFor(200)).toBe('500');
    expect(recordLimitOptionFor(5000)).toBe('all');
  });

  it('restores the object cap a stored run reached, and the default for one that set none', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.applyHistoryConfig({ ...RECORD_RUN.config!, maxNodes: 350 });
    });
    expect(result.current.maxNodes).toBe(350);

    act(() => {
      result.current.applyHistoryConfig(SOQL_RUN.config!);
    });
    expect(result.current.maxNodes).toBeUndefined();
  });

  it('re-caps a SOQL replay at the unscoped cap it ran under', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.applyHistoryConfig(SOQL_RUN.config!);
    });

    expect(result.current.recordLimit).toBe('500');
    // SOQL mode reads related objects from their whole tables, so
    // recordLimitValue clamps back to the 200 the stored run actually used.
    expect(result.current.recordLimitValue).toBe(200);
  });
});

describe('useForgeForm WHERE clause the extension refuses', () => {
  const refusedQuery = "SELECT Id FROM Account WHERE Name LIKE '%--%'";

  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.setState({
      config: null,
      history: [],
      templates: [
        {
          id: 'tpl-soql',
          name: 'Accounts with dashes',
          description: '',
          config: { ...SOQL_RUN.config!, soqlQuery: refusedQuery },
          objectCount: 1,
          recordCount: 0,
          createdAt: '2026-02-14T17:02:00.000Z',
          lastUsedAt: '2026-02-14T17:02:00.000Z',
        },
      ],
    });
    useOrgStore.setState({ selectedOrgId: null });
  });

  it('keeps Discover off for a saved template whose query it would refuse', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
      result.current.setInputMode('template');
      result.current.setSelectedTemplate('tpl-soql');
    });

    expect(result.current.whereClauseRefused).toBe(true);
    expect(result.current.canDiscover).toBe(false);
    act(() => result.current.handleDiscover());
    expect(useForgeStore.getState().config).toBeNull();
  });

  it('lets the same template discover once its query is one the extension accepts', () => {
    useForgeStore.setState({
      templates: useForgeStore.getState().templates.map((tpl) => ({
        ...tpl,
        config: { ...tpl.config, soqlQuery: "SELECT Id FROM Account WHERE Name LIKE 'A%'" },
      })),
    });
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
      result.current.setInputMode('template');
      result.current.setSelectedTemplate('tpl-soql');
    });

    expect(result.current.whereClauseRefused).toBe(false);
    expect(result.current.canDiscover).toBe(true);
  });
});

describe('useForgeForm reusing the last graph', () => {
  const filteredQuery = "SELECT Id FROM Account WHERE Industry = 'X'";

  /** A saved template holding `soqlQuery`, as the template manager stores it. */
  const soqlTemplate = (soqlQuery: string) => ({
    id: 'tpl-soql',
    name: 'Energy accounts',
    description: '',
    config: { ...SOQL_RUN.config!, soqlQuery },
    objectCount: 1,
    recordCount: 0,
    createdAt: '2026-02-14T17:02:00.000Z',
    lastUsedAt: '2026-02-14T17:02:00.000Z',
  });

  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.setState({ config: null, graph: null, history: [RECORD_RUN], templates: [] });
    useOrgStore.setState({ selectedOrgId: null });
  });

  it("sends a SOQL query's WHERE clause as the root object's filter", () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
      result.current.setInputMode('soql');
      result.current.setSoqlQuery(filteredQuery);
    });
    expect(result.current.canReuseLastGraph).toBe(true);
    act(() => result.current.handleReuseLastGraph());

    expect(useForgeStore.getState().config?.objectSoqlFilters).toEqual({
      Account: "Industry = 'X'",
    });
    const { config } = lastPayload<{ config: Record<string, unknown> }>('forge:plan:request');
    expect(config).toMatchObject({
      inputMode: 'soql',
      soqlQuery: filteredQuery,
      objectSoqlFilters: { Account: "Industry = 'X'" },
    });
  });

  it('reuses it for an AI draft only once the draft passed its check', () => {
    const { result } = renderHook(() => useForgeForm());
    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
      result.current.setInputMode('ai');
      result.current.ai.setDraft(filteredQuery);
    });
    // Skipping discovery does not skip the check: the draft's WHERE clause is
    // the run's filter.
    expect(result.current.canReuseLastGraph).toBe(false);

    act(() => result.current.ai.recheck());
    act(() => {
      replyTo('ai:forge-plan', 'ai:forge-plan:response', {
        success: true,
        soql: filteredQuery,
        rootObject: 'Account',
        rootLabel: 'Account',
        fieldsChecked: 2,
        problems: [],
      });
    });

    expect(result.current.canReuseLastGraph).toBe(true);
    act(() => result.current.handleReuseLastGraph());
    const { config } = lastPayload<{ config: Record<string, unknown> }>('forge:plan:request');
    expect(config).toMatchObject({
      inputMode: 'soql',
      soqlQuery: filteredQuery,
      objectSoqlFilters: { Account: "Industry = 'X'" },
    });
  });

  it("sends a saved template's query and its filter, capped like a SOQL run", () => {
    useForgeStore.setState({ templates: [soqlTemplate(filteredQuery)] });
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
      result.current.setInputMode('template');
      result.current.setSelectedTemplate('tpl-soql');
      result.current.setRecordLimit('all');
    });
    // Related objects are read from their whole tables, as in SOQL mode.
    expect(result.current.recordLimitValue).toBe(200);
    act(() => result.current.handleReuseLastGraph());

    const { config } = lastPayload<{ config: Record<string, unknown> }>('forge:plan:request');
    expect(config).toMatchObject({
      inputMode: 'soql',
      soqlQuery: filteredQuery,
      objectSoqlFilters: { Account: "Industry = 'X'" },
      maxRecordsPerObject: 200,
    });
    expect(config.templateId).toBeUndefined();
  });

  it('offers no reuse for a saved template whose query the extension would refuse', () => {
    useForgeStore.setState({
      templates: [soqlTemplate("SELECT Id FROM Account WHERE Name LIKE '%--%'")],
    });
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.setSourceOrgId('org-src');
      result.current.setTargetOrgId('org-tgt');
      result.current.setInputMode('template');
      result.current.setSelectedTemplate('tpl-soql');
    });

    expect(result.current.canReuseLastGraph).toBe(false);
    act(() => result.current.handleReuseLastGraph());
    expect(sentTypes()).not.toContain('forge:plan:request');
  });
});

describe('a built-in template clones from a record', () => {
  it('will not start without one', () => {
    // The templates promise "Clone an Account with its Contacts…". Without a
    // root record the executor's scoped path never activates, so the run
    // cloned whole tables into the target org instead of one record's graph.
    const { result } = renderHook(() => useForgeForm());
    act(() => {
      result.current.setInputMode('template');
      result.current.setSelectedTemplate('builtin:account-360');
      result.current.setSourceOrgId('src');
      result.current.setTargetOrgId('tgt');
    });
    expect(result.current.canQuickStartTemplate).toBe(false);
    expect(result.current.canDiscover).toBe(false);
  });

  it('runs as the record mode it declares, carrying the record', () => {
    const { result } = renderHook(() => useForgeForm());
    act(() => {
      result.current.setInputMode('template');
      result.current.setSelectedTemplate('builtin:account-360');
      result.current.setSourceOrgId('src');
      result.current.setTargetOrgId('tgt');
      result.current.handleRecordIdChange('001AB00000ABCDEFGH');
    });
    expect(result.current.canQuickStartTemplate).toBe(true);
    expect(result.current.canDiscover).toBe(true);

    mockPostMessage.mockClear();
    act(() => {
      result.current.handleDiscover();
    });
    const discover = mockPostMessage.mock.calls
      .map(([envelope]) => (envelope as { payload?: Record<string, unknown> })?.payload)
      .find((m) => (m as { type?: string })?.type === 'forge:discover') as
      | { payload: { config: { inputMode: string; recordId?: string } } }
      | undefined;
    expect(discover, 'no forge:discover was sent').toBeDefined();
    expect(discover?.payload.config.inputMode).toBe('record');
    expect(discover?.payload.config.recordId).toBe('001AB00000ABCDEFGH');
  });
});

describe('applying a saved template', () => {
  const TEMPLATE: ForgeTemplate = {
    id: 'tpl-weekly',
    name: 'Weekly accounts',
    description: '',
    config: {
      inputMode: 'record',
      recordId: '0011t00000AbCdEAAV',
      depth: 'custom',
      customDepth: 4,
      maxNodes: 350,
      anonymizePII: true,
      skipEmpty: true,
      expandOrphanParents: true,
      maxRecordsPerObject: 500,
      batchSize: 'auto',
    },
    targetOrgId: 'org-tgt',
    anonymization: { presetId: 'preset:gdpr-default', rules: { email: 'hash', phone: 'redact' } },
    objectCount: 3,
    recordCount: 474,
    createdAt: '2026-03-01T09:24:00.000Z',
    lastUsedAt: '2026-03-01T09:24:00.000Z',
  };

  const TARGET = { id: 'org-tgt', alias: 'dev', username: 'dev@example.com' } as SalesforceOrg;

  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.getState().reset();
    useForgeStore.getState().setTemplates([TEMPLATE]);
    useOrgStore.setState({ selectedOrgId: null, orgs: [TARGET] });
  });

  it('selects it and puts its depth, caps and toggles in the form', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.applyTemplate({ ...TEMPLATE, targetOrgId: undefined });
    });

    expect(result.current.inputMode).toBe('template');
    expect(result.current.selectedTemplate).toBe('tpl-weekly');
    expect(result.current.depth).toBe('custom');
    expect(result.current.customDepth).toBe(4);
    expect(result.current.maxNodes).toBe(350);
    expect(result.current.anonymize).toBe(true);
    expect(result.current.skipEmpty).toBe(true);
    expect(result.current.expandOrphanParents).toBe(true);
    expect(result.current.recordLimit).toBe('500');
  });

  it('sets the target org it wrote to when that org is connected here', () => {
    const { result } = renderHook(() => useForgeForm());
    let outcome = '';

    act(() => {
      outcome = result.current.applyTemplate(TEMPLATE);
    });

    expect(outcome).toBe('set');
    expect(result.current.targetOrgId).toBe('org-tgt');
  });

  it('leaves the target as it is when that org is not connected here', () => {
    useOrgStore.setState({ orgs: [] });
    const { result } = renderHook(() => useForgeForm());
    act(() => {
      result.current.setTargetOrgId('org-picked');
    });
    let outcome = '';

    act(() => {
      outcome = result.current.applyTemplate(TEMPLATE);
    });

    expect(outcome).toBe('missing');
    expect(result.current.targetOrgId).toBe('org-picked');
  });

  it('brings back the anonymization it was saved with', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.applyTemplate(TEMPLATE);
    });

    const state = useForgeStore.getState();
    expect(state.anonymizationPresetId).toBe('preset:gdpr-default');
    expect(state.anonymizationRules).toMatchObject({
      email: 'hash',
      phone: 'redact',
      name: 'fake',
    });
  });

  it('discovers its input with its options, from the source picked now', () => {
    const { result } = renderHook(() => useForgeForm());
    act(() => {
      result.current.setSourceOrgId('org-src');
    });
    act(() => {
      result.current.applyTemplate(TEMPLATE);
    });
    act(() => {
      result.current.handleDiscover();
    });

    const { config } = lastPayload<{ config: Record<string, unknown> }>('forge:discover');
    expect(config).toMatchObject({
      inputMode: 'record',
      recordId: '0011t00000AbCdEAAV',
      depth: 'custom',
      customDepth: 4,
      maxNodes: 350,
      anonymizePII: true,
      skipEmpty: true,
      expandOrphanParents: true,
      maxRecordsPerObject: 500,
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
    });
  });
});
