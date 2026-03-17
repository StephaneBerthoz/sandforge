import type { ErrorClassification } from '../types/errors.types.js';

/** Classification map for Salesforce API error codes */
export const SF_ERROR_CLASSIFICATIONS: Record<string, ErrorClassification> = {
  UNABLE_TO_LOCK_ROW: { retryable: true, delay: 2_000, strategy: 'exponential' },
  REQUEST_RUNNING_TOO_LONG: { retryable: true, delay: 5_000, strategy: 'exponential' },
  SERVER_UNAVAILABLE: { retryable: true, delay: 10_000, strategy: 'exponential' },
  INVALID_SESSION_ID: { retryable: true, delay: 0, strategy: 'reauth_then_retry' },
  REQUEST_LIMIT_EXCEEDED: { retryable: true, delay: 60_000, strategy: 'fixed_delay' },
  LIMIT_EXCEEDED: { retryable: true, delay: 30_000, strategy: 'reduce_batch' },
  INVALID_FIELD: { retryable: false, category: 'schema' },
  REQUIRED_FIELD_MISSING: { retryable: false, category: 'data' },
  DUPLICATE_VALUE: { retryable: false, category: 'data', suggestUpsert: true },
  FIELD_CUSTOM_VALIDATION_EXCEPTION: { retryable: false, category: 'validation' },
  CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: { retryable: false, category: 'trigger' },
  STRING_TOO_LONG: { retryable: false, category: 'data', suggestTruncate: true },
  INVALID_CROSS_REFERENCE_KEY: { retryable: false, category: 'reference' },
  ENTITY_IS_DELETED: { retryable: false, category: 'reference' },
  STORAGE_LIMIT_EXCEEDED: { retryable: false, category: 'limit', blockAll: true },
  INVALID_TYPE: { retryable: false, category: 'schema' },
  MALFORMED_ID: { retryable: false, category: 'data' },
  INVALID_OPERATION: { retryable: false, category: 'schema' },
  INSUFFICIENT_ACCESS_OR_READONLY: { retryable: false, category: 'permission' },
  INVALID_FIELD_FOR_INSERT_UPDATE: { retryable: false, category: 'schema' },
};

/** Get error classification by Salesforce error code */
export function getErrorClassification(errorCode: string): ErrorClassification {
  return SF_ERROR_CLASSIFICATIONS[errorCode] ?? { retryable: false, category: 'unknown' };
}
