import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import '../../../i18n';
import { ObjectNode } from './ObjectNode';
import type { ObjectNodeData } from './ObjectNode';
import type { NodeProps } from 'reactflow';

/** Default test data for ObjectNode. */
const defaultData: ObjectNodeData = {
  objectApiName: 'Account',
  recordCount: 5200,
  status: 'extracting',
  progress: 45,
  successCount: 2340,
  failureCount: 0,
  elapsedMs: 12500,
  apiCallsUsed: 24,
  hasPii: true,
  isSelected: false,
};

/** Minimal NodeProps wrapper for testing a custom node. */
function makeNodeProps(data: ObjectNodeData): NodeProps<ObjectNodeData> {
  return {
    id: 'test-node',
    data,
    type: 'objectNode',
    selected: false,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    dragging: false,
  };
}

/** Render helper that wraps the node in ReactFlowProvider. */
function renderObjectNode(data: ObjectNodeData = defaultData) {
  return render(
    <ReactFlowProvider>
      <ObjectNode {...makeNodeProps(data)} />
    </ReactFlowProvider>,
  );
}

describe('ObjectNode', () => {
  it('should render without crashing', () => {
    renderObjectNode();
    expect(screen.getByTestId('object-node')).toBeDefined();
  });

  it('should display the object API name', () => {
    renderObjectNode();
    expect(screen.getByText('Account')).toBeDefined();
  });

  it('should display record count', () => {
    renderObjectNode();
    expect(screen.getByTestId('record-count').textContent).toBe('2340 / 5200');
  });

  it('should display elapsed time formatted', () => {
    renderObjectNode();
    expect(screen.getByTestId('elapsed-time').textContent).toBe('12s');
  });

  it('should show PII indicator when hasPii is true', () => {
    renderObjectNode({ ...defaultData, hasPii: true });
    expect(screen.getByTestId('pii-indicator')).toBeDefined();
  });

  it('should not show PII indicator when hasPii is false', () => {
    renderObjectNode({ ...defaultData, hasPii: false });
    expect(screen.queryByTestId('pii-indicator')).toBeNull();
  });

  it('should render progress bar with correct width', () => {
    renderObjectNode({ ...defaultData, progress: 60 });
    const bar = screen.getByTestId('progress-bar');
    expect(bar.style.width).toBe('60%');
  });

  it('should render with pending status', () => {
    renderObjectNode({ ...defaultData, status: 'pending', progress: 0 });
    expect(screen.getByTestId('object-node')).toBeDefined();
  });

  it('should render with failed status', () => {
    renderObjectNode({ ...defaultData, status: 'failed', progress: 30 });
    expect(screen.getByTestId('object-node')).toBeDefined();
  });

  it('should render with completed status', () => {
    renderObjectNode({ ...defaultData, status: 'completed', progress: 100, successCount: 5200 });
    expect(screen.getByTestId('record-count').textContent).toBe('5200 / 5200');
  });
});
