import { describe, it, expect, beforeEach } from 'vitest';
import { GovernanceEngine, GovernanceRuleSchema, GovernancePolicySchema } from './GovernanceEngine';
import type {
  GovernanceRule,
  GovernancePolicy,
  GovernanceRuleResult,
  MetricValues,
} from './GovernanceEngine';

function createRule(overrides?: Partial<GovernanceRule>): GovernanceRule {
  return {
    id: 'rule-1',
    name: 'API Usage Limit',
    description: 'API usage should stay below threshold',
    category: 'performance',
    condition: { metric: 'apiUsagePercent', operator: 'gt', threshold: 90, warningThreshold: 75 },
    remediation: 'Reduce API calls',
    enabled: true,
    ...overrides,
  };
}

function createPolicy(overrides?: Partial<GovernancePolicy>): GovernancePolicy {
  return {
    id: 'policy-1',
    name: 'Test Policy',
    description: 'Test governance policy',
    rules: [createRule()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('GovernanceEngine', () => {
  let engine: GovernanceEngine;

  beforeEach(() => {
    engine = new GovernanceEngine();
  });

  describe('evaluateRule', () => {
    it('should return pass when metric is below threshold (gt operator)', () => {
      const rule = createRule();
      const metrics: MetricValues = { apiUsagePercent: 50 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('pass');
      expect(result.ruleId).toBe('rule-1');
    });

    it('should return fail when metric exceeds threshold (gt operator)', () => {
      const rule = createRule();
      const metrics: MetricValues = { apiUsagePercent: 95 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('fail');
    });

    it('should return warning when metric exceeds warning threshold but not fail threshold', () => {
      const rule = createRule();
      const metrics: MetricValues = { apiUsagePercent: 80 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('warning');
    });

    it('should return pass when metric equals threshold exactly (gt operator)', () => {
      const rule = createRule();
      const metrics: MetricValues = { apiUsagePercent: 90 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('warning');
    });

    it('should handle lt operator', () => {
      const rule = createRule({
        condition: { metric: 'codeCoverage', operator: 'lt', threshold: 75 },
      });
      const metrics: MetricValues = { codeCoverage: 60 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('fail');
    });

    it('should handle gte operator', () => {
      const rule = createRule({
        condition: { metric: 'storage', operator: 'gte', threshold: 100 },
      });
      const metrics: MetricValues = { storage: 100 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('fail');
    });

    it('should handle lte operator', () => {
      const rule = createRule({
        condition: { metric: 'coverage', operator: 'lte', threshold: 50 },
      });
      const metrics: MetricValues = { coverage: 50 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('fail');
    });

    it('should handle eq operator', () => {
      const rule = createRule({
        condition: { metric: 'mfa', operator: 'eq', threshold: 0 },
      });
      const metrics: MetricValues = { mfa: 0 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('fail');
    });

    it('should handle neq operator', () => {
      const rule = createRule({
        condition: { metric: 'mfa', operator: 'neq', threshold: 100 },
      });
      const metrics: MetricValues = { mfa: 50 };
      const result = engine.evaluateRule(rule, metrics);
      expect(result.status).toBe('fail');
    });

    it('should default to 0 when metric is missing', () => {
      const rule = createRule({
        condition: { metric: 'unknown', operator: 'gt', threshold: -1 },
      });
      const result = engine.evaluateRule(rule, {});
      expect(result.status).toBe('fail');
      expect(result.actualValue).toBe(0);
    });

    it('should include remediation only for non-passing results', () => {
      const rule = createRule();
      const passResult = engine.evaluateRule(rule, { apiUsagePercent: 10 });
      expect(passResult.remediation).toBe('');
      const failResult = engine.evaluateRule(rule, { apiUsagePercent: 95 });
      expect(failResult.remediation).toBe('Reduce API calls');
    });
  });

  describe('evaluatePolicy', () => {
    it('should evaluate all enabled rules', () => {
      const policy = createPolicy({
        rules: [
          createRule({ id: 'r1', enabled: true }),
          createRule({ id: 'r2', enabled: false }),
          createRule({ id: 'r3', enabled: true }),
        ],
      });
      const result = engine.evaluatePolicy(policy, { apiUsagePercent: 50 });
      expect(result.ruleResults).toHaveLength(2);
    });

    it('should compute compliance score', () => {
      const policy = createPolicy();
      const result = engine.evaluatePolicy(policy, { apiUsagePercent: 50 });
      expect(result.complianceScore).toBe(100);
    });

    it('should include policy metadata', () => {
      const policy = createPolicy();
      const result = engine.evaluatePolicy(policy, { apiUsagePercent: 50 });
      expect(result.policyId).toBe('policy-1');
      expect(result.policyName).toBe('Test Policy');
      expect(result.evaluatedAt).toBeTruthy();
    });

    it('should collect remediations from failing rules', () => {
      const policy = createPolicy();
      const result = engine.evaluatePolicy(policy, { apiUsagePercent: 95 });
      expect(result.remediations).toContain('Reduce API calls');
    });

    it('should return empty remediations when all pass', () => {
      const policy = createPolicy();
      const result = engine.evaluatePolicy(policy, { apiUsagePercent: 10 });
      expect(result.remediations).toHaveLength(0);
    });
  });

  describe('computeComplianceScore', () => {
    it('should return 100 for empty results', () => {
      expect(GovernanceEngine.computeComplianceScore([])).toBe(100);
    });

    it('should return 100 when all pass', () => {
      const results: GovernanceRuleResult[] = [
        {
          ruleId: 'r1',
          ruleName: 'R1',
          category: 'security',
          status: 'pass',
          actualValue: 0,
          threshold: 0,
          message: '',
          remediation: '',
        },
        {
          ruleId: 'r2',
          ruleName: 'R2',
          category: 'security',
          status: 'pass',
          actualValue: 0,
          threshold: 0,
          message: '',
          remediation: '',
        },
      ];
      expect(GovernanceEngine.computeComplianceScore(results)).toBe(100);
    });

    it('should return 0 when all fail', () => {
      const results: GovernanceRuleResult[] = [
        {
          ruleId: 'r1',
          ruleName: 'R1',
          category: 'security',
          status: 'fail',
          actualValue: 0,
          threshold: 0,
          message: '',
          remediation: '',
        },
      ];
      expect(GovernanceEngine.computeComplianceScore(results)).toBe(0);
    });

    it('should return 50 for warnings', () => {
      const results: GovernanceRuleResult[] = [
        {
          ruleId: 'r1',
          ruleName: 'R1',
          category: 'security',
          status: 'warning',
          actualValue: 0,
          threshold: 0,
          message: '',
          remediation: '',
        },
      ];
      expect(GovernanceEngine.computeComplianceScore(results)).toBe(50);
    });

    it('should average scores correctly', () => {
      const results: GovernanceRuleResult[] = [
        {
          ruleId: 'r1',
          ruleName: 'R1',
          category: 'security',
          status: 'pass',
          actualValue: 0,
          threshold: 0,
          message: '',
          remediation: '',
        },
        {
          ruleId: 'r2',
          ruleName: 'R2',
          category: 'security',
          status: 'fail',
          actualValue: 0,
          threshold: 0,
          message: '',
          remediation: '',
        },
      ];
      expect(GovernanceEngine.computeComplianceScore(results)).toBe(50);
    });
  });

  describe('Zod schemas', () => {
    it('should validate a valid governance rule', () => {
      const rule = createRule();
      expect(GovernanceRuleSchema.safeParse(rule).success).toBe(true);
    });

    it('should reject an invalid governance rule', () => {
      const invalid = { id: 'x', name: 'x' };
      expect(GovernanceRuleSchema.safeParse(invalid).success).toBe(false);
    });

    it('should validate a valid governance policy', () => {
      const policy = createPolicy();
      expect(GovernancePolicySchema.safeParse(policy).success).toBe(true);
    });

    it('should reject an invalid governance policy', () => {
      const invalid = { id: 'x' };
      expect(GovernancePolicySchema.safeParse(invalid).success).toBe(false);
    });
  });
});
