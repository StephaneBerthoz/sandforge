import { findForgeAnonymizationPreset } from '@sandforge/shared';
import type { ForgeGraph } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { startForgeRun } from './startForgeRun';

/**
 * Put the graph a discovery answered with in the store, as the discovery
 * screen shows it and Review sends it.
 *
 * A preset picked in Review — or brought back by a template — applies to the
 * graph it is shown beside. A new graph comes back with every PII field it
 * found selected, and the Review tab would show the preset over fields it
 * never chose.
 */
export function adoptDiscoveredGraph(graph: ForgeGraph): void {
  useForgeStore.getState().setGraph(graph);
  const { anonymizationPresetId, config, applyAnonymizationPreset } = useForgeStore.getState();
  const preset = findForgeAnonymizationPreset(anonymizationPresetId);
  if (preset && config?.anonymizePII) applyAnonymizationPreset(preset.rules);
}

/** Whether `value` has the one part of a graph the run cannot start without: its nodes. */
function isGraph(value: unknown): value is ForgeGraph {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

/**
 * The answer to the discovery a Clone directly waits on, taken here rather
 * than by the discovery screen.
 *
 * The Forge page can be left while its discovery runs — the command palette
 * or a shortcut takes the panel to another page — and a screen's listener
 * goes with the page: taken there, the answer would come to no screen, the
 * run would never start, and the page would come back to a spinner with
 * nothing behind it. Taken here, the run starts as the discovery answers,
 * page or no page, as a run started from Review goes on while the page is
 * away: its progress, its answer and its error are the store's, and
 * Production Guard asks its confirmation in a VS Code dialog, whatever the
 * panel shows. Its error is kept for the discovery screen, which shows it
 * when it comes back.
 *
 * Only the answer correlated to that discovery's request counts: every panel
 * receives every panel's messages.
 */
function takeDirectDiscoveryMessage(event: MessageEvent): void {
  // SECURITY: Validate origin — only accept messages from the VSCode webview host.
  if (event.origin && !event.origin.startsWith('vscode-webview://')) return;
  const data = event.data as
    { type?: unknown; correlationId?: unknown; payload?: unknown } | null | undefined;
  if (!data || typeof data !== 'object') return;
  const store = useForgeStore.getState();
  // No Clone directly waits: no discovery answer is this listener's.
  if (typeof store.directDiscoveryId !== 'string') return;
  if (data.type === 'forge:discover:error') {
    const payload = (data.payload ?? {}) as { message?: unknown };
    store.failDirectDiscovery(
      data.correlationId,
      typeof payload.message === 'string' ? payload.message : '',
    );
    return;
  }
  if (data.type !== 'forge:discover:response') return;
  // An answer with no graph is not taken: the run has nothing to start on.
  const graph = (data.payload as { graph?: unknown } | undefined)?.graph;
  if (!isGraph(graph) || !store.takeDirectDiscovery(data.correlationId)) return;
  adoptDiscoveredGraph(graph);
  startForgeRun({ reviewSkipped: true });
}

// HMR-safe listener registration, as the store registers the run's: re-imported
// by a hot replace, the module would otherwise stack a listener per reload.
let directRunListenerRegistered = false;
function registerDirectRunListener(): void {
  if (directRunListenerRegistered || typeof window === 'undefined') return;
  directRunListenerRegistered = true;
  window.addEventListener('message', takeDirectDiscoveryMessage);
  if (typeof import.meta !== 'undefined' && import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('message', takeDirectDiscoveryMessage);
      directRunListenerRegistered = false;
    });
  }
}
registerDirectRunListener();
