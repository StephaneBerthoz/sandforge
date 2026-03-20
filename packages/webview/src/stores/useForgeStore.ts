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
  /** Toggle a field in a node's anonymizeFields list. */
  toggleAnonymizeField: (objectName: string, fieldName: string) => void;
  /** Set the execution result and append to history. */
  setResult: (result: ForgeExecutionResult) => void;
  /** Remove a template by name. */
  removeTemplate: (name: string) => void;
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

  reset(): void {
    set({ ...INITIAL_STATE, templates: [], history: [] });
  },
}));
