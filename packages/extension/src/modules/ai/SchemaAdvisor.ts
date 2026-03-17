/** Describes a single Salesforce field. */
export interface FieldDescribe {
  apiName: string;
  label: string;
  type: string;
  required: boolean;
  custom: boolean;
  referenceTo?: string[];
  inlineHelpText?: string;
}

/** Describes a Salesforce object with its fields. */
export interface ObjectDescribe {
  apiName: string;
  label: string;
  custom: boolean;
  fields: FieldDescribe[];
  recordCount?: number;
}

/** Issue type classification. */
export type SchemaIssueType =
  | 'unused_field'
  | 'missing_index'
  | 'duplicate_field'
  | 'missing_relationship'
  | 'naming_convention';

/** Severity level for schema issues. */
export type SchemaIssueSeverity = 'low' | 'medium' | 'high';

/** Effort level for schema suggestions. */
export type EffortLevel = 'low' | 'medium' | 'high';

/** A detected schema issue. */
export interface SchemaIssue {
  type: SchemaIssueType;
  objectName: string;
  fieldName?: string;
  description: string;
  severity: SchemaIssueSeverity;
}

/** A suggestion for improving the schema. */
export interface SchemaSuggestion {
  title: string;
  description: string;
  impact: SchemaIssueSeverity;
  effort: EffortLevel;
}

/** Complete schema analysis result. */
export interface SchemaAdvice {
  score: number;
  issues: SchemaIssue[];
  suggestions: SchemaSuggestion[];
}

/** Common standard relationship patterns expected in Salesforce orgs. */
const EXPECTED_RELATIONSHIPS: Array<{ parent: string; child: string; fieldPattern: string }> = [
  { parent: 'Account', child: 'Contact', fieldPattern: 'AccountId' },
  { parent: 'Account', child: 'Opportunity', fieldPattern: 'AccountId' },
  { parent: 'Account', child: 'Case', fieldPattern: 'AccountId' },
  { parent: 'Contact', child: 'Case', fieldPattern: 'ContactId' },
  { parent: 'Opportunity', child: 'OpportunityLineItem', fieldPattern: 'OpportunityId' },
  { parent: 'Campaign', child: 'CampaignMember', fieldPattern: 'CampaignId' },
];

/** Severity weights for scoring deductions. */
const SEVERITY_WEIGHTS: Record<SchemaIssueSeverity, number> = {
  low: 1,
  medium: 3,
  high: 5,
};

/**
 * Analyzes Salesforce org schemas and produces
 * actionable improvement suggestions.
 */
export class SchemaAdvisor {
  /**
   * Analyze a complete schema and produce an advice report.
   * Checks for unused fields, naming conventions, duplicates,
   * and missing relationships across all objects.
   * @param objects - Array of Salesforce object descriptions
   * @returns Schema advice with score, issues, and suggestions
   */
  analyzeSchema(objects: ObjectDescribe[]): SchemaAdvice {
    const issues: SchemaIssue[] = [];

    for (const obj of objects) {
      issues.push(...this.analyzeObject(obj));
    }

    issues.push(...this.detectDuplicateFieldsAcrossObjects(objects));
    issues.push(...this.detectMissingRelationships(objects));

    const suggestions = this.getRecommendations(issues);
    const score = this.computeScore(issues, objects);

    return { score, issues, suggestions };
  }

  /**
   * Analyze a single object for schema issues.
   * @param obj - The Salesforce object description
   * @returns Array of detected issues
   */
  analyzeObject(obj: ObjectDescribe): SchemaIssue[] {
    const issues: SchemaIssue[] = [];

    issues.push(...this.checkUnusedFields(obj));
    issues.push(...this.checkNamingConventions(obj));

    return issues;
  }

  /**
   * Generate improvement suggestions from detected issues.
   * @param issues - Array of schema issues
   * @returns Array of actionable suggestions
   */
  getRecommendations(issues: SchemaIssue[]): SchemaSuggestion[] {
    const suggestions: SchemaSuggestion[] = [];
    const issueCounts = new Map<SchemaIssueType, number>();

    for (const issue of issues) {
      issueCounts.set(issue.type, (issueCounts.get(issue.type) ?? 0) + 1);
    }

    const unusedCount = issueCounts.get('unused_field') ?? 0;
    if (unusedCount > 0) {
      suggestions.push({
        title: 'Remove unused custom fields',
        description: `${unusedCount} custom field(s) appear unused. Removing them simplifies the schema and reduces maintenance burden.`,
        impact: unusedCount > 10 ? 'high' : 'medium',
        effort: 'low',
      });
    }

    const namingCount = issueCounts.get('naming_convention') ?? 0;
    if (namingCount > 0) {
      suggestions.push({
        title: 'Fix naming convention violations',
        description: `${namingCount} field(s) do not follow Salesforce naming conventions. Consistent naming improves discoverability.`,
        impact: 'low',
        effort: 'low',
      });
    }

    const duplicateCount = issueCounts.get('duplicate_field') ?? 0;
    if (duplicateCount > 0) {
      suggestions.push({
        title: 'Consolidate duplicate fields',
        description: `${duplicateCount} field(s) have similar labels across objects. Consider using formula fields or shared lookups instead.`,
        impact: 'medium',
        effort: 'medium',
      });
    }

    const missingRelCount = issueCounts.get('missing_relationship') ?? 0;
    if (missingRelCount > 0) {
      suggestions.push({
        title: 'Add missing standard relationships',
        description: `${missingRelCount} expected standard relationship(s) are missing. Adding them ensures data integrity.`,
        impact: 'high',
        effort: 'medium',
      });
    }

    const missingIndexCount = issueCounts.get('missing_index') ?? 0;
    if (missingIndexCount > 0) {
      suggestions.push({
        title: 'Add indexes on frequently queried fields',
        description: `${missingIndexCount} field(s) may benefit from custom indexing to improve query performance.`,
        impact: 'medium',
        effort: 'low',
      });
    }

    return suggestions;
  }

  private checkUnusedFields(obj: ObjectDescribe): SchemaIssue[] {
    const issues: SchemaIssue[] = [];

    for (const field of obj.fields) {
      if (field.custom && obj.recordCount === 0) {
        issues.push({
          type: 'unused_field',
          objectName: obj.apiName,
          fieldName: field.apiName,
          description: `Custom field "${field.label}" on "${obj.label}" has no records and may be unused.`,
          severity: 'low',
        });
      }
    }

    return issues;
  }

  private checkNamingConventions(obj: ObjectDescribe): SchemaIssue[] {
    const issues: SchemaIssue[] = [];

    for (const field of obj.fields) {
      if (field.custom && !field.apiName.endsWith('__c')) {
        issues.push({
          type: 'naming_convention',
          objectName: obj.apiName,
          fieldName: field.apiName,
          description: `Custom field "${field.apiName}" does not end with "__c" suffix.`,
          severity: 'low',
        });
      }

      if (field.custom && field.label !== field.label.trim()) {
        issues.push({
          type: 'naming_convention',
          objectName: obj.apiName,
          fieldName: field.apiName,
          description: `Field label "${field.label}" has leading or trailing whitespace.`,
          severity: 'low',
        });
      }

      if (field.custom && /\s{2,}/.test(field.label)) {
        issues.push({
          type: 'naming_convention',
          objectName: obj.apiName,
          fieldName: field.apiName,
          description: `Field label "${field.label}" contains consecutive spaces.`,
          severity: 'low',
        });
      }
    }

    return issues;
  }

  private detectDuplicateFieldsAcrossObjects(objects: ObjectDescribe[]): SchemaIssue[] {
    const issues: SchemaIssue[] = [];
    const labelMap = new Map<string, Array<{ objectName: string; fieldName: string }>>();

    for (const obj of objects) {
      for (const field of obj.fields) {
        if (!field.custom) continue;
        const normalizedLabel = field.label.toLowerCase().trim();
        const existing = labelMap.get(normalizedLabel) ?? [];
        existing.push({ objectName: obj.apiName, fieldName: field.apiName });
        labelMap.set(normalizedLabel, existing);
      }
    }

    for (const [label, occurrences] of labelMap) {
      if (occurrences.length > 1) {
        const locations = occurrences.map((o) => `${o.objectName}.${o.fieldName}`).join(', ');
        issues.push({
          type: 'duplicate_field',
          objectName: occurrences[0].objectName,
          fieldName: occurrences[0].fieldName,
          description: `Field label "${label}" appears in multiple objects: ${locations}.`,
          severity: 'medium',
        });
      }
    }

    return issues;
  }

  private detectMissingRelationships(objects: ObjectDescribe[]): SchemaIssue[] {
    const issues: SchemaIssue[] = [];
    const objectNames = new Set(objects.map((o) => o.apiName));

    for (const rel of EXPECTED_RELATIONSHIPS) {
      if (!objectNames.has(rel.parent) || !objectNames.has(rel.child)) {
        continue;
      }

      const childObj = objects.find((o) => o.apiName === rel.child);
      if (!childObj) continue;

      const hasRelField = childObj.fields.some(
        (f) => f.apiName === rel.fieldPattern || (f.referenceTo && f.referenceTo.includes(rel.parent)),
      );

      if (!hasRelField) {
        issues.push({
          type: 'missing_relationship',
          objectName: rel.child,
          description: `Expected relationship from "${rel.child}" to "${rel.parent}" (via ${rel.fieldPattern}) is missing.`,
          severity: 'high',
        });
      }
    }

    return issues;
  }

  private computeScore(issues: SchemaIssue[], objects: ObjectDescribe[]): number {
    if (objects.length === 0) return 100;

    const totalDeductions = issues.reduce(
      (sum, issue) => sum + SEVERITY_WEIGHTS[issue.severity],
      0,
    );

    const totalFields = objects.reduce((sum, obj) => sum + obj.fields.length, 0);
    const maxDeductions = Math.max(totalFields, 1);
    const rawScore = 100 - Math.round((totalDeductions / maxDeductions) * 100);

    return Math.max(0, Math.min(100, rawScore));
  }
}
