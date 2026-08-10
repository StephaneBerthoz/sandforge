import { extractErrorMessage } from './extractErrorMessage.js';

/**
 * Transport-level error codes meaning "the org could not be reached" (DNS,
 * TCP, TLS, socket resets). Distinct from Salesforce API errors (which carry a
 * `statusCode`/`errorCode` and mean the org answered) — only transport
 * failures justify queueing an operation for offline replay.
 */
const NETWORK_ERROR_CODES: readonly string[] = [
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
];

/**
 * Detect whether an error is a network/connectivity failure (as opposed to a
 * Salesforce API or validation error). Used to decide whether a failed
 * operation should be queued for replay when connectivity returns.
 *
 * Matches Node system errors (`err.code`), the engine's own `TimeoutError`
 * (name-based), undici fetch failures (`TypeError: fetch failed` wrapping the
 * real system error in `cause`, matched recursively) and, as a fallback, the
 * well-known codes / "timed out" wording inside the error message.
 *
 * @param err - The caught error value (may be anything).
 * @returns true when the error looks like a connectivity failure.
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const { code, name, cause } = err as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof code === 'string' && NETWORK_ERROR_CODES.includes(code)) {
      return true;
    }
    // TimeoutManager aborts with a dedicated TimeoutError class.
    if (name === 'TimeoutError') {
      return true;
    }
    // undici surfaces transport failures as `TypeError: fetch failed` with the
    // underlying system error (ENOTFOUND & co.) on `cause`.
    if (cause !== undefined && isNetworkError(cause)) {
      return true;
    }
  }

  const message = extractErrorMessage(err);
  if (NETWORK_ERROR_CODES.some((code) => message.includes(code))) {
    return true;
  }
  if (message.includes('fetch failed')) {
    return true;
  }
  return /\btimed out\b/i.test(message);
}
