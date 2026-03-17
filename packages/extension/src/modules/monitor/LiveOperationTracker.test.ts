import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiveOperationTracker } from './LiveOperationTracker';

describe('LiveOperationTracker', () => {
  let tracker: LiveOperationTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new LiveOperationTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a new operation', () => {
    tracker.register('op-1', 'sync', 'Syncing Account', 500);
    const ops = tracker.getAll();
    expect(ops).toHaveLength(1);
    expect(ops[0].operationId).toBe('op-1');
    expect(ops[0].module).toBe('sync');
    expect(ops[0].status).toBe('running');
    expect(ops[0].totalRecords).toBe(500);
  });

  it('updates progress correctly', () => {
    tracker.register('op-1', 'seed', 'Seeding Contact', 100);
    vi.advanceTimersByTime(2000);
    tracker.updateProgress('op-1', 50, 50, 100, 'Step 2');
    const op = tracker.get('op-1');
    expect(op?.percentage).toBe(50);
    expect(op?.processedRecords).toBe(50);
    expect(op?.currentStep).toBe('Step 2');
    expect(op?.recordsPerSecond).toBeGreaterThan(0);
  });

  it('ignores progress update for unknown operation', () => {
    tracker.updateProgress('unknown', 50, 50, 100, 'Step 2');
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('marks operation as completed', () => {
    tracker.register('op-1', 'sync', 'Syncing Account', 500);
    tracker.complete('op-1');
    const op = tracker.get('op-1');
    expect(op?.status).toBe('completed');
    expect(op?.percentage).toBe(100);
  });

  it('auto-removes completed operations after 30s', () => {
    tracker.register('op-1', 'sync', 'Syncing Account', 500);
    tracker.complete('op-1');
    expect(tracker.getAll()).toHaveLength(1);
    vi.advanceTimersByTime(31_000);
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('marks operation as failed with error', () => {
    tracker.register('op-1', 'dataops', 'Backup', 200);
    tracker.fail('op-1', 'Connection timeout');
    const op = tracker.get('op-1');
    expect(op?.status).toBe('failed');
    expect(op?.error).toBe('Connection timeout');
  });

  it('auto-removes failed operations after 60s', () => {
    tracker.register('op-1', 'dataops', 'Backup', 200);
    tracker.fail('op-1', 'Error');
    vi.advanceTimersByTime(61_000);
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('pauses and resumes an operation', () => {
    tracker.register('op-1', 'sync', 'Syncing', 100);
    tracker.pause('op-1');
    expect(tracker.get('op-1')?.status).toBe('paused');
    tracker.resume('op-1');
    expect(tracker.get('op-1')?.status).toBe('running');
  });

  it('cancels an operation', () => {
    tracker.register('op-1', 'sync', 'Syncing', 100);
    tracker.cancel('op-1');
    expect(tracker.get('op-1')?.status).toBe('cancelled');
  });

  it('getActive returns only running or paused', () => {
    tracker.register('op-1', 'sync', 'Syncing', 100);
    tracker.register('op-2', 'seed', 'Seeding', 200);
    tracker.complete('op-2');
    expect(tracker.getActive()).toHaveLength(1);
    expect(tracker.getActive()[0].operationId).toBe('op-1');
  });

  it('activeCount returns count of active operations', () => {
    tracker.register('op-1', 'sync', 'Syncing', 100);
    tracker.register('op-2', 'seed', 'Seeding', 200);
    expect(tracker.activeCount).toBe(2);
    tracker.complete('op-2');
    expect(tracker.activeCount).toBe(1);
  });

  it('notifies change handlers', () => {
    const handler = vi.fn();
    tracker.onChange(handler);
    tracker.register('op-1', 'sync', 'Syncing', 100);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ operationId: 'op-1' }),
    ]));
  });

  it('stops notifying after offChange', () => {
    const handler = vi.fn();
    tracker.onChange(handler);
    tracker.register('op-1', 'sync', 'Syncing', 100);
    tracker.offChange(handler);
    tracker.register('op-2', 'seed', 'Seeding', 200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('clamps percentage between 0 and 100', () => {
    tracker.register('op-1', 'sync', 'Syncing', 100);
    tracker.updateProgress('op-1', 150, 50, 100, 'Step');
    expect(tracker.get('op-1')?.percentage).toBe(100);
    tracker.updateProgress('op-1', -10, 50, 100, 'Step');
    expect(tracker.get('op-1')?.percentage).toBe(0);
  });

  it('handles complete on unknown operation gracefully', () => {
    tracker.complete('unknown');
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('handles fail on unknown operation gracefully', () => {
    tracker.fail('unknown', 'Error');
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('handles pause on unknown operation gracefully', () => {
    tracker.pause('unknown');
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('handles resume on unknown operation gracefully', () => {
    tracker.resume('unknown');
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('handles cancel on unknown operation gracefully', () => {
    tracker.cancel('unknown');
    expect(tracker.getAll()).toHaveLength(0);
  });

  it('tracks multiple operations simultaneously', () => {
    tracker.register('op-1', 'sync', 'Sync A', 100);
    tracker.register('op-2', 'seed', 'Seed B', 200);
    tracker.register('op-3', 'dataops', 'Backup C', 300);
    expect(tracker.getAll()).toHaveLength(3);
    expect(tracker.activeCount).toBe(3);
  });
});
