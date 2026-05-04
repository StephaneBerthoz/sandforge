/**
 * ForgeMetadataDiff compares source and target org schemas for field-level compatibility.
 * Identifies missing fields, type mismatches, and permission issues before execution.
 */

/** Field descriptor returned by org metadata describe. */
export interface DescribedField {
  /** Field API name. */
  name: string;
  /** Salesforce field type. */
  type: string;
  /** Whether the field is createable (can be set on insert). */
  createable: boolean;
}

/** Dependencies for ForgeMetadataDiff. */
export interface MetadataDiffDeps {
  /** Describe an object's fields in a given org. */
  describeObject: (orgId: string, objectApiName: string) => Promise<{ fields: DescribedField[] }>;
}

/** A single metadata diff entry. */
export interface MetadataDiffEntry {
  /** Object API name. */
  objectApiName: string;
  /** Field API name. */
  fieldApiName: string;
  /** Type of issue. */
  issue: 'missing' | 'type_mismatch' | 'permission_denied';
  /** Severity level. */
  severity: 'info' | 'warning' | 'error';
  /** Human-readable description. */
  details: string;
}

/**
 * Compares source and target org schemas for field-level compatibility.
 */
export class ForgeMetadataDiff {
  private readonly deps: MetadataDiffDeps;

  constructor(deps: MetadataDiffDeps) {
    this.deps = deps;
  }

  /**
   * Compare schemas for a list of objects between source and target orgs.
   *
   * @param sourceOrgId - Source Salesforce org identifier.
   * @param targetOrgId - Target Salesforce org identifier.
   * @param objectApiNames - Objects to compare.
   * @returns Array of diff entries describing incompatibilities.
   */
  async compare(
    sourceOrgId: string,
    targetOrgId: string,
    objectApiNames: string[],
  ): Promise<MetadataDiffEntry[]> {
    const diffs: MetadataDiffEntry[] = [];

    for (const objectApiName of objectApiNames) {
      const [sourceDesc, targetDesc] = await Promise.all([
        this.deps.describeObject(sourceOrgId, objectApiName),
        this.deps.describeObject(targetOrgId, objectApiName),
      ]);

      const targetFieldMap = new Map(targetDesc.fields.map((f) => [f.name, f]));

      for (const sourceField of sourceDesc.fields) {
        const targetField = targetFieldMap.get(sourceField.name);

        if (!targetField) {
          diffs.push({
            objectApiName,
            fieldApiName: sourceField.name,
            issue: 'missing',
            severity: 'error',
            details: `Field ${sourceField.name} exists in source but not in target`,
          });
          continue;
        }

        if (sourceField.type !== targetField.type) {
          diffs.push({
            objectApiName,
            fieldApiName: sourceField.name,
            issue: 'type_mismatch',
            severity: 'warning',
            details: `Field ${sourceField.name} type differs: source=${sourceField.type}, target=${targetField.type}`,
          });
        }

        if (sourceField.createable && !targetField.createable) {
          diffs.push({
            objectApiName,
            fieldApiName: sourceField.name,
            issue: 'permission_denied',
            severity: 'warning',
            details: `Field ${sourceField.name} is createable in source but not in target`,
          });
        }
      }
    }

    return diffs;
  }
}
