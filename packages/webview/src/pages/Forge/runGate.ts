import { create } from 'zustand';
import { forgeRunGateStopOf } from '@sandforge/shared';
import type { ForgeRunGateStop, RunCheckpointInfo } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { runCheckpointOf } from '../../utils/runCheckpoint';

/**
 * Why the last run stopped at its gate — the checks the extension makes
 * between Execute and the first record a run writes — for Review to say.
 *
 * A run refused there, or cancelled at one of its questions, wrote nothing
 * and failed nothing: the page goes back to where it was sent from — Review,
 * or the results a retry was started from — rather than holding the execution
 * screen on an error. The stop is kept here until the next run starts or the
 * notice is dismissed.
 */
export interface ForgeRunGateState {
  stop: ForgeRunGateStop | null;
  /**
   * Whether the notice has been brought into view and handed the keyboard
   * for this stop. Once per stop: the page drawn again with the same stop —
   * left and come back to — does not scroll to it again.
   */
  revealed: boolean;
  /**
   * Whether the run that stopped was asked to take a checkpoint first: a run
   * past the day's API requests counts one among them only then.
   */
  checkpointAsked: boolean;
  /** What became of a checkpoint the run had taken when it stopped, when its error says. */
  checkpoint: RunCheckpointInfo | undefined;
  /** Keep why a run stopped at its gate, yet to be brought into view. */
  setStop: (
    stop: ForgeRunGateStop,
    run?: { checkpointAsked: boolean; checkpoint?: RunCheckpointInfo | undefined },
  ) => void;
  /** Say the notice of this stop has been brought into view. */
  markRevealed: () => void;
  /** Forget it: a run starts, or the notice is dismissed. */
  clear: () => void;
}

/** Zustand store for why the last Forge run stopped at its gate. */
export const useForgeRunGateStore = create<ForgeRunGateState>((set) => ({
  stop: null,
  revealed: false,
  checkpointAsked: false,
  checkpoint: undefined,
  setStop(stop, run) {
    set({
      stop,
      revealed: false,
      checkpointAsked: run?.checkpointAsked ?? false,
      checkpoint: run?.checkpoint,
    });
  },
  markRevealed() {
    set({ revealed: true });
  },
  clear() {
    set({ stop: null, revealed: false, checkpointAsked: false, checkpoint: undefined });
  },
}));

/**
 * Take the error of a run stopped at its gate: keep why, and go back to
 * Review, or, for a retry, to the results it was started from. Only the run
 * on screen counts, as the store's own listener counts it; every panel
 * receives every panel's messages.
 *
 * The store's listener has taken the error first — it is registered when the
 * store's module loads, before this one, which imports it — and holds the
 * run as stopped on it: Review is where a stopped run goes back to. A retry
 * went there too, and Review's Execute then started a new clone over the
 * records the run it retried had written.
 */
export function takeGateStop(event: MessageEvent): void {
  // SECURITY: Validate origin — only accept messages from the VSCode webview host.
  if (event.origin && !event.origin.startsWith('vscode-webview://')) return;
  const data = event.data as
    { type?: unknown; correlationId?: unknown; payload?: unknown } | null | undefined;
  if (!data || typeof data !== 'object' || data.type !== 'forge:execute:error') return;
  const payload = data.payload as { gate?: unknown; checkpoint?: unknown } | undefined;
  const stop = forgeRunGateStopOf(payload?.gate);
  if (!stop) return;
  const forge = useForgeStore.getState();
  if (forge.executionRequestId === null || forge.executionRequestId !== data.correlationId) return;
  useForgeRunGateStore.getState().setStop(stop, {
    // As the run was sent: Review's option has not moved since, it is not on screen.
    checkpointAsked: forge.checkpointFirst,
    checkpoint: runCheckpointOf(payload?.checkpoint),
  });
  if (forge.retrying && forge.result) forge.backToResults();
  else forge.reviewAgain();
}

// HMR-safe listener registration, as the store registers the run's: re-imported
// by a hot replace, the module would otherwise stack a listener per reload.
let gateListenerRegistered = false;
function registerGateListener(): void {
  if (gateListenerRegistered || typeof window === 'undefined') return;
  gateListenerRegistered = true;
  window.addEventListener('message', takeGateStop);
  if (typeof import.meta !== 'undefined' && import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('message', takeGateStop);
      gateListenerRegistered = false;
    });
  }
}
registerGateListener();
