import { describe, it, expect } from 'vitest';

import { leftOutAsEmptyTable } from './forge-graph-nodes.js';

describe('leftOutAsEmptyTable', () => {
  it('holds for a node discovery left out because it counted no row', () => {
    expect(leftOutAsEmptyTable({ included: false, recordCount: 0, status: 'idle' })).toBe(true);
  });

  it('does not hold for a node left out because its count or its describe failed', () => {
    // Discovery counts such a node 0, as it counts an empty table.
    expect(leftOutAsEmptyTable({ included: false, recordCount: 0, status: 'error' })).toBe(false);
  });

  it('does not hold for a table with rows, left out or not', () => {
    expect(leftOutAsEmptyTable({ included: false, recordCount: 9, status: 'idle' })).toBe(false);
    expect(leftOutAsEmptyTable({ included: true, recordCount: 9, status: 'idle' })).toBe(false);
  });

  it('does not hold for an empty table the run reads all the same', () => {
    // A run asked not to skip empty objects reads each of them.
    expect(leftOutAsEmptyTable({ included: true, recordCount: 0, status: 'idle' })).toBe(false);
  });
});
