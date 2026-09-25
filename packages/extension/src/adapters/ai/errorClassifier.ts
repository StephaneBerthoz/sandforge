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
 *
 * An answer that came back with HTTP 200 can fail too — declined, cut off or
 * empty. `classifyAnswer` gives it a verdict of the same shape.
 */

export type AIErrorKind =
  | 'overloaded'
  | 'rate-limit'
  | 'auth'
  | 'cancelled'
  | 'transient'
  | 'invalid-request'
  | 'unknown'
  | AIAnswerProblem;

/**
 * What can be wrong with an answer the API sent back with HTTP 200: the model
 * declined to give it, it ran out of room before it was complete, or it holds
 * no text. The provider did its job, so none of them trips the breaker; the
 * call they answer fails instead of handing on text no feature can use.
 */
export type AIAnswerProblem = 'refused' | 'truncated' | 'empty';

export interface AIErrorVerdict {
  kind: AIErrorKind;
  shouldTripBreaker: boolean;
  shouldRetry: boolean;
  retryAfterMs?: number;
  /**
   * The catalogue key of the provider-status banner's copy. An answer problem
   * carries none: it fails the call it answers, with a message the host writes
   * in the editor's language, and never reaches the banner.
   */
  userMessageKey?: string;
  rawStatus?: number;
}

/** The verdict on an answer that came back but cannot be used. */
export interface AIAnswerVerdict extends AIErrorVerdict {
  kind: AIAnswerProblem;
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

/**
 * The verdict on an answer the API returned, or undefined when it can be used.
 *
 * The stop reasons are those of
 * https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons.
 * `refusal` comes back as a normal HTTP 200, which is how Claude Sonnet 5's
 * safeguards decline a request. `max_tokens` and `model_context_window_exceeded`
 * both end a response before it is complete, and on a model that thinks, the
 * thinking counts against `max_tokens` too. Handed on as they came, a cut-off
 * JSON reply made NL2SOQL and Seed personas say the model had answered in the
 * wrong format, left a pipeline draft with no step, and failed a Seed run on a
 * JSON error; a cut-off chat answer read as the whole answer, and an empty one
 * was kept in the conversation as the assistant's turn.
 */
export function classifyAnswer(
  stopReason: string | null,
  text: string,
): AIAnswerVerdict | undefined {
  if (stopReason === 'refusal') {
    return { kind: 'refused', shouldTripBreaker: false, shouldRetry: false };
  }
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    return { kind: 'truncated', shouldTripBreaker: false, shouldRetry: false };
  }
  if (text.trim() === '') {
    return { kind: 'empty', shouldTripBreaker: false, shouldRetry: true };
  }
  return undefined;
}
