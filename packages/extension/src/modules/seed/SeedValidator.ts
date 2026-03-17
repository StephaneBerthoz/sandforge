import type { SeedTemplate, SeedObjectConfig, FieldRule, FieldRuleType } from '@sandforge/shared';

/** Result of a seed template validation */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

/** A single validation error or warning */
export interface ValidationError {
  field: string;
  message: string;
}

/** All valid field rule types for validation checks */
const VALID_RULE_TYPES: ReadonlySet<FieldRuleType> = new Set<FieldRuleType>([
  'static', 'random', 'sequence', 'formula', 'reference',
  'picklist_random', 'ai_generate', 'faker', 'regex', 'from_csv',
]);

/**
 * Validates seed templates before execution.
 * Checks structural integrity, field rule validity, reference targets,
 * circular dependencies, and record count constraints.
 */
export class SeedValidator {
  /**
   * Validate a seed template and return errors and warnings.
   * The template is considered valid only when there are zero errors.
   */
  validate(template: SeedTemplate): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    validateTemplateName(template, errors);
    validateObjects(template, errors, warnings);
    validateReferenceTargets(template, errors);
    validateCircularDependencies(template, errors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

/** Validate that the template has a non-empty name */
function validateTemplateName(
  template: SeedTemplate,
  errors: ValidationError[]
): void {
  if (!template.name || template.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Template name is required' });
  }
}

/** Validate the objects array and each object's configuration */
function validateObjects(
  template: SeedTemplate,
  errors: ValidationError[],
  warnings: ValidationError[]
): void {
  if (!template.objects || template.objects.length === 0) {
    errors.push({ field: 'objects', message: 'Template must have at least one object' });
    return;
  }

  for (const obj of template.objects) {
    validateObjectConfig(obj, errors, warnings);
  }
}

/** Validate a single object configuration */
function validateObjectConfig(
  obj: SeedObjectConfig,
  errors: ValidationError[],
  warnings: ValidationError[]
): void {
  const prefix = `objects[${obj.objectApiName}]`;

  if (!obj.objectApiName || obj.objectApiName.trim().length === 0) {
    errors.push({ field: prefix, message: 'Object API name is required' });
  }

  if (obj.recordCount <= 0) {
    errors.push({
      field: `${prefix}.recordCount`,
      message: 'Record count must be positive',
    });
  }

  if (obj.recordCount > 100000) {
    warnings.push({
      field: `${prefix}.recordCount`,
      message: 'Record count exceeds 100,000 — consider using grappe mode',
    });
  }

  if (obj.batchSize <= 0) {
    errors.push({
      field: `${prefix}.batchSize`,
      message: 'Batch size must be positive',
    });
  }

  for (const rule of obj.fieldRules) {
    validateFieldRule(rule, prefix, errors);
  }
}

/** Validate a single field rule */
function validateFieldRule(
  rule: FieldRule,
  parentPrefix: string,
  errors: ValidationError[]
): void {
  const prefix = `${parentPrefix}.fieldRules[${rule.fieldApiName}]`;

  if (!rule.fieldApiName || rule.fieldApiName.trim().length === 0) {
    errors.push({ field: prefix, message: 'Field API name is required' });
  }

  if (!VALID_RULE_TYPES.has(rule.ruleType)) {
    errors.push({
      field: `${prefix}.ruleType`,
      message: `Invalid rule type: ${rule.ruleType}`,
    });
  }

  validateRuleConfig(rule, prefix, errors);
}

/** Validate rule-specific configuration requirements */
function validateRuleConfig(
  rule: FieldRule,
  prefix: string,
  errors: ValidationError[]
): void {
  switch (rule.ruleType) {
    case 'reference':
      if (!rule.config.referenceObject) {
        errors.push({
          field: `${prefix}.config.referenceObject`,
          message: 'Reference rule requires a referenceObject',
        });
      }
      break;

    case 'picklist_random':
      if (!rule.config.picklistValues || rule.config.picklistValues.length === 0) {
        errors.push({
          field: `${prefix}.config.picklistValues`,
          message: 'Picklist rule requires at least one value',
        });
      }
      break;

    case 'faker':
      if (!rule.config.fakerMethod) {
        errors.push({
          field: `${prefix}.config.fakerMethod`,
          message: 'Faker rule requires a fakerMethod',
        });
      }
      break;

    case 'regex':
      if (!rule.config.regexPattern) {
        errors.push({
          field: `${prefix}.config.regexPattern`,
          message: 'Regex rule requires a regexPattern',
        });
      }
      break;

    case 'from_csv':
      if (!rule.config.csvColumn) {
        errors.push({
          field: `${prefix}.config.csvColumn`,
          message: 'CSV rule requires a csvColumn',
        });
      }
      break;
  }
}

/** Validate that all reference targets exist as objects in the template */
function validateReferenceTargets(
  template: SeedTemplate,
  errors: ValidationError[]
): void {
  const objectNames = new Set(template.objects.map((o) => o.objectApiName));

  for (const obj of template.objects) {
    for (const rule of obj.fieldRules) {
      if (rule.ruleType === 'reference' && rule.config.referenceObject) {
        if (!objectNames.has(rule.config.referenceObject)) {
          errors.push({
            field: `objects[${obj.objectApiName}].fieldRules[${rule.fieldApiName}]`,
            message: `Reference target "${rule.config.referenceObject}" is not in the template`,
          });
        }
      }
    }
  }
}

/** Detect circular dependencies in reference chains */
function validateCircularDependencies(
  template: SeedTemplate,
  errors: ValidationError[]
): void {
  const adjacency = new Map<string, string[]>();

  for (const obj of template.objects) {
    const deps: string[] = [];
    for (const rule of obj.fieldRules) {
      if (rule.ruleType === 'reference' && rule.config.referenceObject) {
        deps.push(rule.config.referenceObject);
      }
    }
    adjacency.set(obj.objectApiName, deps);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function hasCycle(node: string): boolean {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }

    visiting.add(node);
    const neighbors = adjacency.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (hasCycle(neighbor)) {
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }

  for (const obj of template.objects) {
    if (hasCycle(obj.objectApiName)) {
      errors.push({
        field: `objects[${obj.objectApiName}]`,
        message: 'Circular dependency detected',
      });
      break;
    }
  }
}
