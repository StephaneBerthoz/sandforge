import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ForgeLivePreviewPanel } from './ForgeLivePreviewPanel';
import type { ForgeLivePreviewPanelProps } from './ForgeLivePreviewPanel';
import type { RecordPreview } from './forgeUtils';

/** A previewed Contact with two personal fields, as the record tab loads it. */
const PREVIEW: RecordPreview = {
  recordId: '003000000000001AAA',
  objectLabel: 'Contact',
  objectApiName: 'Contact',
  fields: [
    { name: 'Name', value: 'Ada Lovelace' },
    { name: 'Email', value: 'ada@example.com' },
    { name: 'Phone', value: '+44 20 0000 0000' },
  ],
  totalFieldCount: 74,
};

/** The panel as the input step draws it, with `props` over a record tab's. */
function renderPanel(props: Partial<ForgeLivePreviewPanelProps> = {}): void {
  render(
    <ForgeLivePreviewPanel
      preview={null}
      inputMode="record"
      sourceOrgId="org-src"
      anonymize={false}
      onClosePreview={vi.fn()}
      {...props}
    />,
  );
}

describe('ForgeLivePreviewPanel', () => {
  it('asks for a record id on the record tab, and draws no card of the whole org', () => {
    renderPanel();

    expect(screen.getByText('Record ID or Salesforce URL')).toBeDefined();
    expect(screen.queryByTestId('forge-all-preview')).toBeNull();
    expect(screen.queryByTestId('forge-all-pii-off')).toBeNull();
  });

  describe('a clone of the whole org', () => {
    it('says what discovery lists and counts, from which org into which', () => {
      renderPanel({ wholeOrg: true, sourceAlias: 'prod', targetAlias: 'uat' });

      const card = screen.getByTestId('forge-all-preview');
      expect(card.textContent).toContain('Whole org');
      expect(screen.getByTestId('forge-all-preview-body').textContent).toBe(
        'Discovery lists every object of prod that uat can create, and counts their records.',
      );
    });

    it('names the target org by its role while none is picked', () => {
      renderPanel({ wholeOrg: true, sourceAlias: 'prod', targetAlias: '' });

      expect(screen.getByTestId('forge-all-preview-body').textContent).toBe(
        'Discovery lists every object of prod that the target org can create, and counts their records.',
      );
    });

    it('asks for a source org while none is picked', () => {
      renderPanel({ wholeOrg: true, sourceOrgId: '', sourceAlias: '', targetAlias: 'uat' });

      expect(screen.getByTestId('forge-all-preview-body').textContent).toBe(
        'Select a source org to copy all of its data',
      );
    });

    it('draws no record placeholder, preview or root line: ALL previews no record', () => {
      renderPanel({ wholeOrg: true, sourceAlias: 'prod', targetAlias: 'uat', preview: PREVIEW });

      expect(screen.queryByText('Record ID or Salesforce URL')).toBeNull();
      expect(screen.queryByTestId('forge-record-preview')).toBeNull();
      expect(screen.queryByTestId('forge-root-record')).toBeNull();
      // The record banner counts the fields of the record previewed: ALL has its own.
      expect(screen.queryByTestId('forge-pii-warning')).toBeNull();
    });

    it('warns that every personal field goes as it is while Anonymize PII is off', () => {
      renderPanel({ wholeOrg: true, sourceAlias: 'prod', targetAlias: 'uat', anonymize: false });

      expect(screen.getByTestId('forge-all-pii-off').textContent).toBe(
        'Anonymize PII is off: every personal field of the source org is copied as it is.',
      );
    });

    it('says nothing of personal fields once Anonymize PII is on', () => {
      renderPanel({ wholeOrg: true, sourceAlias: 'prod', targetAlias: 'uat', anonymize: true });

      expect(screen.queryByTestId('forge-all-pii-off')).toBeNull();
      expect(screen.queryByTestId('forge-all-real-data')).toBeNull();
    });

    it('says why Anonymize PII came on for a source that holds real people’s data', () => {
      renderPanel({
        wholeOrg: true,
        sourceAlias: 'prod',
        targetAlias: 'uat',
        anonymize: true,
        sourceHoldsRealData: true,
      });

      expect(screen.getByTestId('forge-all-real-data').textContent).toBe(
        'prod holds real people’s data — a production org, or a sandbox marked Staging: a clone of the whole of it anonymizes their personal fields unless you untick Anonymize PII.',
      );
    });
  });

  it('counts the personal fields of a previewed record while Anonymize PII is off', () => {
    renderPanel({ preview: PREVIEW });

    expect(screen.getByTestId('forge-record-preview')).toBeDefined();
    expect(screen.getByTestId('forge-pii-warning')).toBeDefined();
    expect(screen.queryByTestId('forge-all-pii-off')).toBeNull();
  });
});
