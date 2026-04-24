import { z } from 'zod';

/**
 * Compliance status for a governance rule evaluation.
 */
export type ComplianceStatus = 'pass' | 'warning' | 'fail';

/**
 * Zod schema for a governance rule condition.
 */
const GovernanceRuleConditionSchema = z.object({
  metric: z.string(),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  threshold: z.number(),
  warningThreshold: z.number().optional(),
});

/** A governance rule condition. */
export type GovernanceRuleCondition = z.infer<typeof GovernanceRuleConditionSchema>;

/**
 * Zod schema for a single governance rule.
 */
export const GovernanceRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(['security', 'performance', 'compliance', 'custom']),
  condition: GovernanceRuleConditionSchema,
  remediation: z.string(),
  enabled: z.boolean(),
});

/** A governance rule definition. */
export type GovernanceRule = z.infer<typeof GovernanceRuleSchema>;

/**
 * Zod schema for a governance policy (collection of rules).
 */
export const GovernancePolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  rules: z.array(GovernanceRuleSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A governance policy. */
export type GovernancePolicy = z.infer<typeof GovernancePolicySchema>;

/**
 * Result of evaluating a single governance rule.
 */
export interface GovernanceRuleResult {
  /** The rule that was evaluated. */
  ruleId: string;
  /** Rule name for display. */
  ruleName: string;
  /** Category of the rule. */
  category: string;
  /** Compliance status after evaluation. */
  status: ComplianceStatus;
  /** Actual metric value observed. */
  actualValue: number;
  /** Threshold from the rule condition. */
  threshold: number;
  /** Human-readable message describing the result. */
  message: string;
  /** Remediation recommendation if non-passing. */
  remediation: string;
}

/**
 * Result of evaluating all rules in a policy.
 */
export interface GovernanceEvaluationResult {
  /** Policy ID that was evaluated. */
  policyId: string;
  /** Policy name. */
  policyName: string;
  /** Timestamp of the evaluation. */
  evaluatedAt: string;
  /** Overall compliance score (0-100). */
  complianceScore: number;
  /** Individual rule results. */
  ruleResults: GovernanceRuleResult[];
  /** Remediation recommendations for failing rules. */
  remediations: string[];
}

/** Metric values provided for evaluation. */
export type MetricValues = Record<string, number>;

/**
 * Evaluates a condition operator against actual and threshold values.
 *
 * @param actual - The actual metric value.
 * @param operator - The comparison operator.
 * @param threshold - The threshold value.
 * @returns True if the condition is violated (non-compliant).
 */
function isViolation(
  actual: number,
  operator: GovernanceRuleCondition['operator'],
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':
      return actual > threshold;
    case 'gte':
      return actual >= threshold;
    case 'lt':
      return actual < threshold;
    case 'lte':
      return actual <= threshold;
    case 'eq':
      return actual === threshold;
    case 'neq':
      return actual !== threshold;
  }
}

/**
 * Governance policy engine that evaluates rules against org metadata metrics.
 *
 * Supports defining governance rules with conditions (thresholds), evaluating
 * them against actual org metrics, computing compliance scores, and generating
 * remediation recommendations.
 */
export class GovernanceEngine {
  /**
   * Evaluate a single governance rule against provided metric values.
   *
   * @param rule - The governance rule to evaluate.
   * @param metrics - Map of metric names to their current values.
   * @returns The evaluation result for this rule.
   */
  evaluateRule(rule: GovernanceRule, metrics: MetricValues): GovernanceRuleResult {
    const actual = metrics[rule.condition.metric] ?? 0;
    const { operator, threshold, warningThreshold } = rule.condition;

    let status: ComplianceStatus = 'pass';

    if (isViolation(actual, operator, threshold)) {
      status = 'fail';
    } else if (
      warningThreshold !== undefined &&
      isViolation(actual, operator, warningThreshold)
    ) {
      status = 'warning';
    }

    const message =
      status === 'pass'
        ? `${rule.name}: compliant (${actual})`
        : `${rule.name}: ${status} — actual ${actual} ${operator} ${status === 'fail' ? threshold : warningThreshold ?? threshold}`;

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      category: rule.category,
      status,
      actualValue: actual,
      threshold,
      message,
      remediation: status === 'pass' ? '' : rule.remediation,
    };
  }

  /**
   * Evaluate all enabled rules in a policy against the given metrics.
   *
   * @param policy - The governance policy to evaluate.
   * @param metrics - Map of metric names to their current values.
   * @returns Full evaluation result with compliance score and remediations.
   */
  evaluatePolicy(
    policy: GovernancePolicy,
    metrics: MetricValues,
  ): GovernanceEvaluationResult {
    const enabledRules = policy.rules.filter((r) => r.enabled);
    const ruleResults = enabledRules.map((rule) =>
      this.evaluateRule(rule, metrics),
    );

    const complianceScore = GovernanceEngine.computeComplianceScore(ruleResults);

    const remediations = ruleResults
      .filter((r) => r.status !== 'pass' && r.remediation)
      .map((r) => r.remediation);

    return {
      policyId: policy.id,
      policyName: policy.name,
      evaluatedAt: new Date().toISOString(),
      complianceScore,
      ruleResults,
      remediations,
    };
  }

  /**
   * Compute overall compliance score from rule results (0-100).
   * Each passing rule scores 100, warning scores 50, fail scores 0.
   *
   * @param results - The individual rule results.
   * @returns Compliance percentage (0-100).
   */
  static computeComplianceScore(results: GovernanceRuleResult[]): number {
    if (results.length === 0) {
      return 100;
    }

    const scoreMap: Record<ComplianceStatus, number> = {
      pass: 100,
      warning: 50,
      fail: 0,
    };

    const total = results.reduce((sum, r) => sum + scoreMap[r.status], 0);
    return Math.round(total / results.length);
  }
}
