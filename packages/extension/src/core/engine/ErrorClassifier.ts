import {
  SF_ERROR_CLASSIFICATIONS,
  getErrorClassification,
} from '@sandforge/shared';
import type {
  ErrorClassification,
  SalesforceApiError,
  ErrorSummary,
  ErrorCategory,
} from '@sandforge/shared';

/** A Salesforce error enriched with classification and suggested resolution */
export interface ClassifiedError {
  originalError: SalesforceApiError;
  classification: ErrorClassification;
  suggestedAction: string;
}

/**
 * Classifies Salesforce API errors for intelligent retry decisions and
 * user-facing error reporting.
 */
export class ErrorClassifier {
  /** Classify a single Salesforce error */
  classify(error: SalesforceApiError): ClassifiedError {
    const classification = getErrorClassification(error.statusCode);
    const suggestedAction = this.getSuggestedAction(
      error.statusCode,
      classification
    );

    return {
      originalError: error,
      classification,
      suggestedAction,
    };
  }

  /** Classify multiple errors and produce an aggregate summary */
  classifyBatch(errors: SalesforceApiError[]): {
    classified: ClassifiedError[];
    summary: ErrorSummary;
  } {
    const classified = errors.map((e) => this.classify(e));

    const byCategory: Record<ErrorCategory, number> = {
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
    };

    const byErrorCode: Record<string, number> = {};
    let retryableCount = 0;

    for (const c of classified) {
      if (c.classification.retryable) retryableCount++;
      const cat = c.classification.category ?? 'unknown';
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      byErrorCode[c.originalError.statusCode] =
        (byErrorCode[c.originalError.statusCode] ?? 0) + 1;
    }

    const summary: ErrorSummary = {
      totalErrors: errors.length,
      retryableCount,
      nonRetryableCount: errors.length - retryableCount,
      byCategory,
      byErrorCode,
      sampleErrors: errors.slice(0, 5),
    };

    return { classified, summary };
  }

  /** Check if a specific error code is retryable */
  isRetryable(errorCode: string): boolean {
    return getErrorClassification(errorCode).retryable;
  }

  /** Check if any error in the list should block all further operations */
  hasBlockingError(errors: SalesforceApiError[]): boolean {
    return errors.some((e) => {
      const classification = getErrorClassification(e.statusCode);
      return classification.blockAll === true;
    });
  }

  /** Get the number of known Salesforce error classifications */
  get knownErrorCount(): number {
    return Object.keys(SF_ERROR_CLASSIFICATIONS).length;
  }

  private getSuggestedAction(
    errorCode: string,
    classification: ErrorClassification
  ): string {
    if (classification.suggestUpsert) {
      return 'Consider using upsert with external ID';
    }
    if (classification.suggestTruncate) {
      return 'Truncate field values to fit within limits';
    }
    if (classification.blockAll) {
      return 'Operation blocked: resolve storage/limit issue first';
    }
    if (classification.strategy === 'reauth_then_retry') {
      return 'Re-authenticate and retry';
    }
    if (classification.strategy === 'reduce_batch') {
      return 'Reduce batch size and retry';
    }
    if (classification.retryable) {
      return `Retry after ${classification.delay ?? 0}ms`;
    }
    return `Fix ${errorCode} error and retry manually`;
  }
}
