import type {
  DataQualityScanResult,
  DataQualityRuleResult,
  DataQualityRuleType,
} from '@sandforge/shared';

/**
 * Scans records for data quality issues based on configurable rule types.
 * Supports completeness, uniqueness, format, range, referential,
 * consistency, and freshness checks.
 */
export class DataQualityScanner {
  /**
   * Scan records against a set of data quality rule types.
   * Runs each rule type against every field in the records and aggregates results.
   * @param orgId - The org identifier
   * @param objectApiName - The Salesforce object being scanned
   * @param records - The records to scan
   * @param rules - The data quality rule types to evaluate
   * @returns A complete scan result with per-rule details and overall score
   */
  scan(
    orgId: string,
    objectApiName: string,
    records: Record<string, unknown>[],
    rules: DataQualityRuleType[],
  ): DataQualityScanResult {
    const fields = this.extractFields(records);
    const ruleResults: DataQualityRuleResult[] = [];

    for (const ruleType of rules) {
      for (const field of fields) {
        const result = this.evaluateRule(ruleType, field, records);
        ruleResults.push(result);
      }
    }

    return {
      orgId,
      objectApiName,
      totalRecords: records.length,
      score: this.computeScore(ruleResults),
      rules: ruleResults,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check completeness of a field (non-null, non-empty values).
   * @param records - The records to check
   * @param field - The field name to evaluate
   * @returns A DataQualityRuleResult for the completeness check
   */
  checkCompleteness(
    records: Record<string, unknown>[],
    field: string,
  ): DataQualityRuleResult {
    let passed = 0;
    let failed = 0;
    const sampleFailures: string[] = [];

    for (const record of records) {
      const value = record[field];
      if (value !== null && value !== undefined && value !== '') {
        passed += 1;
      } else {
        failed += 1;
        if (sampleFailures.length < 5) {
          sampleFailures.push(
            `Record missing value for ${field}`,
          );
        }
      }
    }

    const total = passed + failed;
    return {
      ruleType: 'completeness',
      fieldApiName: field,
      passed,
      failed,
      passRate: total > 0 ? passed / total : 1,
      sampleFailures,
    };
  }

  /**
   * Check uniqueness of values for a field.
   * @param records - The records to check
   * @param field - The field name to evaluate
   * @returns A DataQualityRuleResult for the uniqueness check
   */
  checkUniqueness(
    records: Record<string, unknown>[],
    field: string,
  ): DataQualityRuleResult {
    const valueCounts = new Map<string, number>();
    const sampleFailures: string[] = [];

    for (const record of records) {
      const key = String(record[field] ?? '');
      valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
    }

    let passed = 0;
    let failed = 0;

    for (const [value, count] of valueCounts) {
      if (count === 1) {
        passed += 1;
      } else {
        failed += count;
        if (sampleFailures.length < 5) {
          sampleFailures.push(
            `Duplicate value '${value}' appears ${count} times in ${field}`,
          );
        }
      }
    }

    const total = passed + failed;
    return {
      ruleType: 'uniqueness',
      fieldApiName: field,
      passed,
      failed,
      passRate: total > 0 ? passed / total : 1,
      sampleFailures,
    };
  }

  /**
   * Check that field values match a specified pattern.
   * @param records - The records to check
   * @param field - The field name to evaluate
   * @param pattern - The regular expression pattern to match against
   * @returns A DataQualityRuleResult for the format check
   */
  checkFormat(
    records: Record<string, unknown>[],
    field: string,
    pattern: RegExp,
  ): DataQualityRuleResult {
    let passed = 0;
    let failed = 0;
    const sampleFailures: string[] = [];

    for (const record of records) {
      const value = record[field];
      if (value === null || value === undefined) {
        failed += 1;
        if (sampleFailures.length < 5) {
          sampleFailures.push(`Null value in ${field}`);
        }
        continue;
      }
      const str = String(value);
      if (pattern.test(str)) {
        passed += 1;
      } else {
        failed += 1;
        if (sampleFailures.length < 5) {
          sampleFailures.push(
            `Value '${str}' in ${field} does not match pattern`,
          );
        }
      }
    }

    const total = passed + failed;
    return {
      ruleType: 'format',
      fieldApiName: field,
      passed,
      failed,
      passRate: total > 0 ? passed / total : 1,
      sampleFailures,
    };
  }

  /**
   * Compute a weighted quality score (0-100) from rule results.
   * The score is the average pass rate across all rules, scaled to 100.
   * @param results - The rule results to aggregate
   * @returns A score between 0 and 100
   */
  computeScore(results: DataQualityRuleResult[]): number {
    if (results.length === 0) {
      return 100;
    }

    const totalPassRate = results.reduce(
      (sum, r) => sum + r.passRate,
      0,
    );

    return Math.round((totalPassRate / results.length) * 100);
  }

  private extractFields(records: Record<string, unknown>[]): string[] {
    if (records.length === 0) {
      return [];
    }
    return Object.keys(records[0]);
  }

  private evaluateRule(
    ruleType: DataQualityRuleType,
    field: string,
    records: Record<string, unknown>[],
  ): DataQualityRuleResult {
    switch (ruleType) {
      case 'completeness':
        return this.checkCompleteness(records, field);
      case 'uniqueness':
        return this.checkUniqueness(records, field);
      case 'format':
        return this.checkFormat(records, field, /.+/);
      case 'range':
        return this.checkRange(records, field);
      case 'referential':
        return this.checkReferential(records, field);
      case 'consistency':
        return this.checkConsistency(records, field);
      case 'freshness':
        return this.checkFreshness(records, field);
    }
  }

  private checkRange(
    records: Record<string, unknown>[],
    field: string,
  ): DataQualityRuleResult {
    let passed = 0;
    let failed = 0;
    const sampleFailures: string[] = [];

    for (const record of records) {
      const value = record[field];
      if (typeof value === 'number' && isFinite(value)) {
        passed += 1;
      } else {
        failed += 1;
        if (sampleFailures.length < 5) {
          sampleFailures.push(
            `Value '${String(value)}' in ${field} is not a valid number`,
          );
        }
      }
    }

    const total = passed + failed;
    return {
      ruleType: 'range',
      fieldApiName: field,
      passed,
      failed,
      passRate: total > 0 ? passed / total : 1,
      sampleFailures,
    };
  }

  private checkReferential(
    records: Record<string, unknown>[],
    field: string,
  ): DataQualityRuleResult {
    let passed = 0;
    let failed = 0;
    const sampleFailures: string[] = [];

    for (const record of records) {
      const value = record[field];
      if (value !== null && value !== undefined && String(value).length > 0) {
        passed += 1;
      } else {
        failed += 1;
        if (sampleFailures.length < 5) {
          sampleFailures.push(
            `Missing reference in ${field}`,
          );
        }
      }
    }

    const total = passed + failed;
    return {
      ruleType: 'referential',
      fieldApiName: field,
      passed,
      failed,
      passRate: total > 0 ? passed / total : 1,
      sampleFailures,
    };
  }

  private checkConsistency(
    records: Record<string, unknown>[],
    field: string,
  ): DataQualityRuleResult {
    const types = new Set<string>();
    let passed = 0;
    let failed = 0;
    const sampleFailures: string[] = [];

    for (const record of records) {
      const value = record[field];
      types.add(typeof value);
    }

    const isConsistent = types.size <= 1;

    for (const record of records) {
      if (isConsistent) {
        passed += 1;
      } else {
        const value = record[field];
        failed += 1;
        if (sampleFailures.length < 5) {
          sampleFailures.push(
            `Inconsistent type '${typeof value}' in ${field}`,
          );
        }
      }
    }

    const total = passed + failed;
    return {
      ruleType: 'consistency',
      fieldApiName: field,
      passed,
      failed,
      passRate: total > 0 ? passed / total : 1,
      sampleFailures,
    };
  }

  private checkFreshness(
    records: Record<string, unknown>[],
    field: string,
  ): DataQualityRuleResult {
    let passed = 0;
    let failed = 0;
    const sampleFailures: string[] = [];
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const record of records) {
      const value = record[field];
      if (typeof value === 'string') {
        const date = new Date(value);
        if (!isNaN(date.getTime()) && date.getTime() >= thirtyDaysAgo) {
          passed += 1;
        } else {
          failed += 1;
          if (sampleFailures.length < 5) {
            sampleFailures.push(
              `Value '${value}' in ${field} is stale or invalid date`,
            );
          }
        }
      } else {
        failed += 1;
        if (sampleFailures.length < 5) {
          sampleFailures.push(
            `Non-string value in ${field} cannot be evaluated for freshness`,
          );
        }
      }
    }

    const total = passed + failed;
    return {
      ruleType: 'freshness',
      fieldApiName: field,
      passed,
      failed,
      passRate: total > 0 ? passed / total : 1,
      sampleFailures,
    };
  }
}
