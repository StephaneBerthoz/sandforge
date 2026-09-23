import { create } from 'zustand';
import type {
  ForgeConfig,
  ForgeGraph,
  ForgeGraphNode,
  ForgeNodeStatus,
  ForgeExecutionResult,
  ForgeTemplate,
  ForgePlan,
  ForgeAnonymizationCategory,
  ForgeBatchStrategy,
} from '@sandforge/shared';
import type { AnonymizationMethod, ComplianceReport } from '@sandforge/shared';
import { FILE_COPY_DEFAULT_MAX_MB } from '@sandforge/shared';
import { updateGraphNodeStatus } from '../utils/graphStoreUtils';

// Re-export shared types so existing imports from this module keep working.
export type {
  ForgeConfig,
  ForgeInputMode,
  ForgeDepth,
  ForgeNodeStatus,
  ForgeGraphNode,
  ForgeGraphEdge,
  ForgeGraph,
  ForgeExecutionResult,
  ForgeTemplate,
  ForgePlan,
  ForgeAnonymizationCategory,
  ForgeBatchStrategy,
} from '@sandforge/shared';

/** Metadata diff entry from backend. */
export interface MetadataDiffEntry {
  /** Object API name. */
  objectApiName: string;
  /** Field API name. */
  fieldApiName: string;
  /** Type of issue. */
  issue: 'missing' | 'type_mismatch' | 'permission_denied';
  /** Severity level. */
  severity: 'info' | 'warning' | 'error';
  /** Human-readable description. */
  details: string;
}

/** Log entry persisted in the forge store. */
export interface ForgeLogEntry {
  /** Unique log entry ID. */
  id: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Log severity level. */
  level: 'info' | 'warn' | 'error' | 'debug';
  /** Log message text. */
  message: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Forge phase in the wizard flow. */
export type ForgePhase = 'input' | 'discovery' | 'review' | 'execution' | 'results';

/** Maximum number of results kept in history. */
const MAX_HISTORY = 50;

/** Default anonymization rules per category. */
const DEFAULT_ANONYMIZATION_RULES: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
  email: 'fake',
  phone: 'mask',
  name: 'fake',
  address: 'fake',
  ssn_id: 'redact',
  financial: 'hash',
  other: 'nullify',
};

/**
 * The run's choice to copy the files of the records it clones, as Review
 * holds it. Off until the user turns it on, for every new run.
 */
export interface ForgeFileCopyChoice {
  /** Whether the run copies the files. */
  enabled: boolean;
  /** Largest file copied, in MB. */
  maxFileSizeMB: number;
  /** Whether the user accepted that files are copied as they are. */
  acceptedAsIs: boolean;
}

/** The choice a new run starts from: no file copied. */
const NO_FILE_COPY: ForgeFileCopyChoice = {
  enabled: false,
  maxFileSizeMB: FILE_COPY_DEFAULT_MAX_MB,
  acceptedAsIs: false,
};

/** Initial state values for reset. */
const INITIAL_STATE = {
  phase: 'input' as ForgePhase,
  config: null as ForgeConfig | null,
  graph: null as ForgeGraph | null,
  result: null as ForgeExecutionResult | null,
  templates: [] as ForgeTemplate[],
  history: [] as ForgeExecutionResult[],
  plan: null as ForgePlan | null,
  complianceReport: null as ComplianceReport | null,
  metadataDiffs: [] as MetadataDiffEntry[],
  anonymizationRules: { ...DEFAULT_ANONYMIZATION_RULES },
  anonymizationPresetId: '',
  fileCopy: { ...NO_FILE_COPY },
  logs: [] as ForgeLogEntry[],
  executionRequestId: null as string | null,
  stoppedAt: null as number | null,
};

/** Forge state machine store — state and actions. */
export interface ForgeState {
  /** Current wizard phase. */
  phase: ForgePhase;
  /** Active forge configuration. */
  config: ForgeConfig | null;
  /** Dependency graph built from metadata scan. */
  graph: ForgeGraph | null;
  /** Result of the last execution. */
  result: ForgeExecutionResult | null;
  /** Available forge templates. */
  templates: ForgeTemplate[];
  /** Recent execution history, newest first. */
  history: ForgeExecutionResult[];
  /** Execution plan with waves. */
  plan: ForgePlan | null;
  /** Compliance report from Review phase. */
  complianceReport: ComplianceReport | null;
  /** Metadata diffs between source and target. */
  metadataDiffs: MetadataDiffEntry[];
  /** Anonymization rules per category. */
  anonymizationRules: Record<ForgeAnonymizationCategory, AnonymizationMethod>;
  /**
   * Id of the anonymization preset picked in Review, or '' for none.
   *
   * Held here rather than in the Review tab, so a run's results can save it
   * with the run as a template, and a template can bring it back.
   */
  anonymizationPresetId: string;
  /**
   * Whether the run copies the files of the records it clones, how large a
   * file it copies, and whether the user accepted that files are copied as
   * they are. Kept apart from `config`: a template or a past run never brings
   * back the acceptance, which is given run by run.
   */
  fileCopy: ForgeFileCopyChoice;
  /**
   * Change the file choice. Turning the copy off takes the acceptance back:
   * turned on again, it is asked for again.
   */
  setFileCopy: (change: Partial<ForgeFileCopyChoice>) => void;
  /**
   * Id of the forge:execute request that started the run on screen, or null.
   * The extension correlates the run's progress, result and error to it.
   */
  executionRequestId: string | null;
  /** Record the id of the forge:execute request that started the run. */
  setExecutionRequestId: (requestId: string | null) => void;
  /**
   * How far the last run had gone when it was stopped, in percent, or null.
   *
   * Kept here because an aborted run leaves the screen that ran it at once:
   * the page says it stopped from a region that outlives the phase, as the
   * results screen says a run finished.
   */
  stoppedAt: number | null;
  /** Record where a run stopped, or clear it (null). */
  setStoppedAt: (percent: number | null) => void;

  /** Set the forge configuration. */
  setConfig: (config: ForgeConfig) => void;
  /** Set the dependency graph. */
  setGraph: (graph: ForgeGraph) => void;
  /** Transition to a new wizard phase. */
  setPhase: (phase: ForgePhase) => void;
  /** Update a node's status and optionally its progress. */
  updateNodeStatus: (objectName: string, status: ForgeNodeStatus, progress?: number) => void;
  /** Put every node back to idle, so a new run does not inherit the last one's statuses. */
  resetNodeStatuses: () => void;
  /** Record what a node turned out to hold, once the run has read it. */
  updateNodeCounts: (
    objectName: string,
    counts: { recordCount?: number; fieldCount?: number; createableFieldCount?: number },
  ) => void;
  /**
   * Take the personal fields the extension read for the nodes that named
   * none — a starter template's — and their selection, leaving every other
   * node, and everything else set on these, as it is.
   */
  fillPersonalFields: (described: ForgeGraph) => void;
  /** Toggle whether a node is included in execution. */
  toggleNodeIncluded: (objectName: string) => void;
  /**
   * Set the included flag of the named nodes, leaving every other node as it
   * is. Select All / Deselect All pass the nodes the search currently shows.
   */
  setNodesIncluded: (objectNames: readonly string[], included: boolean) => void;
  /** Toggle a field in a node's anonymizeFields list. */
  toggleAnonymizeField: (objectName: string, fieldName: string) => void;
  /** Apply a curated anonymization preset (replaces anonymizeFields per object). */
  applyAnonymizationPreset: (
    rules: ReadonlyArray<{ objectApiName: string; fieldNames: readonly string[] }>,
  ) => void;
  /** Set the execution result and append to history. */
  setResult: (result: ForgeExecutionResult) => void;
  /** Replace the template list with the one the extension keeps. */
  setTemplates: (templates: ForgeTemplate[]) => void;
  /** Add a saved template, or replace the one with the same id. */
  upsertTemplate: (template: ForgeTemplate) => void;
  /** Remove a template by id. */
  removeTemplate: (id: string) => void;
  /** Set the execution plan. */
  setPlan: (plan: ForgePlan) => void;
  /** Set the compliance report. */
  setComplianceReport: (report: ComplianceReport | null) => void;
  /** Set metadata diffs. */
  setMetadataDiffs: (diffs: MetadataDiffEntry[]) => void;
  /** Set an anonymization rule for a category. */
  setAnonymizationRule: (category: ForgeAnonymizationCategory, method: AnonymizationMethod) => void;
  /** Set the method of every category a template names, leaving the others as they are. */
  setAnonymizationRules: (
    rules: Partial<Record<ForgeAnonymizationCategory, AnonymizationMethod>>,
  ) => void;
  /** Record the preset picked in Review ('' for none). */
  setAnonymizationPresetId: (presetId: string) => void;
  /** Update a node's batch strategy. */
  updateNodeBatchStrategy: (objectApiName: string, strategy: ForgeBatchStrategy) => void;
  /** Execution log entries (persisted across phase transitions). */
  logs: ForgeLogEntry[];
  /** Append a log entry. */
  addLog: (entry: ForgeLogEntry) => void;
  /** Clear all log entries. */
  clearLogs: () => void;
  /** Soft reset: clear result/graph/plan/compliance/diffs but keep config/templates/history/rules. Go to input phase. */
  forgeAgain: () => void;
  /** Reset the store to its initial state. */
  reset: () => void;
}

/** Zustand store for forge (Smart Clone) state management. */
export const useForgeStore = create<ForgeState>((set) => ({
  ...INITIAL_STATE,

  setConfig(config: ForgeConfig): void {
    // A new run starts with no file copied: the choice and its acceptance
    // belong to the run they were made for.
    set({
      config,
      plan: null,
      complianceReport: null,
      metadataDiffs: [],
      result: null,
      fileCopy: { ...NO_FILE_COPY },
    });
  },

  setFileCopy(change: Partial<ForgeFileCopyChoice>): void {
    set((state) => {
      const next = { ...state.fileCopy, ...change };
      return { fileCopy: next.enabled ? next : { ...next, acceptedAsIs: false } };
    });
  },

  setGraph(graph: ForgeGraph): void {
    set({ graph });
  },

  setPhase(phase: ForgePhase): void {
    set({ phase });
  },

  setExecutionRequestId(executionRequestId: string | null): void {
    set({ executionRequestId });
  },

  setStoppedAt(stoppedAt: number | null): void {
    set({ stoppedAt });
  },

  updateNodeStatus(objectName: string, status: ForgeNodeStatus, progress?: number): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: updateGraphNodeStatus(state.graph.nodes, objectName, status, progress),
        },
      };
    });
  },

  /*
   * The store outlives a run: it is not persisted, but it lives as long as the
   * panel does. Nothing cleared the node statuses when a run started, so after
   * an abort or a failed run the next one opened on the previous statuses —
   * two nodes "done", two "queued", 50%, nothing in flight — and stayed there
   * through the whole opening phase, which emits no event. The elapsed clock
   * ran while the counters sat still, which is also why the remaining-time
   * estimate (elapsed x remaining / done) read exactly the elapsed time.
   */
  resetNodeStatuses(): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) => ({
            ...n,
            status: 'idle' as ForgeNodeStatus,
            progress: 0,
            successCount: 0,
            failureCount: 0,
            errors: [],
          })),
        },
      };
    });
  },

  /*
   * A graph built from a template starts every count at zero and nothing ever
   * filled them in, so the cards claimed "0 records, 0 fields" about objects
   * being cloned. The executor knows them once it has read the node; only the
   * counts it sends are written, so a status-only event leaves them alone.
   */
  updateNodeCounts(objectName, counts): void {
    set((state) => {
      if (!state.graph) return state;
      const given = Object.fromEntries(
        Object.entries(counts).filter(([, value]) => typeof value === 'number'),
      );
      if (Object.keys(given).length === 0) return state;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) =>
            n.objectApiName === objectName ? { ...n, ...given } : n,
          ),
        },
      };
    });
  },

  fillPersonalFields(described: ForgeGraph): void {
    set((state) => {
      if (!state.graph) return state;
      const read = new Map(described.nodes.map((n: ForgeGraphNode) => [n.objectApiName, n]));
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) => {
            const found = read.get(n.objectApiName);
            if (!found || n.piiFields.length > 0 || found.piiFields.length === 0) return n;
            return {
              ...n,
              piiFields: [...found.piiFields],
              anonymizeFields: [...found.anonymizeFields],
            };
          }),
        },
      };
    });
  },

  toggleNodeIncluded(objectName: string): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) =>
            n.objectApiName === objectName ? { ...n, included: !n.included } : n,
          ),
        },
      };
    });
  },

  setNodesIncluded(objectNames: readonly string[], included: boolean): void {
    const names = new Set(objectNames);
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) =>
            names.has(n.objectApiName) ? { ...n, included } : n,
          ),
        },
      };
    });
  },

  toggleAnonymizeField(objectName: string, fieldName: string): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) => {
            if (n.objectApiName !== objectName) return n;
            const anonymizeFields = n.anonymizeFields.includes(fieldName)
              ? n.anonymizeFields.filter((f: string) => f !== fieldName)
              : [...n.anonymizeFields, fieldName];
            return { ...n, anonymizeFields };
          }),
        },
      };
    });
  },

  applyAnonymizationPreset(
    rules: ReadonlyArray<{ objectApiName: string; fieldNames: readonly string[] }>,
  ): void {
    set((state) => {
      if (!state.graph) return state;
      const ruleByObject = new Map<string, readonly string[]>();
      for (const r of rules) ruleByObject.set(r.objectApiName, r.fieldNames);
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) => {
            const fields = ruleByObject.get(n.objectApiName);
            if (!fields) return n;
            // Intersect preset rules with the PII fields actually detected
            // on this node — never add a field the source schema doesn't expose.
            const detected = new Set(n.piiFields);
            const next = fields.filter((f) => detected.has(f));
            return { ...n, anonymizeFields: next };
          }),
        },
      };
    });
  },

  setResult(result: ForgeExecutionResult): void {
    set((state) => ({
      result,
      history: [result, ...state.history].slice(0, MAX_HISTORY),
    }));
  },

  setTemplates(templates: ForgeTemplate[]): void {
    set({ templates });
  },

  upsertTemplate(template: ForgeTemplate): void {
    set((state) => ({
      templates: state.templates.some((t: ForgeTemplate) => t.id === template.id)
        ? state.templates.map((t: ForgeTemplate) => (t.id === template.id ? template : t))
        : [...state.templates, template],
    }));
  },

  /*
   * By id: templates were removed by name, so deleting one of two templates
   * that shared a name took both off the list.
   */
  removeTemplate(id: string): void {
    set((state) => ({
      templates: state.templates.filter((t: ForgeTemplate) => t.id !== id),
    }));
  },

  setPlan(plan: ForgePlan): void {
    set({ plan });
  },

  setComplianceReport(report: ComplianceReport | null): void {
    set({ complianceReport: report });
  },

  setMetadataDiffs(diffs: MetadataDiffEntry[]): void {
    set({ metadataDiffs: diffs });
  },

  setAnonymizationRule(category: ForgeAnonymizationCategory, method: AnonymizationMethod): void {
    set((state) => ({
      anonymizationRules: {
        ...state.anonymizationRules,
        [category]: method,
      },
    }));
  },

  setAnonymizationRules(
    rules: Partial<Record<ForgeAnonymizationCategory, AnonymizationMethod>>,
  ): void {
    set((state) => ({ anonymizationRules: { ...state.anonymizationRules, ...rules } }));
  },

  setAnonymizationPresetId(anonymizationPresetId: string): void {
    set({ anonymizationPresetId });
  },

  updateNodeBatchStrategy(objectApiName: string, strategy: ForgeBatchStrategy): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) =>
            n.objectApiName === objectApiName ? { ...n, batchStrategy: strategy } : n,
          ),
        },
      };
    });
  },

  addLog(entry: ForgeLogEntry): void {
    // Cap log buffer to avoid O(N²) memory churn on long-running Forge runs.
    // Forge can emit hundreds of log entries; without a cap the array clones
    // grow unbounded and the panel re-render cost dominates.
    const MAX_LOGS = 500;
    set((state) => {
      const next =
        state.logs.length >= MAX_LOGS
          ? [...state.logs.slice(state.logs.length - MAX_LOGS + 1), entry]
          : [...state.logs, entry];
      return { logs: next };
    });
  },

  clearLogs(): void {
    set({ logs: [] });
  },

  forgeAgain(): void {
    set({
      phase: 'input' as ForgePhase,
      graph: null,
      result: null,
      plan: null,
      complianceReport: null,
      metadataDiffs: [],
      logs: [],
      stoppedAt: null,
      fileCopy: { ...NO_FILE_COPY },
      // Preserve: config, templates, history, anonymizationRules, anonymizationPresetId
    });
  },

  reset(): void {
    set({ ...INITIAL_STATE, templates: [], history: [], logs: [] });
  },
}));
