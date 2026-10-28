import type {
  SeedTemplate,
  SeedDataPlan,
  SeedDataPlanObject,
  SeedObjectConfig,
  SeedRelation,
  FieldRule,
} from '@sandforge/shared';
import { relationFor, seedDependencies } from '@sandforge/shared';

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
    const relations = template.relations ?? [];
    const sortedObjects = resolveInsertOrder(template.objects, relations);
    const totalRecords = calculateTotalRecords(sortedObjects);
    const estimatedApiCalls = calculateApiCalls(sortedObjects);
    const estimatedDuration = estimatedApiCalls * MS_PER_API_CALL;
    const grappeRecommended = totalRecords > GRAPPE_THRESHOLD;

    const objects: SeedDataPlanObject[] = sortedObjects.map((obj) => ({
      objectApiName: obj.objectApiName,
      recordCount: obj.recordCount,
      sampleRecords: generateSampleRecords(obj, 3, relationFor(obj.objectApiName, relations)),
      dependsOn: seedDependencies(obj, relations),
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

/**
 * Generate sample records for preview.
 * Creates simplified values based on field rule types. An object of rows
 * shows its first rows' values as they are given, over what its rules would
 * fill, and the lookup a relation by key fills as the parent row it names.
 */
function generateSampleRecords(
  obj: SeedObjectConfig,
  sampleCount: number,
  relation?: SeedRelation,
): Record<string, unknown>[] {
  const count = Math.min(sampleCount, obj.recordCount);
  const records: Record<string, unknown>[] = [];

  for (let i = 0; i < count; i++) {
    const record: Record<string, unknown> = {};
    for (const rule of obj.fieldRules) {
      record[rule.fieldApiName] = generateSampleValue(rule, i);
    }
    const row = obj.rows?.[i];
    if (row) {
      Object.assign(record, row.values);
      if (relation?.distribution.mode === 'byKey' && row.parentKey !== undefined) {
        record[relation.lookupField] = `[key:${row.parentKey}]`;
      }
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
 * Resolve the correct insert order using topological sort based on the
 * dependencies between objects: their reference rules, and the parent of a
 * relation whose parents this run writes — a child placed by key is written
 * after the rows it is placed under.
 */
export function resolveInsertOrder(
  objects: SeedObjectConfig[],
  relations: readonly SeedRelation[] = [],
): SeedObjectConfig[] {
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

    const deps = seedDependencies(obj, relations);
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
