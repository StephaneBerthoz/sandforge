/**
 * How a record type is named, keyed and found across two orgs.
 *
 * A DeveloperName is unique within an object and a namespace, not within an
 * object: a managed package — an industry cloud, a CPQ — can install on
 * Account a record type that carries the very DeveloperName of one the org
 * made itself. Keyed by object and DeveloperName alone, the two shared a key
 * and the last one read took it, silently. `RecordType.NamespacePrefix` tells
 * them apart: a package's record type matches the same package's in the other
 * org, the org's own matches the org's own, never one the other.
 *
 * Named as metadata names them: `ns__Retail` for package `ns`'s, `Retail`
 * for the org's own. A DeveloperName never holds two underscores in a row,
 * so the first `__` of a name is where its namespace ends.
 */

import * as z from 'zod';

/**
 * Every record type of an org, inactive ones too, with its namespace: what
 * names each record type a describe lists, joined by its id.
 */
export const RECORD_TYPE_NAMES_SOQL =
  'SELECT Id, SobjectType, DeveloperName, NamespacePrefix FROM RecordType';

/** A record type as the `RecordType` table gives it, by its namespace and DeveloperName. */
export interface NamespacedRecordType {
  id: string;
  /** The DeveloperName, without the namespace. */
  developerName: string;
  /**
   * The package's namespace; `null` for the org's own. Absent when the row
   * was read without it: matched then as the org's own.
   */
  namespacePrefix?: string | null;
  sobjectType?: string;
}

/** One row of {@link RECORD_TYPE_NAMES_SOQL}: external input, checked before it is read. */
const namespacedRowSchema = z
  .object({
    Id: z.string().min(15),
    DeveloperName: z.string().min(1),
    NamespacePrefix: z.string().nullable().optional(),
    SobjectType: z.string().min(1).optional(),
  })
  .loose();

/**
 * The record types in rows of {@link RECORD_TYPE_NAMES_SOQL}; a row of the
 * wrong shape is left out rather than guessed at, and an empty namespace read
 * as none.
 */
export function parseNamespacedRecordTypes(rows: unknown): NamespacedRecordType[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const parsed = namespacedRowSchema.safeParse(row);
    if (!parsed.success) return [];
    const { Id, DeveloperName, NamespacePrefix, SobjectType } = parsed.data;
    return [
      {
        id: Id,
        developerName: DeveloperName,
        namespacePrefix: NamespacePrefix ? NamespacePrefix : null,
        ...(SobjectType ? { sobjectType: SobjectType } : {}),
      },
    ];
  });
}

/** The namespace and the DeveloperName a name holds. */
export interface RecordTypeNameParts {
  /**
   * The package's namespace, `null` for the org's own, `undefined` when the
   * name does not say: a bare name read from a source that leaves the
   * namespace out.
   */
  namespacePrefix: string | null | undefined;
  developerName: string;
}

/** `ns__Retail` for package `ns`'s record type, `Retail` for the org's own. */
export function qualifiedRecordTypeName(
  namespacePrefix: string | null | undefined,
  developerName: string,
): string {
  return namespacePrefix ? `${namespacePrefix}__${developerName}` : developerName;
}

/** A row's name: {@link qualifiedRecordTypeName} of its namespace and DeveloperName. */
export function recordTypeNameOf(type: NamespacedRecordType): string {
  return qualifiedRecordTypeName(type.namespacePrefix, type.developerName);
}

/** A row's namespace and DeveloperName; a row read without its namespace is the org's own. */
export function partsOfRow(type: NamespacedRecordType): RecordTypeNameParts {
  return { namespacePrefix: type.namespacePrefix ?? null, developerName: type.developerName };
}

/**
 * The key two orgs' record types are matched by: object, namespace and
 * DeveloperName. A row read without its namespace keys as the org's own.
 */
export function recordTypeMatchKey(type: NamespacedRecordType): string {
  return `${type.sobjectType ?? ''}::${type.namespacePrefix ?? ''}::${type.developerName}`;
}

/**
 * What a written name says: `ns__Retail` names package `ns`'s Retail, and a
 * bare `Retail` a DeveloperName whose namespace it does not say.
 */
export function partsOfRecordTypeName(name: string): RecordTypeNameParts {
  const at = name.indexOf('__');
  if (at > 0 && at < name.length - 2) {
    return { namespacePrefix: name.slice(0, at), developerName: name.slice(at + 2) };
  }
  return { namespacePrefix: undefined, developerName: name };
}

/** What a name finds among the record types of one object in one org. */
export type RecordTypeNameMatch<T> =
  { readonly found: T } | { readonly ambiguous: readonly T[] } | { readonly none: true };

/**
 * The record type `name` names among `types`, those of one object in one org.
 *
 * `ns__Retail` finds package `ns`'s Retail and no other. A bare `Retail` finds
 * the one record type whose DeveloperName it is, whatever its namespace — a
 * decision or a template written before the namespace was read named a
 * package's record type so, and keeps working. When a package's and the
 * org's own both carry it, a bare name is the org's own, as Salesforce reads
 * one: refusing it left the org's own record type with no name a decision
 * could give it, and the package's is written `ns__Retail`.
 *
 * @param partsOf - Each record type's namespace and DeveloperName.
 */
export function findRecordTypeByName<T>(
  name: string,
  types: readonly T[],
  partsOf: (type: T) => RecordTypeNameParts,
): RecordTypeNameMatch<T> {
  const match = findRecordTypeByParts(partsOfRecordTypeName(name), types, partsOf);
  if (!('ambiguous' in match)) return match;
  const own = match.ambiguous.filter((type) => partsOf(type).namespacePrefix === null);
  return own.length === 1 ? { found: own[0] } : match;
}

/**
 * {@link findRecordTypeByName} for a namespace and a DeveloperName read apart:
 * a namespace given — `null` for the org's own — finds that one and no other;
 * one left `undefined`, the one record type of that DeveloperName.
 */
export function findRecordTypeByParts<T>(
  wanted: RecordTypeNameParts,
  types: readonly T[],
  partsOf: (type: T) => RecordTypeNameParts,
): RecordTypeNameMatch<T> {
  const candidates = types.filter((type) => {
    const parts = partsOf(type);
    if (parts.developerName !== wanted.developerName) return false;
    return wanted.namespacePrefix === undefined || parts.namespacePrefix === wanted.namespacePrefix;
  });
  if (candidates.length === 1) return { found: candidates[0] };
  if (candidates.length > 1) return { ambiguous: candidates };
  return { none: true };
}

/** `ns__Retail, of package ns`, or `Retail, the org's own`, as the parts of a name say. */
export function describedRecordTypeName(parts: RecordTypeNameParts): string {
  const name = qualifiedRecordTypeName(parts.namespacePrefix, parts.developerName);
  if (parts.namespacePrefix) return `${name}, of package ${parts.namespacePrefix}`;
  return parts.namespacePrefix === null ? `${name}, the org's own` : name;
}

/**
 * Why a bare name is not taken for one record type: two of the object carry
 * it, each named, a package's with its namespace.
 *
 * @param where - `the source`, `the target org`.
 */
export function ambiguousRecordTypeReason(
  objectApiName: string,
  name: string,
  where: string,
  carriers: readonly RecordTypeNameParts[],
): string {
  return (
    `${name} names ${carriers.length} ${objectApiName} record types in ${where}: ` +
    carriers.map(describedRecordTypeName).join(' and ')
  );
}
