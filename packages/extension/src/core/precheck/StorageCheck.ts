import type {
  PreCheckConfig,
  PreCheckItem,
  PreCheckSeverity,
  StorageCheckDetail,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Raw storage data returned by the fetch function */
export interface StorageData {
  dataStorage: { used: number; limit: number };
  fileStorage: { used: number; limit: number };
}

/** Dependency: fetches current storage usage for a given org */
export type FetchStorageFn = (orgId: string) => Promise<StorageData>;

/**
 * Checks data storage and file storage capacity against
 * the estimated impact of the planned operation.
 */
export class StorageCheck {
  private readonly fetchStorage: FetchStorageFn;

  constructor(fetchStorage: FetchStorageFn) {
    this.fetchStorage = fetchStorage;
  }

  /** Run all storage checks against the target org */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const data = await this.fetchStorage(config.targetOrgId);
    const dataImpact = this.estimateDataImpact(config);
    const fileImpact = this.estimateFileImpact(config);

    return [
      this.checkStorage(data.dataStorage, dataImpact, 'data'),
      this.checkStorage(data.fileStorage, fileImpact, 'file'),
    ];
  }

  /** Estimate data storage impact in MB */
  private estimateDataImpact(config: PreCheckConfig): number {
    const recordCount = (config.operationConfig['recordCount'] as number) ?? 0;
    const avgRecordSizeKb = (config.operationConfig['avgRecordSizeKb'] as number) ?? 2;
    return (recordCount * avgRecordSizeKb) / 1024;
  }

  /** Estimate file storage impact in MB */
  private estimateFileImpact(config: PreCheckConfig): number {
    return (config.operationConfig['fileStorageImpactMb'] as number) ?? 0;
  }

  /** Check a single storage type (data or file) */
  private checkStorage(
    storage: { used: number; limit: number },
    estimatedImpact: number,
    type: 'data' | 'file',
  ): PreCheckItem {
    const remaining = storage.limit - storage.used;
    const sufficient = remaining >= estimatedImpact;
    const usageAfter = storage.used + estimatedImpact;
    const usagePercentAfter = storage.limit > 0 ? usageAfter / storage.limit : 1;
    const severity = this.classifySeverity(usagePercentAfter, sufficient);
    const label = type === 'data' ? 'Data Storage' : 'File Storage';

    const detail: StorageCheckDetail = {
      type,
      used: storage.used,
      limit: storage.limit,
      estimatedImpact,
      sufficient,
    };

    return {
      id: randomUUID(),
      category: 'storage',
      name: label,
      description: `Checks ${label.toLowerCase()} capacity against estimated impact`,
      severity,
      passed: sufficient,
      message: sufficient
        ? `${label} sufficient: ${remaining.toFixed(1)} MB free, need ~${estimatedImpact.toFixed(1)} MB`
        : `${label} insufficient: ${remaining.toFixed(1)} MB free, need ~${estimatedImpact.toFixed(1)} MB`,
      details: detail as unknown as Record<string, unknown>,
      autoFixable: false,
    };
  }

  /** Classify severity based on projected usage after operation */
  private classifySeverity(usagePercentAfter: number, sufficient: boolean): PreCheckSeverity {
    if (!sufficient) return 'blocker';
    if (usagePercentAfter > 0.95) return 'error';
    if (usagePercentAfter > 0.8) return 'warning';
    return 'info';
  }
}
