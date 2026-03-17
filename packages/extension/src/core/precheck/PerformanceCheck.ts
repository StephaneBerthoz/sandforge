import type {
  PreCheckConfig,
  PreCheckItem,
  PreCheckEstimations,
  GrappeConfig,
} from '@sandforge/shared';
import { randomUUID } from 'crypto';

/** Dependency: provides performance-related org metrics */
export interface PerformanceMetrics {
  avgResponseTimeMs: number;
  recordCount: number;
  objectCount: number;
  hasComplexTriggers: boolean;
  networkLatencyMs: number;
}

/** Dependency: fetches performance metrics for the org */
export type FetchPerformanceMetricsFn = (
  orgId: string,
  operationConfig: Record<string, unknown>
) => Promise<PerformanceMetrics>;

/** Grappe recommendation threshold: use grappe mode above this record count */
const GRAPPE_THRESHOLD = 10_000;

/** Maximum recommended batch size for optimal performance */
const MAX_BATCH_SIZE = 10_000;

/** Base overhead time in milliseconds for any operation */
const BASE_OVERHEAD_MS = 5_000;

/**
 * Estimates operation performance including duration, batch sizing,
 * grappe mode recommendation, and optimal parallel worker count.
 */
export class PerformanceCheck {
  private readonly fetchMetrics: FetchPerformanceMetricsFn;

  constructor(fetchMetrics: FetchPerformanceMetricsFn) {
    this.fetchMetrics = fetchMetrics;
  }

  /** Run performance checks and return advisory items */
  async check(config: PreCheckConfig): Promise<PreCheckItem[]> {
    const metrics = await this.fetchMetrics(
      config.targetOrgId,
      config.operationConfig
    );
    const estimations = this.computeEstimations(config, metrics);
    const items: PreCheckItem[] = [];

    items.push(this.checkEstimatedDuration(estimations));
    items.push(this.checkBatchSize(config, metrics));
    items.push(this.checkGrappeRecommendation(estimations, metrics));
    items.push(this.checkParallelWorkers(metrics));

    return items;
  }

  /** Compute full performance estimations for the operation */
  estimatePerformance(
    config: PreCheckConfig,
    metrics: PerformanceMetrics
  ): PreCheckEstimations {
    return this.computeEstimations(config, metrics);
  }

  /** Internal: compute estimations from config and metrics */
  private computeEstimations(
    config: PreCheckConfig,
    metrics: PerformanceMetrics
  ): PreCheckEstimations {
    const recordCount = metrics.recordCount;
    const batchSize = (config.operationConfig['batchSize'] as number) ?? 200;
    const batches = Math.ceil(recordCount / batchSize);
    const triggerMultiplier = metrics.hasComplexTriggers ? 2.5 : 1.0;
    const timePerBatch = (metrics.avgResponseTimeMs + metrics.networkLatencyMs) * triggerMultiplier;
    const duration = BASE_OVERHEAD_MS + (batches * timePerBatch);
    const apiCalls = batches + 5;
    const avgRecordSizeKb = (config.operationConfig['avgRecordSizeKb'] as number) ?? 2;
    const dataStorageImpact = (recordCount * avgRecordSizeKb) / 1024;
    const fileStorageImpact = (config.operationConfig['fileStorageImpactMb'] as number) ?? 0;
    const bulkJobs = batches > 1 ? Math.ceil(batches / 100) : 0;
    const grappeRecommendation = recordCount > GRAPPE_THRESHOLD;

    let optimalGrappeConfig: GrappeConfig | undefined;
    if (grappeRecommendation) {
      optimalGrappeConfig = this.computeOptimalGrappeConfig(recordCount, metrics);
    }

    return {
      duration,
      apiCalls,
      dataStorageImpact,
      fileStorageImpact,
      bulkJobs,
      grappeRecommendation,
      optimalGrappeConfig,
    };
  }

  /** Compute optimal grappe configuration based on data volume and metrics */
  private computeOptimalGrappeConfig(
    recordCount: number,
    metrics: PerformanceMetrics
  ): GrappeConfig {
    const maxWorkers = Math.min(Math.ceil(recordCount / 5_000), 8);
    const grappeSize = Math.ceil(recordCount / maxWorkers);

    return {
      enabled: true,
      autoActivateThreshold: GRAPPE_THRESHOLD,
      maxWorkers,
      grappeSize,
      strategy: metrics.objectCount > 3 ? 'dependency_aware' : 'round_robin',
      backPressure: {
        enabled: true,
        maxQueueDepth: maxWorkers * 2,
        highWaterMark: 0.8,
        lowWaterMark: 0.3,
        strategy: 'throttle',
        monitoringInterval: 5_000,
      },
      checkpointing: recordCount > 50_000,
      isolationLevel: recordCount > 100_000 ? 'per_grappe' : 'per_object',
    };
  }

  /** Check if estimated duration is reasonable */
  private checkEstimatedDuration(estimations: PreCheckEstimations): PreCheckItem {
    const durationMinutes = estimations.duration / 60_000;
    let severity: 'info' | 'warning' | 'error';

    if (durationMinutes > 60) {
      severity = 'error';
    } else if (durationMinutes > 15) {
      severity = 'warning';
    } else {
      severity = 'info';
    }

    return {
      id: randomUUID(),
      category: 'performance',
      name: 'Estimated Duration',
      description: 'Estimates total operation duration',
      severity,
      passed: durationMinutes <= 60,
      message: `Estimated duration: ${durationMinutes.toFixed(1)} minutes`,
      details: {
        durationMs: estimations.duration,
        durationMinutes,
        apiCalls: estimations.apiCalls,
        bulkJobs: estimations.bulkJobs,
      },
      autoFixable: false,
    };
  }

  /** Check if the configured batch size is optimal */
  private checkBatchSize(config: PreCheckConfig, metrics: PerformanceMetrics): PreCheckItem {
    const batchSize = (config.operationConfig['batchSize'] as number) ?? 200;
    const recommendedSize = metrics.hasComplexTriggers ? 200 : 2_000;
    const isOptimal = batchSize <= MAX_BATCH_SIZE && Math.abs(batchSize - recommendedSize) < recommendedSize;

    return {
      id: randomUUID(),
      category: 'performance',
      name: 'Batch Size',
      description: 'Evaluates the configured batch size for optimal performance',
      severity: isOptimal ? 'info' : 'warning',
      passed: true,
      message: isOptimal
        ? `Batch size ${batchSize} is appropriate`
        : `Batch size ${batchSize} may not be optimal — recommended: ${recommendedSize}`,
      details: { configuredBatchSize: batchSize, recommendedSize, hasComplexTriggers: metrics.hasComplexTriggers },
      autoFixable: false,
    };
  }

  /** Check if grappe mode should be recommended */
  private checkGrappeRecommendation(
    estimations: PreCheckEstimations,
    metrics: PerformanceMetrics
  ): PreCheckItem {
    const recommended = estimations.grappeRecommendation;

    return {
      id: randomUUID(),
      category: 'performance',
      name: 'Grappe Mode Recommendation',
      description: 'Evaluates whether grappe (parallel partition) mode is recommended',
      severity: recommended ? 'warning' : 'info',
      passed: true,
      message: recommended
        ? `Grappe mode recommended for ${metrics.recordCount} records (threshold: ${GRAPPE_THRESHOLD})`
        : `Grappe mode not needed for ${metrics.recordCount} records`,
      details: {
        recordCount: metrics.recordCount,
        threshold: GRAPPE_THRESHOLD,
        recommended,
        optimalConfig: estimations.optimalGrappeConfig,
      },
      autoFixable: false,
    };
  }

  /** Check optimal parallel worker count */
  private checkParallelWorkers(metrics: PerformanceMetrics): PreCheckItem {
    const optimalWorkers = Math.min(Math.ceil(metrics.recordCount / 5_000), 8);
    const isLargeDataset = metrics.recordCount > GRAPPE_THRESHOLD;

    return {
      id: randomUUID(),
      category: 'performance',
      name: 'Parallel Workers',
      description: 'Recommends optimal parallel worker count',
      severity: 'info',
      passed: true,
      message: isLargeDataset
        ? `Recommended ${optimalWorkers} parallel worker(s) for ${metrics.recordCount} records`
        : `Single-threaded processing sufficient for ${metrics.recordCount} records`,
      details: { optimalWorkers, recordCount: metrics.recordCount },
      autoFixable: false,
    };
  }
}
