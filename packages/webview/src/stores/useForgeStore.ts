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
  logs: [] as ForgeLogEntry[],
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

  /** Set the forge configuration. */
  setConfig: (config: ForgeConfig) => void;
  /** Set the dependency graph. */
  setGraph: (graph: ForgeGraph) => void;
  /** Transition to a new wizard phase. */
  setPhase: (phase: ForgePhase) => void;
  /** Update a node's status and optionally its progress. */
  updateNodeStatus: (objectName: string, status: ForgeNodeStatus, progress?: number) => void;
  /** Toggle whether a node is included in execution. */
  toggleNodeIncluded: (objectName: string) => void;
  /** Set all graph nodes' included flag to the given value. */
  setAllNodesIncluded: (included: boolean) => void;
  /** Toggle a field in a node's anonymizeFields list. */
  toggleAnonymizeField: (objectName: string, fieldName: string) => void;
  /** Apply a curated anonymization preset (replaces anonymizeFields per object). */
  applyAnonymizationPreset: (
    rules: ReadonlyArray<{ objectApiName: string; fieldNames: readonly string[] }>,
  ) => void;
  /** Set the execution result and append to history. */
  setResult: (result: ForgeExecutionResult) => void;
  /** Remove a template by name. */
  removeTemplate: (name: string) => void;
  /** Add a new template to the list. */
  addTemplate: (template: ForgeTemplate) => void;
  /** Update an existing template's name and/or description. */
  updateTemplate: (id: string, updates: { name?: string; description?: string }) => void;
  /** Set the execution plan. */
  setPlan: (plan: ForgePlan) => void;
  /** Set the compliance report. */
  setComplianceReport: (report: ComplianceReport | null) => void;
  /** Set metadata diffs. */
  setMetadataDiffs: (diffs: MetadataDiffEntry[]) => void;
  /** Set an anonymization rule for a category. */
  setAnonymizationRule: (category: ForgeAnonymizationCategory, method: AnonymizationMethod) => void;
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
    set({ config, plan: null, complianceReport: null, metadataDiffs: [], result: null });
  },

  setGraph(graph: ForgeGraph): void {
    set({ graph });
  },

  setPhase(phase: ForgePhase): void {
    set({ phase });
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

  setAllNodesIncluded(included: boolean): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((n: ForgeGraphNode) => ({ ...n, included })),
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

  removeTemplate(name: string): void {
    set((state) => ({
      templates: state.templates.filter((t: ForgeTemplate) => t.name !== name),
    }));
  },

  addTemplate(template: ForgeTemplate): void {
    set((state) => ({
      templates: [...state.templates, template],
    }));
  },

  updateTemplate(id: string, updates: { name?: string; description?: string }): void {
    set((state) => ({
      templates: state.templates.map((t: ForgeTemplate) =>
        t.id === id ? { ...t, ...updates } : t,
      ),
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
      // Preserve: config, templates, history, anonymizationRules
    });
  },

  reset(): void {
    set({ ...INITIAL_STATE, templates: [], history: [], logs: [] });
  },
}));
