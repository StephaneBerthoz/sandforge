import { describe, it, expect, beforeEach } from 'vitest';
import type {
  FrozenControlReport,
  FrozenLoadProgress,
  FrozenLoadReportInfo,
  FrozenManifestInfo,
  FrozenProjectConfig,
  FrozenSelectionSummary,
  FrozenStatusInfo,
  FrozenVerifyVerdict,
} from '@sandforge/shared';
import { useFrozenStore } from './useFrozenStore';
import type { FrozenChannelError, FrozenExtractSummary } from './useFrozenStore';

function progressEvent(overrides: Partial<FrozenLoadProgress> = {}): FrozenLoadProgress {
  return {
    phase: 'verify',
    status: 'started',
    progress: 0,
    message: 'checking',
    ...overrides,
  };
}

const CONFIG: FrozenProjectConfig = {
  rootObject: 'Dossier__c',
  axes: [],
  edgeCases: [],
};

const CONTROL_REPORT: FrozenControlReport = {
  passed: true,
  checks: [],
  author: 'qa@example.com',
  checkedAt: '2026-03-13T10:00:00Z',
};

const SELECTION: FrozenSelectionSummary = {
  combinations: [],
  uncovered: [],
  volumetry: { measured: { Account: 12 }, total: 12, budgetMax: 2500 },
  selectedAt: '2026-03-13T10:00:00Z',
  selectionPath: '/sas/selection.json',
};

const VERDICT: FrozenVerifyVerdict = {
  status: 'passed',
  checks: [],
  attempts: 2,
  measuredAt: '2026-03-13T10:05:00Z',
};

const EXTRACT_SUMMARY: FrozenExtractSummary = {
  datasetDir: '/sas/dataset',
  recordCount: 240,
  fileCount: 9,
};

const CHANNEL_ERROR: FrozenChannelError = {
  source: 'frozen:load',
  message: 'target org refused the write',
  code: 'LOAD_FAILED',
  retryable: true,
};

/**
 * Only the fields the store is asked about are filled in: these payloads are
 * opaque to it — it stores them and hands them back.
 */
const STATUS = { configured: true, sasDir: '/sas' } as unknown as FrozenStatusInfo;
const MANIFEST = { version: '1.0.0', status: 'frozen' } as unknown as FrozenManifestInfo;
const LOAD_REPORT = { status: 'completed', orgId: 'org-1' } as unknown as FrozenLoadReportInfo;

/** Every action the store exposes, as exercised by the tests below. */
const EXERCISED_ACTIONS = [
  'setTab',
  'setConfig',
  'setStatus',
  'setSelection',
  'setControlReport',
  'setExtractSummary',
  'setManifest',
  'appendProgress',
  'clearProgress',
  'setLoadReport',
  'setVerdict',
  'setLastError',
  'replaceActiveRequestId',
  'removeActiveRequestId',
  'clearActiveRequestIds',
] as const;

describe('useFrozenStore', () => {
  beforeEach(() => {
    // Back to the state the store was created with, not to a copy kept here: a
    // copy would make the initial-state test read back what this file wrote.
    useFrozenStore.setState(useFrozenStore.getInitialState(), true);
  });

  it('starts on the extract tab with nothing collected', () => {
    const state = useFrozenStore.getState();
    expect(state.tab).toBe('extract');
    expect(state.config).toBeNull();
    expect(state.status).toBeNull();
    expect(state.selection).toBeNull();
    expect(state.controlReport).toBeNull();
    expect(state.extractSummary).toBeNull();
    expect(state.manifest).toBeNull();
    expect(state.progress).toEqual([]);
    expect(state.loadReport).toBeNull();
    expect(state.verdict).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.activeRequestIds.size).toBe(0);
    expect(state.lastRequestIdByType).toEqual({});
  });

  it('covers every action the store exposes', () => {
    // A new action added to the store without a test here fails this: the
    // store is the whole page state, and an untested setter is a page that
    // renders yesterday's data with nobody noticing.
    const actions = Object.entries(useFrozenStore.getState())
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect(actions).toEqual([...EXERCISED_ACTIONS].sort());
  });

  describe('single-value setters', () => {
    it('switches tab', () => {
      useFrozenStore.getState().setTab('load');
      expect(useFrozenStore.getState().tab).toBe('load');
      useFrozenStore.getState().setTab('extract');
      expect(useFrozenStore.getState().tab).toBe('extract');
    });

    it('stores and clears the project config', () => {
      useFrozenStore.getState().setConfig(CONFIG);
      expect(useFrozenStore.getState().config).toEqual(CONFIG);
      useFrozenStore.getState().setConfig(null);
      expect(useFrozenStore.getState().config).toBeNull();
    });

    it('stores and clears the status snapshot', () => {
      useFrozenStore.getState().setStatus(STATUS);
      expect(useFrozenStore.getState().status).toBe(STATUS);
      useFrozenStore.getState().setStatus(null);
      expect(useFrozenStore.getState().status).toBeNull();
    });

    it('stores and clears the selection summary', () => {
      useFrozenStore.getState().setSelection(SELECTION);
      expect(useFrozenStore.getState().selection).toEqual(SELECTION);
      useFrozenStore.getState().setSelection(null);
      expect(useFrozenStore.getState().selection).toBeNull();
    });

    it('stores and clears the control report', () => {
      useFrozenStore.getState().setControlReport(CONTROL_REPORT);
      expect(useFrozenStore.getState().controlReport).toEqual(CONTROL_REPORT);
      useFrozenStore.getState().setControlReport(null);
      expect(useFrozenStore.getState().controlReport).toBeNull();
    });

    it('stores and clears the extract summary', () => {
      useFrozenStore.getState().setExtractSummary(EXTRACT_SUMMARY);
      expect(useFrozenStore.getState().extractSummary).toEqual(EXTRACT_SUMMARY);
      useFrozenStore.getState().setExtractSummary(null);
      expect(useFrozenStore.getState().extractSummary).toBeNull();
    });

    it('stores and clears the manifest', () => {
      useFrozenStore.getState().setManifest(MANIFEST);
      expect(useFrozenStore.getState().manifest).toBe(MANIFEST);
      useFrozenStore.getState().setManifest(null);
      expect(useFrozenStore.getState().manifest).toBeNull();
    });

    it('stores and clears the load report', () => {
      useFrozenStore.getState().setLoadReport(LOAD_REPORT);
      expect(useFrozenStore.getState().loadReport).toBe(LOAD_REPORT);
      useFrozenStore.getState().setLoadReport(null);
      expect(useFrozenStore.getState().loadReport).toBeNull();
    });

    it('stores and clears the verify verdict', () => {
      useFrozenStore.getState().setVerdict(VERDICT);
      expect(useFrozenStore.getState().verdict).toEqual(VERDICT);
      useFrozenStore.getState().setVerdict(null);
      expect(useFrozenStore.getState().verdict).toBeNull();
    });

    it('stores and clears the last channel error', () => {
      useFrozenStore.getState().setLastError(CHANNEL_ERROR);
      expect(useFrozenStore.getState().lastError).toEqual(CHANNEL_ERROR);
      useFrozenStore.getState().setLastError(null);
      expect(useFrozenStore.getState().lastError).toBeNull();
    });
  });

  describe('progress feed', () => {
    it('appends events in arrival order', () => {
      const first = progressEvent({ message: 'one' });
      const second = progressEvent({ message: 'two', status: 'done', progress: 100 });
      useFrozenStore.getState().appendProgress(first);
      useFrozenStore.getState().appendProgress(second);

      expect(useFrozenStore.getState().progress).toEqual([first, second]);
    });

    it('keeps only the last 200 events of a load storm', () => {
      for (let i = 0; i < 205; i++) {
        useFrozenStore.getState().appendProgress(progressEvent({ message: `event-${i}` }));
      }

      const { progress } = useFrozenStore.getState();
      expect(progress).toHaveLength(200);
      // The oldest are the ones dropped: the tail is what the user is reading.
      expect(progress[0].message).toBe('event-5');
      expect(progress[199].message).toBe('event-204');
    });

    it('clears the feed', () => {
      useFrozenStore.getState().appendProgress(progressEvent());
      useFrozenStore.getState().clearProgress();

      expect(useFrozenStore.getState().progress).toEqual([]);
    });
  });

  describe('active request ids', () => {
    it('registers a request id and remembers it by type', () => {
      useFrozenStore.getState().replaceActiveRequestId('frozen:load', 'req-1');

      const state = useFrozenStore.getState();
      expect([...state.activeRequestIds]).toEqual(['req-1']);
      expect(state.lastRequestIdByType['frozen:load']).toBe('req-1');
    });

    it('drops the previous id of the same type, keeping other types', () => {
      const store = useFrozenStore.getState();
      store.replaceActiveRequestId('frozen:load', 'req-1');
      store.replaceActiveRequestId('frozen:verify', 'req-2');
      store.replaceActiveRequestId('frozen:load', 'req-3');

      const state = useFrozenStore.getState();
      // A second load replaces the first, and the verify in flight survives.
      expect([...state.activeRequestIds].sort()).toEqual(['req-2', 'req-3']);
      expect(state.lastRequestIdByType).toEqual({
        'frozen:load': 'req-3',
        'frozen:verify': 'req-2',
      });
    });

    it('is a no-op when the same id is registered twice for a type', () => {
      useFrozenStore.getState().replaceActiveRequestId('frozen:load', 'req-1');
      const before = useFrozenStore.getState();
      useFrozenStore.getState().replaceActiveRequestId('frozen:load', 'req-1');
      const after = useFrozenStore.getState();

      // Same state object: a re-render for nothing is a re-render too many.
      expect(after.activeRequestIds).toBe(before.activeRequestIds);
      expect(after.lastRequestIdByType).toBe(before.lastRequestIdByType);
    });

    it('remembers at most 20 ids, dropping the oldest', () => {
      for (let i = 0; i < 25; i++) {
        useFrozenStore.getState().replaceActiveRequestId(`frozen:type-${i}`, `req-${i}`);
      }

      const ids = [...useFrozenStore.getState().activeRequestIds];
      expect(ids).toHaveLength(20);
      expect(ids[0]).toBe('req-5');
      expect(ids[19]).toBe('req-24');
    });

    it('removes one id and leaves the rest alone', () => {
      const store = useFrozenStore.getState();
      store.replaceActiveRequestId('frozen:load', 'req-1');
      store.replaceActiveRequestId('frozen:verify', 'req-2');

      useFrozenStore.getState().removeActiveRequestId('req-1');

      expect([...useFrozenStore.getState().activeRequestIds]).toEqual(['req-2']);
    });

    it('is a no-op when removing an id it never had', () => {
      useFrozenStore.getState().replaceActiveRequestId('frozen:load', 'req-1');
      const before = useFrozenStore.getState().activeRequestIds;

      useFrozenStore.getState().removeActiveRequestId('req-unknown');

      expect(useFrozenStore.getState().activeRequestIds).toBe(before);
    });

    it('clears both the ids and the per-type memory', () => {
      const store = useFrozenStore.getState();
      store.replaceActiveRequestId('frozen:load', 'req-1');
      store.replaceActiveRequestId('frozen:verify', 'req-2');

      useFrozenStore.getState().clearActiveRequestIds();

      const state = useFrozenStore.getState();
      expect(state.activeRequestIds.size).toBe(0);
      // Leaving the map behind would make the next id of a type replace a
      // request that is already gone.
      expect(state.lastRequestIdByType).toEqual({});
    });
  });
});
