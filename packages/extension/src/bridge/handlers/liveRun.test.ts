import { describe, it, expect, afterEach } from 'vitest';

import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { listLive } from './liveRun.js';

describe('listLive', () => {
  const tracker = new LiveOperationTracker();
  afterEach(() => tracker.dispose());

  it('lists the run as running under its id, module and description', () => {
    listLive(tracker, 'op-1', 'dataops', 'Backup 2 object(s)', 2);
    expect(tracker.get('op-1')).toMatchObject({
      module: 'dataops',
      description: 'Backup 2 object(s)',
      status: 'running',
      totalRecords: 2,
    });
  });

  it('moves the run on as it reports its progress', () => {
    const live = listLive(tracker, 'op-2', 'dataops', 'Rollback 1 object(s)');
    live.progress(50, 1, 2, 'Restored Contact');
    expect(tracker.get('op-2')).toMatchObject({
      percentage: 50,
      processedRecords: 1,
      totalRecords: 2,
      currentStep: 'Restored Contact',
    });
  });

  it('ends a run once: a failure after a cancel leaves it cancelled', () => {
    const live = listLive(tracker, 'op-3', 'dataops', 'Anonymizing');
    live.cancel();
    live.fail('The query was aborted');
    live.complete();
    expect(tracker.get('op-3')?.status).toBe('cancelled');
    expect(tracker.get('op-3')?.error).toBeUndefined();
  });

  it('keeps the reason of a run that failed, and ignores progress after its end', () => {
    const live = listLive(tracker, 'op-4', 'automation', 'Pipeline');
    live.fail('INSUFFICIENT_ACCESS');
    live.progress(90, 9, 10, 'late');
    expect(tracker.get('op-4')).toMatchObject({ status: 'failed', error: 'INSUFFICIENT_ACCESS' });
    expect(tracker.get('op-4')?.currentStep).toBe('Pipeline');
  });

  it('lists nothing and throws nothing without a tracker', () => {
    const live = listLive(undefined, 'op-5', 'dataops', 'Backup');
    expect(() => {
      live.progress(10, 1, 10, 'x');
      live.complete();
    }).not.toThrow();
  });
});
