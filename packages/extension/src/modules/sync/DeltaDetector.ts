import type { SyncObjectConfig, DeltaResult } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/** A record returned from a Salesforce query */
export interface QueryRecord {
  Id: string;
  LastModifiedDate?: string;
  IsDeleted?: boolean;
  [key: string]: unknown;
}

/** Function to query records from an org */
export type QueryFn = (
  orgId: string,
  soql: string
) => Promise<QueryRecord[]>;

/** Dependencies required by DeltaDetector */
export interface DeltaDetectorDeps {
  query: QueryFn;
}

/**
 * Detects changes since the last sync by comparing LastModifiedDate
 * and IsDeleted fields. Returns counts of new, modified, deleted,
 * and unchanged records.
 */
export class DeltaDetector {
  private readonly deps: DeltaDetectorDeps;

  constructor(deps: DeltaDetectorDeps) {
    this.deps = deps;
  }

  /**
   * Detect changes for an object since the last sync timestamp.
   * Queries the source org and categorizes records as new, modified,
   * deleted, or unchanged.
   */
  async detect(
    config: SyncObjectConfig,
    sourceOrgId: string,
    lastSync?: string
  ): Promise<DeltaResult> {
    const allRecordsQuery = buildAllRecordsQuery(config);
    const allRecords = await this.deps.query(sourceOrgId, allRecordsQuery);

    if (!lastSync) {
      return {
        objectApiName: config.objectApiName,
        newRecords: allRecords.length,
        modifiedRecords: 0,
        deletedRecords: 0,
        unchangedRecords: 0,
      };
    }

    const lastSyncDate = new Date(lastSync);

    let newCount = 0;
    let modifiedCount = 0;
    let deletedCount = 0;
    let unchangedCount = 0;

    for (const record of allRecords) {
      if (record.IsDeleted === true) {
        deletedCount++;
        continue;
      }

      const modifiedDate = record.LastModifiedDate
        ? new Date(record.LastModifiedDate)
        : null;

      if (!modifiedDate) {
        newCount++;
        continue;
      }

      if (modifiedDate > lastSyncDate) {
        const createdDate = record.CreatedDate
          ? new Date(String(record.CreatedDate))
          : null;

        if (createdDate && createdDate > lastSyncDate) {
          newCount++;
        } else {
          modifiedCount++;
        }
      } else {
        unchangedCount++;
      }
    }

    return {
      objectApiName: config.objectApiName,
      newRecords: newCount,
      modifiedRecords: modifiedCount,
      deletedRecords: deletedCount,
      unchangedRecords: unchangedCount,
      lastSyncTimestamp: lastSync,
    };
  }
}

/**
 * Build a SOQL query to retrieve all records with metadata fields.
 */
function buildAllRecordsQuery(config: SyncObjectConfig): string {
  const fields = [
    'Id',
    'LastModifiedDate',
    'CreatedDate',
    'IsDeleted',
  ];

  let soql = `SELECT ${fields.join(', ')} FROM ${assertSoqlIdentifier(config.objectApiName)}`;

  if (config.where) {
    soql += ` WHERE ${config.where}`;
  }

  if (config.orderBy) {
    soql += ` ORDER BY ${config.orderBy}`;
  }

  return soql;
}
