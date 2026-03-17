import { describe, it, expect, vi } from 'vitest';
import { VRPreChecker } from './VRPreChecker';
import type { VRConnection, ValidationRuleInfo } from './VRPreChecker';

function makeRule(overrides: Partial<ValidationRuleInfo> = {}): ValidationRuleInfo {
  return {
    fullName: 'Account.RequireName',
    objectName: 'Account',
    active: true,
    errorConditionFormula: 'ISBLANK(Name)',
    errorMessage: 'Name is required',
    ...overrides,
  };
}

function makeConn(rules: ValidationRuleInfo[] = []): VRConnection {
  return {
    queryValidationRules: vi.fn().mockResolvedValue(rules),
  };
}

describe('VRPreChecker', () => {
  const checker = new VRPreChecker();

  describe('checkAll', () => {
    it('should return results for multiple objects', async () => {
      const rule1 = makeRule({ objectName: 'Account' });
      const rule2 = makeRule({
        fullName: 'Contact.RequireEmail',
        objectName: 'Contact',
        errorConditionFormula: 'ISBLANK(Email)',
        errorMessage: 'Email required',
      });
      const conn: VRConnection = {
        queryValidationRules: vi.fn()
          .mockResolvedValueOnce([rule1])
          .mockResolvedValueOnce([rule2]),
      };
      const results = await checker.checkAll(conn, ['Account', 'Contact']);
      expect(results).toHaveLength(2);
      expect(results[0].objectName).toBe('Account');
      expect(results[1].objectName).toBe('Contact');
    });

    it('should return empty array for no objects', async () => {
      const conn = makeConn();
      const results = await checker.checkAll(conn, []);
      expect(results).toEqual([]);
    });
  });

  describe('checkObject', () => {
    it('should return results for active rules only', async () => {
      const rules = [
        makeRule({ active: true }),
        makeRule({ fullName: 'Account.InactiveRule', active: false }),
      ];
      const conn = makeConn(rules);
      const results = await checker.checkObject(conn, 'Account');
      expect(results).toHaveLength(1);
      expect(results[0].ruleName).toBe('Account.RequireName');
    });

    it('should return empty array when query fails', async () => {
      const conn: VRConnection = {
        queryValidationRules: vi.fn().mockRejectedValue(new Error('Network error')),
      };
      const results = await checker.checkObject(conn, 'Account');
      expect(results).toEqual([]);
    });

    it('should return empty array when no rules', async () => {
      const conn = makeConn([]);
      const results = await checker.checkObject(conn, 'Account');
      expect(results).toEqual([]);
    });
  });

  describe('analyzeRule', () => {
    it('should extract rule metadata', () => {
      const rule = makeRule();
      const result = checker.analyzeRule(rule);
      expect(result.ruleName).toBe('Account.RequireName');
      expect(result.objectName).toBe('Account');
      expect(result.formula).toBe('ISBLANK(Name)');
      expect(result.errorMessage).toBe('Name is required');
    });

    it('should extract field references from formula', () => {
      const rule = makeRule({
        errorConditionFormula: 'AND(ISBLANK(FirstName), ISBLANK(LastName))',
      });
      const result = checker.analyzeRule(rule);
      expect(result.potentialConflicts).toContain('FirstName');
      expect(result.potentialConflicts).toContain('LastName');
    });

    it('should not include function names as fields', () => {
      const rule = makeRule({
        errorConditionFormula: 'ISBLANK(Name) && NOT(ISNULL(Email))',
      });
      const result = checker.analyzeRule(rule);
      expect(result.potentialConflicts).not.toContain('ISBLANK');
      expect(result.potentialConflicts).not.toContain('NOT');
      expect(result.potentialConflicts).not.toContain('ISNULL');
    });
  });

  describe('extractFields', () => {
    it('should extract simple field references', () => {
      const fields = checker.extractFields('ISBLANK(Name)');
      expect(fields).toContain('Name');
    });

    it('should extract custom field references', () => {
      const fields = checker.extractFields('ISBLANK(Custom__c)');
      expect(fields).toContain('Custom__c');
    });

    it('should extract multiple fields', () => {
      const fields = checker.extractFields('AND(ISBLANK(FirstName), LEN(LastName) < 2)');
      expect(fields).toContain('FirstName');
      expect(fields).toContain('LastName');
    });

    it('should not include known functions', () => {
      const fields = checker.extractFields('IF(ISBLANK(Name), TRUE, FALSE)');
      expect(fields).not.toContain('IF');
      expect(fields).not.toContain('ISBLANK');
      expect(fields).not.toContain('TRUE');
      expect(fields).not.toContain('FALSE');
    });
  });

  describe('risk assessment', () => {
    it('should assign medium risk for REGEX rules', () => {
      const rule = makeRule({
        errorConditionFormula: 'NOT(REGEX(Email__c, "^[a-zA-Z0-9.]+@[a-zA-Z0-9.]+$"))',
      });
      const result = checker.analyzeRule(rule);
      expect(result.risk).toBe('medium');
    });

    it('should assign medium risk for ISBLANK rules', () => {
      const rule = makeRule({
        errorConditionFormula: 'ISBLANK(Name)',
      });
      const result = checker.analyzeRule(rule);
      expect(result.risk).toBe('medium');
    });

    it('should assign high risk for REGEX + ISBLANK + cross-object', () => {
      const rule = makeRule({
        errorConditionFormula: 'AND(ISBLANK(Account.Name), NOT(REGEX(Email__c, "^.+@.+$")))',
      });
      const result = checker.analyzeRule(rule);
      // ISBLANK=+3, cross-object=+2, REGEX=+3 → score 8 → high
      expect(result.risk).toBe('high');
    });

    it('should assign low risk for simple PRIORVALUE rules', () => {
      const rule = makeRule({
        errorConditionFormula: 'ISCHANGED(Status__c)',
      });
      const result = checker.analyzeRule(rule);
      expect(result.risk).toBe('low');
    });

    it('should assign higher risk for many logical operators', () => {
      const rule = makeRule({
        errorConditionFormula: 'AND(A__c = 1, OR(B__c = 2, C__c = 3), AND(D__c = 4, E__c = 5))',
      });
      const result = checker.analyzeRule(rule);
      // Many AND/OR operators + multiple fields
      expect(['medium', 'high']).toContain(result.risk);
    });
  });
});
