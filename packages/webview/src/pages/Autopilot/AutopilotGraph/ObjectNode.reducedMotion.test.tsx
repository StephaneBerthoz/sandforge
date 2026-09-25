import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import '../../../i18n';
import { MotionProvider } from '../../../motion/MotionProvider';
import { ObjectNode } from './ObjectNode';
import type { ObjectFlowNode, ObjectNodeData } from './ObjectNode';

/**
 * framer-motion reads the system setting once, the first time a component asks
 * for it, so the setting is in place before anything in this file renders.
 */
beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

const extracting: ObjectNodeData = {
  objectApiName: 'Account',
  recordCount: 5200,
  status: 'extracting',
  progress: 45,
  successCount: 2340,
  failureCount: 0,
  elapsedMs: 12500,
  apiCallsUsed: 24,
  hasPii: false,
  isSelected: false,
};

describe('ObjectNode under reduced motion', () => {
  it('holds a running node still, its opacity included', async () => {
    // MotionConfig's reducedMotion="user" stops transforms only: the scale
    // stopped, and the node kept fading between 1 and 0.9 every 1.5 s.
    const props = {
      id: 'account',
      data: extracting,
      type: 'objectNode',
      selected: false,
      isConnectable: true,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      draggable: true,
      selectable: true,
      deletable: true,
      zIndex: 0,
      dragging: false,
    } as NodeProps<ObjectFlowNode>;
    render(
      <MotionProvider>
        <ReactFlowProvider>
          <ObjectNode {...props} />
        </ReactFlowProvider>
      </MotionProvider>,
    );

    const node = screen.getByTestId('object-node');
    // jsdom computes no opacity, so framer-motion first brings the node in from
    // 0; a browser starts it at 1. The pulse is what comes after.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const opacities: string[] = [];
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      opacities.push(node.style.opacity);
    }

    expect(opacities.filter((o) => o !== '' && o !== '1')).toEqual([]);
  });
});
