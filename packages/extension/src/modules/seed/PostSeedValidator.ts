import type { SeedExecutionResult } from '@sandforge/shared';

/** Function signature for querying records from Salesforce */
export type QueryRecordsFn = (
  orgId: string,
  objectApiName: string,
  ids: string[]
) => Promise<QueryResult>;

/** Result of querying records for validation */
export interface QueryResult {
  records: Record<string, unknown>[];
  totalSize: number;
}

/** Result of post-seed validation */
export interface PostValidationResult {
  valid: boolean;
  verifiedCount: number;
  issues: string[];
}

/**
 * Validates seeded data after insertion by querying back
 * the created records and verifying their existence.
 */
export class PostSeedValidator {
  private readonly queryRecords: QueryRecordsFn;

  constructor(queryRecords: QueryRecordsFn) {
    this.queryRecords = queryRecords;
  }

  /**
   * Validate a seed execution result by querying all created records
   * and checking they exist in the target org.
   */
  async validate(
    orgId: string,
    result: SeedExecutionResult
  ): Promise<PostValidationResult> {
    const issues: string[] = [];
    let verifiedCount = 0;

    for (const objResult of result.objectResults) {
      if (objResult.createdIds.length === 0) {
        continue;
      }

      const queryResult = await this.queryRecords(
        orgId,
        objResult.objectApiName,
        objResult.createdIds
      );

      const foundCount = queryResult.totalSize;
      verifiedCount += foundCount;

      const expectedCount = objResult.createdIds.length;
      const missingCount = expectedCount - foundCount;

      if (missingCount > 0) {
        issues.push(
          `${objResult.objectApiName}: ${missingCount} of ${expectedCount} records not found`
        );
      }
    }

    if (result.totalRecordsFailed > 0) {
      issues.push(
        `${result.totalRecordsFailed} records failed during insertion`
      );
    }

    return {
      valid: issues.length === 0,
      verifiedCount,
      issues,
    };
  }
}
