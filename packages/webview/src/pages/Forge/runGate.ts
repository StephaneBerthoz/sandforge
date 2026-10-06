import { create } from 'zustand';
import { forgeRunGateStopOf } from '@sandforge/shared';
import type { ForgeRunGateStop } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';

/**
 * Why the last run stopped at its gate — the checks the extension makes
 * between Execute and the first record a run writes — for Review to say.
 *
 * A run refused there, or cancelled at one of its questions, wrote nothing
 * and failed nothing: the page goes back to Review, where it was sent from,
 * rather than holding the execution screen on an error. The stop is kept here
 * until the next run starts or the notice is dismissed.
 */
export interface ForgeRunGateState {
  stop: ForgeRunGateStop | null;
  /** Keep why a run stopped at its gate. */
  setStop: (stop: ForgeRunGateStop) => void;
  /** Forget it: a run starts, or the notice is dismissed. */
  clear: () => void;
}

/** Zustand store for why the last Forge run stopped at its gate. */
export const useForgeRunGateStore = create<ForgeRunGateState>((set) => ({
  stop: null,
  setStop(stop) {
    set({ stop });
  },
  clear() {
    set({ stop: null });
  },
}));

/**
 * Take the error of a run stopped at its gate: keep why, and go back to
 * Review. Only the run on screen counts, as the store's own listener counts
 * it; every panel receives every panel's messages.
 *
 * The store's listener has taken the error first — it is registered when the
 * store's module loads, before this one, which imports it — and holds the
 * run as stopped on it: Review is where a stopped run goes back to.
 */
export function takeGateStop(event: MessageEvent): void {
  // SECURITY: Validate origin — only accept messages from the VSCode webview host.
  if (event.origin && !event.origin.startsWith('vscode-webview://')) return;
  const data = event.data as
    { type?: unknown; correlationId?: unknown; payload?: unknown } | null | undefined;
  if (!data || typeof data !== 'object' || data.type !== 'forge:execute:error') return;
  const stop = forgeRunGateStopOf((data.payload as { gate?: unknown } | undefined)?.gate);
  if (!stop) return;
  const forge = useForgeStore.getState();
  if (forge.executionRequestId === null || forge.executionRequestId !== data.correlationId) return;
  useForgeRunGateStore.getState().setStop(stop);
  forge.reviewAgain();
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
