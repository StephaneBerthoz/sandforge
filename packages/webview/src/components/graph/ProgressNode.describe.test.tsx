import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { NodeProps } from '@xyflow/react';
import '../../i18n';
import { ProgressNode } from './ProgressNode';
import type { ProgressFlowNode, ProgressNodeData } from './ProgressNode';

/**
 * What a node's keyboard stops say besides its name, in the real catalogue:
 * its status, its counts, its badges. The status was an icon and the errors a
 * bare figure, and a screen reader in graph view missed an object that failed.
 */

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

function props(overrides: Partial<ProgressNodeData>): NodeProps<ProgressFlowNode> {
  return {
    id: 'Contact',
    data: {
      objectApiName: 'Contact',
      recordCount: 1200,
      fieldCount: 60,
      createableFieldCount: 40,
      estimatedSizeMB: 2.4,
      status: 'error',
      progress: 100,
      included: true,
      hasPII: true,
      piiCount: 3,
      errorCount: 2,
      edgeType: 'lookup',
      onSelect: vi.fn(),
      onIncludeToggle: vi.fn(),
      ...overrides,
    },
    type: 'progressNode',
    selected: false,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    draggable: false,
    selectable: true,
    deletable: false,
    zIndex: 0,
    dragging: false,
  };
}

/** The text of every element an element's aria-describedby names, in order. */
function description(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? `<missing ${id}>`)
    .join(' | ');
}

describe('ProgressNode keyboard stops', () => {
  it('describe the name button with the status, the counts, the personal fields and the errors', () => {
    render(<ProgressNode {...props({})} />);
    expect(description(screen.getByTestId('progress-node-select'))).toBe(
      'Failed | 1,200 records~2.4 MB60 fields (40 cloneable) | 3 PII | 2 errors',
    );
  });

  it('describe the include checkbox the same way', () => {
    render(<ProgressNode {...props({ status: 'idle', hasPII: false, errorCount: 0 })} />);
    expect(description(screen.getByTestId('include-checkbox'))).toBe(
      'Not started | 1,200 records~2.4 MB60 fields (40 cloneable)',
    );
  });

  it('say a node a cancel stopped was stopped before its end', () => {
    render(<ProgressNode {...props({ status: 'stopped', errorCount: 0, hasPII: false })} />);
    expect(description(screen.getByTestId('progress-node-select'))).toBe(
      'Stopped | 1,200 records~2.4 MB60 fields (40 cloneable) | Stopped before its end',
    );
  });
});
