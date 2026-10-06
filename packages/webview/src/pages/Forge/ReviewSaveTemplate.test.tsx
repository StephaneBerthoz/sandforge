import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { BaseMessage, ForgeGraph, ForgeGraphNode, ForgeTemplate } from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewSaveTemplate } from './ReviewSaveTemplate';

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 5,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

const GRAPH: ForgeGraph = {
  nodes: [
    node('Account'),
    node('Contact', { piiFields: ['Email', 'Phone'], anonymizeFields: ['Email'] }),
    node('Task', { recordCount: 40 }),
  ],
  edges: [],
  totalRecords: 60,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** The template the last save sent to the extension. */
function savedTemplate(): ForgeTemplate {
  const sent = mockPostMessage.mock.calls
    .map((call) => call[0] as { payload: BaseMessage & { payload: { template: ForgeTemplate } } })
    .filter((envelope) => envelope.payload.type === 'forge:templates:save');
  const last = sent[sent.length - 1];
  if (!last) throw new Error('no template was saved');
  return last.payload.payload.template;
}

describe('ReviewSaveTemplate', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig({
      inputMode: 'record',
      recordId: '001000000000001AAA',
      depth: 'direct',
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      anonymizePII: true,
      skipEmpty: false,
      batchSize: 'auto',
      dryRun: true,
      defaultValues: [{ object: 'Account', field: 'Region__c', value: 'EMEA' }],
    });
    useForgeStore.getState().setGraph(GRAPH);
    useForgeStore.getState().toggleNodeIncluded('Task');
    useForgeStore.getState().setFileCopy({ enabled: true, maxFileSizeMB: 20, acceptedAsIs: true });
  });

  it('saves the run on Review whole: its decisions, the objects it leaves out, its fields and its files', () => {
    render(<ReviewSaveTemplate />);
    fireEvent.click(screen.getByTestId('review-save-template-open'));
    fireEvent.change(screen.getByTestId('review-save-template-name'), {
      target: { value: 'Accounts for QA' },
    });
    fireEvent.click(screen.getByTestId('review-save-template-submit'));

    const template = savedTemplate();
    expect(template.name).toBe('Accounts for QA');
    expect(template.targetOrgId).toBe('org-target');
    expect(template.config).toMatchObject({
      defaultValues: [{ object: 'Account', field: 'Region__c', value: 'EMEA' }],
      excludedObjects: ['Task'],
    });
    // Whether a run only simulates is chosen run by run.
    expect(template.config).not.toHaveProperty('dryRun');
    expect(template.config).not.toHaveProperty('sourceOrgId');
    expect(template.anonymization?.fields).toEqual([
      { objectApiName: 'Contact', fieldNames: ['Email'] },
    ]);
    expect(template.files).toEqual({ maxFileSizeMB: 20 });
    expect(template.objectCount).toBe(2);
    expect(template.recordCount).toBe(20);
  });

  it('asks for a name before it saves anything', () => {
    render(<ReviewSaveTemplate />);
    fireEvent.click(screen.getByTestId('review-save-template-open'));
    fireEvent.click(screen.getByTestId('review-save-template-submit'));

    expect(screen.getByTestId('review-save-template-name-error').textContent).toBe(
      'Name the template to save it.',
    );
    expect(document.activeElement).toBe(screen.getByTestId('review-save-template-name'));
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('lists the template once the extension kept it, says so, and gives the focus back', () => {
    render(<ReviewSaveTemplate />);
    fireEvent.click(screen.getByTestId('review-save-template-open'));
    fireEvent.change(screen.getByTestId('review-save-template-name'), {
      target: { value: 'Accounts for QA' },
    });
    fireEvent.click(screen.getByTestId('review-save-template-submit'));
    const request = mockPostMessage.mock.calls[0][0] as { payload: BaseMessage };

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'resp',
            type: 'forge:templates:save:response',
            timestamp: Date.now(),
            correlationId: request.payload.id,
            payload: { success: true },
          },
        }),
      );
    });

    expect(useForgeStore.getState().templates.map((t) => t.name)).toEqual(['Accounts for QA']);
    expect(screen.getByTestId('review-save-template-saved').textContent).toBe(
      'Saved as “Accounts for QA”. It is listed under Your templates in the Template tab.',
    );
    expect(screen.queryByTestId('review-save-template-form')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('review-save-template-open'));
  });
});
