import { describe, it, expect } from 'vitest';
import { VRAutoAdjuster } from './VRAutoAdjuster';
import type { FieldGenerationConfig, VRCheckResult } from '@sandforge/shared';

function makeConfig(overrides: Partial<FieldGenerationConfig> = {}): FieldGenerationConfig {
  return {
    fieldName: 'TestField',
    fieldType: 'string',
    generationMode: 'null',
    constraints: { required: false, unique: false },
    ...overrides,
  };
}

function makeVRResult(overrides: Partial<VRCheckResult> = {}): VRCheckResult {
  return {
    ruleName: 'TestRule',
    objectName: 'Account',
    formula: 'ISBLANK(TestField)',
    errorMessage: 'Field required',
    potentialConflicts: ['TestField'],
    risk: 'high',
    fieldConstraints: [],
    ...overrides,
  };
}

describe('VRAutoAdjuster', () => {
  const adjuster = new VRAutoAdjuster();

  it('should adjust null field to auto/faker for high-risk ISBLANK rule', () => {
    const configs = [makeConfig({ fieldName: 'Phone', fieldType: 'phone' })];
    const vrResults = [
      makeVRResult({
        ruleName: 'Account.RequirePhone',
        risk: 'high',
        fieldConstraints: [{ fieldName: 'Phone', constraintType: 'required' }],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Phone');
    expect(adjusted).toBeDefined();
    expect(adjusted?.generationMode).toBe('auto');
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].previousMode).toBe('null');
    expect(result.adjustments[0].newMode).toBe('auto');
  });

  it('should adjust null string field to faker lorem for required constraint', () => {
    const configs = [makeConfig({ fieldName: 'Name', fieldType: 'string' })];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [{ fieldName: 'Name', constraintType: 'required' }],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Name');
    expect(adjusted?.generationMode).toBe('faker');
    expect(adjusted?.fakerMethod).toBe('lorem');
  });

  it('should set picklist_random with expected value for ISPICKVAL rule', () => {
    const configs = [
      makeConfig({
        fieldName: 'Status',
        fieldType: 'picklist',
        generationMode: 'null',
      }),
    ];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [
          {
            fieldName: 'Status',
            constraintType: 'picklist_value',
            expectedValue: 'Active',
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Status');
    expect(adjusted?.generationMode).toBe('picklist_random');
    expect(adjusted?.constraints.picklistValues).toEqual(['Active']);
  });

  it('should add expected value to existing picklist_random values', () => {
    const configs = [
      makeConfig({
        fieldName: 'Status',
        fieldType: 'picklist',
        generationMode: 'picklist_random',
        constraints: { required: false, unique: false, picklistValues: ['Open', 'Closed'] },
      }),
    ];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [
          {
            fieldName: 'Status',
            constraintType: 'picklist_value',
            expectedValue: 'Active',
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Status');
    expect(adjusted?.constraints.picklistValues).toContain('Active');
    expect(adjusted?.constraints.picklistValues).toContain('Open');
    expect(adjusted?.constraints.picklistValues).toContain('Closed');
  });

  it('should update length constraints', () => {
    const configs = [
      makeConfig({
        fieldName: 'Code',
        fieldType: 'string',
        generationMode: 'faker',
        constraints: { required: false, unique: false, maxLength: 100 },
      }),
    ];
    const vrResults = [
      makeVRResult({
        risk: 'medium',
        fieldConstraints: [
          {
            fieldName: 'Code',
            constraintType: 'length',
            minLength: 6,
            maxLength: 20,
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Code');
    expect(adjusted?.constraints.minLength).toBe(6);
    expect(adjusted?.constraints.maxLength).toBe(20);
  });

  it('should ignore low-risk rules', () => {
    const configs = [makeConfig({ fieldName: 'Phone' })];
    const vrResults = [
      makeVRResult({
        risk: 'low',
        fieldConstraints: [{ fieldName: 'Phone', constraintType: 'required' }],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Phone');
    expect(adjusted?.generationMode).toBe('null');
    expect(result.adjustments).toHaveLength(0);
  });

  it('should not mutate original configs', () => {
    const original = makeConfig({ fieldName: 'Phone', fieldType: 'phone' });
    Object.freeze(original);
    Object.freeze(original.constraints);

    const configs = [original];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [{ fieldName: 'Phone', constraintType: 'required' }],
      }),
    ];

    // Should not throw even though original is frozen
    const result = adjuster.adjust(configs, vrResults);
    expect(result.adjustedConfigs[0].generationMode).toBe('auto');
    // Original should still be null
    expect(original.generationMode).toBe('null');
  });

  it('should report cross_field constraints as unresolved', () => {
    const configs = [makeConfig({ fieldName: 'Type' })];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [
          {
            fieldName: 'Type',
            constraintType: 'cross_field',
            relatedField: 'SubType',
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    expect(result.unresolvedRules).toHaveLength(1);
    expect(result.unresolvedRules[0]).toContain('cross-field');
    expect(result.unresolvedRules[0]).toContain('SubType');
  });

  it('should report complex regex as unresolved', () => {
    const configs = [
      makeConfig({
        fieldName: 'Code',
        fieldType: 'string',
        generationMode: 'faker',
      }),
    ];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [
          {
            fieldName: 'Code',
            constraintType: 'regex',
            regexPattern: '^[A-Z]{3}-\\d{4}$',
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    expect(result.unresolvedRules).toHaveLength(1);
    expect(result.unresolvedRules[0]).toContain('regex');
  });

  it('should handle simple email regex by setting faker email', () => {
    const configs = [
      makeConfig({
        fieldName: 'Email',
        fieldType: 'string',
        generationMode: 'faker',
        fakerMethod: 'lorem',
      }),
    ];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [
          {
            fieldName: 'Email',
            constraintType: 'regex',
            regexPattern: '^[a-z]+@[a-z]+\\.[a-z]+$',
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Email');
    expect(adjusted?.fakerMethod).toBe('email');
    expect(result.adjustments).toHaveLength(1);
  });

  it('should have correct before/after modes in adjustment log', () => {
    const configs = [
      makeConfig({
        fieldName: 'Status',
        fieldType: 'picklist',
        generationMode: 'null',
      }),
    ];
    const vrResults = [
      makeVRResult({
        risk: 'high',
        fieldConstraints: [
          {
            fieldName: 'Status',
            constraintType: 'picklist_value',
            expectedValue: 'Active',
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].previousMode).toBe('null');
    expect(result.adjustments[0].newMode).toBe('picklist_random');
  });

  it('should handle multiple VR results on same field (last wins)', () => {
    const configs = [
      makeConfig({
        fieldName: 'Phone',
        fieldType: 'string',
        generationMode: 'null',
      }),
    ];
    const vrResults = [
      makeVRResult({
        ruleName: 'Rule1',
        risk: 'high',
        fieldConstraints: [{ fieldName: 'Phone', constraintType: 'required' }],
      }),
      makeVRResult({
        ruleName: 'Rule2',
        risk: 'high',
        fieldConstraints: [
          {
            fieldName: 'Phone',
            constraintType: 'length',
            minLength: 10,
          },
        ],
      }),
    ];

    const result = adjuster.adjust(configs, vrResults);
    const adjusted = result.adjustedConfigs.find((c) => c.fieldName === 'Phone');
    // First rule changes null -> faker/auto, second adds length constraint
    expect(adjusted?.generationMode).not.toBe('null');
    expect(adjusted?.constraints.minLength).toBe(10);
    expect(result.adjustments.length).toBeGreaterThanOrEqual(2);
  });
});
