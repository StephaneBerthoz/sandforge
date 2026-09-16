import type { BaseMessage } from '@sandforge/shared';
import { PROTOCOL_VERSION } from '@sandforge/shared';

import { getVscodeApi } from '../hooks/useVSCodeApi';
import type { VSCodeApi } from '../hooks/useVSCodeApi';
import { buildMessage } from './messageHelpers';

/**
 * Post an already-built message to the extension host, wrapped in the
 * protocol envelope the MessageBroker requires:
 *
 *   { protocolVersion, correlationId?, payload: message }
 *
 * Single source of truth for the outbound envelope — the `useSendMessage`
 * hook delegates here (passing its hook-acquired API) so hook and non-hook
 * senders cannot drift.
 *
 * @param message - The built bridge message to send.
 * @param api - Transport to post through; defaults to the module-cached
 *   shared API from {@link getVscodeApi}. Pass explicitly from React contexts
 *   that already hold the API.
 */
export function postEnvelopedMessage(message: BaseMessage, api: VSCodeApi = getVscodeApi()): void {
  rememberSent(message.id);
  api.postMessage({
    protocolVersion: PROTOCOL_VERSION,
    correlationId: message.correlationId,
    payload: message,
  });
}

/**
 * Ids of the requests this webview sent recently. The broker broadcasts
 * `bridge:error` to every open panel with the refused request's id as
 * correlationId; this lets a panel tell a refusal of its own request from
 * another panel's.
 */
const sentIds = new Set<string>();

/** How many sent ids are kept; a refusal answers within moments of its request. */
const SENT_IDS_KEPT = 200;

function rememberSent(id: string): void {
  sentIds.add(id);
  if (sentIds.size > SENT_IDS_KEPT) {
    const oldest = sentIds.values().next().value;
    if (oldest !== undefined) sentIds.delete(oldest);
  }
}

/** Whether this webview sent the request `id`. */
export function isRequestFromHere(id: string): boolean {
  return sentIds.has(id);
}

/**
 * Build and post an enveloped bridge message from a non-React context
 * (Zustand stores, class components, plain event handlers) where the
 * `useSendMessage` hook cannot be called.
 *
 * Since 1.5.0 the extension-host MessageBroker drops every inbound message
 * without the envelope, so posting a raw `buildMessage(...)` result silently
 * loses the message — always go through this helper.
 *
 * @param type - Message type string (e.g., 'sync:history:list').
 * @param args - Optional payload, same convention as {@link buildMessage}.
 * @returns The id of the posted message: its answer carries it as correlationId.
 */
export function sendBridgeMessage<P = undefined>(
  type: string,
  ...args: P extends undefined ? [] : [payload: P]
): string {
  const message = buildMessage<P>(type, ...args);
  postEnvelopedMessage(message);
  return message.id;
}
