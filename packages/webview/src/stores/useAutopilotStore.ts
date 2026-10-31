import { create } from 'zustand';
import type {
  AutopilotGraph,
  AutopilotNode,
  AutopilotObjectListing,
  ExecutionPlan,
  ComplianceFrameworkType,
  AutopilotAnonymizationRule,
} from '@sandforge/shared';
import { updateGraphNodeStatus, updateGraphNodeProgress } from '../utils/graphStoreUtils';

/**
 * What a node came to once it settled: the records the target refused and
 * why, the records it already held and linked to, the statuses given back to
 * records born a draft, and the records left out because the platform writes
 * them, or what they depend on, itself. A field the message did not carry is
 * left alone.
 */
export type NodeOutcome = Partial<
  Pick<
    AutopilotNode,
    | 'failureCount'
    | 'linkedCount'
    | 'refusals'
    | 'statusesApplied'
    | 'statusRefusals'
    | 'leftToThePlatform'
    | 'currenciesReplaced'
    | 'pricesSettled'
  >
>;

/**
 * Autopilot wizard step. The compliance framework had a step of its own,
 * whose default copied every email and phone number as read; it is now an
 * advanced choice on the review step, beside the neutralization a run makes
 * by default.
 */
export type AutopilotStep = 'connect' | 'objects' | 'review' | 'executing' | 'completed';

/** Execution status */
export type ExecutionStatus =
  'idle' | 'scanning' | 'planning' | 'executing' | 'paused' | 'completed' | 'failed';

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
  objectListing: null as AutopilotObjectListing[] | null,
  objectCounts: {} as Record<string, number>,
  complianceFramework: 'none' as ComplianceFrameworkType,
  neutralizeContactPoints: true,
  muteAutomation: false,
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
  /**
   * The objects the source offers, as its global describe lists them: what
   * the object step chooses from. Null before the first listing.
   */
  objectListing: AutopilotObjectListing[] | null;
  /** Records per listed object, as counted once the object is picked. */
  objectCounts: Record<string, number>;
  /** Active compliance framework */
  complianceFramework: ComplianceFrameworkType;
  /**
   * Whether the run neutralizes emails and phone numbers before it writes
   * them — every address under `.invalid`, every number a fictional one —
   * as a Forge run does. On unless unticked on the review step.
   */
  neutralizeContactPoints: boolean;
  /**
   * Whether the run mutes the target's automation through its own bypass:
   * off unless ticked on the review step.
   */
  muteAutomation: boolean;
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
  /** Keep a fresh listing of the source's objects; the counts of the last one go with it. */
  setObjectListing: (listing: AutopilotObjectListing[]) => void;
  /** Add the counts of objects just counted to those known. */
  addObjectCounts: (counts: Record<string, number>) => void;
  /** Set the compliance framework */
  setComplianceFramework: (framework: ComplianceFrameworkType) => void;
  /** Neutralize emails and phone numbers, or keep them as read */
  setNeutralizeContactPoints: (on: boolean) => void;
  /** Mute the target's automation for the run, or not */
  setMuteAutomation: (mute: boolean) => void;
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
  /** Record what a node came to: its refusals, linked records and statuses */
  updateNodeOutcome: (objectName: string, outcome: NodeOutcome) => void;
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

  setObjectListing(listing: AutopilotObjectListing[]): void {
    set({ objectListing: listing, objectCounts: {} });
  },

  addObjectCounts(counts: Record<string, number>): void {
    set((state) => ({ objectCounts: { ...state.objectCounts, ...counts } }));
  },

  setComplianceFramework(framework: ComplianceFrameworkType): void {
    set({ complianceFramework: framework });
  },

  setNeutralizeContactPoints(on: boolean): void {
    set({ neutralizeContactPoints: on });
  },

  setMuteAutomation(muteAutomation: boolean): void {
    set({ muteAutomation });
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

  updateNodeOutcome(objectName: string, outcome: NodeOutcome): void {
    set((state) => {
      if (!state.graph) return state;
      const carried: NodeOutcome = {};
      if (outcome.failureCount !== undefined) carried.failureCount = outcome.failureCount;
      if (outcome.linkedCount !== undefined) carried.linkedCount = outcome.linkedCount;
      if (outcome.refusals !== undefined) carried.refusals = outcome.refusals;
      if (outcome.statusesApplied !== undefined) carried.statusesApplied = outcome.statusesApplied;
      if (outcome.statusRefusals !== undefined) carried.statusRefusals = outcome.statusRefusals;
      if (outcome.leftToThePlatform !== undefined) {
        carried.leftToThePlatform = outcome.leftToThePlatform;
      }
      if (outcome.currenciesReplaced !== undefined) {
        carried.currenciesReplaced = outcome.currenciesReplaced;
      }
      if (outcome.pricesSettled !== undefined) carried.pricesSettled = outcome.pricesSettled;
      return {
        graph: {
          ...state.graph,
          nodes: state.graph.nodes.map((node) =>
            node.objectApiName === objectName ? { ...node, ...carried } : node,
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
      objectCounts: {},
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
