/**
 * Target-org RecordType ID resolver — implements the engine extension
 * point {@link RecordTypeIdResolver} (types.ts).
 *
 * Resolution is by (SobjectType, DeveloperName) ONLY — labels differ
 * between orgs, mojibake included. Results are cached
 * per (org, object, developerName): RecordType metadata is stable within
 * a load run.
 */

import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import type { RecordTypeIdResolver, UnavailableRecordType } from './types.js';
import type { TargetObjectDescribe, TargetOrgAccess } from './loadTypes.js';

/**
 * Resolves target RecordType IDs through SOQL on `RecordType`.
 * Unknown (object, developerName) pairs resolve to `null` — the loader
 * then drops the RecordTypeId and lists it, never guessing by label.
 */
export class TargetRecordTypeIdResolver implements RecordTypeIdResolver {
  private readonly cache = new Map<string, string | null | UnavailableRecordType>();
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
  ): Promise<string | null | UnavailableRecordType> {
    const key = `${orgId}|${sobjectType}|${developerName}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const soql =
      'SELECT Id FROM RecordType WHERE ' +
      `SobjectType = '${sanitizeSoqlValue(sobjectType)}' AND ` +
      `DeveloperName = '${sanitizeSoqlValue(developerName)}' LIMIT 1`;
    const rows = await this.orgAccess.query(orgId, soql);
    const id = typeof rows[0]?.Id === 'string' ? (rows[0].Id as string) : null;
    const resolved =
      id && (await this.isUnavailable(orgId, sobjectType, id))
        ? { unavailable: true as const, id }
        : id;
    this.cache.set(key, resolved);
    return resolved;
  }

  /** Whether the running user's describe marks this record type unavailable. */
  private async isUnavailable(orgId: string, sobjectType: string, id: string): Promise<boolean> {
    const describe = this.orgAccess.describe;
    if (!describe) return false;
    const key = `${orgId}|${sobjectType}`;
    let pending = this.describes.get(key);
    if (!pending) {
      pending = describe(orgId, sobjectType);
      this.describes.set(key, pending);
    }
    const info = (await pending).recordTypeInfos?.find((rt) => rt.recordTypeId === id);
    return info?.available === false;
  }
}
