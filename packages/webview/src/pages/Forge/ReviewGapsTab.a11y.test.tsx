import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ForgeGap } from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewGapsTab } from './ReviewGapsTab';

const GAPS: ForgeGap[] = [
  {
    id: forgeGapId('picklist_value_refused', 'Case', 'Reason__c', undefined, 'Other'),
    kind: 'picklist_value_refused',
    severity: 'blocking',
    source: 'simulation',
    objectApiName: 'Case',
    field: 'Reason__c',
    value: 'Other',
    rows: 2,
    detail: { allowedValues: ['General'] },
    decisions: ['map_value', 'leave_empty', 'ignore'],
  },
  {
    id: forgeGapId('required_field_missing', 'Case', 'Origin__c'),
    kind: 'required_field_missing',
    severity: 'blocking',
    source: 'metadata',
    objectApiName: 'Case',
    field: 'Origin__c',
    rows: 0,
    decisions: ['set_default'],
  },
  {
    id: forgeGapId('record_type_unmapped', 'Case', undefined, undefined, 'Old_RT'),
    kind: 'record_type_unmapped',
    severity: 'warning',
    source: 'simulation',
    objectApiName: 'Case',
    value: 'Old_RT',
    rows: 1,
    decisions: ['map_record_type'],
  },
];

/** Accessible name of a form control: its own aria-label, else its labels. */
function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labels = (el as HTMLSelectElement).labels;
  return Array.from(labels ?? [])
    .map((l) => l.textContent ?? '')
    .join(' ')
    .trim();
}

describe('ReviewGapsTab accessible names', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig({
      inputMode: 'record',
      recordId: '001000000000001AAA',
      depth: 'direct',
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    });
    useForgeStore.getState().setGaps('simulation', GAPS);
  });

  it('names every list and field a decision is taken with', () => {
    render(<ReviewGapsTab />);
    expect(accessibleName(screen.getByTestId('gap-map-value'))).toBe('Write instead');
    expect(accessibleName(screen.getByTestId('gap-map-record-type'))).toBe('Write as record type');
    expect(accessibleName(screen.getByTestId('gap-default-value'))).toBe('Default value');
  });

  it('groups each gap’s decisions under a name', () => {
    render(<ReviewGapsTab />);
    for (const group of screen.getAllByRole('group')) {
      expect(accessibleName(group)).toBe('Decisions on this gap');
    }
  });

  it('leaves no orphan label', () => {
    render(<ReviewGapsTab />);
    const tab = screen.getByTestId('review-gaps-tab');
    expect(
      Array.from(tab.querySelectorAll('label'))
        .filter((l) => l.control === null)
        .map((l) => l.textContent),
    ).toEqual([]);
  });

  it('names an undo by the decision it takes back', () => {
    useForgeStore.getState().decideGap(GAPS[0], { kind: 'map_value', to: 'General' });
    render(<ReviewGapsTab />);
    const undo = within(screen.getByTestId(`gap-${GAPS[0].id}`)).getByTestId('gap-undo');
    expect(accessibleName(undo)).toBe('Undo the decision: written as “General”');
  });
});
