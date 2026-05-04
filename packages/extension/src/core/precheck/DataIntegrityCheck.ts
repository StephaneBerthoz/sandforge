import type { PreCheckConfig, PreCheckItem } from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Data integrity information for the operation */
export interface DataIntegrityInfo {
  lookupTargets: LookupTargetInfo[];
  uniqueFieldConflicts: UniqueFieldConflictInfo[];
  invalidPicklistValues: PicklistValidationInfo[];
  externalIdFields: ExternalIdFieldInfo[];
}

/** Lookup target existence check */
export interface LookupTargetInfo {
  objectApiName: string;
  fieldApiName: string;
  referencedObject: string;
  missingTargetCount: number;
  totalReferenceCount: number;
}

/** Unique field conflict info */
export interface UniqueFieldConflictInfo {
  objectApiName: string;
  fieldApiName: string;
  conflictCount: number;
}

/** Picklist validation info */
export interface PicklistValidationInfo {
  objectApiName: string;
  fieldApiName: string;
  invalidValues: string[];
}

/** External ID field availability */
export interface ExternalIdFieldInfo {
  objectApiName: string;
  fieldApiName: string;
  isExternalId: boolean;
  isUnique: boolean;
}

/** Dependency: fetches data integrity information for the operation */
export type FetchDataInfoFn = (
  orgId: string,
  operationConfig: Record<string, unknown>,
) => Promise<DataIntegrityInfo>;

/**
 * Checks data integrity aspects including lookup target existence,
 * unique field conflicts, picklist value validity, and External ID availability.
 */
export class DataIntegrityCheck {
  private readonly fetchDataInfo: FetchDataInfoFn;

  constructor(fetchDataInfo: FetchDataInfoFn) {
    this.fetchDataInfo = fetchDataInfo;
  }

  /** Run all data integrity checks */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const info = await this.fetchDataInfo(config.targetOrgId, config.operationConfig);
    const items: PreCheckItem[] = [];

    items.push(...this.checkLookupTargets(info.lookupTargets));
    items.push(...this.checkUniqueFieldConflicts(info.uniqueFieldConflicts));
    items.push(...this.checkPicklistValues(info.invalidPicklistValues));
    items.push(...this.checkExternalIdFields(info.externalIdFields));

    return items;
  }

  /** Check that lookup targets exist in the target org */
  private checkLookupTargets(targets: LookupTargetInfo[]): PreCheckItem[] {
    return targets.map((target) => {
      const passed = target.missingTargetCount === 0;

      return {
        id: randomUUID(),
        category: 'data_integrity' as const,
        name: `Lookup targets for ${target.objectApiName}.${target.fieldApiName}`,
        description: `Verifies referenced ${target.referencedObject} records exist`,
        severity: passed ? ('info' as const) : ('error' as const),
        passed,
        message: passed
          ? `All ${target.totalReferenceCount} lookup targets exist for ${target.objectApiName}.${target.fieldApiName}`
          : `${target.missingTargetCount} of ${target.totalReferenceCount} lookup targets missing for ${target.objectApiName}.${target.fieldApiName}`,
        details: { ...target } as unknown as Record<string, unknown>,
        autoFixable: false,
      };
    });
  }

  /** Check for unique field value conflicts */
  private checkUniqueFieldConflicts(conflicts: UniqueFieldConflictInfo[]): PreCheckItem[] {
    return conflicts.map((conflict) => {
      const passed = conflict.conflictCount === 0;

      return {
        id: randomUUID(),
        category: 'data_integrity' as const,
        name: `Unique field conflicts on ${conflict.objectApiName}.${conflict.fieldApiName}`,
        description: `Checks for duplicate values on unique field ${conflict.fieldApiName}`,
        severity: passed ? ('info' as const) : ('error' as const),
        passed,
        message: passed
          ? `No unique field conflicts on ${conflict.objectApiName}.${conflict.fieldApiName}`
          : `${conflict.conflictCount} unique field conflict(s) on ${conflict.objectApiName}.${conflict.fieldApiName}`,
        details: { ...conflict } as unknown as Record<string, unknown>,
        autoFixable: false,
      };
    });
  }

  /** Check that picklist values are valid in the target org */
  private checkPicklistValues(validations: PicklistValidationInfo[]): PreCheckItem[] {
    return validations.map((validation) => {
      const passed = validation.invalidValues.length === 0;

      return {
        id: randomUUID(),
        category: 'data_integrity' as const,
        name: `Picklist values for ${validation.objectApiName}.${validation.fieldApiName}`,
        description: `Validates picklist values on ${validation.fieldApiName}`,
        severity: passed ? ('info' as const) : ('warning' as const),
        passed,
        message: passed
          ? `All picklist values valid on ${validation.objectApiName}.${validation.fieldApiName}`
          : `Invalid picklist values on ${validation.objectApiName}.${validation.fieldApiName}: ${validation.invalidValues.join(', ')}`,
        details: { ...validation } as unknown as Record<string, unknown>,
        autoFixable: false,
      };
    });
  }

  /** Check External ID field availability for upsert operations */
  private checkExternalIdFields(fields: ExternalIdFieldInfo[]): PreCheckItem[] {
    return fields.map((field) => {
      const passed = field.isExternalId;

      return {
        id: randomUUID(),
        category: 'data_integrity' as const,
        name: `External ID on ${field.objectApiName}.${field.fieldApiName}`,
        description: `Checks if ${field.fieldApiName} is configured as External ID`,
        severity: passed ? ('info' as const) : ('error' as const),
        passed,
        message: passed
          ? `${field.objectApiName}.${field.fieldApiName} is a valid External ID (unique: ${field.isUnique})`
          : `${field.objectApiName}.${field.fieldApiName} is not an External ID field`,
        details: { ...field } as unknown as Record<string, unknown>,
        autoFixable: false,
      };
    });
  }
}
