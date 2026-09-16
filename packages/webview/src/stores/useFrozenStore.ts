import { create } from 'zustand';
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

/** Tabs of the Frozen page. */
export type FrozenTab = 'extract' | 'load';

/** Error surfaced on a `frozen:*:error` channel. */
export interface FrozenChannelError {
  /** Originating request type (e.g. `frozen:load`). */
  source: string;
  message: string;
  code: string;
  retryable: boolean;
}

/** Summary of a successful extraction (details live in the manifest). */
export interface FrozenExtractSummary {
  datasetDir: string;
  recordCount: number;
  fileCount: number;
}

/**
 * Frozen Reference Dataset page state.
 *
 * Deliberately small: bridge request/response cycles live in the
 * `useBridgeQuery`/`useBridgeMutation` hooks; this store only collects the
 * PUSH channels (progress, control result, verify verdict, errors) and the
 * latest operation results so both tabs can render them.
 */
export interface FrozenState {
  tab: FrozenTab;
  /** Last saved/loaded project config. */
  config: FrozenProjectConfig | null;
  /** Module status snapshot (frozen:status). */
  status: FrozenStatusInfo | null;
  /** Latest coverage-matrix selection summary (IDs redacted server-side). */
  selection: FrozenSelectionSummary | null;
  /** Latest 4-point gate report (PASS or FAIL). */
  controlReport: FrozenControlReport | null;
  /** Latest extraction summary. */
  extractSummary: FrozenExtractSummary | null;
  /** Latest frozen manifest. */
  manifest: FrozenManifestInfo | null;
  /** Load/verify progress events (most recent last, capped). */
  progress: FrozenLoadProgress[];
  /** Latest load report. */
  loadReport: FrozenLoadReportInfo | null;
  /** Latest post-load verdict. */
  verdict: FrozenVerifyVerdict | null;
  /** Latest `frozen:*:error` channel error. */
  lastError: FrozenChannelError | null;
  /** Ids of the frozen requests this panel sent and is still reading. */
  activeRequestIds: Set<string>;
  /**
   * Last id sent for each request type. It lives here rather than in the tab
   * because switching between the Extract and Load tabs remounts the tab.
   */
  lastRequestIdByType: Record<string, string>;

  setTab: (tab: FrozenTab) => void;
  setConfig: (config: FrozenProjectConfig | null) => void;
  setStatus: (status: FrozenStatusInfo | null) => void;
  setSelection: (selection: FrozenSelectionSummary | null) => void;
  setControlReport: (report: FrozenControlReport | null) => void;
  setExtractSummary: (summary: FrozenExtractSummary | null) => void;
  setManifest: (manifest: FrozenManifestInfo | null) => void;
  appendProgress: (event: FrozenLoadProgress) => void;
  clearProgress: () => void;
  setLoadReport: (report: FrozenLoadReportInfo | null) => void;
  setVerdict: (verdict: FrozenVerifyVerdict | null) => void;
  setLastError: (error: FrozenChannelError | null) => void;
  /** Register `requestId` and drop the id sent earlier for `requestType`. */
  replaceActiveRequestId: (requestType: string, requestId: string) => void;
  removeActiveRequestId: (requestId: string) => void;
  clearActiveRequestIds: () => void;
}

/** Cap on retained progress events (load storms emit one per phase/object). */
const MAX_PROGRESS_EVENTS = 200;

/** Cap on remembered request ids: a tab that is never reset must not grow one. */
const MAX_ACTIVE_REQUESTS = 20;

/** Zustand store for the Frozen Reference Dataset page. */
export const useFrozenStore = create<FrozenState>((set) => ({
  tab: 'extract',
  config: null,
  status: null,
  selection: null,
  controlReport: null,
  extractSummary: null,
  manifest: null,
  progress: [],
  loadReport: null,
  verdict: null,
  lastError: null,
  activeRequestIds: new Set<string>(),
  lastRequestIdByType: {},

  setTab(tab: FrozenTab): void {
    set({ tab });
  },
  setConfig(config: FrozenProjectConfig | null): void {
    set({ config });
  },
  setStatus(status: FrozenStatusInfo | null): void {
    set({ status });
  },
  setSelection(selection: FrozenSelectionSummary | null): void {
    set({ selection });
  },
  setControlReport(controlReport: FrozenControlReport | null): void {
    set({ controlReport });
  },
  setExtractSummary(extractSummary: FrozenExtractSummary | null): void {
    set({ extractSummary });
  },
  setManifest(manifest: FrozenManifestInfo | null): void {
    set({ manifest });
  },
  appendProgress(event: FrozenLoadProgress): void {
    set((state) => ({ progress: [...state.progress, event].slice(-MAX_PROGRESS_EVENTS) }));
  },
  clearProgress(): void {
    set({ progress: [] });
  },
  setLoadReport(loadReport: FrozenLoadReportInfo | null): void {
    set({ loadReport });
  },
  setVerdict(verdict: FrozenVerifyVerdict | null): void {
    set({ verdict });
  },
  setLastError(lastError: FrozenChannelError | null): void {
    set({ lastError });
  },
  replaceActiveRequestId(requestType: string, requestId: string): void {
    set((state) => {
      const earlier = state.lastRequestIdByType[requestType];
      if (earlier === requestId) return state;
      const ids = [...state.activeRequestIds].filter((id) => id !== earlier);
      // Insertion order is what "last twenty" means here.
      const kept = [...ids.filter((id) => id !== requestId), requestId].slice(-MAX_ACTIVE_REQUESTS);
      return {
        activeRequestIds: new Set(kept),
        lastRequestIdByType: { ...state.lastRequestIdByType, [requestType]: requestId },
      };
    });
  },
  removeActiveRequestId(requestId: string): void {
    set((state) => {
      if (!state.activeRequestIds.has(requestId)) return state;
      const next = new Set(state.activeRequestIds);
      next.delete(requestId);
      return { activeRequestIds: next };
    });
  },
  clearActiveRequestIds(): void {
    set({ activeRequestIds: new Set<string>(), lastRequestIdByType: {} });
  },
}));
