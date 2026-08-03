import { extractErrorMessage } from './extractErrorMessage.js';

/**
 * Salesforce / jsforce error codes meaning "the access token was rejected"
 * (expired or revoked session). Distinct from *authorization* failures
 * (INSUFFICIENT_ACCESS, HTTP 403), which a token refresh cannot fix.
 */
const AUTH_ERROR_CODES: readonly string[] = [
  'INVALID_SESSION_ID',
  'INVALID_AUTH_HEADER',
  'SESSION_EXPIRED',
];

/**
 * Detect whether an error thrown by a Salesforce/jsforce call is an
 * authentication failure that a token refresh may recover from.
 *
 * Matches the structured shapes jsforce produces (`errorCode` on REST API
 * errors, `statusCode` on raw HTTP errors) and, as a fallback, the well-known
 * codes/messages inside the error message. A bare `401` in the message only
 * counts when paired with "Unauthorized", so payloads like "Processed 401
 * records" are not misclassified as auth failures.
 *
 * @param err - The caught error value (may be anything).
 * @returns true when the error looks like an expired/revoked access token.
 */
export function isAuthError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const { errorCode, statusCode } = err as { errorCode?: unknown; statusCode?: unknown };
    if (typeof errorCode === 'string' && AUTH_ERROR_CODES.includes(errorCode)) {
      return true;
    }
    if (statusCode === 401) {
      return true;
    }
  }

  const message = extractErrorMessage(err);
  if (AUTH_ERROR_CODES.some((code) => message.includes(code))) {
    return true;
  }
  // Salesforce session expiry message ("Session expired or invalid").
  if (message.includes('Session expired')) {
    return true;
  }
  // Raw HTTP 401 surface (e.g. "401 Unauthorized" when the response body
  // could not be parsed into a Salesforce error).
  return /\b401\b/.test(message) && /unauthorized/i.test(message);
}
