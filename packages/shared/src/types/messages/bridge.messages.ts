import type { BaseMessage } from './base.messages.js';

/**
 * Bridge control messages — emitted by the MessageBroker itself (or by the
 * webview's ProtocolMismatchBanner for the reload round-trip), not by any
 * domain handler. See `packages/extension/src/bridge/MessageBroker.ts`.
 */

/**
 * Posted back when an inbound envelope fails Zod validation (message dropped).
 *
 * `correlationId` carries the id of the message that failed, when the envelope
 * was intact enough to read it. Without it this was a bare broadcast, and the
 * only way a waiting hook could claim it was to guess from timing — which
 * meant every request younger than the guess window claimed an unrelated
 * rejection as its own. The request that was actually dropped waited out its
 * full 30 s timeout instead, and showed the user the raw timeout string.
 *
 * It stays optional: a payload malformed enough that no id can be read still
 * produces a bridge:error, and that one is genuinely un-attributable.
 */
export interface BridgeErrorMessage extends BaseMessage {
  type: 'bridge:error';
  payload: { reason: string; details: string };
}

/** Posted when the webview's protocol version differs from the extension's. */
export interface BridgeProtocolMismatchMessage extends BaseMessage {
  type: 'bridge:protocol-mismatch';
  payload: { serverVersion: number; clientVersion: number };
}

/** Posted after too many consecutive protocol mismatches — asks the user to reload. */
export interface BridgeReloadBannerMessage extends BaseMessage {
  type: 'bridge:reload-banner';
  payload: { reason: string };
}

/**
 * Sent by the ProtocolMismatchBanner's Reload button; the extension answers by
 * executing `workbench.action.reloadWindow`. No payload.
 */
export interface WorkbenchReloadRequest extends BaseMessage {
  type: 'workbench:reload';
}

/**
 * Crash report posted by the webview's ErrorBoundary when a render throws.
 * The extension logs it to the output channel — before the broker envelope
 * existed this fire-and-forget message was silently dropped.
 */
export interface ErrorBoundaryReport extends BaseMessage {
  type: 'error:boundary';
  payload: {
    message: string;
    stack?: string;
    componentStack?: string;
  };
}
