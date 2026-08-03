/**
 * Target-org RecordType ID resolver — implements the engine extension
 * point {@link RecordTypeIdResolver} (types.ts).
 *
 * Resolution is by (SobjectType, DeveloperName) ONLY — labels differ
 * between orgs, mojibake included (spec pitfall 1). Results are cached
 * per (org, object, developerName): RecordType metadata is stable within
 * a load run.
 */

import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import type { RecordTypeIdResolver } from './types.js';
import type { TargetOrgAccess } from './loadTypes.js';

/**
 * Resolves target RecordType IDs through SOQL on `RecordType`.
 * Unknown (object, developerName) pairs resolve to `null` — the loader
 * then drops the RecordTypeId and lists it, never guessing by label.
 */
export class TargetRecordTypeIdResolver implements RecordTypeIdResolver {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly orgAccess: Pick<TargetOrgAccess, 'query'>) {}

  async resolveByDeveloperName(
    orgId: string,
    sobjectType: string,
    developerName: string,
  ): Promise<string | null> {
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
    this.cache.set(key, id);
    return id;
  }
}
