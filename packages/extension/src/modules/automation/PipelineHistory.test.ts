import { describe, it, expect, beforeEach } from 'vitest';
import { PipelineHistory } from './PipelineHistory';
import type { PipelineRun } from '@sandforge/shared';

function createRun(overrides?: Partial<PipelineRun>): PipelineRun {
  return {
    id: 'run-1',
    pipelineId: 'pipeline-1',
    pipelineName: 'Test Pipeline',
    status: 'completed',
    triggeredBy: 'manual',
    stepResults: [
      {
        stepId: 'step-1',
        stepName: 'Step 1',
        stepType: 'seed',
        status: 'completed',
        startTime: '2026-01-01T00:00:00Z',
        endTime: '2026-01-01T00:01:00Z',
        duration: 60000,
      },
    ],
    variables: {},
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T00:01:00Z',
    duration: 60000,
    ...overrides,
  };
}

describe('PipelineHistory', () => {
  let history: PipelineHistory;

  beforeEach(() => {
    history = new PipelineHistory();
  });

  describe('record', () => {
    it('should store a run and create a history entry', () => {
      const run = createRun();
      history.record(run);

      expect(history.getRun('run-1')).toBeDefined();
      expect(history.getHistory('pipeline-1', 10)).toHaveLength(1);
    });

    it('should accumulate multiple runs for the same pipeline', () => {
      history.record(createRun({ id: 'run-1', startTime: '2026-01-01T00:00:00Z' }));
      history.record(createRun({ id: 'run-2', startTime: '2026-01-02T00:00:00Z' }));

      expect(history.getHistory('pipeline-1', 10)).toHaveLength(2);
    });
  });

  describe('getHistory', () => {
    it('should return entries sorted by start time descending', () => {
      history.record(createRun({ id: 'run-1', startTime: '2026-01-01T00:00:00Z' }));
      history.record(createRun({ id: 'run-2', startTime: '2026-01-03T00:00:00Z' }));
      history.record(createRun({ id: 'run-3', startTime: '2026-01-02T00:00:00Z' }));

      const entries = history.getHistory('pipeline-1', 10);
      expect(entries[0].runId).toBe('run-2');
      expect(entries[1].runId).toBe('run-3');
      expect(entries[2].runId).toBe('run-1');
    });

    it('should respect the limit parameter', () => {
      history.record(createRun({ id: 'run-1', startTime: '2026-01-01T00:00:00Z' }));
      history.record(createRun({ id: 'run-2', startTime: '2026-01-02T00:00:00Z' }));
      history.record(createRun({ id: 'run-3', startTime: '2026-01-03T00:00:00Z' }));

      expect(history.getHistory('pipeline-1', 2)).toHaveLength(2);
    });

    it('should return empty array for unknown pipeline', () => {
      expect(history.getHistory('unknown', 10)).toEqual([]);
    });
  });

  describe('getRun', () => {
    it('should return the run by ID', () => {
      history.record(createRun({ id: 'run-1' }));
      const run = history.getRun('run-1');

      expect(run).toBeDefined();
      expect(run!.id).toBe('run-1');
      expect(run!.pipelineName).toBe('Test Pipeline');
    });

    it('should return undefined for unknown run ID', () => {
      expect(history.getRun('unknown')).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('should return correct stats for a pipeline with runs', () => {
      history.record(createRun({ id: 'run-1', status: 'completed', duration: 100 }));
      history.record(createRun({ id: 'run-2', status: 'completed', duration: 200 }));
      history.record(createRun({ id: 'run-3', status: 'failed', duration: 50 }));

      const stats = history.getStats('pipeline-1');

      expect(stats.totalRuns).toBe(3);
      expect(stats.successRate).toBeCloseTo(2 / 3);
      expect(stats.avgDuration).toBeCloseTo(350 / 3);
    });

    it('should count completed_with_warnings as successful', () => {
      history.record(createRun({ id: 'run-1', status: 'completed_with_warnings', duration: 100 }));

      const stats = history.getStats('pipeline-1');
      expect(stats.successRate).toBe(1);
    });

    it('should return zero stats for unknown pipeline', () => {
      const stats = history.getStats('unknown');

      expect(stats.totalRuns).toBe(0);
      expect(stats.successRate).toBe(0);
      expect(stats.avgDuration).toBe(0);
    });
  });

  describe('clearHistory', () => {
    it('should remove all history and runs for a pipeline', () => {
      history.record(createRun({ id: 'run-1' }));
      history.record(createRun({ id: 'run-2' }));

      history.clearHistory('pipeline-1');

      expect(history.getHistory('pipeline-1', 10)).toEqual([]);
      expect(history.getRun('run-1')).toBeUndefined();
      expect(history.getRun('run-2')).toBeUndefined();
    });

    it('should not affect other pipelines', () => {
      history.record(createRun({ id: 'run-1', pipelineId: 'pipeline-1' }));
      history.record(createRun({ id: 'run-2', pipelineId: 'pipeline-2' }));

      history.clearHistory('pipeline-1');

      expect(history.getRun('run-2')).toBeDefined();
    });
  });

  describe('getRecentRuns', () => {
    it('should return runs across all pipelines sorted by time', () => {
      history.record(createRun({ id: 'run-1', pipelineId: 'p1', startTime: '2026-01-01T00:00:00Z' }));
      history.record(createRun({ id: 'run-2', pipelineId: 'p2', startTime: '2026-01-03T00:00:00Z' }));
      history.record(createRun({ id: 'run-3', pipelineId: 'p1', startTime: '2026-01-02T00:00:00Z' }));

      const recent = history.getRecentRuns(2);

      expect(recent).toHaveLength(2);
      expect(recent[0].runId).toBe('run-2');
      expect(recent[1].runId).toBe('run-3');
    });

    it('should return empty array when no runs exist', () => {
      expect(history.getRecentRuns(10)).toEqual([]);
    });
  });
});
