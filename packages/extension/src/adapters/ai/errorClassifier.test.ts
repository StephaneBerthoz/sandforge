import { describe, it, expect } from 'vitest';
import { classifyAnthropicError, parseRetryAfter } from './errorClassifier.js';

class MockSDKError extends Error {
  constructor(
    public override name: string,
    public status: number,
    public error?: unknown,
    public headers?: unknown,
  ) {
    super(`${name} ${status}`);
  }
}

describe('classifyAnthropicError', () => {
  it('APIUserAbortError → cancelled, no breaker trip, no retry', () => {
    const err = new MockSDKError('APIUserAbortError', 0);
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('cancelled');
    expect(v.shouldTripBreaker).toBe(false);
    expect(v.shouldRetry).toBe(false);
    expect(v.userMessageKey).toBe('ai.error.cancelled');
  });

  it('429 (RateLimitError) → rate-limit, trips breaker, retry, default 30s', () => {
    const err = new MockSDKError('RateLimitError', 429);
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('rate-limit');
    expect(v.shouldTripBreaker).toBe(true);
    expect(v.shouldRetry).toBe(true);
    expect(v.retryAfterMs).toBe(30_000);
  });

  it('429 with Retry-After: 90 honours the header (90s → 90_000 ms)', () => {
    const err = new MockSDKError('RateLimitError', 429, undefined, { 'Retry-After': '90' });
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('rate-limit');
    expect(v.retryAfterMs).toBe(90_000);
  });

  it('status 529 → overloaded, trips breaker', () => {
    const err = new MockSDKError('InternalServerError', 529);
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('overloaded');
    expect(v.shouldTripBreaker).toBe(true);
    expect(v.shouldRetry).toBe(true);
  });

  it('status 500 + body type=overloaded_error → overloaded (dual signal)', () => {
    const err = new MockSDKError('InternalServerError', 500, {
      error: { type: 'overloaded_error' },
    });
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('overloaded');
    expect(v.shouldTripBreaker).toBe(true);
  });

  it('status 500 with no overloaded body → transient, NO breaker trip, retry allowed', () => {
    const err = new MockSDKError('InternalServerError', 500);
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('transient');
    expect(v.shouldTripBreaker).toBe(false);
    expect(v.shouldRetry).toBe(true);
  });

  it('401 (AuthenticationError) → auth, NO trip, NO retry', () => {
    const err = new MockSDKError('AuthenticationError', 401);
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('auth');
    expect(v.shouldTripBreaker).toBe(false);
    expect(v.shouldRetry).toBe(false);
  });

  it('400 (BadRequestError) → invalid-request, NO trip, NO retry', () => {
    const err = new MockSDKError('BadRequestError', 400);
    const v = classifyAnthropicError(err);
    expect(v.kind).toBe('invalid-request');
    expect(v.shouldTripBreaker).toBe(false);
    expect(v.shouldRetry).toBe(false);
  });

  it('plain Error → unknown, NO trip', () => {
    const v = classifyAnthropicError(new Error('something broke'));
    expect(v.kind).toBe('unknown');
    expect(v.shouldTripBreaker).toBe(false);
  });

  it('non-error value (string / null / undefined) → unknown verdict', () => {
    expect(classifyAnthropicError('boom').kind).toBe('unknown');
    expect(classifyAnthropicError(null).kind).toBe('unknown');
    expect(classifyAnthropicError(undefined).kind).toBe('unknown');
  });

  it('malformed Retry-After header → fallback default (60s for overloaded, 30s for rate-limit)', () => {
    const err1 = new MockSDKError('RateLimitError', 429, undefined, { 'Retry-After': 'abc' });
    expect(classifyAnthropicError(err1).retryAfterMs).toBe(30_000);

    const err2 = new MockSDKError('InternalServerError', 529, undefined, { 'Retry-After': 'xyz' });
    expect(classifyAnthropicError(err2).retryAfterMs).toBe(60_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads numeric seconds from a record-style header object', () => {
    expect(parseRetryAfter({ 'Retry-After': '60' })).toBe(60_000);
    expect(parseRetryAfter({ 'retry-after': '15' })).toBe(15_000);
  });

  it('returns undefined for non-numeric values and missing headers', () => {
    expect(parseRetryAfter({ 'Retry-After': 'abc' })).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter({})).toBeUndefined();
  });

  it('rejects negative values', () => {
    expect(parseRetryAfter({ 'Retry-After': '-1' })).toBeUndefined();
  });

  it('reads via .get() when header is a Headers-like object', () => {
    const headers = {
      get: (k: string) => (k === 'retry-after' ? '120' : null),
    };
    expect(parseRetryAfter(headers)).toBe(120_000);
  });
});
