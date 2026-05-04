import { describe, it, expect } from 'vitest';

import type {
  ErrorClassification,
  BatchRecordError,
  ErrorSummary,
  SalesforceApiError,
} from './errors.types.js';
import type { ErrorCategory } from './common.types.js';

describe('ErrorClassification', () => {
  it('should create a retryable classification with full retry config', () => {
    const classification: ErrorClassification = {
      retryable: true,
      delay: 2000,
      strategy: 'exponential',
      category: 'network',
    };

    expect(classification.retryable).toBe(true);
    expect(classification.delay).toBe(2000);
    expect(classification.strategy).toBe('exponential');
    expect(classification.category).toBe('network');
  });

  it('should create a non-retryable classification with only required fields', () => {
    const classification: ErrorClassification = {
      retryable: false,
    };

    expect(classification.retryable).toBe(false);
    expect(classification.delay).toBeUndefined();
    expect(classification.strategy).toBeUndefined();
    expect(classification.category).toBeUndefined();
  });

  it('should support suggestion flags for data errors', () => {
    const classification: ErrorClassification = {
      retryable: false,
      category: 'data',
      suggestUpsert: true,
      suggestTruncate: false,
      blockAll: false,
    };

    expect(classification.suggestUpsert).toBe(true);
    expect(classification.suggestTruncate).toBe(false);
    expect(classification.blockAll).toBe(false);
  });
});

describe('BatchRecordError', () => {
  function createSfApiError(overrides: Partial<SalesforceApiError> = {}): SalesforceApiError {
    return {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Value too large for field',
      ...overrides,
    };
  }

  it('should create a batch error with a single API error', () => {
    const batchError: BatchRecordError = {
      recordIndex: 5,
      errors: [createSfApiError()],
      retryable: false,
    };

    expect(batchError.recordIndex).toBe(5);
    expect(batchError.errors).toHaveLength(1);
    expect(batchError.errors[0].statusCode).toBe('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(batchError.retryable).toBe(false);
  });

  it('should support optional recordId and multiple errors', () => {
    const batchError: BatchRecordError = {
      recordIndex: 12,
      recordId: '001xx000003DGbYAAW',
      errors: [
        createSfApiError({
          statusCode: 'REQUIRED_FIELD_MISSING',
          message: 'Required fields are missing: [Name]',
          fields: ['Name'],
        }),
        createSfApiError({
          statusCode: 'INVALID_FIELD',
          message: 'Invalid field: Rating',
          fields: ['Rating'],
          errorCode: 'INVALID_FIELD',
        }),
      ],
      retryable: false,
    };

    expect(batchError.recordId).toBe('001xx000003DGbYAAW');
    expect(batchError.errors).toHaveLength(2);
    expect(batchError.errors[0].fields).toEqual(['Name']);
    expect(batchError.errors[1].errorCode).toBe('INVALID_FIELD');
  });
});

describe('ErrorSummary', () => {
  it('should create a summary with errors distributed across categories', () => {
    const summary: ErrorSummary = {
      totalErrors: 25,
      retryableCount: 10,
      nonRetryableCount: 15,
      byCategory: {
        auth: 0,
        permission: 3,
        schema: 0,
        data: 7,
        validation: 5,
        limit: 0,
        network: 10,
        trigger: 0,
        reference: 0,
        unknown: 0,
      } as Record<ErrorCategory, number>,
      byErrorCode: {
        REQUEST_LIMIT_EXCEEDED: 10,
        FIELD_CUSTOM_VALIDATION_EXCEPTION: 5,
        INSUFFICIENT_ACCESS: 3,
        STRING_TOO_LONG: 7,
      },
      sampleErrors: [
        {
          statusCode: 'REQUEST_LIMIT_EXCEEDED',
          message: 'TotalRequests Limit exceeded.',
        },
        {
          statusCode: 'STRING_TOO_LONG',
          message: 'Value too long for field: Description',
          fields: ['Description'],
        },
      ],
    };

    expect(summary.totalErrors).toBe(25);
    expect(summary.retryableCount + summary.nonRetryableCount).toBe(summary.totalErrors);
    expect(summary.byCategory['network']).toBe(10);
    expect(Object.keys(summary.byErrorCode)).toHaveLength(4);
    expect(summary.sampleErrors).toHaveLength(2);
  });

  it('should represent an empty summary with zero errors', () => {
    const emptySummary: ErrorSummary = {
      totalErrors: 0,
      retryableCount: 0,
      nonRetryableCount: 0,
      byCategory: {
        auth: 0,
        permission: 0,
        schema: 0,
        data: 0,
        validation: 0,
        limit: 0,
        network: 0,
        trigger: 0,
        reference: 0,
        unknown: 0,
      } as Record<ErrorCategory, number>,
      byErrorCode: {},
      sampleErrors: [],
    };

    expect(emptySummary.totalErrors).toBe(0);
    expect(emptySummary.sampleErrors).toEqual([]);
    expect(Object.keys(emptySummary.byErrorCode)).toHaveLength(0);
  });
});
