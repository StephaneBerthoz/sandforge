import type { ErrorCategory } from './common.types.js';

/** Error classification for Salesforce errors — determines retry behavior */
export interface ErrorClassification {
  retryable: boolean;
  delay?: number;
  strategy?: RetryStrategyType;
  category?: ErrorCategory;
  suggestUpsert?: boolean;
  suggestTruncate?: boolean;
  blockAll?: boolean;
}

/** Retry strategy type */
export type RetryStrategyType =
  | 'exponential'
  | 'fixed_delay'
  | 'reauth_then_retry'
  | 'reduce_batch';

/** Structured Salesforce API error */
export interface SalesforceApiError {
  statusCode: string;
  message: string;
  fields?: string[];
  errorCode?: string;
}

/** Batch error with record context */
export interface BatchRecordError {
  recordIndex: number;
  recordId?: string;
  errors: SalesforceApiError[];
  retryable: boolean;
}

/** Error summary for an operation */
export interface ErrorSummary {
  totalErrors: number;
  retryableCount: number;
  nonRetryableCount: number;
  byCategory: Record<ErrorCategory, number>;
  byErrorCode: Record<string, number>;
  sampleErrors: SalesforceApiError[];
}

/** Error resolution suggestion */
export interface ErrorResolution {
  errorCode: string;
  suggestion: string;
  autoFixable: boolean;
  action?: ErrorResolutionAction;
}

/** Automated action to fix an error */
export type ErrorResolutionAction =
  | 'retry'
  | 'reauth'
  | 'reduce_batch'
  | 'upsert_instead'
  | 'truncate_field'
  | 'skip_record'
  | 'manual';
