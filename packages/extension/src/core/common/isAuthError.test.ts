import { describe, it, expect } from 'vitest';
import { isAuthError } from './isAuthError.js';

describe('isAuthError', () => {
  it('detects Salesforce auth error codes inside the message', () => {
    expect(isAuthError(new Error('INVALID_SESSION_ID: Session expired or invalid'))).toBe(true);
    expect(isAuthError(new Error('INVALID_AUTH_HEADER'))).toBe(true);
    expect(isAuthError(new Error('SESSION_EXPIRED'))).toBe(true);
  });

  it('detects the Salesforce session expiry message', () => {
    expect(isAuthError(new Error('Session expired or invalid'))).toBe(true);
  });

  it('detects structured jsforce error properties', () => {
    expect(isAuthError(Object.assign(new Error('x'), { errorCode: 'INVALID_SESSION_ID' }))).toBe(
      true,
    );
    expect(isAuthError(Object.assign(new Error('x'), { errorCode: 'INVALID_AUTH_HEADER' }))).toBe(
      true,
    );
    expect(isAuthError(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))).toBe(true);
  });

  it('detects raw HTTP 401 Unauthorized messages', () => {
    expect(isAuthError(new Error('401 Unauthorized'))).toBe(true);
    expect(isAuthError(new Error('HTTP 401: request unauthorized'))).toBe(true);
  });

  it('detects auth codes in non-Error values', () => {
    expect(isAuthError('INVALID_SESSION_ID')).toBe(true);
  });

  it('rejects non-auth errors', () => {
    expect(isAuthError(new Error('NETWORK_ERROR'))).toBe(false);
    expect(isAuthError(new Error('REQUEST_LIMIT_EXCEEDED'))).toBe(false);
    expect(isAuthError(new Error('INSUFFICIENT_ACCESS_OR_READONLY'))).toBe(false);
    expect(isAuthError(Object.assign(new Error('boom'), { statusCode: 500 }))).toBe(false);
    expect(isAuthError(Object.assign(new Error('boom'), { errorCode: 'DUPLICATE_VALUE' }))).toBe(
      false,
    );
  });

  it('does not misclassify messages containing 401 for other reasons', () => {
    expect(isAuthError(new Error('Processed 401 records'))).toBe(false);
  });

  it('handles non-error values', () => {
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(42)).toBe(false);
  });
});
