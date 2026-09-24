import { describe, it, expect } from 'vitest';

import { STATUS_NEEDS_CHILDREN } from './status-children.js';

describe('STATUS_NEEDS_CHILDREN', () => {
  it('gives an order its status past Draft only with its items, named by their order', () => {
    // The target refused an activated order with nothing on it: "an order
    // must include at least one product".
    expect(STATUS_NEEDS_CHILDREN['Order']).toEqual({ object: 'OrderItem', lookup: 'OrderId' });
  });

  it('names no child of its own object', () => {
    for (const [parent, child] of Object.entries(STATUS_NEEDS_CHILDREN)) {
      expect(child.object).not.toBe(parent);
    }
  });
});
