import type { SeedDataPlan } from '@sandforge/shared';

/** Result of cross-object consistency validation */
export interface ConsistencyResult {
  consistent: boolean;
  issues: ConsistencyIssue[];
}

/** A single consistency issue found between objects */
export interface ConsistencyIssue {
  sourceObject: string;
  targetObject: string;
  field: string;
  message: string;
}

/**
 * Validates cross-object data consistency in a seed operation.
 * Ensures all reference links resolve to existing records
 * and there are no orphaned references.
 */
export class CrossObjectConsistency {
  /**
   * Validate that all reference fields in the generated data
   * point to records that actually exist in the data plan.
   */
  validate(
    plan: SeedDataPlan,
    generatedData: Map<string, Record<string, unknown>[]>
  ): ConsistencyResult {
    const issues: ConsistencyIssue[] = [];

    const availableIds = buildAvailableIdMap(generatedData);

    for (const planObj of plan.objects) {
      for (const dep of planObj.dependsOn) {
        validateDependencyExists(planObj.objectApiName, dep, generatedData, issues);
      }

      const records = generatedData.get(planObj.objectApiName);
      if (!records || records.length === 0) {
        continue;
      }

      validateReferenceLinks(
        planObj.objectApiName,
        records,
        plan,
        availableIds,
        issues
      );
    }

    return {
      consistent: issues.length === 0,
      issues,
    };
  }
}

/** Build a set of known IDs per object from generated data */
function buildAvailableIdMap(
  generatedData: Map<string, Record<string, unknown>[]>
): Map<string, Set<string>> {
  const idMap = new Map<string, Set<string>>();

  for (const [objectName, records] of generatedData) {
    const ids = new Set<string>();
    for (const record of records) {
      const id = record['Id'];
      if (typeof id === 'string') {
        ids.add(id);
      }
    }
    idMap.set(objectName, ids);
  }

  return idMap;
}

/** Validate that a dependency object has generated data */
function validateDependencyExists(
  sourceObject: string,
  targetObject: string,
  generatedData: Map<string, Record<string, unknown>[]>,
  issues: ConsistencyIssue[]
): void {
  const targetRecords = generatedData.get(targetObject);
  if (!targetRecords || targetRecords.length === 0) {
    issues.push({
      sourceObject,
      targetObject,
      field: '',
      message: `Dependency "${targetObject}" has no generated records`,
    });
  }
}

/**
 * Validate that reference field values in records point to
 * existing IDs in the target object's data.
 */
function validateReferenceLinks(
  objectName: string,
  records: Record<string, unknown>[],
  plan: SeedDataPlan,
  availableIds: Map<string, Set<string>>,
  issues: ConsistencyIssue[]
): void {
  const planObj = plan.objects.find((o) => o.objectApiName === objectName);
  if (!planObj) {
    return;
  }

  for (const depObject of planObj.dependsOn) {
    const targetIds = availableIds.get(depObject);

    for (const record of records) {
      const referenceFields = findReferenceFieldsForTarget(record, depObject);
      for (const [field, value] of referenceFields) {
        if (typeof value === 'string') {
          if (!targetIds || targetIds.size === 0 || !targetIds.has(value)) {
            issues.push({
              sourceObject: objectName,
              targetObject: depObject,
              field,
              message: `Reference "${value}" not found in "${depObject}" records`,
            });
          }
        }
      }
    }
  }
}

/**
 * Find fields in a record that could be references to the target object.
 * Looks for fields ending with 'Id' whose value is a string.
 */
function findReferenceFieldsForTarget(
  record: Record<string, unknown>,
  _targetObject: string
): Array<[string, unknown]> {
  const candidates: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith('Id') && typeof value === 'string' && key !== 'Id' && key !== 'RecordTypeId') {
      candidates.push([key, value]);
    }
  }

  return candidates;
}
