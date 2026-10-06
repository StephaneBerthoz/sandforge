import { findForgeAnonymizationPreset } from '@sandforge/shared';
import type { BaseMessage, ForgeConfig, ForgeGraph } from '@sandforge/shared';
import { buildMessage } from '../../bridge/messageHelpers';
import { useForgeStore } from '../../stores/useForgeStore';
import { startForgeRun } from './startForgeRun';

/**
 * Send the discovery of `config` through `send`, as the one the flow waits on
 * from now on: only its answer and its error are taken, here, page or no
 * page. With `direct`, it is a Clone directly's, and its answer starts the
 * run.
 */
export function sendDiscovery(
  send: (message: BaseMessage) => void,
  config: ForgeConfig,
  direct = false,
): void {
  const request = buildMessage<{ config: ForgeConfig }>('forge:discover', { config });
  const store = useForgeStore.getState();
  if (direct) store.awaitDirectRun(request.id);
  else store.awaitDiscovery(request.id);
  send(request);
}

/**
 * Put the graph a discovery answered with in the store, as the discovery
 * screen shows it and Review sends it.
 *
 * A preset picked in Review — or brought back by a template — applies to the
 * graph it is shown beside. A new graph comes back with every PII field it
 * found selected, and the Review tab would show the preset over fields it
 * never chose. The fields a template kept object by object come after it:
 * they are what Review held once the preset had been changed by hand. The
 * objects the run's config leaves out are left out of the graph as it lands.
 */
export function adoptDiscoveredGraph(graph: ForgeGraph): void {
  useForgeStore.getState().setGraph(graph);
  const { anonymizationPresetId, anonymizeFieldChoices, config, applyAnonymizationPreset } =
    useForgeStore.getState();
  if (!config?.anonymizePII) return;
  const preset = findForgeAnonymizationPreset(anonymizationPresetId);
  if (preset) applyAnonymizationPreset(preset.rules);
  if (anonymizeFieldChoices) applyAnonymizationPreset(anonymizeFieldChoices);
}

/** Whether `value` has the one part of a graph nothing can be done without: its nodes. */
function isGraph(value: unknown): value is ForgeGraph {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

/**
 * The answer to the discovery the flow waits on, and its error, taken here
 * rather than by the discovery screen.
 *
 * The Forge page can be left while its discovery runs — the command palette
 * or a shortcut takes the panel to another page — and a screen's listener
 * goes with the page. Nor does the discovery screen listen before it has come
 * in, once the input screen has gone out, and a discovery the extension
 * answers from its cache answers sooner. Taken there, the answer came to no
 * screen: the page came back to a spinner with nothing behind it, or to the
 * graph of the discovery before, which Review would then have sent. Taken
 * here, the graph lands in the store page or no page, and the screen draws it
 * when it comes back; its error is kept for the screen the same way.
 *
 * A Clone directly's run starts as its discovery answers, page or no page, as
 * a run started from Review goes on while the page is away: its progress, its
 * answer and its error are the store's, and Production Guard asks its
 * confirmation in a VS Code dialog, whatever the panel shows.
 *
 * Only the answer correlated to the discovery the flow waits on counts: every
 * panel receives every panel's messages, and a discovery replaced by a newer
 * one — Back, then Discover again — may still answer.
 */
function takeDiscoveryMessage(event: MessageEvent): void {
  // SECURITY: Validate origin — only accept messages from the VSCode webview host.
  if (event.origin && !event.origin.startsWith('vscode-webview://')) return;
  const data = event.data as
    { type?: unknown; correlationId?: unknown; payload?: unknown } | null | undefined;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'forge:discover:response' && data.type !== 'forge:discover:error') return;
  const store = useForgeStore.getState();
  // No discovery waits: no answer is this listener's.
  if (typeof store.discoveryId !== 'string' && typeof store.directDiscoveryId !== 'string') return;
  if (data.type === 'forge:discover:error') {
    const payload = (data.payload ?? {}) as { message?: unknown };
    const message = typeof payload.message === 'string' ? payload.message : '';
    // One discovery is waited on at a time, a Clone directly's or the
    // screen's: each takes only the error of its own request.
    store.failDirectDiscovery(data.correlationId, message);
    store.failDiscovery(data.correlationId, message);
    return;
  }
  // An answer with no graph is not taken: there is nothing to draw, nor any
  // run to start on.
  const graph = (data.payload as { graph?: unknown } | undefined)?.graph;
  if (!isGraph(graph)) return;
  if (store.takeDirectDiscovery(data.correlationId)) {
    adoptDiscoveredGraph(graph);
    startForgeRun({ reviewSkipped: true });
  } else if (store.takeDiscovery(data.correlationId)) {
    adoptDiscoveredGraph(graph);
  }
}

// HMR-safe listener registration, as the store registers the run's: re-imported
// by a hot replace, the module would otherwise stack a listener per reload.
let discoveryListenerRegistered = false;
function registerDiscoveryListener(): void {
  if (discoveryListenerRegistered || typeof window === 'undefined') return;
  discoveryListenerRegistered = true;
  window.addEventListener('message', takeDiscoveryMessage);
  if (typeof import.meta !== 'undefined' && import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener('message', takeDiscoveryMessage);
      discoveryListenerRegistered = false;
    });
  }
}
registerDiscoveryListener();
