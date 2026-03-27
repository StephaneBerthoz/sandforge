import { describe, it, expect } from 'vitest';
import * as SyncSchedulerModule from './SyncScheduler';
import { SyncScheduleExecutor } from './SyncScheduler';

describe('SyncScheduler (re-export)', () => {
  it('should re-export SyncScheduleExecutor from the legacy module path', () => {
    expect(SyncScheduleExecutor).toBeDefined();
    expect(typeof SyncScheduleExecutor).toBe('function');
  });

  it('should be constructable with proper deps', () => {
    const executor = new SyncScheduleExecutor({
      scheduleStore: {
        loadAll: () => [],
        save: () => undefined,
        load: () => undefined,
        delete: () => true,
        list: () => [],
      },
      configStore: { load: () => undefined },
      onExecute: async () => ({
        configId: 'cfg-1',
        operationId: 'op-1',
        status: 'success' as const,
        objectResults: [],
        totalProcessed: 0,
        totalSuccess: 0,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 0,
        timestamp: new Date().toISOString(),
      }),
      notificationCenter: { notify: () => undefined },
      log: () => undefined,
    });

    expect(executor).toBeInstanceOf(SyncScheduleExecutor);
  });

  it('should not export the old parseCronField or SyncScheduler class', () => {
    const moduleExports = SyncSchedulerModule as Record<string, unknown>;
    expect(moduleExports['parseCronField']).toBeUndefined();
    expect(moduleExports['SyncScheduler']).toBeUndefined();
  });
});
