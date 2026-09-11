import { describe, it, expect } from 'vitest';
import { extractErrorMessage, extractErrorCode } from './extractErrorMessage.js';

describe('extractErrorMessage', () => {
  it('returns the message from an Error instance', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message from a subclass of Error', () => {
    class CustomError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'CustomError';
      }
    }
    expect(extractErrorMessage(new CustomError('custom boom'))).toBe('custom boom');
  });

  it('converts a string to itself', () => {
    expect(extractErrorMessage('plain string')).toBe('plain string');
  });

  it('converts a number to its string representation', () => {
    expect(extractErrorMessage(42)).toBe('42');
  });

  it('converts null to "null"', () => {
    expect(extractErrorMessage(null)).toBe('null');
  });

  it('converts undefined to "undefined"', () => {
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });

  it('converts an object to its string representation', () => {
    expect(extractErrorMessage({ key: 'value' })).toBe('[object Object]');
  });

  describe('Salesforce error codes (jsforce keeps them off `message`)', () => {
    it('prefixes the API error code jsforce mirrors onto name/errorCode', () => {
      // Shape of jsforce HttpApiError: name === errorCode, message = API text.
      const err = Object.assign(new Error('insufficient access rights on cross-reference id'), {
        name: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
        errorCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
      });

      expect(extractErrorMessage(err)).toBe(
        'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id',
      );
    });

    it('falls back to the code when the API returned no description', () => {
      // jsforce OAuth2 errors: `new Error(error_description)` with name = code,
      // and Salesforce omits error_description on some invalid_grant replies.
      const err = Object.assign(new Error(''), { name: 'invalid_grant' });

      expect(extractErrorMessage(err)).toBe('invalid_grant');
    });

    it('never returns an empty string', () => {
      expect(extractErrorMessage(new Error('   '))).toBe('Unknown error');
    });

    it('does not repeat a code the message already carries', () => {
      const err = Object.assign(new Error('MALFORMED_QUERY: unexpected token'), {
        name: 'MALFORMED_QUERY',
        errorCode: 'MALFORMED_QUERY',
      });

      expect(extractErrorMessage(err)).toBe('MALFORMED_QUERY: unexpected token');
    });

    it('leaves ordinary error class names alone', () => {
      expect(extractErrorMessage(new TypeError('fetch failed'))).toBe('fetch failed');
      const aborted = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
      expect(extractErrorMessage(aborted)).toBe('The operation was aborted');
    });

    it('reads the message of a plain Salesforce error object', () => {
      expect(
        extractErrorMessage({ errorCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }),
      ).toBe('ENTITY_IS_DELETED: entity is deleted');
    });
  });

  describe('MULTIPLE_API_ERRORS (jsforce parks the real errors on `data`)', () => {
    function multipleApiErrors(data: unknown): Error {
      return Object.assign(
        new Error('Multiple errors returned.\n  Check `error.data` for the error details'),
        { name: 'MULTIPLE_API_ERRORS', errorCode: 'MULTIPLE_API_ERRORS', data },
      );
    }

    it('renders every underlying Salesforce error instead of the pointer message', () => {
      const err = multipleApiErrors([
        {
          errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          message: 'Amount must be positive',
          fields: ['Amount'],
        },
        {
          errorCode: 'REQUIRED_FIELD_MISSING',
          message: 'Required fields are missing: [Name]',
          fields: ['Name'],
        },
      ]);

      expect(extractErrorMessage(err)).toBe(
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Amount must be positive | ' +
          'REQUIRED_FIELD_MISSING: Required fields are missing: [Name]',
      );
    });

    it('deduplicates repeated errors and summarizes beyond three', () => {
      const err = multipleApiErrors([
        { errorCode: 'DUPLICATE_VALUE', message: 'duplicate value found' },
        { errorCode: 'DUPLICATE_VALUE', message: 'duplicate value found' },
        { errorCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' },
        { errorCode: 'UNABLE_TO_LOCK_ROW', message: 'unable to obtain exclusive access' },
        { errorCode: 'STORAGE_LIMIT_EXCEEDED', message: 'storage limit exceeded' },
      ]);

      expect(extractErrorMessage(err)).toBe(
        'DUPLICATE_VALUE: duplicate value found | ' +
          'ENTITY_IS_DELETED: entity is deleted | ' +
          'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access (+1 more)',
      );
    });

    it('keeps the original message when `data` carries no usable error', () => {
      expect(extractErrorMessage(multipleApiErrors([]))).toBe(
        'MULTIPLE_API_ERRORS: Multiple errors returned.\n  Check `error.data` for the error details',
      );
      expect(extractErrorMessage(multipleApiErrors(['nope', null]))).toBe(
        'MULTIPLE_API_ERRORS: Multiple errors returned.\n  Check `error.data` for the error details',
      );
    });

    it('ignores a non-array `data` (single-error jsforce shape)', () => {
      const err = Object.assign(new Error('Required fields are missing: [Name]'), {
        name: 'REQUIRED_FIELD_MISSING',
        errorCode: 'REQUIRED_FIELD_MISSING',
        data: {
          errorCode: 'REQUIRED_FIELD_MISSING',
          message: 'Required fields are missing: [Name]',
        },
      });

      expect(extractErrorMessage(err)).toBe(
        'REQUIRED_FIELD_MISSING: Required fields are missing: [Name]',
      );
    });
  });
});

describe('extractErrorCode', () => {
  it('reads back the code extractErrorMessage puts in front of the text', () => {
    const err = Object.assign(new Error('unable to obtain exclusive access to this record'), {
      errorCode: 'UNABLE_TO_LOCK_ROW',
      name: 'UNABLE_TO_LOCK_ROW',
    });

    expect(extractErrorCode(extractErrorMessage(err))).toBe('UNABLE_TO_LOCK_ROW');
  });

  it('reads the code of a message that degraded to the code alone', () => {
    const err = Object.assign(new Error(''), { errorCode: 'INVALID_SESSION_ID' });

    expect(extractErrorMessage(err)).toBe('INVALID_SESSION_ID');
    expect(extractErrorCode('INVALID_SESSION_ID')).toBe('INVALID_SESSION_ID');
  });

  it('reads the first code of an aggregated MULTIPLE_API_ERRORS line', () => {
    expect(extractErrorCode('DUPLICATE_VALUE: duplicate | STRING_TOO_LONG: too long')).toBe(
      'DUPLICATE_VALUE',
    );
  });

  it('reads the lower_snake codes of the OAuth token endpoint', () => {
    expect(extractErrorCode('invalid_grant: expired authorization code')).toBe('invalid_grant');
  });

  it('finds no code in prose that happens to contain a colon', () => {
    expect(extractErrorCode('Duplicate operation: op-17')).toBeUndefined();
    expect(extractErrorCode('Operation blocked by Production Guard: 40k records')).toBeUndefined();
    expect(extractErrorCode('Network request failed after 3 attempts')).toBeUndefined();
  });

  it('does not mistake a plain error class name for a code', () => {
    expect(extractErrorCode(extractErrorMessage(new Error('boom')))).toBeUndefined();
    expect(extractErrorCode('AbortError: aborted')).toBeUndefined();
  });
});
