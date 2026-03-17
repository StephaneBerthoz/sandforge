import type {
  SyncConfig,
  SyncObjectConfig,
  DeltaResult,
  ConflictRecord,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';

/** Impact analysis result for a single object. */
export interface ObjectImpactAnalysis {
  objectApiName: string;
  operation: string;
  delta: DeltaResult;
  conflicts: ConflictRecord[];
  mappingCount: number;
  transformCount: number;
  estimatedApiCalls: number;
  riskLevel: 'low' | 'medium' | 'high';
  riskReasons: string[];
}

/** Full sync impact analysis result. */
export interface SyncImpactAnalysis {
  objects: ObjectImpactAnalysis[];
  totalNewRecords: number;
  totalModifiedRecords: number;
  totalDeletedRecords: number;
  totalConflicts: number;
  estimatedDuration: number;
  estimatedApiCalls: number;
  overallRisk: 'low' | 'medium' | 'high';
  warnings: string[];
}

/** Connection abstraction for sync analysis. */
export interface SyncAnalyzerConnection {
  queryCount(orgId: string, soql: string): Promise<number>;
  queryModifiedSince(orgId: string, objectName: string, since: string): Promise<number>;
  detectConflicts(
    sourceOrgId: string,
    targetOrgId: string,
    objectName: string,
    matchField: string,
  ): Promise<ConflictRecord[]>;
}

/**
 * Analyzes a sync configuration to produce impact metrics,
 * conflict previews, and risk assessments before execution.
 */
export class SyncAnalyzer {
  /** Average records per second for estimation. */
  private static readonly RECORDS_PER_SEC = 200;

  /**
   * Perform a full impact analysis of a sync configuration.
   */
  async analyze(
    conn: SyncAnalyzerConnection,
    config: SyncConfig,
  ): Promise<SyncImpactAnalysis> {
    const objectAnalyses: ObjectImpactAnalysis[] = [];
    const warnings: string[] = [];

    for (const objConfig of config.objects) {
      const analysis = await this.analyzeObject(conn, config, objConfig);
      objectAnalyses.push(analysis);
    }

    const totalNew = objectAnalyses.reduce((sum, a) => sum + a.delta.newRecords, 0);
    const totalMod = objectAnalyses.reduce((sum, a) => sum + a.delta.modifiedRecords, 0);
    const totalDel = objectAnalyses.reduce((sum, a) => sum + a.delta.deletedRecords, 0);
    const totalConflicts = objectAnalyses.reduce((sum, a) => sum + a.conflicts.length, 0);
    const totalApiCalls = objectAnalyses.reduce((sum, a) => sum + a.estimatedApiCalls, 0);
    const totalRecords = totalNew + totalMod + totalDel;
    const estimatedDuration = Math.ceil(totalRecords / SyncAnalyzer.RECORDS_PER_SEC);

    // Generate warnings
    if (totalDel > 0) {
      warnings.push(`${totalDel} records will be deleted`);
    }
    if (totalConflicts > 0) {
      warnings.push(`${totalConflicts} conflicts detected — review conflict strategy`);
    }
    if (config.mode === 'full' && totalMod > 1000) {
      warnings.push('Full sync with >1000 modifications — consider incremental mode');
    }
    const highRiskObjects = objectAnalyses.filter((a) => a.riskLevel === 'high');
    if (highRiskObjects.length > 0) {
      warnings.push(`${highRiskObjects.length} high-risk objects require attention`);
    }

    const overallRisk = this.computeOverallRisk(objectAnalyses, totalConflicts, totalDel);

    return {
      objects: objectAnalyses,
      totalNewRecords: totalNew,
      totalModifiedRecords: totalMod,
      totalDeletedRecords: totalDel,
      totalConflicts,
      estimatedDuration,
      estimatedApiCalls: totalApiCalls,
      overallRisk,
      warnings,
    };
  }

  /**
   * Analyze a single object's sync impact.
   */
  private async analyzeObject(
    conn: SyncAnalyzerConnection,
    config: SyncConfig,
    objConfig: SyncObjectConfig,
  ): Promise<ObjectImpactAnalysis> {
    const riskReasons: string[] = [];

    // Count source records
    let sourceCount: number;
    try {
      const whereClause = objConfig.where ? ` WHERE ${objConfig.where}` : '';
      sourceCount = await conn.queryCount(
        config.sourceOrgId,
        `SELECT COUNT() FROM ${assertSoqlIdentifier(objConfig.objectApiName)}${whereClause}`,
      );
    } catch {
      sourceCount = 0;
    }

    // Detect delta
    const delta: DeltaResult = {
      objectApiName: objConfig.objectApiName,
      newRecords: objConfig.operation === 'insert' ? sourceCount : 0,
      modifiedRecords: objConfig.operation === 'update' || objConfig.operation === 'upsert' ? sourceCount : 0,
      deletedRecords: objConfig.operation === 'delete' ? sourceCount : 0,
      unchangedRecords: 0,
      lastSyncTimestamp: undefined,
    };

    // Detect conflicts (only for bidirectional)
    let conflicts: ConflictRecord[] = [];
    if (config.direction === 'bidirectional' && objConfig.externalIdField) {
      try {
        conflicts = await conn.detectConflicts(
          config.sourceOrgId,
          config.targetOrgId,
          objConfig.objectApiName,
          objConfig.externalIdField,
        );
      } catch {
        conflicts = [];
      }
    }

    // Risk assessment
    if (objConfig.operation === 'delete') {
      riskReasons.push('Delete operation');
    }
    if (sourceCount > 10000) {
      riskReasons.push(`High volume: ${sourceCount.toLocaleString()} records`);
    }
    if (conflicts.length > 0) {
      riskReasons.push(`${conflicts.length} conflicts detected`);
    }
    if (objConfig.batchSize > 200) {
      riskReasons.push('Batch size exceeds recommended 200');
    }

    const mappingCount = objConfig.fieldMappings.length;
    const transformCount = objConfig.transformRules.length;
    const estimatedApiCalls = Math.ceil(sourceCount / (objConfig.batchSize || 200));

    return {
      objectApiName: objConfig.objectApiName,
      operation: objConfig.operation,
      delta,
      conflicts,
      mappingCount,
      transformCount,
      estimatedApiCalls,
      riskLevel: this.assessObjectRisk(riskReasons, sourceCount, conflicts.length),
      riskReasons,
    };
  }

  /** Assess risk for a single object. */
  private assessObjectRisk(
    reasons: string[],
    recordCount: number,
    conflictCount: number,
  ): 'low' | 'medium' | 'high' {
    if (reasons.some((r) => r.includes('Delete'))) return 'high';
    if (conflictCount > 10) return 'high';
    if (recordCount > 10000) return 'medium';
    if (conflictCount > 0) return 'medium';
    if (reasons.length >= 2) return 'medium';
    return 'low';
  }

  /** Compute overall risk from all object analyses. */
  private computeOverallRisk(
    analyses: ObjectImpactAnalysis[],
    totalConflicts: number,
    totalDeleted: number,
  ): 'low' | 'medium' | 'high' {
    if (analyses.some((a) => a.riskLevel === 'high')) return 'high';
    if (totalDeleted > 0) return 'high';
    if (totalConflicts > 0) return 'medium';
    if (analyses.some((a) => a.riskLevel === 'medium')) return 'medium';
    return 'low';
  }
}
