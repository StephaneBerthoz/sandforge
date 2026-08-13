import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ForgeNodeDetail } from './ForgeNodeDetail';
import type { ForgeGraphNode } from '../../stores/useForgeStore';

/*
 * The include switch is a bare track/thumb pair: the label sits in a sibling
 * span, so without aria-label the switch has no accessible name at all.
 */

/** Factory to create a test node with sane defaults. */
function makeNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 150,
    fieldCount: 25,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

describe('ForgeNodeDetail include switch — accessible name', () => {
  it('should name the include switch', () => {
    render(
      <ForgeNodeDetail node={makeNode()} onToggleIncluded={vi.fn()} onToggleAnonymize={vi.fn()} />,
    );
    expect(screen.getByTestId('node-include-toggle').getAttribute('aria-label')).toBe(
      'Include in execution',
    );
  });

  it('should expose the switch by role and name', () => {
    render(
      <ForgeNodeDetail
        node={makeNode({ included: false })}
        onToggleIncluded={vi.fn()}
        onToggleAnonymize={vi.fn()}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Include in execution' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
