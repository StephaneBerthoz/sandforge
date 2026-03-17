import type {
  PreCheckConfig,
  PreCheckItem,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Schema metadata for a single object */
export interface ObjectSchemaInfo {
  objectApiName: string;
  requiredFields: string[];
  mappedFields: string[];
  validationRuleCount: number;
  activeTriggerCount: number;
  activeFlowCount: number;
  duplicateRuleCount: number;
}

/** Dependency: fetches schema metadata for objects in the operation */
export type FetchSchemaFn = (
  orgId: string,
  operationConfig: Record<string, unknown>
) => Promise<ObjectSchemaInfo[]>;

/**
 * Checks schema compatibility including required fields, validation rules,
 * active triggers, active flows, and duplicate rules.
 */
export class SchemaCheck {
  private readonly fetchSchema: FetchSchemaFn;

  constructor(fetchSchema: FetchSchemaFn) {
    this.fetchSchema = fetchSchema;
  }

  /** Run all schema checks against the target org */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const schemas = await this.fetchSchema(
      config.targetOrgId,
      config.operationConfig
    );
    const items: PreCheckItem[] = [];

    for (const schema of schemas) {
      items.push(...this.checkRequiredFields(schema));
      items.push(this.checkValidationRules(schema));
      items.push(this.checkActiveTriggers(schema));
      items.push(this.checkActiveFlows(schema));
      items.push(this.checkDuplicateRules(schema));
    }

    return items;
  }

  /** Check that all required fields are mapped in the operation config */
  private checkRequiredFields(schema: ObjectSchemaInfo): PreCheckItem[] {
    const unmapped = schema.requiredFields.filter(
      (field) => !schema.mappedFields.includes(field)
    );

    if (unmapped.length === 0) {
      return [{
        id: randomUUID(),
        category: 'schema',
        name: `Required fields for ${schema.objectApiName}`,
        description: `Verifies all required fields are mapped on ${schema.objectApiName}`,
        severity: 'info',
        passed: true,
        message: `All required fields mapped on ${schema.objectApiName}`,
        details: { objectApiName: schema.objectApiName, requiredFields: schema.requiredFields },
        autoFixable: false,
      }];
    }

    return [{
      id: randomUUID(),
      category: 'schema',
      name: `Required fields for ${schema.objectApiName}`,
      description: `Verifies all required fields are mapped on ${schema.objectApiName}`,
      severity: 'error',
      passed: false,
      message: `Unmapped required fields on ${schema.objectApiName}: ${unmapped.join(', ')}`,
      details: { objectApiName: schema.objectApiName, unmappedFields: unmapped },
      autoFixable: true,
      fixDescription: `Auto-map missing required fields on ${schema.objectApiName} using default values`,
    }];
  }

  /** Check for active validation rules that may block inserts/updates */
  private checkValidationRules(schema: ObjectSchemaInfo): PreCheckItem {
    const hasRules = schema.validationRuleCount > 0;

    return {
      id: randomUUID(),
      category: 'schema',
      name: `Validation rules on ${schema.objectApiName}`,
      description: `Detects active validation rules on ${schema.objectApiName}`,
      severity: hasRules ? 'warning' : 'info',
      passed: true,
      message: hasRules
        ? `${schema.validationRuleCount} active validation rule(s) on ${schema.objectApiName} — data must comply`
        : `No active validation rules on ${schema.objectApiName}`,
      details: { objectApiName: schema.objectApiName, validationRuleCount: schema.validationRuleCount },
      autoFixable: false,
    };
  }

  /** Check for active triggers that may affect data operations */
  private checkActiveTriggers(schema: ObjectSchemaInfo): PreCheckItem {
    const hasTriggers = schema.activeTriggerCount > 0;

    return {
      id: randomUUID(),
      category: 'schema',
      name: `Active triggers on ${schema.objectApiName}`,
      description: `Detects active Apex triggers on ${schema.objectApiName}`,
      severity: hasTriggers ? 'warning' : 'info',
      passed: true,
      message: hasTriggers
        ? `${schema.activeTriggerCount} active trigger(s) on ${schema.objectApiName} — may affect performance`
        : `No active triggers on ${schema.objectApiName}`,
      details: { objectApiName: schema.objectApiName, activeTriggerCount: schema.activeTriggerCount },
      autoFixable: false,
    };
  }

  /** Check for active flows that may affect data operations */
  private checkActiveFlows(schema: ObjectSchemaInfo): PreCheckItem {
    const hasFlows = schema.activeFlowCount > 0;

    return {
      id: randomUUID(),
      category: 'schema',
      name: `Active flows on ${schema.objectApiName}`,
      description: `Detects active record-triggered flows on ${schema.objectApiName}`,
      severity: hasFlows ? 'warning' : 'info',
      passed: true,
      message: hasFlows
        ? `${schema.activeFlowCount} active flow(s) on ${schema.objectApiName} — may affect performance`
        : `No active flows on ${schema.objectApiName}`,
      details: { objectApiName: schema.objectApiName, activeFlowCount: schema.activeFlowCount },
      autoFixable: false,
    };
  }

  /** Check for duplicate rules that may reject records */
  private checkDuplicateRules(schema: ObjectSchemaInfo): PreCheckItem {
    const hasRules = schema.duplicateRuleCount > 0;

    return {
      id: randomUUID(),
      category: 'schema',
      name: `Duplicate rules on ${schema.objectApiName}`,
      description: `Detects active duplicate rules on ${schema.objectApiName}`,
      severity: hasRules ? 'warning' : 'info',
      passed: true,
      message: hasRules
        ? `${schema.duplicateRuleCount} duplicate rule(s) on ${schema.objectApiName} — may reject records`
        : `No duplicate rules on ${schema.objectApiName}`,
      details: { objectApiName: schema.objectApiName, duplicateRuleCount: schema.duplicateRuleCount },
      autoFixable: false,
    };
  }
}
