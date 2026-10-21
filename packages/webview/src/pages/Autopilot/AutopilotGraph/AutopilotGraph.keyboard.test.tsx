import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type {
  AutopilotGraph as AutopilotGraphType,
  AutopilotNode,
  PIIFieldDetection,
} from '@sandforge/shared';
import '../../../i18n';
import { AutopilotGraph } from './AutopilotGraph';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';

/**
 * The graph from the keyboard: each node is a stop, and Enter or Space picks
 * it in the store the control panel reads. React Flow's own keyboard path
 * never calls onNodeClick, and the pick it reported was dropped.
 */

beforeAll(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  };
  if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
    globalThis.DOMMatrixReadOnly = class {
      m22 = 1;
    } as unknown as typeof DOMMatrixReadOnly;
  }
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    top: 0,
    right: 800,
    bottom: 600,
    left: 0,
    toJSON: () => ({}),
  }));
});

function node(
  objectApiName: string,
  level: number,
  extra: Partial<AutopilotNode> = {},
): AutopilotNode {
  return {
    objectApiName,
    recordCount: 40,
    estimatedApiCalls: 1,
    piiFields: [],
    anonymizationRules: [],
    status: 'loading',
    progress: 50,
    insertOrder: level,
    level,
    successCount: 20,
    failureCount: 0,
    errors: [],
    elapsedMs: 0,
    apiCallsUsed: 0,
    ...extra,
  };
}

const EMAIL: PIIFieldDetection = {
  objectApiName: 'Contact',
  fieldApiName: 'Email',
  fieldLabel: 'Email',
  fieldType: 'email',
  piiCategory: 'PII',
  detectionMethod: 'field_name',
  confidence: 1,
  suggestedMethod: 'fake',
};

const GRAPH: AutopilotGraphType = {
  nodes: [
    node('Account', 0),
    node('Contact', 1, { status: 'failed', failureCount: 3, piiFields: [EMAIL] }),
  ],
  edges: [],
  cycles: [],
  stats: {
    totalObjects: 2,
    totalRelationships: 0,
    cycleCount: 0,
    maxDepth: 1,
    totalRecords: 80,
    totalEstimatedApiCalls: 2,
  },
};

function nodeWrapper(id: string): HTMLElement {
  return screen.getByTestId(`rf__node-${id}`);
}

describe('AutopilotGraph from the keyboard', () => {
  beforeEach(() => {
    act(() => {
      useAutopilotStore.getState().setGraph(GRAPH);
      useAutopilotStore.getState().selectNode(null);
    });
  });

  it('picks the focused node on Enter, and lets it go on Escape', () => {
    render(<AutopilotGraph />);
    const account = nodeWrapper('Account');
    account.focus();

    fireEvent.keyDown(account, { key: 'Enter' });
    expect(useAutopilotStore.getState().selectedNodeName).toBe('Account');
    expect(nodeWrapper('Account').getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(nodeWrapper('Account'), { key: 'Escape' });
    expect(useAutopilotStore.getState().selectedNodeName).toBeNull();
  });

  it('picks a node on Space too, and moves the pick to the next node picked', () => {
    render(<AutopilotGraph />);
    fireEvent.keyDown(nodeWrapper('Account'), { key: ' ' });
    fireEvent.keyDown(nodeWrapper('Contact'), { key: ' ' });
    expect(useAutopilotStore.getState().selectedNodeName).toBe('Contact');
    expect(nodeWrapper('Account').getAttribute('aria-pressed')).toBe('false');
  });

  it('names each node by its object, status and counts, as a button', () => {
    render(<AutopilotGraph />);
    expect(nodeWrapper('Account').getAttribute('role')).toBe('button');
    expect(nodeWrapper('Account').getAttribute('aria-label')).toBe(
      'Account: Loading. Written: 20 of 40',
    );
    expect(nodeWrapper('Contact').getAttribute('aria-label')).toBe(
      'Contact: Failed. Written: 20 of 40. 3 records failed. PII fields detected',
    );
  });

  it('says what Enter does in the panel language, not that Delete removes the node', () => {
    render(<AutopilotGraph />);
    const describedBy = nodeWrapper('Account').getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Press Enter or Space to show this object's details and pick it for Skip. Escape lets it go.",
    );
  });
});
