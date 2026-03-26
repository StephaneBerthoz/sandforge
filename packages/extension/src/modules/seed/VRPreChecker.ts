import type { VRCheckResult, VRFieldConstraint } from '@sandforge/shared';

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
 * Extracts structured constraints (required, picklist_value, length, regex)
 * that VRAutoAdjuster can use to auto-fix field generation configs.
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
   * Includes structured field constraints extracted from the formula.
   */
  analyzeRule(rule: ValidationRuleInfo): VRCheckResult {
    const fields = this.extractFields(rule.errorConditionFormula);
    const risk = this.assessRisk(rule.errorConditionFormula, fields);
    const fieldConstraints = this.extractConstraints(rule.errorConditionFormula);

    return {
      ruleName: rule.fullName,
      objectName: rule.objectName,
      formula: rule.errorConditionFormula,
      errorMessage: rule.errorMessage,
      potentialConflicts: fields,
      risk,
      fieldConstraints,
    };
  }

  /**
   * Extract field API names referenced in a validation rule formula.
   * Matches patterns like: ISBLANK(FieldName), FieldName != null, etc.
   */
  extractFields(formula: string): string[] {
    const fields = new Set<string>();

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
   * Extract structured constraints from a validation rule formula.
   * Parses ISBLANK, ISPICKVAL, LEN, REGEX patterns into VRFieldConstraint objects.
   *
   * @param formula - Salesforce validation rule formula string
   * @returns Array of structured field constraints
   */
  extractConstraints(formula: string): VRFieldConstraint[] {
    const constraints: VRFieldConstraint[] = [];
    let match: RegExpExecArray | null;

    // ISBLANK(FieldName) or ISNULL(FieldName) -> required
    const isblankPattern = /(?:ISBLANK|ISNULL)\s*\(\s*([A-Za-z][A-Za-z0-9_]*(?:__[a-z])?)\s*\)/gi;
    while ((match = isblankPattern.exec(formula)) !== null) {
      constraints.push({
        fieldName: match[1],
        constraintType: 'required',
      });
    }

    // ISPICKVAL(FieldName, 'Value') or ISPICKVAL(FieldName, "Value") -> picklist_value
    const ispickvalPattern = /ISPICKVAL\s*\(\s*([A-Za-z][A-Za-z0-9_]*(?:__[a-z])?)\s*,\s*["']([^"']*)["']\s*\)/gi;
    while ((match = ispickvalPattern.exec(formula)) !== null) {
      constraints.push({
        fieldName: match[1],
        constraintType: 'picklist_value',
        expectedValue: match[2],
      });
    }

    // LEN(FieldName) > N -> minLength = N + 1
    const lenGtPattern = /LEN\s*\(\s*([A-Za-z][A-Za-z0-9_]*(?:__[a-z])?)\s*\)\s*>\s*(\d+)/gi;
    while ((match = lenGtPattern.exec(formula)) !== null) {
      constraints.push({
        fieldName: match[1],
        constraintType: 'length',
        minLength: parseInt(match[2], 10) + 1,
      });
    }

    // LEN(FieldName) < N -> maxLength = N - 1
    const lenLtPattern = /LEN\s*\(\s*([A-Za-z][A-Za-z0-9_]*(?:__[a-z])?)\s*\)\s*<\s*(\d+)/gi;
    while ((match = lenLtPattern.exec(formula)) !== null) {
      constraints.push({
        fieldName: match[1],
        constraintType: 'length',
        maxLength: parseInt(match[2], 10) - 1,
      });
    }

    // REGEX(FieldName, 'pattern') or REGEX(FieldName, "pattern") -> regex
    const regexPatternRe = /REGEX\s*\(\s*([A-Za-z][A-Za-z0-9_]*(?:__[a-z])?)\s*,\s*["']([^"']*)["']\s*\)/gi;
    while ((match = regexPatternRe.exec(formula)) !== null) {
      constraints.push({
        fieldName: match[1],
        constraintType: 'regex',
        regexPattern: match[2],
      });
    }

    // Cross-field: IF(Field1 = ..., ...(Field2)...) -- best effort
    const ifPattern = /IF\s*\(\s*([A-Za-z][A-Za-z0-9_]*(?:__[a-z])?)\s*[=!<>]/gi;
    while ((match = ifPattern.exec(formula)) !== null) {
      const condField = match[1];
      const otherFields = this.extractFields(formula).filter((f) => f !== condField);
      if (otherFields.length > 0) {
        constraints.push({
          fieldName: condField,
          constraintType: 'cross_field',
          relatedField: otherFields[0],
        });
      }
    }

    return constraints;
  }

  /**
   * Assess risk level based on formula complexity and patterns.
   */
  private assessRisk(
    formula: string,
    fields: string[],
  ): 'low' | 'medium' | 'high' {
    let score = 0;

    if (/ISBLANK|ISNULL/i.test(formula)) {
      score += 3;
    }

    if (/\w+\.\w+/i.test(formula)) {
      score += 2;
    }

    if (/REGEX/i.test(formula)) {
      score += 3;
    }

    if (/PRIORVALUE|ISCHANGED/i.test(formula)) {
      score -= 1;
    }

    const logicalOps = (formula.match(/\bAND\b|\bOR\b|\b&&\b|\|\|/gi) ?? []).length;
    if (logicalOps >= 3) {
      score += 2;
    }

    if (fields.length >= 5) {
      score += 1;
    }

    if (score >= 4) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
  }
}
