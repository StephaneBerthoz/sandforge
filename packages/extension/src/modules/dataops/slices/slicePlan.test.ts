import { describe, expect, it } from 'vitest';
import { MAX_SLICES_PER_SET } from '@sandforge/shared';

import { bytesWords, diskNeeded, planSlices, sliceRequests, slicesFor } from './slicePlan.js';

describe('slicePlan', () => {
  it('cuts the rows into slices of a size, one at least, which finds the object empty', () => {
    expect(slicesFor(3412877, 1_000_000)).toBe(4);
    expect(slicesFor(3002, 1000)).toBe(4);
    expect(slicesFor(1000, 1000)).toBe(1);
    expect(slicesFor(0, 1000)).toBe(1);
  });

  it('counts a slice as its pages, the clock, its updates and its duplicate reads', () => {
    expect(sliceRequests(1000, 2000, { masking: true })).toBe(1 + 1 + 5);
    expect(sliceRequests(1000, 500, { masking: true, duplicateRule: true })).toBe(2 + 1 + 5 + 2);
    expect(sliceRequests(1000, 2000, { masking: false })).toBe(2);
  });

  it('plans a masking run: slices, requests in parts, no Bulk batch, the disk and the time', () => {
    const plan = planSlices(
      [{ objectApiName: 'Contact', rows: 3002, fields: 8 }],
      1000,
      2000,
      'masking',
    );

    expect(plan.objects).toEqual([{ objectApiName: 'Contact', size: 1000, slices: 4 }]);
    // Three full slices of one page, the rest's page, the read that finds the end.
    expect(plan.parts.snapshots).toBe(3 + 1 + 1);
    expect(plan.parts.updates).toBe(Math.ceil(3002 / 200));
    // The clock before each slice, and the two counts of rows created meanwhile.
    expect(plan.parts.reads).toBe(4 + 2);
    expect(plan.requests).toBe(plan.parts.snapshots + plan.parts.updates + plan.parts.reads);
    expect(plan.diskBytes).toBe(3002 * (48 + 64 * 8));
    expect(plan.seconds).toBeGreaterThan(0);
    expect(plan.tooMany).toEqual([]);
  });

  it('plans a backup with no update, and names the objects past the slices a set holds', () => {
    const plan = planSlices(
      [
        {
          objectApiName: 'Task',
          rows: (MAX_SLICES_PER_SET + 1) * 100,
          fields: 30,
          approximate: true,
        },
        { objectApiName: 'Lead', rows: 10, fields: 30 },
      ],
      100,
      2000,
      'backup',
    );

    expect(plan.parts.updates).toBe(0);
    expect(plan.tooMany).toEqual(['Task']);
    expect(plan.objects[0]).toMatchObject({ approximate: true, slices: MAX_SLICES_PER_SET + 1 });
  });

  it('wants a tenth more disk free than the snapshots take, and says bytes as a person reads them', () => {
    expect(diskNeeded(1000)).toBe(1100);
    expect(bytesWords(800)).toBe('800 bytes');
    expect(bytesWords(80 * 1024)).toBe('80 KB');
    expect(bytesWords(1.2 * 1024 ** 3)).toBe('1.2 GB');
  });
});
