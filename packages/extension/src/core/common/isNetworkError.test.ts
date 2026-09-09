import { describe, it, expect } from 'vitest';
import { isNetworkError } from './isNetworkError.js';
import { TimeoutError } from '../engine/TimeoutManager.js';

describe('isNetworkError', () => {
  it('matches Node system error codes (ENOTFOUND/ECONNREFUSED/ETIMEDOUT…)', () => {
    for (const code of [
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ECONNRESET',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
    ]) {
      expect(isNetworkError(Object.assign(new Error(`request failed: ${code}`), { code }))).toBe(
        true,
      );
    }
  });

  it('matches the engine TimeoutError by name', () => {
    expect(isNetworkError(new TimeoutError('describe-global', 5000))).toBe(true);
  });

  it('unwraps undici `fetch failed` errors to the system cause', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND login.salesforce.com'), {
      code: 'ENOTFOUND',
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(isNetworkError(err)).toBe(true);
  });

  it('falls back to well-known codes and "timed out" wording in the message', () => {
    expect(isNetworkError(new Error('connect ECONNREFUSED 10.0.0.1:443'))).toBe(true);
    expect(isNetworkError(new Error('Operation "query" timed out after 30000ms'))).toBe(true);
    expect(isNetworkError('ENOTFOUND login.salesforce.com')).toBe(true);
  });

  it('rejects Salesforce API errors (auth, validation, limits)', () => {
    expect(isNetworkError(new Error('INVALID_SESSION_ID: Session expired or invalid'))).toBe(false);
    expect(isNetworkError(new Error('FIELD_INTEGRITY_EXCEPTION: bad value'))).toBe(false);
    expect(
      isNetworkError(
        Object.assign(new Error('REQUEST_LIMIT_EXCEEDED'), {
          statusCode: 'REQUEST_LIMIT_EXCEEDED',
        }),
      ),
    ).toBe(false);
  });

  it('rejects non-error values and unrelated messages', () => {
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError('some random failure')).toBe(false);
    expect(isNetworkError(new Error('Operation blocked by Production Guard'))).toBe(false);
  });
});
