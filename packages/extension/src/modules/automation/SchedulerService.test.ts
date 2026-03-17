import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerService } from './SchedulerService';
import type { SchedulerDependencies } from './SchedulerService';
import type { PipelineTrigger } from '@sandforge/shared';

function createScheduleTrigger(overrides?: Partial<PipelineTrigger>): PipelineTrigger {
  return {
    id: 'trigger-1',
    type: 'schedule',
    enabled: true,
    config: { cron: '0 8 * * *' },
    ...overrides,
  };
}

function createMockDeps(): SchedulerDependencies {
  return {
    triggerEngine: {
      getNextFireTime: vi.fn().mockReturnValue(new Date('2026-03-01T08:00:00Z')),
      evaluateTrigger: vi.fn().mockReturnValue(false),
      matchesCron: vi.fn().mockReturnValue(false),
      matchesEvent: vi.fn().mockReturnValue(false),
      getActiveTriggers: vi.fn().mockReturnValue([]),
    } as unknown as SchedulerDependencies['triggerEngine'],
  };
}

describe('SchedulerService', () => {
  let service: SchedulerService;
  let deps: SchedulerDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    service = new SchedulerService(deps);
  });

  describe('schedule', () => {
    it('should register a pipeline for scheduled execution', () => {
      const trigger = createScheduleTrigger();
      service.schedule('pipeline-1', trigger);

      expect(service.isScheduled('pipeline-1')).toBe(true);
    });

    it('should overwrite an existing schedule for the same pipeline', () => {
      const trigger1 = createScheduleTrigger({ config: { cron: '0 8 * * *' } });
      const trigger2 = createScheduleTrigger({ config: { cron: '0 12 * * *' } });

      service.schedule('pipeline-1', trigger1);
      service.schedule('pipeline-1', trigger2);

      const schedule = service.getSchedule('pipeline-1');
      expect(schedule?.config.cron).toBe('0 12 * * *');
    });
  });

  describe('unschedule', () => {
    it('should remove a pipeline from the schedule', () => {
      service.schedule('pipeline-1', createScheduleTrigger());
      service.unschedule('pipeline-1');

      expect(service.isScheduled('pipeline-1')).toBe(false);
    });

    it('should not throw when unscheduling a non-existent pipeline', () => {
      expect(() => service.unschedule('non-existent')).not.toThrow();
    });
  });

  describe('getScheduledPipelines', () => {
    it('should return all scheduled pipelines with next fire times', () => {
      service.schedule('pipeline-1', createScheduleTrigger());
      service.schedule('pipeline-2', createScheduleTrigger({ id: 'trigger-2' }));

      const scheduled = service.getScheduledPipelines();

      expect(scheduled).toHaveLength(2);
      expect(scheduled[0].pipelineId).toBe('pipeline-1');
      expect(scheduled[0].nextFireTime).toBeDefined();
    });

    it('should exclude pipelines without a computable next fire time', () => {
      vi.mocked(deps.triggerEngine.getNextFireTime).mockReturnValue(undefined);
      service.schedule('pipeline-1', createScheduleTrigger());

      const scheduled = service.getScheduledPipelines();

      expect(scheduled).toHaveLength(0);
    });

    it('should return empty array when nothing is scheduled', () => {
      expect(service.getScheduledPipelines()).toEqual([]);
    });
  });

  describe('isScheduled', () => {
    it('should return false for non-scheduled pipelines', () => {
      expect(service.isScheduled('pipeline-1')).toBe(false);
    });

    it('should return true for scheduled pipelines', () => {
      service.schedule('pipeline-1', createScheduleTrigger());
      expect(service.isScheduled('pipeline-1')).toBe(true);
    });
  });

  describe('getSchedule', () => {
    it('should return the trigger for a scheduled pipeline', () => {
      const trigger = createScheduleTrigger();
      service.schedule('pipeline-1', trigger);

      expect(service.getSchedule('pipeline-1')).toBe(trigger);
    });

    it('should return undefined for non-scheduled pipelines', () => {
      expect(service.getSchedule('non-existent')).toBeUndefined();
    });
  });
});
