import type { VRCheckResult } from '@sandforge/shared';

/** Salesforce validation rule metadata from Tooling API. */
export interface ValidationRuleInfo {
  fullName: string;
  objectName: string;
  active: boolean;
  errorConditionFormula: string;
  errorMessage: string;
}

/** Connection abstraction for querying validation rules. */
export interface VRConnection {
  queryValidationRules(objectName: string): Promise<ValidationRuleInfo[]>;
}

/**
 * Pre-checks Salesforce validation rules against seed field configurations.
 * Parses validation rule formulas to identify fields that may conflict
 * with generated data and assigns a risk level.
 */
export class VRPreChecker {
  /**
   * Check all validation rules for a list of objects.
   * Returns a list of potential conflicts with risk assessments.
   */
  async checkAll(
    conn: VRConnection,
    objectNames: string[],
  ): Promise<VRCheckResult[]> {
    const results: VRCheckResult[] = [];
    for (const objectName of objectNames) {
      const objectResults = await this.checkObject(conn, objectName);
      results.push(...objectResults);
    }
    return results;
  }

  /**
   * Check validation rules for a single object.
   */
  async checkObject(
    conn: VRConnection,
    objectName: string,
  ): Promise<VRCheckResult[]> {
    let rules: ValidationRuleInfo[];
    try {
      rules = await conn.queryValidationRules(objectName);
    } catch {
      return [];
    }

    const activeRules = rules.filter((r) => r.active);
    return activeRules.map((rule) => this.analyzeRule(rule));
  }

  /**
   * Analyze a single validation rule and assess its risk for seeded data.
   */
  analyzeRule(rule: ValidationRuleInfo): VRCheckResult {
    const fields = this.extractFields(rule.errorConditionFormula);
    const risk = this.assessRisk(rule.errorConditionFormula, fields);

    return {
      ruleName: rule.fullName,
      objectName: rule.objectName,
      formula: rule.errorConditionFormula,
      errorMessage: rule.errorMessage,
      potentialConflicts: fields,
      risk,
    };
  }

  /**
   * Extract field API names referenced in a validation rule formula.
   * Matches patterns like: ISBLANK(FieldName), FieldName != null, etc.
   */
  extractFields(formula: string): string[] {
    const fields = new Set<string>();

    // Match field references: word patterns that look like API names
    // Excludes known functions and operators
    const functionNames = new Set([
      'ISBLANK', 'ISNULL', 'NOT', 'AND', 'OR', 'IF', 'CASE',
      'LEN', 'TEXT', 'VALUE', 'BEGINS', 'CONTAINS', 'INCLUDES',
      'ISPICKVAL', 'PRIORVALUE', 'ISCHANGED', 'ISNEW',
      'TODAY', 'NOW', 'YEAR', 'MONTH', 'DAY',
      'TRUE', 'FALSE', 'NULL', 'BLANKVALUE', 'NULLVALUE',
      'LEFT', 'RIGHT', 'MID', 'TRIM', 'LOWER', 'UPPER',
      'REGEX', 'ROUND', 'CEILING', 'FLOOR', 'ABS', 'MAX', 'MIN',
      'BR', 'HYPERLINK', 'IMAGE', 'SUBSTITUTE',
    ]);

    // Pattern: word chars optionally followed by __c, __r, etc.
    const fieldPattern = /\b([A-Z][A-Za-z0-9_]*(?:__[a-z])?)\b/g;
    let match: RegExpExecArray | null;

    while ((match = fieldPattern.exec(formula)) !== null) {
      const name = match[1];
      if (!functionNames.has(name.toUpperCase()) && !functionNames.has(name)) {
        fields.add(name);
      }
    }

    return [...fields];
  }

  /**
   * Assess risk level based on formula complexity and patterns.
   */
  private assessRisk(
    formula: string,
    fields: string[],
  ): 'low' | 'medium' | 'high' {
    let score = 0;

    // Required field checks (ISBLANK) are high risk for seeded data
    if (/ISBLANK|ISNULL/i.test(formula)) {
      score += 3;
    }

    // Cross-object references increase risk
    if (/\w+\.\w+/i.test(formula)) {
      score += 2;
    }

    // REGEX validation is high risk — generated data likely won't match
    if (/REGEX/i.test(formula)) {
      score += 3;
    }

    // PRIORVALUE/ISCHANGED — update-only rules, lower risk for inserts
    if (/PRIORVALUE|ISCHANGED/i.test(formula)) {
      score -= 1;
    }

    // Complex formulas with many AND/OR conditions
    const logicalOps = (formula.match(/\bAND\b|\bOR\b|\b&&\b|\|\|/gi) ?? []).length;
    if (logicalOps >= 3) {
      score += 2;
    }

    // Many fields referenced increases conflict surface
    if (fields.length >= 5) {
      score += 1;
    }

    if (score >= 4) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
  }
}
