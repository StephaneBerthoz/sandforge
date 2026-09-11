/**
 * Pure classifier for Anthropic SDK errors.
 *
 * Maps a thrown error to an actionable verdict the adapter can use to:
 *  - decide whether the CircuitBreaker should trip
 *  - decide whether a retry is sensible
 *  - surface a localised banner copy via `userMessageKey`
 *
 * The SDK ships no `OverloadedError` class, so overload is detected via a dual
 * signal — `err.status === 529` OR `err.error?.error?.type ===
 * 'overloaded_error'`. Either signal trips the breaker.
 *
 * APIUserAbortError is special: NEVER trips the breaker (cancel is a user
 * action, not a provider failure).
 */

export type AIErrorKind =
  | 'overloaded'
  | 'rate-limit'
  | 'auth'
  | 'cancelled'
  | 'transient'
  | 'invalid-request'
  | 'unknown';

export interface AIErrorVerdict {
  kind: AIErrorKind;
  shouldTripBreaker: boolean;
  shouldRetry: boolean;
  retryAfterMs?: number;
  userMessageKey: string;
  rawStatus?: number;
}

interface AnthropicErrorLike {
  name?: string;
  status?: number;
  headers?: unknown;
  error?: { error?: { type?: string; message?: string } } | { type?: string; message?: string };
}

/**
 * Parse a Retry-After header value (header-record OR plain object). Returns
 * milliseconds or undefined if no header / non-numeric.
 */
export function parseRetryAfter(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const h = headers as Record<string, string | undefined> & {
    get?: (k: string) => string | null | undefined;
  };
  const raw =
    typeof h.get === 'function'
      ? (h.get('retry-after') ?? h.get('Retry-After'))
      : (h['retry-after'] ?? h['Retry-After']);
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function getErrorBodyType(err: AnthropicErrorLike): string | undefined {
  const body = err.error;
  if (!body || typeof body !== 'object') return undefined;
  // Two common shapes: { error: { type } } and { type } directly.
  const inner = (body as { error?: { type?: string } }).error;
  if (inner && typeof inner.type === 'string') return inner.type;
  const direct = (body as { type?: string }).type;
  return typeof direct === 'string' ? direct : undefined;
}

function isOverloaded(err: AnthropicErrorLike): boolean {
  if (err.status === 529) return true;
  return getErrorBodyType(err) === 'overloaded_error';
}

/**
 * Classify a thrown error from the Anthropic SDK or generic Error.
 *
 * The classifier is duck-typed (no instanceof against SDK error classes)
 * because the SDK class layout shifted between minor versions. We look at
 * `err.name`, `err.status`, and `err.error.error.type` instead.
 */
export function classifyAnthropicError(err: unknown): AIErrorVerdict {
  // 1) Cancelled — never trips the breaker.
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'APIUserAbortError') {
    return {
      kind: 'cancelled',
      shouldTripBreaker: false,
      shouldRetry: false,
      userMessageKey: 'ai.error.cancelled',
    };
  }

  if (!err || typeof err !== 'object') {
    return {
      kind: 'unknown',
      shouldTripBreaker: false,
      shouldRetry: false,
      userMessageKey: 'ai.error.unknown',
    };
  }

  const e = err as AnthropicErrorLike;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const retryAfterMs = parseRetryAfter(e.headers);

  // 2) Overloaded — dual signal (status 529 OR an `overloaded_error` body).
  if (isOverloaded(e)) {
    return {
      kind: 'overloaded',
      shouldTripBreaker: true,
      shouldRetry: true,
      retryAfterMs: retryAfterMs ?? 60_000,
      userMessageKey: 'ai.error.overloaded',
      rawStatus: status,
    };
  }

  // 3) Rate-limit — 429 OR RateLimitError.
  if (status === 429 || (e as { name?: string }).name === 'RateLimitError') {
    return {
      kind: 'rate-limit',
      shouldTripBreaker: true,
      shouldRetry: true,
      retryAfterMs: retryAfterMs ?? 30_000,
      userMessageKey: 'ai.error.rateLimit',
      rawStatus: status,
    };
  }

  // 4) Auth — 401 / 403 / AuthenticationError.
  if (status === 401 || status === 403 || (e as { name?: string }).name === 'AuthenticationError') {
    return {
      kind: 'auth',
      shouldTripBreaker: false,
      shouldRetry: false,
      userMessageKey: 'ai.error.auth',
      rawStatus: status,
    };
  }

  // 5) Bad request — 400 / 422 / BadRequestError.
  if (status === 400 || status === 422 || (e as { name?: string }).name === 'BadRequestError') {
    return {
      kind: 'invalid-request',
      shouldTripBreaker: false,
      shouldRetry: false,
      userMessageKey: 'ai.error.invalidRequest',
      rawStatus: status,
    };
  }

  // 6) Other 5xx — transient (don't trip; allow retry).
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return {
      kind: 'transient',
      shouldTripBreaker: false,
      shouldRetry: true,
      userMessageKey: 'ai.error.transient',
      rawStatus: status,
    };
  }

  // 7) Default.
  return {
    kind: 'unknown',
    shouldTripBreaker: false,
    shouldRetry: false,
    userMessageKey: 'ai.error.unknown',
    rawStatus: status,
  };
}
