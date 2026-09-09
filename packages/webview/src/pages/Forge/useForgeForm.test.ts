import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { BaseMessage, ForgeExecutionResult, ForgeGraph } from '@sandforge/shared';

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
function simulateResponse(type: string, payload: unknown): void {
  const message: BaseMessage & { payload: unknown } = {
    id: `resp-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  };
  window.dispatchEvent(new MessageEvent('message', { data: message }));
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
      simulateResponse('forge:history:list:response', {
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
      result.current.setAiPrompt('clone the pipeline');
    });
    act(() => {
      result.current.applyHistoryConfig(SOQL_RUN.config!);
    });

    expect(result.current.inputMode).toBe('soql');
    expect(result.current.soqlQuery).toBe('SELECT Id, Name FROM Account');
    expect(result.current.recordId).toBe('');
    expect(result.current.aiPrompt).toBe('');
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

  it('re-caps a SOQL replay at the unscoped cap it ran under', () => {
    const { result } = renderHook(() => useForgeForm());

    act(() => {
      result.current.applyHistoryConfig(SOQL_RUN.config!);
    });

    expect(result.current.recordLimit).toBe('500');
    // SOQL mode discards the WHERE clause, so recordLimitValue clamps back to
    // the 200 the stored run actually used.
    expect(result.current.recordLimitValue).toBe(200);
  });
});
