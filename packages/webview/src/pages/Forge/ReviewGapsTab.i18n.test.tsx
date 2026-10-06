import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgeGap, ForgeGapKind } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewGapsTab } from './ReviewGapsTab';

/* `t` echoes its key, so any label still hardcoded in the component shows up
   as English prose instead of a key. */
vi.mock('react-i18next', () => ({
  // The store loads the panel's i18n instance, which registers this plugin.
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en', exists: () => false },
  }),
}));

const KINDS: ForgeGapKind[] = [
  'picklist_value_refused',
  'dependent_value_invalid',
  'picklist_value_absent',
  'required_field_missing',
  'value_too_long',
  'number_out_of_range',
  'record_type_unmapped',
  'record_type_unavailable',
  'currency_inactive',
  'unique_value_collision',
  'lookup_filter',
  'validation_rule',
  'duplicate_rule',
  'api_budget',
  'rehearsal_refusal',
];

const GAP: ForgeGap = {
  id: 'picklist_value_refused|Case|Reason__c||Other',
  kind: 'picklist_value_refused',
  severity: 'blocking',
  source: 'rehearsal',
  objectApiName: 'Case',
  field: 'Reason__c',
  value: 'Other',
  rows: 1,
  detail: { allowedValues: ['General'] },
  decisions: ['map_value', 'leave_empty', 'exclude_object', 'ignore'],
  defaultDecision: 'leave_empty',
};

describe('ReviewGapsTab — translated labels', () => {
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
  });

  it('resolves the kind, the source, the severity and every control through i18n', () => {
    useForgeStore.getState().setGaps('rehearsal', [GAP]);
    render(<ReviewGapsTab />);

    expect(screen.getByText('forge.gaps.kind.picklist_value_refused')).toBeTruthy();
    expect(screen.getByTestId('gap-source').textContent).toBe('forge.gaps.source.rehearsal');
    expect(screen.getByText('forge.gaps.severity.blocking (1)')).toBeTruthy();
    expect(screen.getByTestId('gap-leave-empty').textContent).toBe('forge.gaps.leaveEmptyValue');
    expect(screen.getByTestId('gap-exclude-object').textContent).toBe('forge.gaps.excludeObject');
    expect(screen.getByTestId('gap-ignore').textContent).toBe('forge.gaps.ignore');
  });

  it('backs every kind, severity, source, read and decision with an entry in the reference locale', () => {
    for (const kind of KINDS) expect(typeof en.forge.gaps.kind[kind]).toBe('string');
    for (const severity of ['blocking', 'warning', 'info'] as const) {
      expect(typeof en.forge.gaps.severity[severity]).toBe('string');
    }
    for (const source of ['metadata', 'simulation', 'rehearsal'] as const) {
      expect(typeof en.forge.gaps.source[source]).toBe('string');
      expect(typeof en.forge.gaps.readName[source]).toBe('string');
    }
    for (const decision of [
      'map_value',
      'leave_empty',
      'set_default',
      'truncate',
      'map_record_type',
      'exclude_object',
      'skip_rows',
      'ignore',
    ] as const) {
      expect(typeof en.forge.gaps.decision[decision]).toBe('string');
    }
  });
});
