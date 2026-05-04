import type {
  SeedTemplate,
  SeedDataPlan,
  SeedDataPlanObject,
  SeedObjectConfig,
  FieldRule,
} from '@sandforge/shared';

/** Threshold above which grappe mode is recommended */
const GRAPPE_THRESHOLD = 10000;

/** Average milliseconds per API call for duration estimation */
const MS_PER_API_CALL = 150;

/** Default batch size if object config does not specify one */
const DEFAULT_BATCH_SIZE = 200;

/**
 * Builds an execution plan (preview) for a seed template.
 * Calculates total records, estimated API calls, duration,
 * generates sample records, and resolves dependency ordering.
 */
export class DataPlanBuilder {
  /**
   * Build a data plan from a seed template.
   * Resolves insert order based on reference dependencies,
   * generates sample records, and estimates execution parameters.
   */
  build(template: SeedTemplate): SeedDataPlan {
    const sortedObjects = resolveInsertOrder(template.objects);
    const totalRecords = calculateTotalRecords(sortedObjects);
    const estimatedApiCalls = calculateApiCalls(sortedObjects);
    const estimatedDuration = estimatedApiCalls * MS_PER_API_CALL;
    const grappeRecommended = totalRecords > GRAPPE_THRESHOLD;

    const objects: SeedDataPlanObject[] = sortedObjects.map((obj) => ({
      objectApiName: obj.objectApiName,
      recordCount: obj.recordCount,
      sampleRecords: generateSampleRecords(obj, 3),
      dependsOn: extractDependencies(obj),
    }));

    return {
      objects,
      totalRecords,
      estimatedApiCalls,
      estimatedDuration,
      grappeRecommended,
    };
  }
}

/** Calculate total number of records across all objects */
function calculateTotalRecords(objects: SeedObjectConfig[]): number {
  return objects.reduce((sum, obj) => sum + obj.recordCount, 0);
}

/** Calculate estimated API calls based on record counts and batch sizes */
function calculateApiCalls(objects: SeedObjectConfig[]): number {
  return objects.reduce((sum, obj) => {
    const batchSize = obj.batchSize > 0 ? obj.batchSize : DEFAULT_BATCH_SIZE;
    return sum + Math.ceil(obj.recordCount / batchSize);
  }, 0);
}

/** Extract object names this object depends on via reference field rules */
function extractDependencies(obj: SeedObjectConfig): string[] {
  const deps = new Set<string>();
  for (const rule of obj.fieldRules) {
    if (rule.ruleType === 'reference' && rule.config.referenceObject) {
      deps.add(rule.config.referenceObject);
    }
  }
  return Array.from(deps);
}

/**
 * Generate sample records for preview.
 * Creates simplified values based on field rule types.
 */
function generateSampleRecords(
  obj: SeedObjectConfig,
  sampleCount: number,
): Record<string, unknown>[] {
  const count = Math.min(sampleCount, obj.recordCount);
  const records: Record<string, unknown>[] = [];

  for (let i = 0; i < count; i++) {
    const record: Record<string, unknown> = {};
    for (const rule of obj.fieldRules) {
      record[rule.fieldApiName] = generateSampleValue(rule, i);
    }
    records.push(record);
  }

  return records;
}

/** Generate a single sample value for preview based on field rule type */
function generateSampleValue(rule: FieldRule, index: number): unknown {
  switch (rule.ruleType) {
    case 'static':
      return rule.config.staticValue ?? null;
    case 'sequence': {
      const start = rule.config.sequenceStart ?? 1;
      const step = rule.config.sequenceStep ?? 1;
      const prefix = rule.config.sequencePrefix ?? '';
      return `${prefix}${start + index * step}`;
    }
    case 'picklist_random':
      if (rule.config.picklistValues && rule.config.picklistValues.length > 0) {
        return rule.config.picklistValues[index % rule.config.picklistValues.length];
      }
      return null;
    case 'reference':
      return `[ref:${rule.config.referenceObject ?? 'unknown'}]`;
    case 'faker':
      return `[faker:${rule.config.fakerMethod ?? 'lorem'}]`;
    case 'ai_generate':
      return `[ai:${rule.config.aiPrompt ?? 'generated'}]`;
    case 'random':
      return `sample_${index}`;
    case 'formula':
      return `[formula:${rule.config.formula ?? ''}]`;
    case 'regex':
      return `[regex:${rule.config.regexPattern ?? ''}]`;
    case 'from_csv':
      return `[csv:${rule.config.csvColumn ?? ''}]`;
    default:
      return null;
  }
}

/**
 * Resolve the correct insert order using topological sort
 * based on reference dependencies between objects.
 */
export function resolveInsertOrder(objects: SeedObjectConfig[]): SeedObjectConfig[] {
  const objectMap = new Map<string, SeedObjectConfig>();
  for (const obj of objects) {
    objectMap.set(obj.objectApiName, obj);
  }

  const visited = new Set<string>();
  const sorted: SeedObjectConfig[] = [];

  function visit(name: string): void {
    if (visited.has(name)) {
      return;
    }
    visited.add(name);

    const obj = objectMap.get(name);
    if (!obj) {
      return;
    }

    const deps = extractDependencies(obj);
    for (const dep of deps) {
      visit(dep);
    }

    sorted.push(obj);
  }

  for (const obj of objects) {
    visit(obj.objectApiName);
  }

  return sorted;
}
