import React from 'react';
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
import { ForgeSaveTemplate } from './ForgeSaveTemplate';

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

/** The form as Review shows it. */
const Review: React.FC = () => (
  <ForgeSaveTemplate idPrefix="review-save-template" openerTestId="review-save-template-open" />
);

describe('ForgeSaveTemplate', () => {
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
    render(<Review />);
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

  it('counts the records the screen gives it, under the ids of that screen', () => {
    render(
      <ForgeSaveTemplate
        idPrefix="forge-save-template"
        openerTestId="forge-save-template"
        size="md"
        recordCount={7}
      />,
    );
    const opener = screen.getByTestId('forge-save-template');
    fireEvent.click(opener);
    expect(opener.getAttribute('aria-controls')).toBe('forge-save-template-form');
    fireEvent.change(screen.getByTestId('forge-save-template-name'), {
      target: { value: 'After the run' },
    });
    fireEvent.click(screen.getByTestId('forge-save-template-submit'));

    expect(savedTemplate()).toMatchObject({
      name: 'After the run',
      objectCount: 2,
      recordCount: 7,
    });
  });

  it('keeps the controls set on Review with the template', () => {
    useForgeStore.getState().updateConfig((config) => ({
      ...config,
      fieldExclusions: { Account: ['Description'] },
      objectSoqlFilters: { Contact: 'Email != null' },
      ownerMappings: { '005000000000001AAA': '005000000000101AAA' },
      fieldMappings: { Account: { Region__c: 'Area__c' } },
      maxRecordsPerObject: 25,
      skippedRows: [{ object: 'Account', gapId: 'currency_inactive|Account|CurrencyIsoCode||CHF' }],
    }));
    render(<Review />);
    fireEvent.click(screen.getByTestId('review-save-template-open'));
    fireEvent.change(screen.getByTestId('review-save-template-name'), {
      target: { value: 'Controlled' },
    });
    fireEvent.click(screen.getByTestId('review-save-template-submit'));

    expect(savedTemplate().config).toMatchObject({
      fieldExclusions: { Account: ['Description'] },
      objectSoqlFilters: { Contact: 'Email != null' },
      ownerMappings: { '005000000000001AAA': '005000000000101AAA' },
      fieldMappings: { Account: { Region__c: 'Area__c' } },
      maxRecordsPerObject: 25,
      skippedRows: [{ object: 'Account', gapId: 'currency_inactive|Account|CurrencyIsoCode||CHF' }],
    });
  });

  it('asks for a name before it saves anything', () => {
    render(<Review />);
    fireEvent.click(screen.getByTestId('review-save-template-open'));
    fireEvent.click(screen.getByTestId('review-save-template-submit'));

    expect(screen.getByTestId('review-save-template-name-error').textContent).toBe(
      'Name the template to save it.',
    );
    expect(document.activeElement).toBe(screen.getByTestId('review-save-template-name'));
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('lists the template once the extension kept it, says so, and gives the focus back', () => {
    render(<Review />);
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
