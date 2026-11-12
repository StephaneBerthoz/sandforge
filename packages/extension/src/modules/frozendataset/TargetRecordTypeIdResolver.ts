/**
 * Target-org RecordType ID resolver — implements the engine extension
 * point {@link RecordTypeIdResolver} (types.ts).
 *
 * Resolution is by (SobjectType, NamespacePrefix, DeveloperName) ONLY —
 * labels differ between orgs, mojibake included, and a package's record type
 * can carry the DeveloperName of the org's own on the same object. Results
 * are cached per (org, object, namespace, developerName): RecordType metadata
 * is stable within a load run.
 *
 * It also says what the target gives a record sent without a record type,
 * from the describe it holds: what a record whose type the user cannot use
 * goes in as once the type is dropped.
 */

import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { parseRecordTypeInfos } from '../../core/metadata/recordTypeAvailability.js';
import { recordTypeGivenOf, type GivenRecordType } from '../../core/metadata/recordTypeGiven.js';
import {
  findRecordTypeByParts,
  parseNamespacedRecordTypes,
  partsOfRecordTypeName,
  partsOfRow,
  type RecordTypeNameParts,
} from '../../core/metadata/recordTypeNames.js';
import type { AmbiguousRecordType, RecordTypeIdResolver, UnavailableRecordType } from './types.js';
import type { TargetObjectDescribe, TargetOrgAccess } from './loadTypes.js';

type Resolved = string | null | UnavailableRecordType | AmbiguousRecordType;

/**
 * Resolves target RecordType IDs through SOQL on `RecordType`.
 * Unknown (object, developerName) pairs resolve to `null` — the loader
 * then drops the RecordTypeId and lists it, never guessing by label.
 */
export class TargetRecordTypeIdResolver implements RecordTypeIdResolver {
  private readonly cache = new Map<string, Resolved>();
  private readonly describes = new Map<string, Promise<TargetObjectDescribe>>();

  /**
   * @param orgAccess - `query` finds the record type; `describe`, when given,
   *   says whether the running user may use it. The `RecordType` table does
   *   not: run for real, a product record type resolved there, active, and
   *   every product naming it was refused as "not valid for the user".
   */
  constructor(
    private readonly orgAccess: Pick<TargetOrgAccess, 'query'> &
      Partial<Pick<TargetOrgAccess, 'describe'>>,
  ) {}

  async resolveByDeveloperName(
    orgId: string,
    sobjectType: string,
    developerName: string,
    namespacePrefix?: string | null,
  ): Promise<Resolved> {
    const wanted: RecordTypeNameParts =
      namespacePrefix === undefined
        ? partsOfRecordTypeName(developerName)
        : { namespacePrefix, developerName };
    const key = `${orgId}|${sobjectType}|${String(wanted.namespacePrefix)}|${wanted.developerName}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // Every record type of the object that carries the DeveloperName, in any
    // namespace: which of them the name means is told here, not by the org.
    const soql =
      'SELECT Id, DeveloperName, NamespacePrefix FROM RecordType WHERE ' +
      `SobjectType = '${sanitizeSoqlValue(sobjectType)}' AND ` +
      `DeveloperName = '${sanitizeSoqlValue(wanted.developerName)}'`;
    const rows = parseNamespacedRecordTypes(await this.orgAccess.query(orgId, soql));
    const match = findRecordTypeByParts(wanted, rows, partsOfRow);
    let resolved: Resolved;
    if ('ambiguous' in match) {
      resolved = { ambiguous: true, carriers: match.ambiguous.map(partsOfRow) };
    } else if ('found' in match) {
      const id = match.found.id;
      resolved = (await this.isUnavailable(orgId, sobjectType, id))
        ? { unavailable: true as const, id }
        : id;
    } else {
      resolved = null;
    }
    this.cache.set(key, resolved);
    return resolved;
  }

  /** Whether the running user's describe marks this record type unavailable. */
  private async isUnavailable(orgId: string, sobjectType: string, id: string): Promise<boolean> {
    const held = this.describeOf(orgId, sobjectType);
    if (!held) return false;
    const info = (await held).recordTypeInfos?.find((rt) => rt.recordTypeId === id);
    return info?.available === false;
  }

  /**
   * What the target gives a record of the object sent without a record type,
   * for the running user, from the describe held: undefined with no describe.
   */
  async givenRecordType(orgId: string, sobjectType: string): Promise<GivenRecordType | undefined> {
    const held = this.describeOf(orgId, sobjectType);
    if (!held) return undefined;
    return recordTypeGivenOf(parseRecordTypeInfos((await held).recordTypeInfos));
  }

  /** The running user's describe of the object, read once; undefined when it cannot be read. */
  private describeOf(
    orgId: string,
    sobjectType: string,
  ): Promise<TargetObjectDescribe> | undefined {
    const describe = this.orgAccess.describe;
    if (!describe) return undefined;
    const key = `${orgId}|${sobjectType}`;
    let pending = this.describes.get(key);
    if (!pending) {
      pending = describe(orgId, sobjectType);
      this.describes.set(key, pending);
    }
    return pending;
  }
}
