import * as z from 'zod';
import type {
  SyncConfig,
  SyncObjectConfig,
  FieldMapping,
  TransformRule,
  MappingType,
} from '@sandforge/shared';

// ── SFDMU Zod Schemas ─────────────────────────────────────

/**
 * Schema for a single SFDMU field mapping entry. A `fieldMapping` holds two
 * kinds of entry, which one entry may also join: `targetObject` sends the
 * object to another object of the target, and `sourceField` with `targetField`
 * sends a field to another field. SFDMU's documentation writes `targetObject`
 * on an entry of its own, which read here as two missing fields.
 */
const sfdmuFieldMappingItemSchema = z
  .object({
    targetObject: z.string().optional(),
    sourceField: z.string().min(1).optional(),
    targetField: z.string().min(1).optional(),
  })
  .refine(
    ({ targetObject, sourceField, targetField }) =>
      (sourceField === undefined) === (targetField === undefined) &&
      (sourceField !== undefined || Boolean(targetObject)),
    { message: 'A field mapping names a targetObject, or a sourceField with its targetField.' },
  );

/** Schema for a single SFDMU values mapping entry */
const sfdmuValuesMappingItemSchema = z.object({
  fieldName: z.string().min(1),
  rawValue: z.string(),
  mappedValue: z.string(),
});

/** Schema for a single SFDMU ScriptObject */
const sfdmuScriptObjectSchema = z.object({
  query: z.string().min(1),
  operation: z.enum([
    'Insert',
    'Update',
    'Upsert',
    'Delete',
    'Readonly',
    'DeleteSource',
    'DeleteHierarchy',
  ]),
  externalId: z.string().optional().default('Id'),
  objectName: z.string().min(1),
  master: z.boolean().optional().default(true),
  excludedFields: z.array(z.string()).optional().default([]),
  fieldMapping: z.array(sfdmuFieldMappingItemSchema).optional().default([]),
  valuesMapping: z.array(sfdmuValuesMappingItemSchema).optional().default([]),
  deleteOldData: z.boolean().optional().default(false),
  updateWithMockData: z.boolean().optional().default(false),
  mockFields: z.array(z.string()).optional().default([]),
  where: z.string().optional(),
  orderBy: z.string().optional(),
  limit: z.number().optional(),
});

/** Schema for the top-level SFDMU export.json */
export const sfdmuExportSchema = z.object({
  objects: z.array(sfdmuScriptObjectSchema).min(1),
  excludeIdsFromCSVFiles: z.boolean().optional(),
  apiVersion: z.string().optional(),
  bulkApiVersion: z.string().optional(),
  pollingIntervalMs: z.number().optional(),
  bulkApiV1BatchSize: z.number().optional(),
  allOrNone: z.boolean().optional(),
  promptOnUpdateError: z.boolean().optional(),
  promptOnMissingParentObjects: z.boolean().optional(),
});

/** Inferred type for the SFDMU export format */
export type SfdmuExport = z.infer<typeof sfdmuExportSchema>;

/** Inferred type for a single SFDMU ScriptObject */
export type SfdmuScriptObject = z.infer<typeof sfdmuScriptObjectSchema>;

/** Inferred type for a single SFDMU field mapping item */
export type SfdmuFieldMappingItem = z.infer<typeof sfdmuFieldMappingItemSchema>;

/** Inferred type for a single SFDMU values mapping item */
export type SfdmuValuesMappingItem = z.infer<typeof sfdmuValuesMappingItemSchema>;

// ── Dependency Edge ───────────────────────────────────────

/** Represents a parent/child dependency between objects */
export interface DependencyEdge {
  parent: string;
  child: string;
  field: string;
}

// ── File reader interface ─────────────────────────────────

/** Interface for reading files — allows easy mocking in tests */
export interface FileReader {
  readFile(filePath: string): Promise<string>;
}

// ── Target object ─────────────────────────────────────────

/**
 * An export that sends an object to another object, which a Sync configuration
 * cannot say: an object of one has one name, `objectApiName`, that it is read,
 * described, written, matched and removed under. Converted all the same, an
 * export mapping Account onto Lead wrote `Name → Company` on Account, unsaid,
 * so nothing of such an export is imported, and each object is named with
 * where it goes and its fields.
 */
export class SfdmuTargetObjectError extends Error {
  /** Each object refused, as `Account → Lead (Name → Company)`. */
  readonly objects: readonly string[];

  constructor(objects: readonly string[]) {
    super(
      'Nothing was imported: Sync writes an object to the same object in the target org, and ' +
        `this export sends one to another: ${objects.join('; ')}. Take out its targetObject ` +
        'entries, or those objects, then import it again.',
    );
    this.name = 'SfdmuTargetObjectError';
    this.objects = objects;
  }
}

/** An entry of a `fieldMapping` that names a field, rather than a target object alone. */
function namesAField(
  item: SfdmuFieldMappingItem,
): item is SfdmuFieldMappingItem & { sourceField: string; targetField: string } {
  return item.sourceField !== undefined && item.targetField !== undefined;
}

/**
 * The objects of an export written to another object, as
 * {@link SfdmuTargetObjectError} names them. SFDMU takes the last target an
 * object's entries name, and an API name matches whatever its case, so a
 * target that names the object itself changes nothing. A `Readonly` object is
 * left out of the configuration, so nothing is written for it.
 *
 * SFDMU reads a mapping only under `useFieldMapping`, which the importer does
 * not read: an object's field mappings are converted either way, so a target
 * left under that flag switched off is refused too, or its fields would land
 * on the source object.
 */
function objectsSentElsewhere(sfdmuExport: SfdmuExport): string[] {
  return sfdmuExport.objects.flatMap((obj) => {
    if (obj.operation === 'Readonly') return [];
    const target = obj.fieldMapping.flatMap((item) => item.targetObject || []).at(-1);
    if (target === undefined || target.toLowerCase() === obj.objectName.toLowerCase()) return [];
    const fields = obj.fieldMapping
      .filter(namesAField)
      .map((item) => `${item.sourceField} → ${item.targetField}`);
    return [`${obj.objectName} → ${target}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`];
  });
}

// ── SfdmuImporter ─────────────────────────────────────────

/**
 * Imports SFDMU export.json configurations and converts them
 * to the SandForge SyncConfig format.
 *
 * Maps:
 * - ScriptObject to SyncObjectConfig
 * - externalId to SyncObjectConfig.externalIdField
 * - fieldMapping to FieldMapping[]
 * - valuesMapping to TransformRule[] (map_value)
 * - excludedFields to SyncObjectConfig.excludedFields
 * - master/child relationships to DependencyEdge[]
 */
export class SfdmuImporter {
  private readonly fileReader: FileReader;

  constructor(fileReader: FileReader) {
    this.fileReader = fileReader;
  }

  /**
   * Import an SFDMU export.json file and convert to SyncConfig.
   * @param filePath - Path to the SFDMU export.json file
   * @returns Parsed and converted SyncConfig
   * @throws {SfdmuTargetObjectError} When it sends an object to another object.
   */
  async import(filePath: string): Promise<SyncConfig> {
    const content = await this.fileReader.readFile(filePath);
    const parsed: unknown = JSON.parse(content);
    const validated = sfdmuExportSchema.parse(parsed);
    const refused = objectsSentElsewhere(validated);
    if (refused.length > 0) throw new SfdmuTargetObjectError(refused);
    return this.convert(validated);
  }

  /**
   * Extract dependency edges from SFDMU objects.
   * Infers parent/child relationships from lookup fields in queries.
   * @param sfdmuExport - Validated SFDMU export configuration
   * @returns Array of dependency edges
   */
  extractDependencies(sfdmuExport: SfdmuExport): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    const objectNames = new Set(sfdmuExport.objects.map((o) => o.objectName));

    for (const obj of sfdmuExport.objects) {
      if (obj.master === false) {
        continue;
      }

      const fieldsFromQuery = extractFieldsFromQuery(obj.query);
      for (const field of fieldsFromQuery) {
        if (field.includes('.')) {
          const parts = field.split('.');
          const relationshipName = parts[0];
          const parentObject = resolveRelationshipToObject(relationshipName);
          if (objectNames.has(parentObject)) {
            edges.push({
              parent: parentObject,
              child: obj.objectName,
              field: relationshipName,
            });
          }
        }
      }
    }

    return edges;
  }

  /**
   * Convert a validated SFDMU export to SyncConfig.
   * @param sfdmuExport - Validated SFDMU export configuration
   * @returns Converted SyncConfig
   */
  private convert(sfdmuExport: SfdmuExport): SyncConfig {
    const now = new Date().toISOString();
    const objects: SyncObjectConfig[] = sfdmuExport.objects
      .filter((obj) => obj.operation !== 'Readonly')
      .map((obj, index) => this.convertObject(obj, index));

    return {
      id: generateId(),
      name: 'SFDMU Import',
      description: 'Imported from SFDMU export.json',
      sourceOrgId: generateId(),
      targetOrgId: generateId(),
      direction: 'source_to_target',
      mode: 'full',
      objects,
      conflictStrategy: 'source_wins',
      enableRollback: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Convert a single SFDMU ScriptObject to SyncObjectConfig.
   * @param obj - SFDMU ScriptObject
   * @param index - Insertion order index
   * @returns Converted SyncObjectConfig
   */
  private convertObject(obj: SfdmuScriptObject, index: number): SyncObjectConfig {
    const fieldMappings = this.convertFieldMappings(obj.fieldMapping);
    const transformRules = this.convertValuesMapping(obj.valuesMapping, fieldMappings);

    return {
      objectApiName: obj.objectName,
      externalIdField: obj.externalId === 'Id' ? undefined : obj.externalId,
      operation: mapOperation(obj.operation),
      query: obj.query,
      fieldMappings,
      transformRules,
      excludedFields: obj.excludedFields,
      addOnFields: [],
      batchSize: 200,
      orderBy: obj.orderBy,
      where: obj.where,
      insertOrder: index + 1,
    };
  }

  /**
   * Convert SFDMU field mappings to SandForge FieldMapping[]: the entries that
   * name a field, as one that names a target object alone maps none.
   * @param mappings - SFDMU field mapping items
   * @returns Converted FieldMapping array
   */
  private convertFieldMappings(mappings: SfdmuFieldMappingItem[]): FieldMapping[] {
    return mappings.filter(namesAField).map((m) => {
      const type: MappingType = m.sourceField === m.targetField ? 'direct' : 'rename';
      return {
        sourceField: m.sourceField,
        targetField: m.targetField,
        type,
      };
    });
  }

  /**
   * Convert SFDMU values mappings to SandForge TransformRule[]: one Map Value
   * rule per field, naming that field. The field was dropped once grouped, and
   * each rule ran on every field of the record: a mapping of "New" to "Open"
   * meant for Status rewrote any other field that read "New".
   *
   * The rule runs once the record is mapped, on the target's field names, so
   * a field the export renames is named as the target calls it.
   * @param mappings - SFDMU values mapping items
   * @param fieldMappings - The object's field mappings, already converted
   * @returns Converted TransformRule array
   */
  private convertValuesMapping(
    mappings: SfdmuValuesMappingItem[],
    fieldMappings: FieldMapping[],
  ): TransformRule[] {
    if (mappings.length === 0) {
      return [];
    }

    const grouped = new Map<string, Record<string, string>>();
    for (const m of mappings) {
      const renamed = fieldMappings.find((f) => f.sourceField === m.fieldName);
      const field = renamed?.targetField ?? m.fieldName;
      const existing = grouped.get(field) ?? {};
      existing[m.rawValue] = m.mappedValue;
      grouped.set(field, existing);
    }

    const rules: TransformRule[] = [];
    for (const [field, valueMap] of grouped) {
      rules.push({
        type: 'map_value',
        field,
        config: { valueMap },
      });
    }

    return rules;
  }
}

/**
 * Map SFDMU operation to SandForge SyncOperation.
 * @param operation - SFDMU operation string
 * @returns SandForge SyncOperation
 */
function mapOperation(
  operation: SfdmuScriptObject['operation'],
): 'insert' | 'update' | 'upsert' | 'delete' {
  const mapping: Record<string, 'insert' | 'update' | 'upsert' | 'delete'> = {
    Insert: 'insert',
    Update: 'update',
    Upsert: 'upsert',
    Delete: 'delete',
    DeleteSource: 'delete',
    DeleteHierarchy: 'delete',
  };
  return mapping[operation] ?? 'upsert';
}

/**
 * Extract field names from a SOQL SELECT query.
 * @param query - SOQL query string
 * @returns Array of field names
 */
function extractFieldsFromQuery(query: string): string[] {
  const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
  if (!selectMatch) {
    return [];
  }
  return selectMatch[1].split(',').map((f) => f.trim());
}

/**
 * Resolve a relationship name to a likely parent object.
 * Handles standard Salesforce naming conventions.
 * @param relationshipName - Relationship name from query
 * @returns Inferred parent object API name
 */
function resolveRelationshipToObject(relationshipName: string): string {
  const standardMappings: Record<string, string> = {
    Account: 'Account',
    Contact: 'Contact',
    Owner: 'User',
    CreatedBy: 'User',
    LastModifiedBy: 'User',
    Parent: 'Account',
    RecordType: 'RecordType',
  };

  if (standardMappings[relationshipName]) {
    return standardMappings[relationshipName];
  }

  if (relationshipName.endsWith('__r')) {
    return relationshipName.replace(/__r$/, '__c');
  }

  return relationshipName;
}

/**
 * Generate a placeholder UUID-like string.
 * @returns Generated ID string
 */
function generateId(): string {
  return globalThis.crypto.randomUUID();
}
