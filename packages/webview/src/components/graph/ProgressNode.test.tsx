import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProgressNode } from './ProgressNode';
import type { ProgressFlowNode, ProgressNodeData } from './ProgressNode';
import type { NodeProps } from '@xyflow/react';
import en from '../../i18n/locales/en.json';

/** Helper to build minimal NodeProps for ProgressNode. */
function makeNodeProps(overrides: Partial<ProgressNodeData> = {}): NodeProps<ProgressFlowNode> {
  const data: ProgressNodeData = {
    objectApiName: 'Account',
    recordCount: 120,
    fieldCount: 35,
    createableFieldCount: 20,
    estimatedSizeMB: 0.12,
    status: 'idle',
    progress: 0,
    included: true,
    hasPII: false,
    piiCount: 0,
    errorCount: 0,
    edgeType: null,
    ...overrides,
  };

  return {
    id: 'test-node',
    data,
    type: 'progressNode',
    selected: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    draggable: true,
    selectable: true,
    deletable: true,
    zIndex: 0,
    dragging: false,
  };
}

/* React Flow requires a parent ReactFlow context for Handles; mock the module. */
/**
 * Real interpolation, against the real English catalogue: the node's counts used
 * to be three hardcoded English words ("records", "fields", "cloneable") shown
 * inside a French UI, so the assertions below have to read what a user reads,
 * not a key.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          en as unknown,
        );
      if (typeof template !== 'string') return key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  }),
}));

vi.mock('@xyflow/react', () => ({
  Handle: ({ type, position }: { type: string; position: string }) => (
    <div data-testid={`handle-${type}`} data-position={position} />
  ),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
}));

describe('ProgressNode', () => {
  it('should render the object name', () => {
    render(<ProgressNode {...makeNodeProps()} />);
    expect(screen.getByText('Account')).toBeDefined();
  });

  it('should render record count and size estimate', () => {
    render(<ProgressNode {...makeNodeProps({ recordCount: 1500, estimatedSizeMB: 1.5 })} />);
    expect(screen.getByText(/1.?500 records/)).toBeDefined();
    expect(screen.getByText('~1.5 MB')).toBeDefined();
  });

  it('should render field counts with cloneable', () => {
    render(<ProgressNode {...makeNodeProps({ fieldCount: 35, createableFieldCount: 20 })} />);
    expect(screen.getByText('35 fields (20 cloneable)')).toBeDefined();
  });

  it('should show progress bar when status is running', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'running', progress: 55 })} />);
    const fill = screen.getByTestId('progress-bar-fill');
    expect(fill.style.width).toBe('55%');
  });

  it('should show progress bar when status is scanning', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'scanning', progress: 30 })} />);
    expect(screen.getByTestId('progress-bar-fill')).toBeDefined();
  });

  it('should not show progress bar when idle', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'idle' })} />);
    expect(screen.queryByTestId('progress-bar-fill')).toBeNull();
  });

  it('should not show progress bar when done', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'done' })} />);
    expect(screen.queryByTestId('progress-bar-fill')).toBeNull();
  });

  it('draws a node a cancel stopped while it was written apart from a written one', () => {
    // It ended done, and the graph drew it with the check and the outline of
    // the nodes written whole.
    render(<ProgressNode {...makeNodeProps({ status: 'stopped', progress: 100 })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).toContain('border-status-warning');
    expect(node.className).not.toContain('border-status-success');
    expect(node.querySelector('svg.lucide-circle-stop')).not.toBeNull();
    expect(node.querySelector('svg.lucide-check')).toBeNull();
    // Said in words, not by its colour alone.
    expect(screen.getByTestId('node-stopped').textContent).toBe('Stopped before its end');
    expect(screen.queryByTestId('progress-bar-fill')).toBeNull();
  });

  it('says nothing of a stop on a node written whole', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'done', progress: 100 })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.querySelector('svg.lucide-check')).not.toBeNull();
    expect(screen.queryByTestId('node-stopped')).toBeNull();
  });

  it('marks a node left out of the run with a dashed outline, not faded text', () => {
    render(<ProgressNode {...makeNodeProps({ included: false })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).toContain('border-dashed');
    // At 40% opacity its name read 2.1:1 on Light Modern.
    expect(node.className).not.toMatch(/(^|\s)opacity-\d+(\s|$)/);
  });

  it('draws an included node with a solid outline', () => {
    render(<ProgressNode {...makeNodeProps({ included: true })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).not.toContain('border-dashed');
  });

  it('should show PII badge with count when hasPII is true', () => {
    render(<ProgressNode {...makeNodeProps({ hasPII: true, piiCount: 3 })} />);
    expect(screen.getByTestId('pii-badge')).toBeDefined();
    expect(screen.getByText('3 PII')).toBeDefined();
  });

  it('should not show PII badge when hasPII is false', () => {
    render(<ProgressNode {...makeNodeProps({ hasPII: false })} />);
    expect(screen.queryByTestId('pii-badge')).toBeNull();
  });

  it('should show error badge when errorCount > 0', () => {
    render(<ProgressNode {...makeNodeProps({ errorCount: 2 })} />);
    expect(screen.getByTestId('error-badge')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('should not show error badge when errorCount is 0', () => {
    render(<ProgressNode {...makeNodeProps({ errorCount: 0 })} />);
    expect(screen.queryByTestId('error-badge')).toBeNull();
  });

  it('should show MD badge for master-detail edge type', () => {
    render(<ProgressNode {...makeNodeProps({ edgeType: 'master-detail' })} />);
    expect(screen.getByTestId('edge-type-badge')).toBeDefined();
    expect(screen.getByText('MD')).toBeDefined();
  });

  it('should show LK badge for lookup edge type', () => {
    render(<ProgressNode {...makeNodeProps({ edgeType: 'lookup' })} />);
    expect(screen.getByTestId('edge-type-badge')).toBeDefined();
    expect(screen.getByText('LK')).toBeDefined();
  });

  it('should not show edge type badge when edgeType is null', () => {
    render(<ProgressNode {...makeNodeProps({ edgeType: null })} />);
    expect(screen.queryByTestId('edge-type-badge')).toBeNull();
  });

  it('should render include checkbox when onIncludeToggle is provided', () => {
    render(<ProgressNode {...makeNodeProps({ included: true, onIncludeToggle: vi.fn() })} />);
    const checkbox = screen.getByTestId('include-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('should hide include checkbox when onIncludeToggle is not provided', () => {
    render(<ProgressNode {...makeNodeProps({ onIncludeToggle: undefined })} />);
    expect(screen.queryByTestId('include-checkbox')).toBeNull();
  });

  it('should call onIncludeToggle when checkbox is toggled', () => {
    const handler = vi.fn();
    render(<ProgressNode {...makeNodeProps({ onIncludeToggle: handler })} />);
    fireEvent.click(screen.getByTestId('include-checkbox'));
    expect(handler).toHaveBeenCalledWith('Account');
  });

  /* ---- Checkbox uses onChange, not onClick+readOnly ---- */
  it('should not have readOnly attribute on checkbox', () => {
    render(<ProgressNode {...makeNodeProps({ onIncludeToggle: vi.fn() })} />);
    const checkbox = screen.getByTestId('include-checkbox') as HTMLInputElement;
    expect(checkbox.hasAttribute('readonly')).toBe(false);
  });

  it('selects the node from a button on its name, beside the checkbox and not around it', () => {
    const handler = vi.fn();
    render(<ProgressNode {...makeNodeProps({ onSelect: handler, onIncludeToggle: vi.fn() })} />);
    const node = screen.getByTestId('progress-node');
    // The card itself is no control: a control inside a control is one a
    // screen reader cannot tell apart.
    expect(node.getAttribute('role')).toBeNull();
    expect(node.hasAttribute('tabindex')).toBe(false);
    const select = screen.getByRole('button', { name: 'Show the details of Account' });
    expect(select.contains(screen.getByTestId('include-checkbox'))).toBe(false);
    fireEvent.click(select);
    expect(handler).toHaveBeenCalledWith('Account');
  });

  it('shows the name as plain text where the graph selects nothing', () => {
    render(<ProgressNode {...makeNodeProps({ onSelect: undefined })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Account')).toBeDefined();
  });

  it('should apply green border when done', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'done' })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).toContain('border-status-success');
  });

  it('should apply red border when error', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'error' })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).toContain('border-status-error');
  });

  it('should render top and bottom handles', () => {
    render(<ProgressNode {...makeNodeProps()} />);
    expect(screen.getByTestId('handle-target')).toBeDefined();
    expect(screen.getByTestId('handle-source')).toBeDefined();
  });
});

describe('a node whose counts nobody measured', () => {
  it('says so instead of stating zeroes', () => {
    // A run started from a template builds its graph locally, with zeroes, and
    // no progress event ever fills the counts in. The card used to read
    // "0 records ~0.0 MB / 0 fields (0 cloneable)" on an object being cloned.
    render(<ProgressNode {...makeNodeProps({ fieldCount: 0, recordCount: 0 })} />);
    expect(screen.getByTestId('node-counts-unknown')).toBeDefined();
    expect(screen.queryByText(/0 fields/)).toBeNull();
  });

  it('states the counts once the object has been described', () => {
    render(<ProgressNode {...makeNodeProps({ fieldCount: 35, createableFieldCount: 20 })} />);
    expect(screen.queryByTestId('node-counts-unknown')).toBeNull();
    expect(screen.getByText('35 fields (20 cloneable)')).toBeDefined();
  });
});
