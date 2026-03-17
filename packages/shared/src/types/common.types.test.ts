import { describe, it, expect } from 'vitest';
import type { OperationResult, OperationError } from './common.types.js';

describe('common.types', () => {
  it('should allow creating a successful OperationResult', () => {
    const result: OperationResult<string> = {
      success: true,
      data: 'test',
      warnings: [],
      duration: 100,
      timestamp: new Date().toISOString(),
    };
    expect(result.success).toBe(true);
    expect(result.data).toBe('test');
  });

  it('should allow creating a failed OperationResult', () => {
    const error: OperationError = {
      code: 'INVALID_FIELD',
      message: 'Field not found',
      retryable: false,
      category: 'schema',
    };
    const result: OperationResult = {
      success: false,
      error,
      warnings: [],
      duration: 50,
      timestamp: new Date().toISOString(),
    };
    expect(result.success).toBe(false);
    expect(result.error?.retryable).toBe(false);
  });
});
