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
import { FILE_COPY_DEFAULT_MAX_MB, forgeNodeStatusSchema } from '@sandforge/shared';
import i18n from '../i18n';
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

/**
 * How the run on screen ended when an error ended it rather than its answer:
 * what went wrong, and what it had written by then when the error said so.
 */
export interface ForgeRunError {
  /** What went wrong, as the extension said it. */
  message: string;
  /**
   * The run as the extension keeps it in its history, when it had created
   * records before it stopped; null when the error said nothing of them.
   */
  stoppedRun: ForgeExecutionResult | null;
}

/**
 * How long the run on screen has gone, by this machine's clock: when it
 * started, how long it was held paused, and whether it is paused now or has
 * ended.
 */
export interface ForgeRunClock {
  /** When the run was started, in milliseconds. */
  startedAt: number;
  /** How long it was held paused before the pause under way, in milliseconds. */
  pausedMs: number;
  /** When the pause under way began, or null while the run is not paused. */
  pausedSince: number | null;
  /** When the run ended — answered, or stopped by its error — or null while it goes on. */
  endedAt: number | null;
}

/**
 * How long a run has gone at `now`, in whole seconds, its pauses not counted:
 * frozen while it is paused, and once it has ended.
 */
export function runElapsedSeconds(clock: ForgeRunClock, now: number): number {
  const at = clock.pausedSince ?? clock.endedAt ?? now;
  return Math.max(0, Math.floor((at - clock.startedAt - clock.pausedMs) / 1000));
}

/** `clock` stopped now, unless it had stopped already. */
function endedClock(clock: ForgeRunClock | null): ForgeRunClock | null {
  return clock && clock.endedAt === null ? { ...clock, endedAt: Date.now() } : clock;
}

/** A `forge:progress` event of a run, as the store takes it. */
export interface ForgeProgressUpdate {
  /** The object the event is about. */
  objectName: string;
  /** Where the object stands. */
  status: ForgeNodeStatus;
  /** How far the object has gone, in percent, when the event says. */
  progress?: number;
  /** The executor's own line for the log, when it wrote one. */
  message?: string;
  /**
   * What the node turned out to hold, once the run has read it: its records
   * are those of every write of the object so far.
   */
  recordCount?: number;
  fieldCount?: number;
  createableFieldCount?: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Forge phase in the wizard flow. */
export type ForgePhase = 'input' | 'discovery' | 'review' | 'execution' | 'results';

/** Maximum number of results kept in history. */
const MAX_HISTORY = 50;

/**
 * Most log lines a run keeps. Forge can emit hundreds of them; without a cap
 * the array clones grow unbounded and the panel's re-render cost dominates.
 */
const MAX_LOGS = 500;

/** `logs` with `entry` appended, the oldest dropped past the cap. */
function withLogLine(logs: ForgeLogEntry[], entry: ForgeLogEntry): ForgeLogEntry[] {
  return logs.length >= MAX_LOGS
    ? [...logs.slice(logs.length - MAX_LOGS + 1), entry]
    : [...logs, entry];
}

/** How many log lines were made, for the id of the next. */
let logLinesMade = 0;

/**
 * A line for the run's log, stamped now, with an id no other line has: the
 * lines outlive the screen that shows them, and a counter kept by the screen
 * started again at each mount.
 */
export function forgeLogEntry(level: ForgeLogEntry['level'], message: string): ForgeLogEntry {
  logLinesMade += 1;
  return { id: `forge-log-${String(logLinesMade)}`, timestamp: Date.now(), level, message };
}

/**
 * How far a run has gone, in percent: the share of the graph's objects that
 * have settled. A node that was skipped or failed is finished with, so it
 * counts: dividing only the "done" nodes by the total left a completed run
 * showing 50% whenever half its objects had been skipped.
 */
export function settledPercent(nodes: readonly ForgeGraphNode[]): number {
  if (nodes.length === 0) return 0;
  const settled = nodes.filter(
    (n) => n.status === 'done' || n.status === 'error' || n.status === 'skipped',
  ).length;
  return Math.round((settled / nodes.length) * 100);
}

/**
 * `node` put into the run or taken out of it by the user.
 *
 * Taken out, it is marked as the user's: the run then holds back what cannot
 * be written without it and says what that costs, where a node discovery left
 * out is only skipped. Put back, the mark goes. A node already where the user
 * puts it — an empty table discovery left out, under Deselect All — is left
 * as it is, so discovery's stay unmarked.
 */
function includedByUser(node: ForgeGraphNode, included: boolean): ForgeGraphNode {
  if (node.included === included) return node;
  if (!included) return { ...node, included: false, leftOutByUser: true };
  const back: ForgeGraphNode = { ...node, included: true };
  delete back.leftOutByUser;
  return back;
}

/** Every node back to idle, keeping what discovery said went wrong with each. */
function idleNodes(nodes: ForgeGraphNode[]): ForgeGraphNode[] {
  return nodes.map((n: ForgeGraphNode) => ({
    ...n,
    status: 'idle' as ForgeNodeStatus,
    progress: 0,
    successCount: 0,
    failureCount: 0,
  }));
}

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
  statusesBeyondGraph: {} as Record<string, ForgeNodeStatus>,
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
  runError: null as ForgeRunError | null,
  runClock: null as ForgeRunClock | null,
  stopRequestedAt: null as number | null,
  runsEnded: 0,
};

/** Forge state machine store — state and actions. */
export interface ForgeState {
  /** Current wizard phase. */
  phase: ForgePhase;
  /** Active forge configuration. */
  config: ForgeConfig | null;
  /** Dependency graph built from metadata scan. */
  graph: ForgeGraph | null;
  /**
   * The status the run on screen last reported of each object the graph holds
   * no node of, by API name: the catalog beyond the cap and the selling model
   * options a run adds to discovery's graph, a parent an orphan needed. The
   * results give such an object a row from what the run's result carries, and
   * this is the status it shows. Emptied as a run starts.
   */
  statusesBeyondGraph: Record<string, ForgeNodeStatus>;
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
  /**
   * Record the id of the forge:execute request that started the run: a new
   * run, which starts with none of the last one's log lines, error or stop.
   */
  setExecutionRequestId: (requestId: string | null) => void;
  /**
   * Why the run on screen stopped, when an error ended it rather than its
   * answer, or null.
   *
   * Kept here, as its answer is: the execution screen that showed the error
   * went with the page, and came back as a run under way.
   */
  runError: ForgeRunError | null;
  /**
   * Take a `forge:progress` event: when it reports on the run on screen, set
   * its object's status and counts and log it. An event of another request,
   * or one that comes once the run was left or had stopped, changes nothing.
   *
   * @param requestId - The request the event correlates to.
   * @param update - What the event says of its object.
   */
  takeProgress: (requestId: unknown, update: ForgeProgressUpdate) => void;
  /**
   * Take the extension's error for a `forge:execute` request: when it ends
   * the run on screen, keep why, what it had written if the error says, and
   * where it stopped, and log it. An error of another request, or one that
   * comes once the run was left, changes nothing.
   *
   * @param requestId - The request the error correlates to.
   * @param message - What went wrong.
   * @param stoppedRun - What the run had written, when the error carries it.
   */
  failRun: (
    requestId: unknown,
    message: string,
    stoppedRun: ForgeExecutionResult | undefined,
  ) => void;
  /** Show the results of what the run that stopped had written, when its error said. */
  showStoppedRun: () => void;
  /**
   * Leave the run that stopped for the Review it was started from, with the
   * graph as discovery left it for the next run.
   */
  reviewAgain: () => void;
  /**
   * How long the run on screen has gone, or null while none was started.
   *
   * Kept here, not by the execution screen: left and come back to, the
   * screen's own clock started again at 0:00, and a paused run read as
   * forging, with Pause to press again.
   */
  runClock: ForgeRunClock | null;
  /** Hold the run on screen: its clock stands still until it is resumed. */
  pauseRun: () => void;
  /** Let the run on screen go on: its clock goes on from where it stood. */
  resumeRun: () => void;
  /**
   * When the user asked the run on screen to stop, by this machine's clock, or
   * null while no stop is asked of it or it has answered.
   *
   * A run stops once the step under way is done, then says what it wrote. The
   * screen used to leave for the input screen as the abort was sent: the
   * answer that said what the run had written came to no screen, and the
   * recent runs, read as that screen came, were read before the run was kept.
   * Kept as a time, not a flag: a stop that goes unanswered has a way out
   * once it has waited long enough, however often the screen was left and
   * came back meanwhile.
   */
  stopRequestedAt: number | null;
  /** Ask the run on screen to stop, while it goes on; nothing once it has ended. */
  requestStop: () => void;
  /**
   * Leave a run asked to stop that has not answered, for the input screen.
   * Its answer, should it come, changes nothing on screen: the run is in the
   * recent runs by then, which are read again as it ends.
   */
  leaveStoppingRun: () => void;
  /**
   * How many runs this panel has heard end — its own or another panel's,
   * answered or stopped by an error. Each is in the extension's history by
   * then: the recent runs are read again at every change.
   */
  runsEnded: number;
  /**
   * How far the last run had gone when it was stopped, in percent, or null.
   *
   * Kept here because the screen that ran it can be left and come back to:
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
  /**
   * Update a node's status and optionally its progress; for an object the
   * graph holds no node of, keep its status in `statusesBeyondGraph`.
   */
  updateNodeStatus: (objectName: string, status: ForgeNodeStatus, progress?: number) => void;
  /**
   * Put every node back to idle, so a new run does not inherit the last one's
   * statuses, keeping what discovery said went wrong with each.
   */
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
  /**
   * Take the extension's answer to a `forge:execute` request: when it answers
   * the run on screen, keep its result and show the results. An answer to
   * another request, or one that comes once the run was left, changes nothing.
   *
   * @param requestId - The request the answer correlates to.
   * @param result - The run's result, when the answer carries one.
   */
  finishRun: (requestId: unknown, result: ForgeExecutionResult | undefined) => void;
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
  /** Soft reset: clear result/graph/plan/compliance/diffs but keep config/templates/history/rules. Go to input phase. */
  forgeAgain: () => void;
  /** Reset the store to its initial state. */
  reset: () => void;
}

/*
 * Whether a message correlated to `requestId` is the run on screen's. Every
 * panel receives every forge message, so it is only when it correlates to the
 * request that started the run; and a run left before it ended — back on
 * the input screen, or its results already shown — has no screen to show it
 * on.
 */
function ofRunOnScreen(state: ForgeState, requestId: unknown): boolean {
  return (
    state.executionRequestId !== null &&
    requestId === state.executionRequestId &&
    state.phase === 'execution'
  );
}

/** Zustand store for forge (Smart Clone) state management. */
export const useForgeStore = create<ForgeState>((set, get) => ({
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

  /*
   * The execution screen used to clear the log and the stop as it mounted:
   * left and come back to, it cleared those of the run it was showing. A run
   * starts here, once.
   */
  setExecutionRequestId(executionRequestId: string | null): void {
    set({
      executionRequestId,
      logs: [],
      runError: null,
      stoppedAt: null,
      stopRequestedAt: null,
      runClock:
        executionRequestId === null
          ? null
          : { startedAt: Date.now(), pausedMs: 0, pausedSince: null, endedAt: null },
    });
  },

  pauseRun(): void {
    set((state) => {
      const clock = state.runClock;
      if (!clock || clock.pausedSince !== null || clock.endedAt !== null) return state;
      if (state.phase !== 'execution' || state.runError || state.stopRequestedAt !== null) {
        return state;
      }
      return { runClock: { ...clock, pausedSince: Date.now() } };
    });
  },

  resumeRun(): void {
    set((state) => {
      const clock = state.runClock;
      if (!clock || clock.pausedSince === null || clock.endedAt !== null) return state;
      return {
        runClock: {
          ...clock,
          pausedMs: clock.pausedMs + (Date.now() - clock.pausedSince),
          pausedSince: null,
        },
      };
    });
  },

  requestStop(): void {
    set((state) => {
      if (state.phase !== 'execution' || state.executionRequestId === null) return state;
      if (state.runError || (state.runClock !== null && state.runClock.endedAt !== null)) {
        return state;
      }
      // Asked once: asked again, the wait for its answer would start over.
      if (state.stopRequestedAt !== null) return state;
      return { stopRequestedAt: Date.now() };
    });
  },

  /*
   * Only from a run asked to stop that has not answered. STOPPING... used to
   * have no way out: a run whose answer never came held the page on it until
   * the panel was closed. A run under way has no other screen to be stopped
   * from, and one that answered has its own way on.
   */
  leaveStoppingRun(): void {
    const state = get();
    if (state.phase !== 'execution' || state.stopRequestedAt === null || state.runError) return;
    state.forgeAgain();
  },

  /*
   * The only listener for these events lived in the execution screen, and
   * left with it: back on the page, the objects stood where they had stood
   * when it was left, and the log started empty.
   */
  takeProgress(requestId: unknown, update: ForgeProgressUpdate): void {
    const state = get();
    // The extension flushes the last throttled event after the error: the
    // run has ended by then.
    if (!ofRunOnScreen(state, requestId) || state.runError) return;
    const { objectName, status, progress } = update;
    state.updateNodeStatus(objectName, status, progress);
    // Counts ride the same event once the run has read the object: the
    // records of every write of it so far, which the extension adds up, in
    // place of discovery's count. An event that knows none leaves the node's
    // own alone.
    state.updateNodeCounts(objectName, {
      recordCount: update.recordCount,
      fieldCount: update.fieldCount,
      createableFieldCount: update.createableFieldCount,
    });
    const line = forgeLogEntry(
      status === 'error' ? 'error' : 'info',
      update.message ??
        `${objectName}: ${status}${progress !== undefined ? ` (${String(progress)}%)` : ''}`,
    );
    set((s) => ({ logs: withLogLine(s.logs, line) }));
  },

  failRun(requestId: unknown, message: string, stoppedRun: ForgeExecutionResult | undefined): void {
    set((state) => {
      if (!ofRunOnScreen(state, requestId) || state.runError) return state;
      return {
        runError: { message, stoppedRun: stoppedRun ?? null },
        // Said by the page, whose region outlives the screen: where it stopped.
        stoppedAt: settledPercent(state.graph?.nodes ?? []),
        logs: withLogLine(state.logs, forgeLogEntry('error', message)),
        // An abort asked for is answered here, with what the run wrote.
        stopRequestedAt: null,
        runClock: endedClock(state.runClock),
      };
    });
  },

  /*
   * What the run wrote is known to the last record, as the history keeps it:
   * the results show it as they show a finished run, with its Id map and its
   * errors, and say why it stopped.
   */
  showStoppedRun(): void {
    set((state) => {
      const stopped = state.runError?.stoppedRun;
      if (!stopped || state.phase !== 'execution') return state;
      return {
        phase: 'results' as ForgePhase,
        result: stopped,
        history: [stopped, ...state.history].slice(0, MAX_HISTORY),
      };
    });
  },

  /*
   * Only from a run that stopped: leaving a run under way for Review would
   * leave it writing with no screen to stop it from. The statuses it left on
   * the graph are not the next run's, and Review draws them.
   */
  reviewAgain(): void {
    set((state) => {
      if (state.phase !== 'execution' || !state.runError) return state;
      return {
        phase: 'review' as ForgePhase,
        runError: null,
        runClock: null,
        ...(state.graph ? { graph: { ...state.graph, nodes: idleNodes(state.graph.nodes) } } : {}),
        statusesBeyondGraph: {},
      };
    });
  },

  setStoppedAt(stoppedAt: number | null): void {
    set({ stoppedAt });
  },

  updateNodeStatus(objectName: string, status: ForgeNodeStatus, progress?: number): void {
    set((state) => {
      if (!state.graph) return state;
      // An object the run adds to the graph reports as the others do, and its
      // status used to go nowhere: its row on the results had none to show.
      if (!state.graph.nodes.some((n: ForgeGraphNode) => n.objectApiName === objectName)) {
        return { statusesBeyondGraph: { ...state.statusesBeyondGraph, [objectName]: status } };
      }
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
   *
   * A node's errors are discovery's — its describe or its count failed — and
   * stay: a run reports its own in its result, never on the nodes. Wiped here,
   * the results listed every object the org would not count (NOACCESS, "does
   * not support query") with no error at all.
   */
  resetNodeStatuses(): void {
    set((state) => {
      if (!state.graph) return state;
      return {
        graph: { ...state.graph, nodes: idleNodes(state.graph.nodes) },
        statusesBeyondGraph: {},
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
            n.objectApiName === objectName ? includedByUser(n, !n.included) : n,
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
            names.has(n.objectApiName) ? includedByUser(n, included) : n,
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

  finishRun(requestId: unknown, result: ForgeExecutionResult | undefined): void {
    set((state) => {
      if (!ofRunOnScreen(state, requestId)) return state;
      // An answer with no result leaves none on screen: a retry's would
      // otherwise show the run it retried. One that comes after an abort was
      // asked for is of a run that finished before the abort reached it.
      return {
        phase: 'results' as ForgePhase,
        result: result ?? null,
        stopRequestedAt: null,
        runClock: endedClock(state.runClock),
        ...(result ? { history: [result, ...state.history].slice(0, MAX_HISTORY) } : {}),
      };
    });
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
    set((state) => ({ logs: withLogLine(state.logs, entry) }));
  },

  forgeAgain(): void {
    set({
      phase: 'input' as ForgePhase,
      graph: null,
      statusesBeyondGraph: {},
      result: null,
      plan: null,
      complianceReport: null,
      metadataDiffs: [],
      logs: [],
      stoppedAt: null,
      runError: null,
      runClock: null,
      stopRequestedAt: null,
      fileCopy: { ...NO_FILE_COPY },
      // Preserve: config, templates, history, anonymizationRules, anonymizationPresetId
    });
  },

  reset(): void {
    set({ ...INITIAL_STATE, templates: [], history: [], logs: [] });
  },
}));

/**
 * A `forge:progress` payload as the store takes it, or null when it names no
 * object or no status a node can have.
 */
function progressUpdate(payload: unknown): ForgeProgressUpdate | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as Record<string, unknown>;
  const status = forgeNodeStatusSchema.safeParse(event.status);
  if (typeof event.objectName !== 'string' || event.objectName === '' || !status.success) {
    return null;
  }
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' ? value : undefined;
  return {
    objectName: event.objectName,
    status: status.data,
    progress: count(event.progress),
    message: typeof event.message === 'string' ? event.message : undefined,
    recordCount: count(event.recordCount),
    fieldCount: count(event.fieldCount),
    createableFieldCount: count(event.createableFieldCount),
  };
}

/**
 * What the extension says of a run — its progress, its answer, its error —
 * taken here rather than by a screen.
 *
 * A run's last steps — the lookups filled in last, the files, the statuses
 * given back, reading back when the target dated its writes — come after its
 * last object's event, and its answer carries what the whole run did. The
 * only listener for that answer lived in the execution screen, which left
 * for the results as soon as the last object settled and took the listener
 * with it: an answer later than its exit was dropped, and the results showed
 * no record inserted, no rate from the records read and no Id map. The run's
 * progress and its error went the same way whenever the page was left while
 * the run went on. The store outlives every screen of the page, and the page
 * itself.
 */
function takeRunMessage(event: MessageEvent): void {
  // SECURITY: Validate origin — only accept messages from the VSCode webview host.
  if (event.origin && !event.origin.startsWith('vscode-webview://')) return;
  const data = event.data as
    | { type?: unknown; correlationId?: unknown; payload?: unknown }
    | null
    | undefined;
  if (!data || typeof data !== 'object') return;
  const store = useForgeStore.getState();
  if (data.type === 'forge:progress') {
    const update = progressUpdate(data.payload);
    if (update) store.takeProgress(data.correlationId, update);
    return;
  }
  if (data.type !== 'forge:execute:response' && data.type !== 'forge:execute:error') return;
  // Whichever run it ends, this panel's or another's, the extension keeps it
  // in its history before it says so: the recent runs are read again.
  useForgeStore.setState((state) => ({ runsEnded: state.runsEnded + 1 }));
  if (data.type === 'forge:execute:response') {
    const payload = data.payload as { result?: ForgeExecutionResult } | undefined;
    store.finishRun(data.correlationId, payload?.result);
  } else {
    const payload = (data.payload ?? {}) as { message?: unknown; result?: unknown };
    const message =
      typeof payload.message === 'string' && payload.message !== ''
        ? payload.message
        : i18n.t('forge.executeFailed');
    const stoppedRun =
      payload.result && typeof payload.result === 'object'
        ? (payload.result as ForgeExecutionResult)
        : undefined;
    store.failRun(data.correlationId, message, stoppedRun);
  }
}

// HMR-safe listener registration, as the CDC stores do it: re-imported by a
// hot replace, the module would otherwise stack a listener per reload and
// take every message once per copy.
let runListenerRegistered = false;
function registerRunListener(): void {
  if (runListenerRegistered || typeof window === 'undefined') return;
  runListenerRegistered = true;
  window.addEventListener('message', takeRunMessage);
  if (typeof import.meta !== 'undefined' && import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('message', takeRunMessage);
      runListenerRegistered = false;
    });
  }
}
registerRunListener();
