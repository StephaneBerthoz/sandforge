import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { AnonymizeCoverageObject, SlicePlan as SlicePlanCost } from '@sandforge/shared';
import { SlicePlan, slicedObjects } from './SlicePlan';

/** An object of a coverage, cut into `slices` of `size` rows when given. */
function object(
  objectApiName: string,
  slices?: number,
  extra: Partial<AnonymizeCoverageObject> = {},
): AnonymizeCoverageObject {
  return {
    objectApiName,
    count: 10,
    backedUp: 0,
    truncated: false,
    ...(slices !== undefined ? { slicePlan: { objectApiName, size: 1_000, slices } } : {}),
    ...extra,
  };
}

const plan: SlicePlanCost = {
  requests: 18_900,
  parts: { snapshots: 1_710, updates: 17_065, reads: 125 },
  bulkBatches: 0,
  diskBytes: 1.2 * 1024 ** 3,
  seconds: 3 * 3600 + 600,
  apiBudget: { verdict: 'fits', remaining: 4_861_233, max: 5_000_000 },
};

describe('slicedObjects', () => {
  it('keeps the objects a run cuts into more than one slice', () => {
    expect(
      slicedObjects([object('Contact', 4), object('Lead', 1), object('Case')]).map(
        (o) => o.objectApiName,
      ),
    ).toEqual(['Contact']);
    expect(slicedObjects(undefined)).toEqual([]);
  });
});

describe('SlicePlan', () => {
  it('says the slices, the requests against the org’s day, no Bulk batch, the disk and the time', () => {
    render(<SlicePlan plan={plan} objects={slicedObjects([object('Contact', 4)])} testId="plan" />);

    expect(screen.getByTestId('plan-Contact').textContent).toBe(
      'Contact: 4 slices of up to 1,000 records',
    );
    expect(screen.getByTestId('plan-requests').textContent).toBe(
      'Requests: about 18,900 (backups 1,710, updates 17,065, reads 125) of the 4,861,233 the ' +
        'org has left today: they fit.',
    );
    expect(screen.getByTestId('plan-bulk').textContent).toBe(
      'Bulk API batches: none. The run writes over REST, 200 records a call.',
    );
    expect(screen.getByTestId('plan-disk').textContent).toBe('Disk: about 1.2 GB on this machine.');
    expect(screen.getByTestId('plan-time').textContent).toBe('Time: about 3h 10min.');
  });

  it('says a plan past what the org has left is no refusal, and that Resume carries on', () => {
    render(
      <SlicePlan
        plan={{ ...plan, apiBudget: { verdict: 'exceeds', remaining: 900, max: 15_000 } }}
        objects={slicedObjects([object('Contact', 4)])}
        testId="plan"
      />,
    );

    expect(screen.getByTestId('plan-requests').textContent).toBe(
      'Requests: about 18,900 (backups 1,710, updates 17,065, reads 125) of the 900 the org ' +
        'has left today: more than is left. The run goes as far as the day allows and stops ' +
        'between two slices; Resume carries on.',
    );
  });

  it('says when the org’s day was not read, and when its count is the org’s own figure', () => {
    render(
      <SlicePlan
        plan={{ ...plan, diskFree: 412 * 1024 ** 3, apiBudget: { verdict: 'unread', unread: 'x' } }}
        objects={slicedObjects([
          object('Task', 9, {
            slicePlan: { objectApiName: 'Task', size: 1_000, slices: 9, approximate: true },
          }),
        ])}
        testId="plan"
      />,
    );

    expect(screen.getByTestId('plan-requests').textContent).toBe(
      'Requests: about 18,900 (backups 1,710, updates 17,065, reads 125). What the org has ' +
        'left today was not read.',
    );
    expect(screen.getByTestId('plan-Task').textContent).toBe(
      "Task: 9 slices of up to 1,000 records (from the org's own figure, approximate: it gave up counting)",
    );
    expect(screen.getByTestId('plan-disk').textContent).toBe(
      'Disk: about 1.2 GB on this machine, 412 GB free.',
    );
  });
});
