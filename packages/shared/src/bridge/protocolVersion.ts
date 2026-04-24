/**
 * Bridge protocol version — bumped whenever the envelope or any bridge message
 * shape changes in a non-backward-compatible way.
 *
 * The extension host and webview MUST agree on this number. When they disagree
 * (e.g. after a hot reload or an extension update without a window reload), the
 * {@link MessageBroker} logs a warn, posts a `bridge:protocol-mismatch` event,
 * and — after 3 consecutive mismatches — a `bridge:reload-banner` instructing
 * the user to reload the VSCode window.
 *
 * History:
 *  - `1` (2026-04-24, v1.3.0): initial envelope `{ protocolVersion, correlationId?, payload }`.
 */
export const PROTOCOL_VERSION = 1 as const;

/** Type alias for the literal protocol version — usable in generics. */
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Check whether an incoming protocolVersion is compatible with the current one.
 *
 * The minimal policy today is strict equality. Later versions may relax this
 * to a min/max range once backward-compatible message additions are introduced.
 *
 * @param incoming - The protocolVersion value from an inbound envelope.
 * @returns true when `incoming` matches the current {@link PROTOCOL_VERSION}.
 */
export function isVersionCompatible(incoming: number): boolean {
  return incoming === PROTOCOL_VERSION;
}
