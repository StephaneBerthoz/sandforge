import { create } from 'zustand';
import type {
  AutopilotGraph,
  AutopilotNode,
  ExecutionPlan,
  ComplianceFrameworkType,
  AutopilotAnonymizationRule,
} from '@sandforge/shared';
import { updateGraphNodeStatus, updateGraphNodeProgress } from '../utils/graphStoreUtils';

/** Autopilot wizard step */
export type AutopilotStep =
  | 'connect'
  | 'objects'
  | 'compliance'
  | 'review'
  | 'executing'
  | 'completed';

/** Execution status */
export type ExecutionStatus =
  | 'idle'
  | 'scanning'
  | 'planning'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed';

/** Live statistics during execution */
export interface LiveStats {
  recordsProcessed: number;
  recordsTotal: number;
  apiCallsUsed: number;
  apiCallsEstimated: number;
  elapsedMs: number;
  currentWave: number;
  totalWaves: number;
}

/** Default live stats values */
const DEFAULT_LIVE_STATS: LiveStats = {
  recordsProcessed: 0,
  recordsTotal: 0,
  apiCallsUsed: 0,
  apiCallsEstimated: 0,
  elapsedMs: 0,
  currentWave: 0,
  totalWaves: 0,
};

/** Initial state values for reset */
const INITIAL_STATE = {
  step: 'connect' as AutopilotStep,
  sourceOrgId: null as string | null,
  targetOrgId: null as string | null,
  selectedObjects: [] as string[],
  complianceFramework: 'none' as ComplianceFrameworkType,
  graph: null as AutopilotGraph | null,
  plan: null as ExecutionPlan | null,
  rules: [] as AutopilotAnonymizationRule[],
  executionStatus: 'idle' as ExecutionStatus,
  selectedNodeName: null as string | null,
  liveStats: { ...DEFAULT_LIVE_STATS },
  errors: [] as string[],
};

/** Autopilot store state and actions */
export interface AutopilotState {
  /** Current wizard step */
  step: AutopilotStep;
  /** Source org identifier */
  sourceOrgId: string | null;
  /** Target org identifier */
  targetOrgId: string | null;
  /** Selected Salesforce object API names */
  selectedObjects: string[];
  /** Active compliance framework */
  complianceFramework: ComplianceFrameworkType;
  /** Dependency graph built from metadata scan */
  graph: AutopilotGraph | null;
  /** Execution plan derived from the graph */
  plan: ExecutionPlan | null;
  /** Anonymization rules to apply */
  rules: AutopilotAnonymizationRule[];
  /** Current execution status */
  executionStatus: ExecutionStatus;
  /** Currently selected node name for detail panel */
  selectedNodeName: string | null;
  /** Live statistics during execution */
  liveStats: LiveStats;
  /** Accumulated error messages */
  errors: string[];

  /** Set the current wizard step */
  setStep: (step: AutopilotStep) => void;
  /** Set the source org identifier */
  setSourceOrg: (orgId: string | null) => void;
  /** Set the target org identifier */
  setTargetOrg: (orgId: string | null) => void;
  /** Replace all selected objects */
  setSelectedObjects: (objects: string[]) => void;
  /** Toggle a single object in the selection */
  toggleObject: (objectName: string) => void;
  /** Set the compliance framework */
  setComplianceFramework: (framework: ComplianceFrameworkType) => void;
  /** Set the dependency graph */
  setGraph: (graph: AutopilotGraph | null) => void;
  /** Set the execution plan */
  setPlan: (plan: ExecutionPlan | null) => void;
  /** Set anonymization rules */
  setRules: (rules: AutopilotAnonymizationRule[]) => void;
  /** Set the execution status */
  setExecutionStatus: (status: ExecutionStatus) => void;
  /** Select a node by object API name */
  selectNode: (nodeName: string | null) => void;
  /** Update a node's status and optionally its progress */
  updateNodeStatus: (
    objectName: string,
    status: AutopilotNode['status'],
    progress?: number,
  ) => void;
  /** Update a node's progress and records processed */
  updateNodeProgress: (objectName: string, progress: number, recordsProcessed: number) => void;
  /** Merge partial live stats updates */
  updateLiveStats: (stats: Partial<LiveStats>) => void;
  /** Append an error message */
  addError: (error: string) => void;
  /** Reset the store to initial state */
  reset: () => void;

  /** Get the currently selected node */
  selectedNode: () => AutopilotNode | undefined;
  /** Count nodes with 'completed' status */
  completedCount: () => number;
  /** Count nodes with 'failed' status */
  failedCount: () => number;
  /** Compute overall progress percentage (0-100) */
  overallProgress: () => number;
}

/** Zustand store for autopilot state management */
export const useAutopilotStore = create<AutopilotState>((set, get) => ({
  ...INITIAL_STATE,

  setStep(step: AutopilotStep): void {
    set({ step });
  },

  setSourceOrg(orgId: string | null): void {
    set({ sourceOrgId: orgId });
  },

  setTargetOrg(orgId: string | null): void {
    set({ targetOrgId: orgId });
  },

  setSelectedObjects(objects: string[]): void {
    set({ selectedObjects: objects });
  },

  toggleObject(objectName: string): void {
    set((state) => {
      const exists = state.selectedObjects.includes(objectName);
      return {
        selectedObjects: exists
          ? state.selectedObjects.filter((o) => o !== objectName)
          : [...state.selectedObjects, objectName],
      };
    });
  },

  setComplianceFramework(framework: ComplianceFrameworkType): void {
    set({ complianceFramework: framework });
  },

  setGraph(graph: AutopilotGraph | null): void {
    set({ graph });
  },

  setPlan(plan: ExecutionPlan | null): void {
    set({ plan });
  },

  setRules(rules: AutopilotAnonymizationRule[]): void {
    set({ rules });
  },

  setExecutionStatus(status: ExecutionStatus): void {
    set({ executionStatus: status });
  },

  selectNode(nodeName: string | null): void {
    set({ selectedNodeName: nodeName });
  },

  updateNodeStatus(objectName: string, status: AutopilotNode['status'], progress?: number): void {
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

  updateNodeProgress(objectName: string, progress: number, recordsProcessed: number): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: {
          ...state.graph,
          nodes: updateGraphNodeProgress(
            state.graph.nodes,
            objectName,
            progress,
            'successCount',
            recordsProcessed,
          ),
        },
      };
    });
  },

  updateLiveStats(stats: Partial<LiveStats>): void {
    set((state) => ({
      liveStats: { ...state.liveStats, ...stats },
    }));
  },

  addError(error: string): void {
    set((state) => ({ errors: [...state.errors, error] }));
  },

  reset(): void {
    set({
      ...INITIAL_STATE,
      liveStats: { ...DEFAULT_LIVE_STATS },
      errors: [],
      selectedObjects: [],
      rules: [],
    });
  },

  selectedNode(): AutopilotNode | undefined {
    const { graph, selectedNodeName } = get();
    if (!graph || !selectedNodeName) return undefined;
    return graph.nodes.find((n) => n.objectApiName === selectedNodeName);
  },

  completedCount(): number {
    const { graph } = get();
    if (!graph) return 0;
    return graph.nodes.filter((n) => n.status === 'completed').length;
  },

  failedCount(): number {
    const { graph } = get();
    if (!graph) return 0;
    return graph.nodes.filter((n) => n.status === 'failed').length;
  },

  overallProgress(): number {
    const { graph } = get();
    if (!graph || graph.nodes.length === 0) return 0;
    const totalProgress = graph.nodes.reduce((sum, node) => sum + node.progress, 0);
    return Math.round(totalProgress / graph.nodes.length);
  },
}));

/* Expose store for E2E testing in development mode */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__AUTOPILOT_STORE__ = useAutopilotStore;
}
