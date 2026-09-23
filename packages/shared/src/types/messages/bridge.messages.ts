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
 * Posted to one panel when VS Code shows or hides it. Every panel keeps its
 * page running while hidden (`retainContextWhenHidden`), timers included: the
 * Monitor's auto-refresh went on reading the org every 30 s from a tab nobody
 * was looking at.
 */
export interface PanelVisibilityMessage extends BaseMessage {
  type: 'panel:visibility';
  payload: { visible: boolean };
}

/**
 * Sent by the ProtocolMismatchBanner's Reload button; the extension answers by
 * executing `workbench.action.reloadWindow`. No payload.
 */
export interface WorkbenchReloadRequest extends BaseMessage {
  type: 'workbench:reload';
}

/**
 * Sent by a page that needs a SandForge setting changed: the extension opens
 * VS Code's Settings editor on it. The Grappe page is empty until
 * `sandforge.grappe.enabled` is on, and it had no way to get there.
 */
export interface WorkbenchOpenSettingRequest extends BaseMessage {
  type: 'workbench:open-setting';
  /** A `sandforge.*` setting id; the extension refuses anything else. */
  payload: { setting: string };
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
