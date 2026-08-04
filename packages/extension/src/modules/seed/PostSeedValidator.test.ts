import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostSeedValidator } from './PostSeedValidator';
import type { QueryRecordsFn } from './PostSeedValidator';
import type { SeedExecutionResult } from '@sandforge/shared';

function createExecutionResult(overrides?: Partial<SeedExecutionResult>): SeedExecutionResult {
  return {
    templateId: 'tpl-1',
    operationId: 'op-1',
    status: 'success',
    objectResults: [
      {
        objectApiName: 'Account',
        recordsCreated: 3,
        recordsFailed: 0,
        createdIds: ['001A', '001B', '001C'],
        errors: [],
      },
    ],
    totalRecordsCreated: 3,
    totalRecordsFailed: 0,
    duration: 1500,
    timestamp: '2026-01-15T10:00:00Z',
    ...overrides,
  };
}

describe('PostSeedValidator', () => {
  let validator: PostSeedValidator;
  let queryRecords: QueryRecordsFn;

  beforeEach(() => {
    queryRecords = vi
      .fn<Parameters<QueryRecordsFn>, ReturnType<QueryRecordsFn>>()
      .mockResolvedValue({
        records: [{ Id: '001A' }, { Id: '001B' }, { Id: '001C' }],
        totalSize: 3,
      });
    validator = new PostSeedValidator(queryRecords);
  });

  describe('validate', () => {
    it('should return valid when all records are found', async () => {
      const result = await validator.validate('org-1', createExecutionResult());

      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(3);
      expect(result.issues).toHaveLength(0);
    });

    it('should report missing records', async () => {
      vi.mocked(queryRecords).mockResolvedValue({
        records: [{ Id: '001A' }],
        totalSize: 1,
      });

      const result = await validator.validate('org-1', createExecutionResult());

      expect(result.valid).toBe(false);
      expect(result.verifiedCount).toBe(1);
      expect(result.issues.some((i) => i.includes('2 of 3'))).toBe(true);
    });

    it('should report insertion failures', async () => {
      const execResult = createExecutionResult({
        totalRecordsFailed: 5,
      });

      const result = await validator.validate('org-1', execResult);

      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.includes('5 records failed'))).toBe(true);
    });

    it('should validate multiple objects', async () => {
      const execResult = createExecutionResult({
        objectResults: [
          {
            objectApiName: 'Account',
            recordsCreated: 2,
            recordsFailed: 0,
            createdIds: ['001A', '001B'],
            errors: [],
          },
          {
            objectApiName: 'Contact',
            recordsCreated: 3,
            recordsFailed: 0,
            createdIds: ['003A', '003B', '003C'],
            errors: [],
          },
        ],
        totalRecordsCreated: 5,
        totalRecordsFailed: 0,
      });

      const result = await validator.validate('org-1', execResult);

      expect(queryRecords).toHaveBeenCalledTimes(2);
      expect(result.verifiedCount).toBe(6);
    });

    it('should skip objects with no created IDs', async () => {
      const execResult = createExecutionResult({
        objectResults: [
          {
            objectApiName: 'Account',
            recordsCreated: 0,
            recordsFailed: 5,
            createdIds: [],
            errors: ['Error'],
          },
        ],
      });

      await validator.validate('org-1', execResult);

      expect(queryRecords).not.toHaveBeenCalled();
    });

    it('should pass correct parameters to queryRecords', async () => {
      await validator.validate('org-1', createExecutionResult());

      expect(queryRecords).toHaveBeenCalledWith('org-1', 'Account', ['001A', '001B', '001C']);
    });

    it('should handle query errors by propagating them', async () => {
      vi.mocked(queryRecords).mockRejectedValue(new Error('Query failed'));

      await expect(validator.validate('org-1', createExecutionResult())).rejects.toThrow(
        'Query failed',
      );
    });

    it('should return valid true when all objects have empty createdIds', async () => {
      const execResult = createExecutionResult({
        objectResults: [
          {
            objectApiName: 'Account',
            recordsCreated: 0,
            recordsFailed: 0,
            createdIds: [],
            errors: [],
          },
        ],
        totalRecordsCreated: 0,
        totalRecordsFailed: 0,
      });

      const result = await validator.validate('org-1', execResult);
      expect(result.valid).toBe(true);
      expect(result.verifiedCount).toBe(0);
    });

    it('should handle partial verification across objects', async () => {
      let callCount = 0;
      vi.mocked(queryRecords).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { records: [{ Id: '001A' }], totalSize: 1 };
        }
        return { records: [{ Id: '003A' }, { Id: '003B' }], totalSize: 2 };
      });

      const execResult = createExecutionResult({
        objectResults: [
          {
            objectApiName: 'Account',
            recordsCreated: 2,
            recordsFailed: 0,
            createdIds: ['001A', '001B'],
            errors: [],
          },
          {
            objectApiName: 'Contact',
            recordsCreated: 2,
            recordsFailed: 0,
            createdIds: ['003A', '003B'],
            errors: [],
          },
        ],
        totalRecordsCreated: 4,
        totalRecordsFailed: 0,
      });

      const result = await validator.validate('org-1', execResult);
      expect(result.valid).toBe(false);
      expect(result.verifiedCount).toBe(3);
    });

    it('should accumulate issues from multiple objects and failures', async () => {
      vi.mocked(queryRecords).mockResolvedValue({ records: [], totalSize: 0 });

      const execResult = createExecutionResult({
        objectResults: [
          {
            objectApiName: 'Account',
            recordsCreated: 2,
            recordsFailed: 0,
            createdIds: ['001A', '001B'],
            errors: [],
          },
          {
            objectApiName: 'Contact',
            recordsCreated: 3,
            recordsFailed: 0,
            createdIds: ['003A', '003B', '003C'],
            errors: [],
          },
        ],
        totalRecordsCreated: 5,
        totalRecordsFailed: 1,
      });

      const result = await validator.validate('org-1', execResult);
      expect(result.issues.length).toBe(3);
    });
  });
});
