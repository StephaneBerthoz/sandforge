import type {
  SeedFieldInfo,
  FieldGenerationConfig,
  FieldGenerationMode,
  FieldGenerationConstraints,
} from '@sandforge/shared';

/**
 * Smart field generation engine that auto-detects the optimal generation
 * strategy for each Salesforce field based on its metadata, type, and constraints.
 *
 * Analyzes field name patterns, type, required/unique flags, picklist values,
 * and reference targets to suggest the best FieldGenerationConfig.
 */
export class SmartFieldGenerator {
  /** Well-known field name patterns mapped to faker methods. */
  private static readonly NAME_PATTERNS: ReadonlyArray<{
    pattern: RegExp;
    fakerMethod: string;
    mode: FieldGenerationMode;
  }> = [
    { pattern: /^(first\s?name|prenom)/i, fakerMethod: 'firstName', mode: 'faker' },
    { pattern: /^(last\s?name|nom)/i, fakerMethod: 'lastName', mode: 'faker' },
    { pattern: /^(full\s?name|name__c$)/i, fakerMethod: 'name', mode: 'faker' },
    { pattern: /email/i, fakerMethod: 'email', mode: 'faker' },
    { pattern: /phone|mobile|fax/i, fakerMethod: 'phone', mode: 'faker' },
    { pattern: /^(street|address|mailing)/i, fakerMethod: 'address', mode: 'faker' },
    { pattern: /^city/i, fakerMethod: 'city', mode: 'faker' },
    { pattern: /^(country|pays)/i, fakerMethod: 'country', mode: 'faker' },
    { pattern: /^(zip|postal)/i, fakerMethod: 'zipCode', mode: 'faker' },
    { pattern: /^company|^account\s?name/i, fakerMethod: 'company', mode: 'faker' },
    { pattern: /website|url|link/i, fakerMethod: 'url', mode: 'faker' },
    { pattern: /^(description|comment|note|body)/i, fakerMethod: 'paragraph', mode: 'faker' },
    { pattern: /^title$/i, fakerMethod: 'sentence', mode: 'faker' },
    { pattern: /^subject$/i, fakerMethod: 'sentence', mode: 'faker' },
  ];

  /**
   * Generate smart field configurations for all fields of an object.
   * Analyzes each field's metadata to suggest the optimal generation strategy.
   */
  suggestConfigs(fields: SeedFieldInfo[]): FieldGenerationConfig[] {
    return fields.map((field) => this.suggestForField(field));
  }

  /**
   * Suggest the optimal generation config for a single field.
   */
  suggestForField(field: SeedFieldInfo): FieldGenerationConfig {
    const constraints = this.buildConstraints(field);

    // System/auto fields → null
    if (this.isSystemField(field)) {
      return this.buildConfig(field, 'null', constraints);
    }

    // Picklist → picklist_random
    if (field.type === 'picklist' || field.type === 'multipicklist') {
      if (field.picklistValues && field.picklistValues.length > 0) {
        return this.buildConfig(field, 'picklist_random', constraints);
      }
    }

    // Reference (Lookup/MasterDetail) → null (handled by ReferenceLinker)
    if (field.referenceTo) {
      return this.buildConfig(field, 'null', constraints);
    }

    // Boolean → auto (random true/false)
    if (field.type === 'boolean') {
      return this.buildConfig(field, 'auto', constraints);
    }

    // Id/ExternalId fields with unique constraint → sequence
    if (field.unique || field.externalId) {
      return this.buildConfig(field, 'sequence', constraints, {
        sequencePattern: `${field.apiName}-{n}`,
      });
    }

    // Date fields → faker
    if (field.type === 'date' || field.type === 'datetime') {
      return this.buildConfig(field, 'faker', constraints, {
        fakerMethod: 'date',
      });
    }

    // Number types → auto
    if (
      field.type === 'double' ||
      field.type === 'currency' ||
      field.type === 'percent' ||
      field.type === 'int'
    ) {
      return this.buildConfig(field, 'auto', constraints);
    }

    // Text fields — try to match by name pattern
    if (
      field.type === 'string' ||
      field.type === 'textarea' ||
      field.type === 'email' ||
      field.type === 'phone' ||
      field.type === 'url'
    ) {
      // Email type → faker email
      if (field.type === 'email') {
        return this.buildConfig(field, 'faker', constraints, {
          fakerMethod: 'email',
        });
      }
      // Phone type → faker phone
      if (field.type === 'phone') {
        return this.buildConfig(field, 'faker', constraints, {
          fakerMethod: 'phone',
        });
      }
      // URL type → faker url
      if (field.type === 'url') {
        return this.buildConfig(field, 'faker', constraints, {
          fakerMethod: 'url',
        });
      }

      // Match name patterns
      const match = SmartFieldGenerator.NAME_PATTERNS.find((p) =>
        p.pattern.test(field.apiName) || p.pattern.test(field.label),
      );
      if (match) {
        return this.buildConfig(field, match.mode, constraints, {
          fakerMethod: match.fakerMethod,
        });
      }

      // Default text → faker lorem
      return this.buildConfig(field, 'faker', constraints, {
        fakerMethod: field.maxLength && field.maxLength <= 80 ? 'sentence' : 'paragraph',
      });
    }

    // Fallback: auto
    return this.buildConfig(field, 'auto', constraints);
  }

  /** Check if a field is a system/auto-populated field that should be skipped. */
  private isSystemField(field: SeedFieldInfo): boolean {
    const systemFields = new Set([
      'Id', 'CreatedDate', 'CreatedById', 'LastModifiedDate',
      'LastModifiedById', 'SystemModstamp', 'IsDeleted',
      'LastActivityDate', 'LastViewedDate', 'LastReferencedDate',
    ]);
    return systemFields.has(field.apiName);
  }

  /** Build FieldGenerationConstraints from SeedFieldInfo. */
  private buildConstraints(field: SeedFieldInfo): FieldGenerationConstraints {
    return {
      required: field.required,
      unique: field.unique,
      maxLength: field.maxLength,
      picklistValues: field.picklistValues,
    };
  }

  /** Build a complete FieldGenerationConfig. */
  private buildConfig(
    field: SeedFieldInfo,
    mode: FieldGenerationMode,
    constraints: FieldGenerationConstraints,
    extras?: { fakerMethod?: string; fixedValue?: unknown; sequencePattern?: string },
  ): FieldGenerationConfig {
    return {
      fieldName: field.apiName,
      fieldType: field.type,
      generationMode: mode,
      fakerMethod: extras?.fakerMethod,
      fixedValue: extras?.fixedValue,
      sequencePattern: extras?.sequencePattern,
      constraints,
    };
  }
}
