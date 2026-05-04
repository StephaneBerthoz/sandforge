import type { ObjectDescribe, FieldDescribe } from './MetadataReader';

/** Schema analysis result for an object */
export interface ObjectAnalysis {
  objectName: string;
  totalFields: number;
  creatableFields: number;
  requiredFields: number;
  referenceFields: number;
  externalIdFields: number;
  customFieldCount: number;
  hasRecordTypes: boolean;
  recordTypeCount: number;
  estimatedRecordSize: number;
  complexity: 'simple' | 'moderate' | 'complex';
}

/** Field analysis with recommendations */
export interface FieldAnalysis {
  fieldName: string;
  type: string;
  isRequired: boolean;
  isReference: boolean;
  isExternalId: boolean;
  isCustom: boolean;
  maxLength: number;
  referenceTo: string[];
}

/**
 * Analyzes Salesforce object schemas to provide insights
 * for data operations like seed, sync, and compare.
 */
export class SchemaAnalyzer {
  /** Analyze a single object's schema */
  analyzeObject(describe: ObjectDescribe): ObjectAnalysis {
    const creatableFields = describe.fields.filter((f) => f.createable);
    const requiredFields = describe.fields.filter(
      (f) =>
        f.createable && !f.nillable && !f.autoNumber && !f.calculated && f.defaultValue === null,
    );
    const referenceFields = describe.fields.filter((f) => f.referenceTo.length > 0);
    const externalIdFields = describe.fields.filter((f) => f.externalId);
    const customFields = describe.fields.filter((f) => f.name.endsWith('__c'));
    const activeRecordTypes = describe.recordTypeInfos.filter((rt) => rt.active);

    const estimatedRecordSize = this.estimateRecordSize(describe.fields);
    const complexity = this.assessComplexity(describe);

    return {
      objectName: describe.name,
      totalFields: describe.fields.length,
      creatableFields: creatableFields.length,
      requiredFields: requiredFields.length,
      referenceFields: referenceFields.length,
      externalIdFields: externalIdFields.length,
      customFieldCount: customFields.length,
      hasRecordTypes: activeRecordTypes.length > 1,
      recordTypeCount: activeRecordTypes.length,
      estimatedRecordSize,
      complexity,
    };
  }

  /** Analyze all fields of an object */
  analyzeFields(describe: ObjectDescribe): FieldAnalysis[] {
    return describe.fields.map((field) => ({
      fieldName: field.name,
      type: field.type,
      isRequired:
        field.createable &&
        !field.nillable &&
        !field.autoNumber &&
        !field.calculated &&
        field.defaultValue === null,
      isReference: field.referenceTo.length > 0,
      isExternalId: field.externalId,
      isCustom: field.name.endsWith('__c'),
      maxLength: field.length,
      referenceTo: field.referenceTo,
    }));
  }

  /** Suggest the best external ID field for upsert operations */
  suggestExternalIdField(describe: ObjectDescribe): string | undefined {
    const externalIdFields = describe.fields.filter((f) => f.externalId);
    if (externalIdFields.length === 0) return undefined;

    const custom = externalIdFields.find((f) => f.name.endsWith('__c'));
    return custom?.name ?? externalIdFields[0].name;
  }

  /** Suggest optimal batch size based on object complexity */
  suggestBatchSize(describe: ObjectDescribe): number {
    const fieldCount = describe.fields.filter((f) => f.createable).length;
    const hasLargeTextFields = describe.fields.some(
      (f) => (f.type === 'textarea' || f.type === 'richtext') && f.length > 10000,
    );

    if (hasLargeTextFields || fieldCount > 100) return 50;
    if (fieldCount > 50) return 100;
    return 200;
  }

  /** Estimate record size in bytes based on field types */
  private estimateRecordSize(fields: FieldDescribe[]): number {
    let size = 0;
    for (const field of fields) {
      if (!field.createable) continue;
      switch (field.type) {
        case 'boolean':
          size += 1;
          break;
        case 'int':
        case 'double':
        case 'currency':
        case 'percent':
          size += 8;
          break;
        case 'date':
        case 'datetime':
        case 'time':
          size += 8;
          break;
        case 'id':
        case 'reference':
          size += 18;
          break;
        case 'textarea':
        case 'richtext':
          size += Math.min(field.length, 1000);
          break;
        default:
          size += Math.min(field.length, 255);
          break;
      }
    }
    return size;
  }

  /** Assess object complexity for UI hints */
  private assessComplexity(describe: ObjectDescribe): 'simple' | 'moderate' | 'complex' {
    const fieldCount = describe.fields.length;
    const refCount = describe.fields.filter((f) => f.referenceTo.length > 0).length;
    const hasRecordTypes = describe.recordTypeInfos.filter((rt) => rt.active).length > 1;

    if (fieldCount > 100 || refCount > 10 || (hasRecordTypes && refCount > 5)) return 'complex';
    if (fieldCount > 30 || refCount > 3 || hasRecordTypes) return 'moderate';
    return 'simple';
  }
}
