/**
 * Message protocol for Extension <-> WebView communication.
 *
 * ## Architecture overview
 *
 * The WebView (React) and the Extension (Node.js) communicate through a
 * strongly-typed, asynchronous message channel:
 *
 * 1. **WebView -> Extension**: the React app calls `vscode.postMessage(msg)`.
 *    The extension receives these messages via `webview.onDidReceiveMessage()`.
 *
 * 2. **Extension -> WebView**: the extension calls `webview.postMessage(msg)`.
 *    The React app listens with `window.addEventListener('message', ...)`.
 *
 * 3. **Routing**: the {@link MessageBroker} (in `packages/extension/src/bridge/`)
 *    dispatches incoming messages to the appropriate **DomainHandler** based on
 *    the message `type` prefix (e.g. `"org:"`, `"seed:"`, `"ai:"`).
 *    Each DomainHandler processes the request and posts a response back.
 *
 * 4. **Typing**: every message extends {@link BaseMessage} with a literal `type`
 *    discriminant, enabling exhaustive pattern matching in handlers.
 *    The union types {@link WebViewToExtensionMessage} and
 *    {@link ExtensionToWebViewMessage} enumerate all valid messages per direction.
 *
 * ## Source layout
 *
 * This file is the public entry point and intentionally contains only
 * re-exports: the message interfaces live in per-domain files under
 * `./messages/` (`ai.messages.ts`, `monitor.messages.ts`, ...), and
 * `./messages/index.ts` composes the directional unions. Existing imports
 * from `./messages.types.js` (or the `@sandforge/shared` barrel) are
 * unaffected by the split.
 *
 * @see MessageBroker — central router in `packages/extension/src/bridge/MessageBroker.ts`
 * @see BaseMessage — every message must include `id`, `type`, and `timestamp`
 */

export * from './messages/index.js';
