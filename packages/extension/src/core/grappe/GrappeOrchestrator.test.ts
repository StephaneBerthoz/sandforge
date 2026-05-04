import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GrappeOrchestrator } from './GrappeOrchestrator';
import type { GrappeOrchestratorDeps, GrappeOrchestratorListener } from './GrappeOrchestrator';
import type { GrappePartitioner } from './GrappePartitioner';
import type { GrappeWorkerManager } from './GrappeWorkerManager';
import type { GrappeAggregator } from './GrappeAggregator';
import type { GrappeScheduler } from './GrappeScheduler';
import type { BackPressureManager } from './BackPressureManager';
import type { GrappeMonitor } from './GrappeMonitor';
import type {
  GrappeConfig,
  GrappePartition,
  GrappeProgress,
  GrappeResult,
  AggregatedGrappeResult,
} from '@sandforge/shared';

function createConfig(overrides: Partial<GrappeConfig> = {}): GrappeConfig {
  return {
    enabled: true,
    autoActivateThreshold: 1000,
    maxWorkers: 2,
    grappeSize: 5,
    strategy: 'round_robin',
    backPressure: {
      enabled: false,
      maxQueueDepth: 100,
      highWaterMark: 80,
      lowWaterMark: 60,
      strategy: 'pause',
      monitoringInterval: 1000,
    },
    checkpointing: false,
    isolationLevel: 'none',
    ...overrides,
  };
}

function createPartition(overrides: Partial<GrappePartition> = {}): GrappePartition {
  const progress: GrappeProgress = {
    processedRecords: 0,
    totalRecords: 3,
    successCount: 0,
    failureCount: 0,
    percentage: 0,
    recordsPerSecond: 0,
  };

  return {
    id: 'p-001',
    index: 0,
    totalPartitions: 1,
    recordCount: 3,
    records: ['r1', 'r2', 'r3'],
    dependencies: [],
    status: 'pending',
    progress,
    retryCount: 0,
    ...overrides,
  };
}

function createResult(overrides: Partial<GrappeResult> = {}): GrappeResult {
  return {
    grappeId: 'p-001',
    status: 'success',
    processedRecords: 3,
    successCount: 3,
    failureCount: 0,
    errors: [],
    duration: 50,
    ...overrides,
  };
}

function createAggregatedResult(
  overrides: Partial<AggregatedGrappeResult> = {},
): AggregatedGrappeResult {
  return {
    operationId: 'op-001',
    totalPartitions: 1,
    completedPartitions: 1,
    failedPartitions: 0,
    totalRecords: 3,
    successRecords: 3,
    failedRecords: 0,
    duration: 50,
    partitionResults: [createResult()],
    ...overrides,
  };
}

function createMockDeps(): GrappeOrchestratorDeps {
  const partition = createPartition();

  const partitioner = {
    partition: vi.fn().mockReturnValue([partition]),
    selectStrategy: vi.fn().mockReturnValue('round_robin'),
    getPartitionCount: vi.fn().mockReturnValue(1),
    setMetadata: vi.fn(),
  } as unknown as GrappePartitioner;

  const workerManager = {
    createWorkers: vi.fn(),
    assignPartition: vi.fn().mockReturnValue(0),
    releaseWorker: vi.fn(),
    getWorkerStatus: vi.fn().mockReturnValue({
      workerId: 0,
      active: false,
      processedGrappes: 0,
      queuedGrappes: 0,
    }),
    getAllWorkerStatuses: vi.fn().mockReturnValue([]),
    getAvailableWorkerCount: vi.fn().mockReturnValue(2),
    processPartition: vi
      .fn()
      .mockImplementation(
        async (
          _workerId: number,
          _partition: GrappePartition,
          processFn: (records: string[]) => Promise<GrappeResult>,
        ) => processFn(_partition.records),
      ),
  } as unknown as GrappeWorkerManager;

  const aggregator = {
    addResult: vi.fn(),
    aggregate: vi.fn().mockReturnValue(createAggregatedResult()),
    getPartialResults: vi.fn().mockReturnValue([]),
    getOverallProgress: vi.fn().mockReturnValue({
      processedRecords: 0,
      totalRecords: 0,
      successCount: 0,
      failureCount: 0,
      percentage: 0,
      recordsPerSecond: 0,
    }),
    reset: vi.fn(),
  } as unknown as GrappeAggregator;

  const scheduler = {
    schedule: vi.fn().mockReturnValue([[partition]]),
    getNextBatch: vi.fn().mockReturnValue([]),
    canExecute: vi.fn().mockReturnValue(true),
    reorderByPriority: vi.fn().mockImplementation((partitions: GrappePartition[]) => partitions),
  } as unknown as GrappeScheduler;

  const backPressureManager = {
    evaluate: vi.fn().mockReturnValue('normal'),
    shouldPause: vi.fn().mockReturnValue(false),
    shouldThrottle: vi.fn().mockReturnValue(false),
    getDelay: vi.fn().mockReturnValue(0),
    getLevel: vi.fn().mockReturnValue('normal'),
    reset: vi.fn(),
  } as unknown as BackPressureManager;

  const monitor = {
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    updatePartitionStatus: vi.fn(),
    updateProgress: vi.fn(),
    getOperationStatus: vi.fn().mockReturnValue({
      operationId: 'op-001',
      workers: [],
      backPressureLevel: 'normal',
      apiUsagePercent: 0,
      partitions: [],
      overallProgress: {
        processedRecords: 0,
        totalRecords: 0,
        successCount: 0,
        failureCount: 0,
        percentage: 0,
        recordsPerSecond: 0,
      },
    }),
    getEstimatedTimeRemaining: vi.fn().mockReturnValue(0),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    isMonitoring: vi.fn().mockReturnValue(true),
  } as unknown as GrappeMonitor;

  return {
    partitioner,
    workerManager,
    aggregator,
    scheduler,
    backPressureManager,
    monitor,
  };
}

describe('GrappeOrchestrator', () => {
  let orchestrator: GrappeOrchestrator;
  let deps: GrappeOrchestratorDeps;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new GrappeOrchestrator(deps);
  });

  describe('shouldActivateGrappe', () => {
    it('should return true when record count exceeds threshold and enabled', () => {
      const config = createConfig({
        enabled: true,
        autoActivateThreshold: 100,
      });
      expect(orchestrator.shouldActivateGrappe(200, config)).toBe(true);
    });

    it('should return false when record count is below threshold', () => {
      const config = createConfig({
        enabled: true,
        autoActivateThreshold: 1000,
      });
      expect(orchestrator.shouldActivateGrappe(500, config)).toBe(false);
    });

    it('should return false when grappe is disabled', () => {
      const config = createConfig({
        enabled: false,
        autoActivateThreshold: 100,
      });
      expect(orchestrator.shouldActivateGrappe(200, config)).toBe(false);
    });

    it('should return true when record count equals threshold', () => {
      const config = createConfig({
        enabled: true,
        autoActivateThreshold: 100,
      });
      expect(orchestrator.shouldActivateGrappe(100, config)).toBe(true);
    });
  });

  describe('execute', () => {
    it('should partition records, schedule, and return aggregated result', async () => {
      const config = createConfig();
      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      const result = await orchestrator.execute(['r1', 'r2', 'r3'], config, processFn);

      expect(deps.partitioner.partition).toHaveBeenCalled();
      expect(deps.scheduler.schedule).toHaveBeenCalled();
      expect(deps.workerManager.createWorkers).toHaveBeenCalledWith(2);
      expect(deps.aggregator.reset).toHaveBeenCalled();
      expect(deps.monitor.startMonitoring).toHaveBeenCalled();
      expect(result.operationId).toBe('op-001');
    });

    it('should emit started and completed events', async () => {
      const startedListener = vi.fn<GrappeOrchestratorListener>();
      const completedListener = vi.fn<GrappeOrchestratorListener>();

      orchestrator.on('started', startedListener);
      orchestrator.on('completed', completedListener);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await orchestrator.execute(['r1'], createConfig(), processFn);

      expect(startedListener).toHaveBeenCalledOnce();
      expect(completedListener).toHaveBeenCalledOnce();
    });

    it('should emit failed event when execution throws', async () => {
      const failedListener = vi.fn<GrappeOrchestratorListener>();
      orchestrator.on('failed', failedListener);

      (deps.partitioner.partition as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Partition error');
      });

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();

      await expect(orchestrator.execute(['r1'], createConfig(), processFn)).rejects.toThrow(
        'Partition error',
      );

      expect(failedListener).toHaveBeenCalledOnce();
      expect(failedListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'failed',
          error: 'Partition error',
        }),
      );
    });

    it('should not deadlock when no workers are available and wavePromises is empty', async () => {
      const config = createConfig();
      const partition = createPartition();

      (deps.partitioner.partition as ReturnType<typeof vi.fn>).mockReturnValue([partition]);
      (deps.scheduler.schedule as ReturnType<typeof vi.fn>).mockReturnValue([[partition]]);
      (deps.workerManager.getAvailableWorkerCount as ReturnType<typeof vi.fn>).mockReturnValue(0);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      // Should complete without hanging, even though availableWorkers is 0
      // and wavePromises is empty at the start of the wave
      const result = await orchestrator.execute(['r1', 'r2', 'r3'], config, processFn);

      expect(result).toBeDefined();
    });

    it('should handle partition processing failures gracefully', async () => {
      const failingPartition = createPartition({ id: 'fail-p' });
      (deps.partitioner.partition as ReturnType<typeof vi.fn>).mockReturnValue([failingPartition]);
      (deps.scheduler.schedule as ReturnType<typeof vi.fn>).mockReturnValue([[failingPartition]]);
      (deps.workerManager.processPartition as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Worker failed'),
      );

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();

      const result = await orchestrator.execute(['r1'], createConfig(), processFn);

      expect(deps.aggregator.addResult).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failure',
          errors: ['Worker failed'],
        }),
      );
      expect(result).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('should return undefined before any execution', () => {
      expect(orchestrator.getStatus()).toBeUndefined();
    });

    it('should return status after execution', async () => {
      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await orchestrator.execute(['r1'], createConfig(), processFn);

      expect(orchestrator.getStatus()).toBeDefined();
    });
  });

  describe('pause / resume', () => {
    it('should emit paused event when pause is called', async () => {
      const listener = vi.fn<GrappeOrchestratorListener>();
      orchestrator.on('paused', listener);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await orchestrator.execute(['r1'], createConfig(), processFn);

      orchestrator.pause();

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'paused' }));
    });

    it('should emit resumed event when resume is called', async () => {
      const listener = vi.fn<GrappeOrchestratorListener>();
      orchestrator.on('resumed', listener);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await orchestrator.execute(['r1'], createConfig(), processFn);

      orchestrator.pause();
      orchestrator.resume();

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'resumed' }));
    });
  });

  describe('cancel', () => {
    it('should stop processing when cancelled', () => {
      orchestrator.cancel();
      expect(orchestrator.getStatus()).toBeUndefined();
    });
  });

  describe('on / off', () => {
    it('should register and call event listeners', async () => {
      const listener = vi.fn<GrappeOrchestratorListener>();
      orchestrator.on('started', listener);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await orchestrator.execute(['r1'], createConfig(), processFn);

      expect(listener).toHaveBeenCalledOnce();
    });

    it('should stop calling removed listeners', async () => {
      const listener = vi.fn<GrappeOrchestratorListener>();
      orchestrator.on('started', listener);
      orchestrator.off('started', listener);

      const processFn = vi.fn<(records: string[]) => Promise<GrappeResult>>();
      processFn.mockResolvedValue(createResult());

      await orchestrator.execute(['r1'], createConfig(), processFn);

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
