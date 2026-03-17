import { describe, it, expect, beforeAll } from 'vitest';
import { ErrorClassifier } from './ErrorClassifier';
import type { SalesforceApiError } from '@sandforge/shared';

function createError(
  statusCode: string,
  message: string = `Error: ${statusCode}`
): SalesforceApiError {
  return { statusCode, message };
}

describe('ErrorClassifier', () => {
  let classifier: ErrorClassifier;

  beforeAll(() => {
    classifier = new ErrorClassifier();
  });

  describe('classify - retryable errors', () => {
    it('should classify UNABLE_TO_LOCK_ROW as retryable', () => {
      const result = classifier.classify(createError('UNABLE_TO_LOCK_ROW'));

      expect(result.classification.retryable).toBe(true);
      expect(result.classification.strategy).toBe('exponential');
    });

    it('should classify INVALID_SESSION_ID as retryable with reauth strategy', () => {
      const result = classifier.classify(createError('INVALID_SESSION_ID'));

      expect(result.classification.retryable).toBe(true);
      expect(result.classification.strategy).toBe('reauth_then_retry');
      expect(result.suggestedAction).toBe('Re-authenticate and retry');
    });

    it('should classify LIMIT_EXCEEDED as retryable with reduce_batch strategy', () => {
      const result = classifier.classify(createError('LIMIT_EXCEEDED'));

      expect(result.classification.retryable).toBe(true);
      expect(result.classification.strategy).toBe('reduce_batch');
      expect(result.suggestedAction).toBe('Reduce batch size and retry');
    });
  });

  describe('classify - non-retryable errors', () => {
    it('should classify INVALID_FIELD as non-retryable schema error', () => {
      const result = classifier.classify(createError('INVALID_FIELD'));

      expect(result.classification.retryable).toBe(false);
      expect(result.classification.category).toBe('schema');
    });

    it('should classify REQUIRED_FIELD_MISSING as non-retryable data error', () => {
      const result = classifier.classify(createError('REQUIRED_FIELD_MISSING'));

      expect(result.classification.retryable).toBe(false);
      expect(result.classification.category).toBe('data');
    });
  });

  describe('classify - special suggestions', () => {
    it('should suggest upsert for DUPLICATE_VALUE', () => {
      const result = classifier.classify(createError('DUPLICATE_VALUE'));

      expect(result.suggestedAction).toBe(
        'Consider using upsert with external ID'
      );
    });

    it('should suggest truncation for STRING_TOO_LONG', () => {
      const result = classifier.classify(createError('STRING_TOO_LONG'));

      expect(result.suggestedAction).toBe(
        'Truncate field values to fit within limits'
      );
    });

    it('should flag STORAGE_LIMIT_EXCEEDED as blocking', () => {
      const result = classifier.classify(
        createError('STORAGE_LIMIT_EXCEEDED')
      );

      expect(result.classification.blockAll).toBe(true);
      expect(result.suggestedAction).toBe(
        'Operation blocked: resolve storage/limit issue first'
      );
    });
  });

  describe('classify - unknown errors', () => {
    it('should classify unknown error codes as non-retryable', () => {
      const result = classifier.classify(createError('SOME_NEW_ERROR'));

      expect(result.classification.retryable).toBe(false);
      expect(result.classification.category).toBe('unknown');
      expect(result.suggestedAction).toBe(
        'Fix SOME_NEW_ERROR error and retry manually'
      );
    });
  });

  describe('classifyBatch', () => {
    it('should classify all errors and compute summary', () => {
      const errors = [
        createError('UNABLE_TO_LOCK_ROW'),
        createError('INVALID_FIELD'),
        createError('DUPLICATE_VALUE'),
        createError('UNABLE_TO_LOCK_ROW'),
      ];

      const { classified, summary } = classifier.classifyBatch(errors);

      expect(classified).toHaveLength(4);
      expect(summary.totalErrors).toBe(4);
      expect(summary.retryableCount).toBe(2);
      expect(summary.nonRetryableCount).toBe(2);
      expect(summary.byErrorCode['UNABLE_TO_LOCK_ROW']).toBe(2);
      expect(summary.byErrorCode['INVALID_FIELD']).toBe(1);
    });

    it('should categorize errors correctly in summary', () => {
      const errors = [
        createError('INVALID_FIELD'),
        createError('INVALID_TYPE'),
        createError('REQUIRED_FIELD_MISSING'),
      ];

      const { summary } = classifier.classifyBatch(errors);

      expect(summary.byCategory.schema).toBe(2);
      expect(summary.byCategory.data).toBe(1);
    });

    it('should include up to 5 sample errors', () => {
      const errors = Array.from({ length: 10 }, (_, i) =>
        createError(`ERROR_${i}`)
      );

      const { summary } = classifier.classifyBatch(errors);
      expect(summary.sampleErrors).toHaveLength(5);
    });
  });

  describe('isRetryable', () => {
    it('should return true for retryable error codes', () => {
      expect(classifier.isRetryable('UNABLE_TO_LOCK_ROW')).toBe(true);
      expect(classifier.isRetryable('SERVER_UNAVAILABLE')).toBe(true);
    });

    it('should return false for non-retryable error codes', () => {
      expect(classifier.isRetryable('INVALID_FIELD')).toBe(false);
      expect(classifier.isRetryable('UNKNOWN_CODE')).toBe(false);
    });
  });

  describe('hasBlockingError', () => {
    it('should return true when a blocking error is present', () => {
      const errors = [
        createError('INVALID_FIELD'),
        createError('STORAGE_LIMIT_EXCEEDED'),
      ];

      expect(classifier.hasBlockingError(errors)).toBe(true);
    });

    it('should return false when no blocking errors exist', () => {
      const errors = [
        createError('INVALID_FIELD'),
        createError('UNABLE_TO_LOCK_ROW'),
      ];

      expect(classifier.hasBlockingError(errors)).toBe(false);
    });

    it('should return false for empty error list', () => {
      expect(classifier.hasBlockingError([])).toBe(false);
    });
  });

  describe('knownErrorCount', () => {
    it('should return the number of classified error codes', () => {
      expect(classifier.knownErrorCount).toBeGreaterThan(0);
      expect(classifier.knownErrorCount).toBe(20);
    });
  });
});
