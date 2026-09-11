import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProgressNode } from './ProgressNode';
import type { ProgressNodeData } from './ProgressNode';
import type { NodeProps } from 'reactflow';

/** Helper to build minimal NodeProps for ProgressNode. */
function makeNodeProps(overrides: Partial<ProgressNodeData> = {}): NodeProps<ProgressNodeData> {
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
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    dragging: false,
  };
}

/* React Flow requires a parent ReactFlow context for Handles; mock the module. */
vi.mock('reactflow', () => ({
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

  it('should apply dim styling when not included', () => {
    render(<ProgressNode {...makeNodeProps({ included: false })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).toContain('opacity-40');
  });

  it('should not apply dim styling when included', () => {
    render(<ProgressNode {...makeNodeProps({ included: true })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).not.toContain('opacity-40');
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

  it('should call onSelect with the object name when clicked', () => {
    const handler = vi.fn();
    render(<ProgressNode {...makeNodeProps({ onSelect: handler })} />);
    fireEvent.click(screen.getByTestId('progress-node'));
    expect(handler).toHaveBeenCalledWith('Account');
  });

  it('should call onSelect when Enter key is pressed', () => {
    const handler = vi.fn();
    render(<ProgressNode {...makeNodeProps({ onSelect: handler })} />);
    fireEvent.keyDown(screen.getByTestId('progress-node'), { key: 'Enter' });
    expect(handler).toHaveBeenCalledWith('Account');
  });

  it('should apply green border when done', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'done' })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).toContain('border-green-500');
  });

  it('should apply red border when error', () => {
    render(<ProgressNode {...makeNodeProps({ status: 'error' })} />);
    const node = screen.getByTestId('progress-node');
    expect(node.className).toContain('border-red-500');
  });

  it('should render top and bottom handles', () => {
    render(<ProgressNode {...makeNodeProps()} />);
    expect(screen.getByTestId('handle-target')).toBeDefined();
    expect(screen.getByTestId('handle-source')).toBeDefined();
  });
});
