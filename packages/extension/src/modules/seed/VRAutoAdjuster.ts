import type {
  FieldGenerationConfig,
  FieldGenerationMode,
  VRCheckResult,
  VRFieldConstraint,
} from '@sandforge/shared';

/** Log entry describing a single adjustment made to a field config */
export interface AdjustmentLog {
  /** Field API name that was adjusted */
  fieldName: string;
  /** Validation rule name that triggered the adjustment */
  ruleName: string;
  /** Human-readable description of what was changed */
  action: string;
  /** Generation mode before adjustment */
  previousMode: FieldGenerationMode;
  /** Generation mode after adjustment */
  newMode: FieldGenerationMode;
}

/** Result of auto-adjusting field configs based on VR analysis */
export interface AdjustmentResult {
  /** New field configs with adjustments applied (originals are not mutated) */
  adjustedConfigs: FieldGenerationConfig[];
  /** Log of all adjustments made */
  adjustments: AdjustmentLog[];
  /** Rule names that could not be auto-fixed */
  unresolvedRules: string[];
}

/**
 * Auto-adjusts field generation configs based on validation rule analysis.
 * Reads VRCheckResults with structured VRFieldConstraints and modifies
 * field generation configs so that seeded data satisfies high-risk
 * validation rules.
 *
 * Does NOT mutate input configs -- returns new adjusted copies.
 */
export class VRAutoAdjuster {
  /**
   * Adjust field generation configs based on VR analysis results.
   * Only processes high and medium risk VR results.
   *
   * @param configs - Original field generation configs (not mutated)
   * @param vrResults - Validation rule check results with field constraints
   * @returns Adjusted configs, adjustment log, and unresolved rules
   */
  adjust(
    configs: FieldGenerationConfig[],
    vrResults: VRCheckResult[],
  ): AdjustmentResult {
    // Create mutable copies of all configs
    const configMap = new Map<string, FieldGenerationConfig>();
    for (const config of configs) {
      configMap.set(config.fieldName, { ...config, constraints: { ...config.constraints } });
    }

    const adjustments: AdjustmentLog[] = [];
    const unresolvedRules: string[] = [];

    // Only process high and medium risk rules
    const relevantResults = vrResults.filter(
      (r) => r.risk === 'high' || r.risk === 'medium',
    );

    for (const vrResult of relevantResults) {
      for (const constraint of vrResult.fieldConstraints) {
        this.processConstraint(
          constraint,
          vrResult.ruleName,
          configMap,
          adjustments,
          unresolvedRules,
        );
      }
    }

    return {
      adjustedConfigs: [...configMap.values()],
      adjustments,
      unresolvedRules,
    };
  }

  /**
   * Process a single VR field constraint and adjust the matching config.
   */
  private processConstraint(
    constraint: VRFieldConstraint,
    ruleName: string,
    configMap: Map<string, FieldGenerationConfig>,
    adjustments: AdjustmentLog[],
    unresolvedRules: string[],
  ): void {
    const config = configMap.get(constraint.fieldName);

    switch (constraint.constraintType) {
      case 'required':
        this.handleRequired(constraint, ruleName, config, configMap, adjustments);
        break;
      case 'picklist_value':
        this.handlePicklistValue(constraint, ruleName, config, configMap, adjustments);
        break;
      case 'length':
        this.handleLength(constraint, ruleName, config, adjustments);
        break;
      case 'regex':
        this.handleRegex(constraint, ruleName, unresolvedRules, adjustments, config);
        break;
      case 'cross_field':
        unresolvedRules.push(
          `${ruleName}: cross-field dependency between ${constraint.fieldName} and ${constraint.relatedField ?? 'unknown'}`,
        );
        break;
    }
  }

  /**
   * Handle 'required' constraint: ensure field generates non-null values.
   */
  private handleRequired(
    constraint: VRFieldConstraint,
    ruleName: string,
    config: FieldGenerationConfig | undefined,
    configMap: Map<string, FieldGenerationConfig>,
    adjustments: AdjustmentLog[],
  ): void {
    if (!config) {
      return;
    }

    if (config.generationMode === 'null') {
      const previousMode = config.generationMode;
      // Choose appropriate non-null mode based on field type
      if (config.fieldType === 'string' || config.fieldType === 'textarea') {
        config.generationMode = 'faker';
        config.fakerMethod = 'lorem';
      } else {
        config.generationMode = 'auto';
      }
      config.constraints.required = true;
      configMap.set(config.fieldName, config);

      adjustments.push({
        fieldName: constraint.fieldName,
        ruleName,
        action: `Changed from null to ${config.generationMode} to satisfy required constraint`,
        previousMode,
        newMode: config.generationMode,
      });
    }
  }

  /**
   * Handle 'picklist_value' constraint: ensure field uses the expected value.
   */
  private handlePicklistValue(
    constraint: VRFieldConstraint,
    ruleName: string,
    config: FieldGenerationConfig | undefined,
    configMap: Map<string, FieldGenerationConfig>,
    adjustments: AdjustmentLog[],
  ): void {
    if (!config || !constraint.expectedValue) {
      return;
    }

    const previousMode = config.generationMode;

    if (config.generationMode === 'null') {
      config.generationMode = 'picklist_random';
      config.constraints.picklistValues = [constraint.expectedValue];
      configMap.set(config.fieldName, config);

      adjustments.push({
        fieldName: constraint.fieldName,
        ruleName,
        action: `Changed from null to picklist_random with value "${constraint.expectedValue}"`,
        previousMode,
        newMode: config.generationMode,
      });
    } else if (config.generationMode === 'picklist_random') {
      // Ensure the expected value is in the list
      const values = config.constraints.picklistValues ?? [];
      if (!values.includes(constraint.expectedValue)) {
        config.constraints.picklistValues = [...values, constraint.expectedValue];
        configMap.set(config.fieldName, config);

        adjustments.push({
          fieldName: constraint.fieldName,
          ruleName,
          action: `Added "${constraint.expectedValue}" to picklist values`,
          previousMode,
          newMode: config.generationMode,
        });
      }
    }
  }

  /**
   * Handle 'length' constraint: update min/max length on constraints.
   */
  private handleLength(
    constraint: VRFieldConstraint,
    ruleName: string,
    config: FieldGenerationConfig | undefined,
    adjustments: AdjustmentLog[],
  ): void {
    if (!config) {
      return;
    }

    let changed = false;

    if (constraint.minLength !== undefined) {
      config.constraints.minLength = constraint.minLength;
      changed = true;
    }

    if (constraint.maxLength !== undefined) {
      // Use the more restrictive value
      if (config.constraints.maxLength === undefined || constraint.maxLength < config.constraints.maxLength) {
        config.constraints.maxLength = constraint.maxLength;
        changed = true;
      }
    }

    if (changed) {
      adjustments.push({
        fieldName: constraint.fieldName,
        ruleName,
        action: `Updated length constraints: minLength=${constraint.minLength ?? 'unchanged'}, maxLength=${constraint.maxLength ?? 'unchanged'}`,
        previousMode: config.generationMode,
        newMode: config.generationMode,
      });
    }
  }

  /**
   * Handle 'regex' constraint: attempt to set faker method or mark unresolved.
   */
  private handleRegex(
    constraint: VRFieldConstraint,
    ruleName: string,
    unresolvedRules: string[],
    adjustments: AdjustmentLog[],
    config: FieldGenerationConfig | undefined,
  ): void {
    if (!config || !constraint.regexPattern) {
      return;
    }

    // Simple email pattern detection
    if (constraint.regexPattern.includes('@') && config.fieldType === 'string') {
      const previousMode = config.generationMode;
      config.generationMode = 'faker';
      config.fakerMethod = 'email';

      adjustments.push({
        fieldName: constraint.fieldName,
        ruleName,
        action: `Changed to faker email based on email regex pattern`,
        previousMode,
        newMode: config.generationMode,
      });
      return;
    }

    // Complex regex -- mark as unresolved
    unresolvedRules.push(
      `${ruleName}: regex pattern "${constraint.regexPattern}" on field ${constraint.fieldName} is too complex for auto-fix`,
    );
  }
}
