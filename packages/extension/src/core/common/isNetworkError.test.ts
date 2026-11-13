import { describe, it, expect } from 'vitest';
import { isNetworkError, networkFailureOf } from './isNetworkError.js';
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

describe('networkFailureOf', () => {
  it('names the network’s word for an org not reached, from the error or its message alone, never the URL or the host it names', () => {
    const dns =
      'request to https://example-org.my.salesforce.com/services/data/v62.0/query?q=SELECT ' +
      'failed, reason: getaddrinfo EAI_AGAIN example-org.my.salesforce.com';
    expect(networkFailureOf(new Error(dns))).toBe('EAI_AGAIN');
    expect(networkFailureOf(dns)).toBe('EAI_AGAIN');
    expect(networkFailureOf(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe(
      'ECONNRESET',
    );
    expect(networkFailureOf(new Error('getaddrinfo ENOTFOUND example.invalid'))).toBe('ENOTFOUND');
    expect(networkFailureOf(new Error('connect ETIMEDOUT 10.0.0.1:443'))).toBe('ETIMEDOUT');
    expect(networkFailureOf(new Error('request to https://x failed, reason: socket hang up'))).toBe(
      'socket hang up',
    );
  });

  it('names nothing when the org answered, refusing or not', () => {
    expect(networkFailureOf(new Error('INVALID_SESSION_ID: Session expired or invalid'))).toBe(
      undefined,
    );
    expect(
      networkFailureOf("INVALID_TYPE: sObject type 'FlowDefinitionView' is not supported."),
    ).toBe(undefined);
  });
});
