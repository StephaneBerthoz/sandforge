/**
 * The record types of both orgs a Sync run writes between, read once a run.
 *
 * A record type's id is the org's own: the same type, deployed to two orgs
 * from the same metadata, has two ids. A Sync sent `RecordTypeId` as it read
 * it, and run into a client sandbox that shared none of the source's ids, the
 * target refused every row carrying one — "INVALID_CROSS_REFERENCE_KEY: Record
 * Type ID: this ID value isn't valid for the user". Forge has always looked the
 * type up in the target by its object, namespace and API name
 * (`RecordTypeMapper`); a Sync now reads the same two lists, the same way, and
 * maps by the same rule.
 *
 * Read beside them, the target's person account record types: what tells, as
 * Forge tells it, a person account the target takes as a business one because
 * the type it goes in with is a business account's.
 */

import { ACCOUNT } from '../../core/common/platformRecords.js';
import { queryAllPages, type PagedQuerySource } from '../forge/queryAllPages.js';
import {
  RECORD_TYPES_SOQL,
  RecordTypeMapper,
  parseRecordTypeRows,
  type RecordTypeInfo,
  type RecordTypeMapping,
} from './RecordTypeMapper.js';

/** The record types a Sync run maps `RecordTypeId` with. */
export interface SyncRecordTypes {
  /**
   * Each active record type of the source with the target's of the same
   * object, namespace and API name.
   */
  mappings: readonly RecordTypeMapping[];
  /** The source's active record types: what names one the target has no counterpart of. */
  source: readonly RecordTypeInfo[];
  /**
   * The target's active record types: what names, by its id, one the running
   * user may not use there — `ns__Retail` for a package's, whatever the
   * describe calls it — and tells that the target holds a namesake of an
   * unmapped one under another namespace.
   */
  target?: readonly RecordTypeInfo[];
  /**
   * The ids of the target's person account record types, by their first
   * fifteen characters. Absent when the target has no person accounts, or
   * they could not be read.
   */
  personTypes?: ReadonlySet<string>;
}

/** The target's person account record types, as Forge reads them (`personRecordTypesInTarget`). */
const PERSON_TYPES_SOQL = `SELECT Id FROM RecordType WHERE SobjectType = '${ACCOUNT}' AND IsPersonType = true`;

/**
 * The record types of both orgs, and how each of the source's maps to the
 * target's (`RecordTypeMapper.buildMapping`): two reads, and a third of the
 * target's person account types, which an org without person accounts refuses
 * — it has no `IsPersonType` — and which is then left out.
 *
 * @throws When either org refuses the read of its record types: a run that
 *   cannot map them says so rather than send the source's ids.
 */
export async function readSyncRecordTypes(
  source: PagedQuerySource<Record<string, unknown>>,
  target: PagedQuerySource<Record<string, unknown>>,
): Promise<SyncRecordTypes> {
  const [sourceTypes, targetTypes] = await Promise.all([
    queryAllPages(source, RECORD_TYPES_SOQL).then(({ records }) => parseRecordTypeRows(records)),
    queryAllPages(target, RECORD_TYPES_SOQL).then(({ records }) => parseRecordTypeRows(records)),
  ]);
  let personTypes: ReadonlySet<string> | undefined;
  try {
    const { records } = await queryAllPages(target, PERSON_TYPES_SOQL);
    personTypes = new Set(
      records.flatMap((row) => (typeof row.Id === 'string' ? [row.Id.slice(0, 15)] : [])),
    );
  } catch {
    personTypes = undefined;
  }
  return {
    mappings: new RecordTypeMapper().buildMapping(sourceTypes, targetTypes),
    source: sourceTypes,
    target: targetTypes,
    ...(personTypes ? { personTypes } : {}),
  };
}
