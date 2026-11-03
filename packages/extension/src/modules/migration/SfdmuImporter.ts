import { basename, dirname, join } from 'node:path';
import * as z from 'zod';
import type {
  MigrationImportNote,
  MigrationImportNoteCode,
  MigrationImportRefusal,
  SyncConfig,
  SyncObjectConfig,
  FieldMapping,
  TransformRule,
  MappingType,
} from '@sandforge/shared';
import {
  isSafeSoqlOrderBy,
  isSafeSoqlWhere,
  validateSoqlIdentifier,
} from '../../core/common/soqlValidator.js';
import { readSfdmuQuery } from './sfdmuQuery.js';
import type { SfdmuQuery } from './sfdmuQuery.js';
import {
  FIELD_MAPPING_FILE,
  VALUE_MAPPING_FILE,
  readFieldMappingRows,
  readValueMappingRows,
} from './sfdmuMappingFiles.js';
import type { FieldMappingRow, ValueMappingRow } from './sfdmuMappingFiles.js';

// ── SFDMU Zod Schemas ─────────────────────────────────────

/**
 * Schema for a single SFDMU field mapping entry. A `fieldMapping` holds two
 * kinds of entry, which one entry may also join: `targetObject` sends the
 * object to another object of the target, and `sourceField` with `targetField`
 * sends a field to another field. SFDMU's documentation writes `targetObject`
 * on an entry of its own, which read here as two missing fields.
 *
 * SFDMU's own schema requires none of the three, and its resolver passes over
 * an entry that names neither a target nor both fields of a pair: such an
 * entry, refused here, made the whole file "not of the kind SFDMU's format
 * holds", though SFDMU ran it.
 */
const sfdmuFieldMappingItemSchema = z.object({
  targetObject: z.string().optional(),
  sourceField: z.string().optional(),
  targetField: z.string().optional(),
});

/** Schema for a single SFDMU values mapping entry */
const sfdmuValuesMappingItemSchema = z.object({
  fieldName: z.string().min(1),
  rawValue: z.string(),
  mappedValue: z.string(),
});

/**
 * Schema for a `mockFields` entry. SFDMU writes an object, `name` the field and
 * `pattern` the fake value it takes.
 */
const sfdmuMockFieldSchema = z.union([
  z.string().min(1),
  z.looseObject({ name: z.string().min(1) }),
]);

/**
 * Schema for a single SFDMU ScriptObject, as SFDMU's own `export.schema.json`
 * allows one: no key for the object, which comes from `query`, and any key this
 * importer does not know kept for the import to name it. `objectName`, `where`,
 * `orderBy`, `limit` and `valuesMapping` are no key of SFDMU's: files written
 * for this importer carried them, and they are still read.
 */
const sfdmuScriptObjectSchema = z.looseObject({
  query: z.string().optional(),
  name: z.string().optional(),
  objectName: z.string().optional(),
  operation: z.string().optional(),
  // No default: an object that names none is keyed by SFDMU on its name field,
  // not on Id, and the import says so.
  externalId: z.string().optional(),
  master: z.boolean().optional().default(true),
  excluded: z.boolean().optional(),
  excludedFields: z.array(z.string()).optional().default([]),
  useFieldMapping: z.boolean().optional(),
  fieldMapping: z.array(sfdmuFieldMappingItemSchema).optional().default([]),
  useValuesMapping: z.boolean().optional(),
  valuesMapping: z.array(sfdmuValuesMappingItemSchema).optional().default([]),
  deleteOldData: z.boolean().optional().default(false),
  deleteFromSource: z.boolean().optional(),
  deleteByHierarchy: z.boolean().optional(),
  hardDelete: z.boolean().optional(),
  updateWithMockData: z.boolean().optional().default(false),
  mockFields: z.array(sfdmuMockFieldSchema).optional().default([]),
  where: z.string().optional(),
  orderBy: z.string().optional(),
  limit: z.number().optional(),
});

/**
 * Schema for the top-level SFDMU export.json. SFDMU asks for `objects` or
 * `objectSets`, runs the first and then each set, and takes any other key.
 */
export const sfdmuExportSchema = z
  .looseObject({
    objects: z.array(sfdmuScriptObjectSchema).optional().default([]),
    objectSets: z
      .array(z.looseObject({ objects: z.array(sfdmuScriptObjectSchema).optional().default([]) }))
      .optional(),
    csvFileDelimiter: z.string().optional(),
    csvReadFileDelimiter: z.string().optional(),
  })
  .refine((script) => allEntries(script).length > 0, {
    message: 'An export lists its objects under objects or objectSets.',
  });

/** Every object of an export, `objects` first and then each set, as SFDMU runs them. */
function allEntries<T>(script: {
  objects: T[];
  objectSets?: ReadonlyArray<{ objects: T[] }>;
}): T[] {
  return [...script.objects, ...(script.objectSets ?? []).flatMap((set) => set.objects)];
}

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

/**
 * Interface for reading files — allows easy mocking in tests. A file that does
 * not exist rejects with the code `ENOENT`, as `node:fs` does: the mapping
 * files beside an export are optional.
 */
export interface FileReader {
  readFile(filePath: string): Promise<string>;
}

/** A converted export, and what it asked that the configuration does not do as SFDMU would. */
export interface SfdmuImport {
  config: SyncConfig;
  notes: MigrationImportNote[];
}

// ── Refusals ──────────────────────────────────────────────

/**
 * An export nothing is imported from, with a code the page words in the
 * reader's language. A file that was no export ended on Zod's issues as JSON,
 * or on JavaScript's own `SyntaxError`, which named nothing of the file.
 */
export class SfdmuRefusal extends Error {
  readonly code: MigrationImportRefusal;
  /** What it is about: objects, or entries by their place in the file. */
  readonly objects: readonly string[];

  constructor(code: MigrationImportRefusal, message: string, objects: readonly string[] = []) {
    super(message);
    this.name = 'SfdmuRefusal';
    this.code = code;
    this.objects = objects;
  }
}

/**
 * An export that sends an object to another object, which a Sync configuration
 * cannot say: an object of one has one name, `objectApiName`, that it is read,
 * described, written, matched and removed under. Converted all the same, an
 * export mapping Account onto Lead wrote `Name → Company` on Account, unsaid,
 * so nothing of such an export is imported, and each object is named with
 * where it goes and its fields.
 */
export class SfdmuTargetObjectError extends SfdmuRefusal {
  /** @param objects - Each object refused, as `Account → Lead (Name → Company)`. */
  constructor(objects: readonly string[]) {
    super(
      'TARGET_OBJECT_MAPPED',
      'Nothing was imported: Sync writes an object to the same object in the target org, and ' +
        `this export sends one to another: ${objects.join('; ')}. Take out its targetObject ` +
        'entries, or those objects, then import it again.',
      objects,
    );
    this.name = 'SfdmuTargetObjectError';
  }
}

/** A place in the file, as `objects[2].fieldMapping[0]`. */
function placeOf(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (place, key) =>
      typeof key === 'number'
        ? `${place}[${key}]`
        : `${place}${place === '' ? '' : '.'}${String(key)}`,
    '',
  );
}

/**
 * The export a file holds.
 *
 * @throws {SfdmuRefusal} For a file that is not JSON, that lists no object, or
 *   that holds a value of a kind SFDMU's format does not hold there. A key it
 *   does not know is none of these: SFDMU takes any key.
 */
function parseExport(content: string, fileName: string): SfdmuExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err);
    throw new SfdmuRefusal('NOT_JSON', `Nothing was imported: ${fileName} is not JSON (${why}).`);
  }
  const noObjects = new SfdmuRefusal(
    'NO_OBJECTS',
    `Nothing was imported: ${fileName} lists no object, under objects or objectSets.`,
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw noObjects;
  const checked = sfdmuExportSchema.safeParse(parsed);
  if (checked.success) return checked.data;
  const places = [...new Set(checked.error.issues.map((issue) => placeOf(issue.path)))];
  if (places.every((place) => place === '')) throw noObjects;
  throw new SfdmuRefusal(
    'INVALID_EXPORT',
    `Nothing was imported: these entries of ${fileName} are not of the kind SFDMU's format ` +
      `holds there: ${places.join(', ')}. Correct them, then import it again.`,
    places,
  );
}

// ── Reading an object ─────────────────────────────────────

/** SFDMU's operations, which it reads whatever their case. */
const SFDMU_OPERATIONS = [
  'Insert',
  'Update',
  'Upsert',
  'Readonly',
  'Delete',
  'DeleteSource',
  'DeleteHierarchy',
  'HardDelete',
] as const;

type SfdmuOperation = (typeof SFDMU_OPERATIONS)[number];

/** The operations a Sync configuration has a way to carry. */
type CarriedOperation = Exclude<SfdmuOperation, 'Readonly' | 'DeleteSource' | 'DeleteHierarchy'>;

/** An entry of the export, read: what it selects from, and where the file holds it. */
type ReadEntry = SfdmuScriptObject & {
  place: string;
  /** The set SFDMU runs it in: 0 for `objects`, then each of `objectSets` in turn. */
  set: number;
  object: string;
  read: SfdmuQuery;
  /** Undefined: SFDMU has no operation of that name. */
  sfdmuOperation: SfdmuOperation | undefined;
  /** The keys it sets that the import does not act on. */
  settingsLeft: string[];
};

/** An entry the configuration takes. */
type TakenEntry = ReadEntry & { sfdmuOperation: CarriedOperation };

/** An entry the configuration takes, with the mappings SFDMU would apply to it. */
type KeptEntry = TakenEntry & {
  /** The entries of its `fieldMapping` SFDMU ignores, with `useFieldMapping` off. */
  fieldMappingsIgnored: number;
  /** The fields SFDMU writes fake values into, which `excludedFields` now holds. */
  mockedFields: string[];
  /** Rows of `ValueMapping.csv` a Map Value rule cannot apply, as `Field (raw value)`. */
  valueRowsLeft: string[];
};

/**
 * The object an entry selects from. SFDMU blanks `name` as it loads a file and
 * takes the FROM of the query: `name` and `objectName` count where none can be read.
 */
function objectNameOf(entry: SfdmuScriptObject): string | undefined {
  return (
    (entry.query ? readSfdmuQuery(entry.query).object : undefined) ??
    [entry.name, entry.objectName].find((name) => name !== undefined && name.trim() !== '')
  );
}

/** The operation of an entry: one that names none is `Readonly`, SFDMU's default. */
function operationOf(entry: SfdmuScriptObject): SfdmuOperation | undefined {
  const asked = (entry.operation ?? 'Readonly').trim().toLowerCase();
  return SFDMU_OPERATIONS.find((operation) => operation.toLowerCase() === asked);
}

/**
 * Every entry of an export, in the order SFDMU runs them.
 *
 * @throws {SfdmuRefusal} When one names no object.
 */
function readEntries(script: SfdmuExport): ReadEntry[] {
  const placed = [
    ...script.objects.map((entry, at) => ({ entry, set: 0, place: `objects[${at}]` })),
    ...(script.objectSets ?? []).flatMap((set, setAt) =>
      set.objects.map((entry, at) => ({
        entry,
        set: setAt + 1,
        place: `objectSets[${setAt}].objects[${at}]`,
      })),
    ),
  ];
  const unnamed = placed
    .filter(({ entry }) => objectNameOf(entry) === undefined)
    .map(({ entry, place }) => (entry.query ? `${place} (${entry.query.slice(0, 80)})` : place));
  if (unnamed.length > 0) {
    throw new SfdmuRefusal(
      'OBJECT_NOT_NAMED',
      'Nothing was imported: no object can be read in these entries, neither in the FROM of a ' +
        `query nor under name: ${unnamed.join('; ')}. Correct them, then import it again.`,
      unnamed,
    );
  }
  return placed.map(({ entry, set, place }) => {
    const read = readSfdmuQuery(entry.query ?? '');
    return {
      ...entry,
      place,
      set,
      object: objectNameOf(entry) ?? '',
      read,
      sfdmuOperation: operationOf(entry),
      settingsLeft: [
        ...settingsNotRead(entry, OBJECT_KEYS_READ),
        ...(whereOf({ ...entry, read }) !== entry.where && isSet(entry.where) ? ['where'] : []),
      ],
    };
  });
}

/**
 * The filter of an entry: the WHERE of its query, which SFDMU runs. `where`
 * is no key of SFDMU's, which ignores it; it counts only for a query that has
 * no WHERE, as files written for this importer carried it there. Taken over
 * the query's, an empty one read every record of the object, which a Delete
 * then removed from the target where they held the ids.
 */
function whereOf(entry: Pick<ReadEntry, 'where' | 'read'>): string | undefined {
  if (entry.read.where !== undefined) return entry.read.where;
  return entry.where?.trim() ? entry.where : undefined;
}

/** What SFDMU's `mockFields` calls every field of an object. */
const MOCK_ALL_FIELDS = 'all';

/** The fields SFDMU writes fake values into: none unless the object says so. */
function mockedFieldsOf(entry: SfdmuScriptObject): string[] {
  if (!entry.updateWithMockData) return [];
  return [...new Set(entry.mockFields.map((f) => (typeof f === 'string' ? f : f.name)))];
}

/**
 * Why an entry stays out of the configuration, or `undefined` when it goes in.
 *
 * Sync's delete goes to the target, so a `DeleteSource` converted to one, as
 * it was, deleted in the org the export meant to leave alone. Sync has no fake
 * data either, and an object faked whole has no field list to leave out: its
 * real values would reach the target where the export hid them.
 */
function whyLeftOut(entry: ReadEntry): Pick<MigrationImportNote, 'code' | 'detail'> | undefined {
  const operation = entry.sfdmuOperation;
  if (entry.excluded) return { code: 'excluded' };
  // SFDMU's loader drops such an entry: taken, it would copy an object SFDMU never read.
  if (!entry.query?.trim()) return { code: 'noQuery' };
  if (operation === undefined) return { code: 'unknownOperation', detail: entry.operation };
  if (operation === 'Readonly') return { code: 'readonly' };
  if (operation === 'DeleteSource' || operation === 'DeleteHierarchy') {
    return { code: 'deletesElsewhere', detail: operation };
  }
  const deletes = operation === 'Delete' || operation === 'HardDelete';
  if (deletes && entry.deleteFromSource) {
    return { code: 'deletesElsewhere', detail: 'deleteFromSource' };
  }
  if (deletes && entry.deleteByHierarchy) {
    return { code: 'deletesElsewhere', detail: 'deleteByHierarchy' };
  }
  if (!deletes && mockedFieldsOf(entry).includes(MOCK_ALL_FIELDS)) {
    return { code: 'mockAllFields' };
  }
  return undefined;
}

/**
 * The values SFDMU writes as an empty field (`_normalizeMappedValue`). A Map
 * Value rule would write them as text: `null` into a rating SFDMU clears.
 */
const SFDMU_NULL_VALUES: ReadonlySet<string> = new Set(['null', 'NULL', 'undefined', '#N/A']);

/**
 * Whether a Map Value rule can apply a row of `ValueMapping.csv`: it maps one
 * exact value to another on a field. SFDMU's `/regex/` and `eval(…)` are code,
 * an `eval` of any case, as SFDMU reads it, and its null values write an
 * empty field, which the rule would write as their letters.
 */
function isExactValueRow(row: { field: string; rawValue: string; value: string }): boolean {
  return (
    validateSoqlIdentifier(row.field) &&
    !/^\/.*\/$/.test(row.rawValue) &&
    !/^eval[(].*[)]$/i.test(row.value) &&
    !SFDMU_NULL_VALUES.has(row.value.trim())
  );
}

/** Whether a setting says anything: `false`, nothing and an empty list do not. */
function isSet(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== false && value !== null && value !== undefined && value !== '';
}

/** The keys of an object the import acts on: any other is named in its notes. */
const OBJECT_KEYS_READ: ReadonlySet<string> = new Set([
  'query',
  'name',
  'objectName',
  'operation',
  'externalId',
  'master',
  'excluded',
  'excludedFields',
  'useFieldMapping',
  'fieldMapping',
  'useValuesMapping',
  'valuesMapping',
  'deleteOldData',
  'deleteFromSource',
  'deleteByHierarchy',
  'hardDelete',
  'updateWithMockData',
  'mockFields',
  'where',
  'orderBy',
  'limit',
]);

/**
 * The keys of a file the import acts on, or need say nothing of: any other is
 * named in its notes. `orgs` names orgs the page has the user pick.
 */
const SCRIPT_KEYS_READ: ReadonlySet<string> = new Set([
  'objects',
  'objectSets',
  'orgs',
  'csvFileDelimiter',
  'csvReadFileDelimiter',
]);

/** The keys of `from` set to something the import does not act on, by name. */
function settingsNotRead(from: Record<string, unknown>, read: ReadonlySet<string>): string[] {
  return (
    Object.entries(from)
      // `$schema` and `$comment` speak of the file and ask nothing of a run.
      .filter(([key, value]) => !read.has(key) && !key.startsWith('$') && isSet(value))
      .map(([key]) => key)
  );
}

/**
 * What an object of the configuration does not do as SFDMU would. Those that
 * read or write more than SFDMU matter most: Sync never runs the query, so a
 * cap, or the narrowing of a slave object, would go with no word, and every
 * record of the object be read.
 */
function notesOf(entry: KeptEntry): MigrationImportNote[] {
  const notes: MigrationImportNote[] = [];
  const add = (code: MigrationImportNoteCode, detail?: string): void => {
    notes.push({ code, object: entry.object, ...(detail === undefined ? {} : { detail }) });
  };
  const { read, sfdmuOperation: operation } = entry;
  const asked = targetKeyOf(entry);
  const key = asked ?? 'Id';
  const deletes = operation === 'Delete' || operation === 'HardDelete';

  if (read.object === undefined) add('queryUnread');
  const named = entry.name || entry.objectName;
  if (named && named.toLowerCase() !== entry.object.toLowerCase()) add('nameDiffers', named);
  if (deletes) add('delete', entry.hardDelete ? 'HardDelete' : operation);
  // SFDMU keys an object that names no key on its name field, past an Insert.
  if (asked === undefined && (operation === 'Update' || operation === 'Upsert')) {
    add('defaultKey');
  }
  if (operation === 'Update' && key !== 'Id') add('updateKey', key);
  if (key !== 'Id' && !validateSoqlIdentifier(key)) add('unusableKey', key);
  else if (operation === 'Upsert' && key !== 'Id' && !key.endsWith('__c')) add('upsertKey', key);
  if (entry.fieldMappingsIgnored > 0) add('fieldMappingOff', String(entry.fieldMappingsIgnored));
  if (entry.valueRowsLeft.length > 0) add('valueRows', entry.valueRowsLeft.join(', '));
  if (entry.master === false) add('notMaster');
  const limit = entry.limit ?? read.limit;
  if (limit !== undefined) add('limit', String(limit));
  const where = whereOf(entry);
  if (where !== undefined && !isSafeSoqlWhere(where)) add('whereRefused');
  const orderBy = entry.orderBy ?? read.orderBy;
  if (orderBy !== undefined && !isSafeSoqlOrderBy(orderBy)) {
    add('queryClause', `ORDER BY ${orderBy}`);
  }
  for (const clause of read.otherClauses) add('queryClause', clause);
  if (entry.deleteOldData && !deletes) add('deleteOldData');
  if (entry.mockedFields.length > 0) add('mockFields', entry.mockedFields.join(', '));
  if (entry.settingsLeft.length > 0) add('settings', entry.settingsLeft.join(', '));
  return notes;
}

/**
 * An entry of a `fieldMapping` that names a field, rather than a target object
 * alone: both fields of the pair, as SFDMU reads one (`mapping.sourceField &&
 * mapping.targetField`).
 */
function namesAField(
  item: SfdmuFieldMappingItem,
): item is SfdmuFieldMappingItem & { sourceField: string; targetField: string } {
  return Boolean(item.sourceField) && Boolean(item.targetField);
}

/** An entry of a `fieldMapping` that maps anything: a field, or the object to a target. */
function mapsAnything(item: SfdmuFieldMappingItem): boolean {
  return namesAField(item) || Boolean(item.targetObject);
}

/**
 * The field the target matches an entry on, or `undefined` when the export
 * names none: its `externalId`, under the name a field mapping gives that
 * field in the target, as SFDMU matches it (`getMappedExternalIdFieldName`).
 * Carried under its source name, a key a mapping renames named a field the
 * mapped record no longer holds, and the run refused the object for it.
 */
function targetKeyOf(entry: KeptEntry): string | undefined {
  const key = entry.externalId;
  if (key === undefined || key.trim() === '') return undefined;
  return fieldPairsOf(entry.fieldMapping).find((m) => m.sourceField === key)?.targetField ?? key;
}

/**
 * The fields a mapping sends elsewhere, each once. A field mapped twice goes
 * where the last entry sends it, as in SFDMU, where the export's own entries
 * come after those of `FieldMapping.csv`.
 */
function fieldPairsOf(mapping: readonly SfdmuFieldMappingItem[]) {
  return [...new Map(mapping.filter(namesAField).map((m) => [m.sourceField, m])).values()];
}

/**
 * The objects of an export written to another object, as
 * {@link SfdmuTargetObjectError} names them. SFDMU takes the last target an
 * object's entries name, and an API name matches whatever its case, so a
 * target that names the object itself changes nothing. Only an object the
 * configuration takes counts, by the mapping SFDMU would apply to it: with
 * `useFieldMapping` off it applies none, so nothing goes anywhere else.
 */
function objectsSentElsewhere(entries: readonly KeptEntry[]): string[] {
  return entries.flatMap((entry) => {
    const target = entry.fieldMapping.flatMap((item) => item.targetObject || []).at(-1);
    if (target === undefined || target.toLowerCase() === entry.object.toLowerCase()) return [];
    const fields = fieldPairsOf(entry.fieldMapping).map(
      (item) => `${item.sourceField} → ${item.targetField}`,
    );
    return [`${entry.object} → ${target}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`];
  });
}

/** The delimiter of the CSV files beside an export, as SFDMU reads the two settings. */
function csvDelimiterOf(script: SfdmuExport): string {
  const asked = script.csvFileDelimiter ?? script.csvReadFileDelimiter ?? '';
  const named = new Map([
    ['comma', ','],
    ['semicolon', ';'],
    ['tab', '\t'],
    ['\\t', '\t'],
  ]);
  return named.get(asked.trim().toLowerCase()) ?? (asked || ',');
}

// ── SfdmuImporter ─────────────────────────────────────────

/**
 * Imports SFDMU export.json configurations and converts them
 * to the SandForge SyncConfig format.
 *
 * Maps:
 * - ScriptObject to SyncObjectConfig, named by the FROM of its query
 * - externalId to SyncObjectConfig.externalIdField
 * - the query's WHERE and ORDER BY to SyncObjectConfig.where and orderBy
 * - fieldMapping and FieldMapping.csv to FieldMapping[], under useFieldMapping
 * - ValueMapping.csv and valuesMapping to TransformRule[] (map_value)
 * - excludedFields to SyncObjectConfig.excludedFields
 * - master/child relationships to DependencyEdge[]
 *
 * What it cannot carry, it says, object by object, in the notes of the result.
 */
export class SfdmuImporter {
  private readonly fileReader: FileReader;

  constructor(fileReader: FileReader) {
    this.fileReader = fileReader;
  }

  /**
   * Import an SFDMU export.json file and convert to SyncConfig.
   * @param filePath - Path to the SFDMU export.json file
   * @returns The converted SyncConfig, and what it does not do as SFDMU would
   * @throws {SfdmuTargetObjectError} When it sends an object to another object.
   * @throws {SfdmuRefusal} When it is no export, or an entry names no object.
   */
  async import(filePath: string): Promise<SfdmuImport> {
    const content = await this.fileReader.readFile(filePath);
    const script = parseExport(content, basename(filePath));
    const entries = readEntries(script);
    const notes: MigrationImportNote[] = [];

    const seen = new Set<string>();
    const taken: TakenEntry[] = [];
    for (const entry of entries) {
      const left = whyLeftOut(entry);
      if (left) {
        notes.push({ ...left, object: entry.object });
      } else if (seen.has(entry.object.toLowerCase())) {
        // SFDMU runs each set apart. A configuration holds an object once, and
        // the page and the run both tell its objects apart by name.
        notes.push({ code: 'duplicate', object: entry.object, detail: entry.place });
      } else {
        seen.add(entry.object.toLowerCase());
        taken.push(entry as TakenEntry);
      }
    }

    const beside = await this.readMappingFiles(filePath, script, taken);
    const kept = taken.map((entry) => withMappings(entry, beside));
    const refused = objectsSentElsewhere(kept);
    if (refused.length > 0) throw new SfdmuTargetObjectError(refused);

    const onTheFile: MigrationImportNote[] = [...beside.notes];
    // SFDMU makes a set of `objects`, and runs each set apart.
    const sets = (script.objects.length > 0 ? 1 : 0) + (script.objectSets?.length ?? 0);
    if (sets > 1) onTheFile.push({ code: 'objectSets', detail: String(sets) });
    if (kept.some((entry) => mapOperation(entry.sfdmuOperation) !== 'delete')) {
      onTheFile.push({ code: 'everyField' });
      // SFDMU copies emails and phone numbers as read; a Sync run neutralizes
      // them unless its configuration keeps them (`contactPointsOfRun`).
      onTheFile.push({ code: 'contactPoints' });
    }
    const settings = settingsNotRead(script, SCRIPT_KEYS_READ);
    if (settings.length > 0) onTheFile.push({ code: 'settings', detail: settings.join(', ') });

    // Each object's notes together, in the order of the file.
    const place = (note: MigrationImportNote): number =>
      entries.findIndex((entry) => entry.object === note.object);
    const onObjects = [...notes, ...kept.flatMap(notesOf)].sort((a, b) => place(a) - place(b));
    const keepOrder = script.keepObjectOrderWhileExecute === true;
    return {
      config: this.convert(inRunOrder(kept, keepOrder)),
      notes: [...onTheFile, ...onObjects],
    };
  }

  /**
   * The rows of the mapping files beside an export. SFDMU reads each for the
   * objects that ask for it, and a file that is not there is no mapping.
   */
  private async readMappingFiles(
    filePath: string,
    script: SfdmuExport,
    taken: readonly SfdmuScriptObject[],
  ): Promise<MappingFiles> {
    const delimiter = csvDelimiterOf(script);
    const files: MappingFiles = { fieldRows: [], valueRows: [], notes: [] };
    if (taken.some((entry) => entry.useFieldMapping)) {
      const text = await this.readBeside(filePath, FIELD_MAPPING_FILE);
      const rows = text === undefined ? [] : readFieldMappingRows(text, delimiter);
      if (rows) files.fieldRows = rows;
      else files.notes.push({ code: 'mappingFileUnread', detail: FIELD_MAPPING_FILE });
    }
    if (taken.some((entry) => entry.useValuesMapping)) {
      const text = await this.readBeside(filePath, VALUE_MAPPING_FILE);
      const rows = text === undefined ? [] : readValueMappingRows(text, delimiter);
      if (rows) files.valueRows = rows;
      else files.notes.push({ code: 'mappingFileUnread', detail: VALUE_MAPPING_FILE });
    }
    return files;
  }

  /** The content of `fileName` beside an export, or `undefined` when it has none. */
  private async readBeside(filePath: string, fileName: string): Promise<string | undefined> {
    try {
      return await this.fileReader.readFile(join(dirname(filePath), fileName));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /**
   * Extract dependency edges from SFDMU objects.
   * Infers parent/child relationships from lookup fields in queries.
   * @param sfdmuExport - Validated SFDMU export configuration
   * @returns Array of dependency edges
   */
  extractDependencies(sfdmuExport: SfdmuExport): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    // By lower case: `from account` keeps the case it was written in.
    const objectNames = new Map(
      sfdmuExport.objects.flatMap((obj) => {
        const name = objectNameOf(obj);
        return name === undefined ? [] : [[name.toLowerCase(), name] as const];
      }),
    );

    for (const obj of sfdmuExport.objects) {
      const child = objectNameOf(obj);
      if (obj.master === false || child === undefined) {
        continue;
      }

      const fieldsFromQuery = extractFieldsFromQuery(obj.query ?? '');
      for (const field of fieldsFromQuery) {
        if (field.includes('.')) {
          const parts = field.split('.');
          const relationshipName = parts[0];
          const parent = objectNames.get(
            resolveRelationshipToObject(relationshipName).toLowerCase(),
          );
          if (parent !== undefined) {
            edges.push({
              parent,
              child,
              field: relationshipName,
            });
          }
        }
      }
    }

    return edges;
  }

  /**
   * Convert the entries an export keeps to SyncConfig.
   * @param entries - The entries, read, with their mappings
   * @returns Converted SyncConfig
   */
  private convert(entries: readonly KeptEntry[]): SyncConfig {
    const now = new Date().toISOString();
    const objects: SyncObjectConfig[] = entries.map((obj, index) => this.convertObject(obj, index));

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
   *
   * The filter and the order come from the query, where a real export holds
   * them. A key that is no field name, an SFDMU composite or a parent's path,
   * is not carried: Sync's boundary would refuse the whole configuration for
   * it, and the object's row asks for one where it needs one.
   *
   * @param obj - The entry, read, with its mappings
   * @param index - Insertion order index
   * @returns Converted SyncObjectConfig
   */
  private convertObject(obj: KeptEntry, index: number): SyncObjectConfig {
    const fieldMappings = this.convertFieldMappings(obj.fieldMapping);
    const transformRules = this.convertValuesMapping(obj.valuesMapping, fieldMappings);
    const orderBy = obj.orderBy ?? obj.read.orderBy;
    const key = targetKeyOf(obj);

    return {
      objectApiName: obj.object,
      externalIdField:
        key !== undefined && key !== 'Id' && validateSoqlIdentifier(key) ? key : undefined,
      operation: mapOperation(obj.sfdmuOperation),
      query: obj.query,
      fieldMappings,
      transformRules,
      excludedFields: obj.excludedFields,
      addOnFields: [],
      batchSize: 200,
      orderBy: orderBy !== undefined && isSafeSoqlOrderBy(orderBy) ? orderBy : undefined,
      where: whereOf(obj),
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
    return fieldPairsOf(mappings).map((m) => {
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

/** What the mapping files beside an export hold. */
interface MappingFiles {
  fieldRows: FieldMappingRow[];
  valueRows: ValueMappingRow[];
  notes: MigrationImportNote[];
}

/**
 * An entry with the mappings SFDMU would apply to it, which it reads under
 * `useFieldMapping` and `useValuesMapping` alone. A rename under the first
 * switched off was applied here all the same, on a field SFDMU writes as read.
 *
 * Fields SFDMU writes fake values into join the fields left out: Sync has no
 * fake data, and carried as read they would put real values in the target
 * where the export hid them. The note says so, and the file can take them out.
 */
function withMappings(entry: TakenEntry, files: MappingFiles): KeptEntry {
  const isItsRow = (row: { object: string }): boolean =>
    row.object.toLowerCase() === entry.object.toLowerCase();

  const fieldRows = entry.useFieldMapping ? files.fieldRows.filter(isItsRow) : [];
  const fieldItems = fieldRows.map(({ field, target }) =>
    field === '' ? { targetObject: target } : { sourceField: field, targetField: target },
  );
  // A row that maps to nothing SFDMU does not use, and writes the value as
  // read; a rule of it blanked the field.
  const valueRows = entry.useValuesMapping
    ? files.valueRows.filter((row) => isItsRow(row) && row.value.trim() !== '')
    : [];
  const valueItems = valueRows
    .filter(isExactValueRow)
    .map(({ field, rawValue, value }) => ({ fieldName: field, rawValue, mappedValue: value }));

  const deletes = mapOperation(entry.sfdmuOperation) === 'delete';
  const mockedFields = deletes ? [] : mockedFieldsOf(entry);
  return {
    ...entry,
    fieldMapping: entry.useFieldMapping ? [...fieldItems, ...entry.fieldMapping] : [],
    fieldMappingsIgnored: entry.useFieldMapping
      ? 0
      : entry.fieldMapping.filter(mapsAnything).length,
    valuesMapping: [...valueItems, ...entry.valuesMapping],
    excludedFields: [...new Set([...entry.excludedFields, ...mockedFields])],
    mockedFields,
    valueRowsLeft: valueRows
      .filter((row) => !isExactValueRow(row))
      .map((row) => `${row.field} (${row.rawValue})`),
  };
}

/**
 * The entries in the order SFDMU runs them, which becomes the configuration's.
 * SFDMU deletes before it writes, and deletes the last object listed first,
 * in the file's order only under `keepObjectOrderWhileExecute`; its query
 * forced to Id, a Delete has no lookup to order it by. Each set runs apart.
 * Kept in the file's order, an Account listed before its Cases was deleted
 * first, and every account a case named was refused, the cases deleted next.
 * Sync orders the objects it writes by their lookups, and leaves its deletes
 * where the configuration puts them.
 */
function inRunOrder(entries: readonly KeptEntry[], keepOrder: boolean): KeptEntry[] {
  const deletes = (entry: KeptEntry): boolean => mapOperation(entry.sfdmuOperation) === 'delete';
  const rank = (entry: KeptEntry, at: number): [number, number, number] =>
    deletes(entry) ? [entry.set, 0, keepOrder ? at : -at] : [entry.set, 1, at];
  return entries
    .map((entry, at) => ({ entry, rank: rank(entry, at) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
    .map(({ entry }) => entry);
}

/**
 * Map SFDMU operation to SandForge SyncOperation.
 * @param operation - An SFDMU operation a configuration can carry
 * @returns SandForge SyncOperation
 */
function mapOperation(operation: CarriedOperation): SyncObjectConfig['operation'] {
  const mapping: Record<CarriedOperation, SyncObjectConfig['operation']> = {
    Insert: 'insert',
    Update: 'update',
    Upsert: 'upsert',
    Delete: 'delete',
    HardDelete: 'delete',
  };
  return mapping[operation];
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
