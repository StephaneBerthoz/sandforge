import {
  SEED_RELATION_LIMITS,
  acceptsGeneratedSentence,
  relationFor,
  resolveFakerMethod,
  seedDependencies,
} from '@sandforge/shared';
import type {
  SeedTemplate,
  SeedObjectConfig,
  SeedRelation,
  FieldRule,
  FieldRuleType,
} from '@sandforge/shared';

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
  'static',
  'random',
  'sequence',
  'formula',
  'reference',
  'picklist_random',
  'ai_generate',
  'faker',
  'regex',
  'from_csv',
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
    validateRelations(template, errors);
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
function validateTemplateName(template: SeedTemplate, errors: ValidationError[]): void {
  if (!template.name || template.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Template name is required' });
  }
}

/** Validate the objects array and each object's configuration */
function validateObjects(
  template: SeedTemplate,
  errors: ValidationError[],
  warnings: ValidationError[],
): void {
  if (!template.objects || template.objects.length === 0) {
    errors.push({ field: 'objects', message: 'Template must have at least one object' });
    return;
  }

  for (const obj of template.objects) {
    validateObjectConfig(obj, errors, warnings, relationFor(obj.objectApiName, template.relations));
  }
}

/** Validate a single object configuration */
function validateObjectConfig(
  obj: SeedObjectConfig,
  errors: ValidationError[],
  warnings: ValidationError[],
  relation: SeedRelation | undefined,
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

  // A request to write records with no fields cannot be satisfied:
  // `FieldMapper.mapFields` answers an empty list for it, and the run then
  // reports "success, 0 created" — a silent no-op, which is the worst of the
  // answers available. Run against a real org, asking for five accounts this
  // way wrote nothing and said it had succeeded. A relation fills a lookup of
  // the object, which is a field to fill.
  if (obj.recordCount > 0 && obj.fieldRules.length === 0 && !relation) {
    errors.push({
      field: `${prefix}.fieldRules`,
      message: `${obj.objectApiName} asks for ${obj.recordCount} record(s) and names no field to fill: add at least one field rule`,
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
function validateFieldRule(rule: FieldRule, parentPrefix: string, errors: ValidationError[]): void {
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
function validateRuleConfig(rule: FieldRule, prefix: string, errors: ValidationError[]): void {
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
      } else if (!resolveFakerMethod(rule.config.fakerMethod)) {
        // Refused here, before the first object is inserted: the generator
        // would throw only when it reached this object, after the objects
        // ahead of it had already been written to the org.
        errors.push({
          field: `${prefix}.config.fakerMethod`,
          message:
            `Faker method "${rule.config.fakerMethod}" in ${prefix} is not implemented: ` +
            'choose a method SandForge generates. No record was written.',
        });
      }
      break;

    case 'ai_generate':
      // A field the AI call leaves empty is filled with a generated sentence,
      // which a number, date, boolean, email or picklist field cannot hold.
      if (rule.fieldType !== undefined && !acceptsGeneratedSentence(rule.fieldType)) {
        errors.push({
          field: `${prefix}.ruleType`,
          message:
            `AI generation in ${prefix} writes text, which a "${rule.fieldType}" field cannot hold: ` +
            'choose another rule for this field. No record was written.',
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

/**
 * Check each relation against the template it belongs to. A relation the run
 * cannot honour is refused before the first insert: found on the way, its
 * child object would be skipped after its parents had been written.
 */
function validateRelations(template: SeedTemplate, errors: ValidationError[]): void {
  const objectNames = new Set(template.objects.map((o) => o.objectApiName));
  const children = new Set<string>();

  for (const relation of template.relations ?? []) {
    const { childObject: child, lookupField: lookup, parentObject: parent } = relation;
    const field = `relations[${child}.${lookup}]`;

    if (!objectNames.has(child)) {
      errors.push({
        field,
        message: `The relation on ${child}.${lookup} fills an object the template does not write`,
      });
    }
    if (children.has(child)) {
      // Each relation decides how many records its child gets; two would
      // each claim the count.
      errors.push({
        field,
        message:
          `${child} has more than one relation: an object takes its record count from one ` +
          'relation, so keep one and let the other lookup draw from its field rule',
      });
    }
    children.add(child);

    if (relation.parents.kind === 'generated') {
      if (parent === child) {
        errors.push({
          field,
          message:
            `${child} records cannot point at ${child} records written by the same insert: draw ` +
            'the parents from records already in the org',
        });
      } else if (!objectNames.has(parent)) {
        errors.push({
          field,
          message: `The relation draws ${child}'s parents from the ${parent} records this run writes, and the template writes none`,
        });
      }
    } else if (
      !isWholeNumberIn(relation.parents.limit, 1, SEED_RELATION_LIMITS.maxExistingParents)
    ) {
      errors.push({
        field: `${field}.parents.limit`,
        message: `The relation on ${child}.${lookup} reads between 1 and ${SEED_RELATION_LIMITS.maxExistingParents} existing ${parent} records`,
      });
    }

    if (!isUsableDistribution(relation.distribution)) {
      errors.push({
        field: `${field}.distribution`,
        message: `The relation on ${child}.${lookup} gives each ${parent} a number of children it cannot use`,
      });
    }
  }
}

/** Whether `value` is a whole number from `min` to `max`. */
function isWholeNumberIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Whether a distribution gives each parent a number of children the run can write. */
function isUsableDistribution(distribution: SeedRelation['distribution']): boolean {
  const most = SEED_RELATION_LIMITS.maxPerParent;
  switch (distribution.mode) {
    case 'perParent':
      return isWholeNumberIn(distribution.count, 1, most);
    case 'range':
      return (
        isWholeNumberIn(distribution.min, 0, most) &&
        isWholeNumberIn(distribution.max, 1, most) &&
        distribution.min <= distribution.max
      );
    case 'ratio':
      return (
        Number.isFinite(distribution.ratio) &&
        distribution.ratio >= SEED_RELATION_LIMITS.minRatio &&
        distribution.ratio <= most
      );
    default:
      return false;
  }
}

/**
 * Validate that all reference targets exist as objects in the template. A
 * rule on a lookup a relation fills is the relation's to answer.
 */
function validateReferenceTargets(template: SeedTemplate, errors: ValidationError[]): void {
  const objectNames = new Set(template.objects.map((o) => o.objectApiName));

  for (const obj of template.objects) {
    const relation = relationFor(obj.objectApiName, template.relations);
    for (const rule of obj.fieldRules) {
      if (relation && rule.fieldApiName === relation.lookupField) continue;
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

/** Detect circular dependencies in reference chains and relations */
function validateCircularDependencies(template: SeedTemplate, errors: ValidationError[]): void {
  const adjacency = new Map<string, string[]>();

  for (const obj of template.objects) {
    adjacency.set(obj.objectApiName, seedDependencies(obj, template.relations));
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
