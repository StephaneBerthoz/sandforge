import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, renderHook, act } from '@testing-library/react';
import type { ForgeConfig, ForgeGap, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { forgeGapId } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewGapsTab, useUndecidedBlockingGaps } from './ReviewGapsTab';

vi.mock('../../bridge/sendBridgeMessage', () => ({ sendBridgeMessage: vi.fn(() => 'req-1') }));

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'direct',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

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
  nodes: [node('Account'), node('Case'), node('Contact')],
  edges: [],
  totalRecords: 30,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const REFUSED: ForgeGap = {
  id: forgeGapId('picklist_value_refused', 'Case', 'Reason__c', 'Claim', 'Other'),
  kind: 'picklist_value_refused',
  severity: 'blocking',
  source: 'simulation',
  objectApiName: 'Case',
  field: 'Reason__c',
  recordType: 'Claim',
  value: 'Other',
  rows: 12,
  detail: { allowedValues: ['General', 'Billing'], replacement: 'General' },
  decisions: ['map_value', 'leave_empty', 'exclude_object', 'ignore'],
  defaultDecision: 'map_value',
};

const REQUIRED: ForgeGap = {
  id: forgeGapId('required_field_missing', 'Account', 'Region__c'),
  kind: 'required_field_missing',
  severity: 'blocking',
  source: 'metadata',
  objectApiName: 'Account',
  field: 'Region__c',
  rows: 0,
  decisions: ['set_default', 'exclude_object'],
};

const TOO_LONG: ForgeGap = {
  id: forgeGapId('value_too_long', 'Contact', 'Description'),
  kind: 'value_too_long',
  severity: 'warning',
  source: 'simulation',
  objectApiName: 'Contact',
  field: 'Description',
  rows: 3,
  decisions: ['truncate', 'ignore'],
};

const UNMAPPED: ForgeGap = {
  id: forgeGapId('record_type_unmapped', 'Case', undefined, undefined, 'Old_RT'),
  kind: 'record_type_unmapped',
  severity: 'blocking',
  source: 'simulation',
  objectApiName: 'Case',
  value: 'Old_RT',
  rows: 5,
  detail: { targetRecordTypes: ['Claim', 'Support'] },
  decisions: ['map_record_type', 'ignore'],
};

/** The gap's item on the tab. */
function item(gap: ForgeGap): HTMLElement {
  return screen.getByTestId(`gap-${gap.id}`);
}

describe('ReviewGapsTab', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setGraph(GRAPH);
  });

  describe('before and after a read', () => {
    it('says nothing was read yet, pointing at the simulation and the rehearsal', () => {
      render(<ReviewGapsTab />);
      expect(screen.getByTestId('gaps-not-read').textContent).toBe(
        'Nothing has been read yet. Simulate the run, or rehearse it, to find what the target would refuse or change in its rows.',
      );
      expect(screen.queryByTestId('gaps-none')).toBeNull();
    });

    it('tells a read that found nothing from one not made, naming the read', () => {
      act(() => useForgeStore.getState().setGaps('metadata', []));
      render(<ReviewGapsTab />);

      expect(screen.queryByTestId('gaps-not-read')).toBeNull();
      expect(screen.getByTestId('gaps-read').textContent).toBe("Read: the target's metadata.");
      expect(screen.getByTestId('gaps-none').textContent).toBe(
        'What was read holds nothing against these rows.',
      );
    });

    it('says what a read could not read, with its reason', () => {
      act(() =>
        useForgeStore
          .getState()
          .setGaps('metadata', [], [{ part: 'apiBudget', reason: 'INSUFFICIENT_ACCESS' }]),
      );
      render(<ReviewGapsTab />);

      expect(screen.getByTestId('gaps-unread').textContent).toContain(
        "Not read by the target's metadata",
      );
      expect(screen.getByTestId('gaps-unread').textContent).toContain('INSUFFICIENT_ACCESS');
    });
  });

  describe('the gaps', () => {
    beforeEach(() => {
      useForgeStore.getState().setGaps('metadata', [REQUIRED]);
      useForgeStore.getState().setGaps('simulation', [REFUSED, TOO_LONG, UNMAPPED]);
    });

    it('groups them by severity, then by object, the gravest first', () => {
      render(<ReviewGapsTab />);
      const blocking = screen.getByTestId('gaps-severity-blocking');

      expect(within(blocking).getByRole('heading', { level: 3 }).textContent).toBe(
        'Will refuse rows (3)',
      );
      expect(
        within(blocking)
          .getAllByRole('heading', { level: 4 })
          .map((h) => h.textContent),
      ).toEqual(['Account', 'Case']);
      expect(within(screen.getByTestId('gaps-severity-warning')).getByText('Contact')).toBeTruthy();
    });

    it('says what a gap is, where it was found, its rows, its detail and what the run does left undecided', () => {
      render(<ReviewGapsTab />);
      const refused = item(REFUSED);

      expect(within(refused).getByText('Picklist value the record type refuses')).toBeTruthy();
      expect(within(refused).getByTestId('gap-subject').textContent).toBe(
        'Case.Reason__c · record type Claim · value “Other”',
      );
      expect(within(refused).getByTestId('gap-rows').textContent).toBe('12 rows');
      expect(within(refused).getByTestId('gap-detail').textContent).toBe(
        'Allowed valuesGeneral, BillingreplacementGeneral',
      );
      expect(within(refused).getByTestId('gap-source').textContent).toBe('Found by the simulation');
      expect(within(refused).getByTestId('gap-default').textContent).toBe(
        'If nothing is decided: another value is written.',
      );
      // Read from metadata alone, a gap counts no row.
      expect(within(item(REQUIRED)).queryByTestId('gap-rows')).toBeNull();
    });

    it('maps a refused value in one pick, shows it chosen, and takes it back', () => {
      render(<ReviewGapsTab />);
      fireEvent.change(within(item(REFUSED)).getByTestId('gap-map-value'), {
        target: { value: 'Billing' },
      });

      expect(useForgeStore.getState().config?.picklistValueMappings).toEqual([
        { object: 'Case', field: 'Reason__c', recordType: 'Claim', from: 'Other', to: 'Billing' },
      ]);
      expect(within(item(REFUSED)).getByTestId('gap-decided').textContent).toBe(
        'Decided: written as “Billing”',
      );
      const undo = within(item(REFUSED)).getByTestId('gap-undo');
      expect(document.activeElement).toBe(undo);

      fireEvent.click(undo);
      expect(useForgeStore.getState().config).not.toHaveProperty('picklistValueMappings');
      expect(within(item(REFUSED)).getByTestId('gap-decisions')).toBe(document.activeElement);
    });

    it('leaves a refused value empty in its rows', () => {
      render(<ReviewGapsTab />);
      fireEvent.click(within(item(REFUSED)).getByTestId('gap-leave-empty'));

      expect(useForgeStore.getState().config?.picklistValueMappings?.[0].to).toBeNull();
      expect(within(item(REFUSED)).getByTestId('gap-decided').textContent).toBe(
        'Decided: the field left empty in these rows',
      );
    });

    it('gives a required field the default value typed', () => {
      render(<ReviewGapsTab />);
      const required = item(REQUIRED);
      expect((within(required).getByTestId('gap-set-default') as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.change(within(required).getByTestId('gap-default-value'), {
        target: { value: 'EMEA' },
      });
      fireEvent.click(within(required).getByTestId('gap-set-default'));

      expect(useForgeStore.getState().config?.defaultValues).toEqual([
        { object: 'Account', field: 'Region__c', value: 'EMEA' },
      ]);
    });

    it('cuts a text to its field, and ignores a gap', () => {
      render(<ReviewGapsTab />);
      fireEvent.click(within(item(TOO_LONG)).getByTestId('gap-truncate'));
      fireEvent.click(within(item(UNMAPPED)).getByTestId('gap-ignore'));

      expect(useForgeStore.getState().config?.truncateFields).toEqual([
        { object: 'Contact', field: 'Description' },
      ]);
      expect(useForgeStore.getState().config?.ignoredGaps).toEqual([UNMAPPED.id]);
    });

    it('maps a record type to one of the target’s, or to the object’s default', () => {
      render(<ReviewGapsTab />);
      fireEvent.change(within(item(UNMAPPED)).getByTestId('gap-map-record-type'), {
        target: { value: 'Support' },
      });
      expect(useForgeStore.getState().config?.recordTypeMappings).toEqual([
        { object: 'Case', from: 'Old_RT', to: 'Support' },
      ]);

      fireEvent.click(within(item(UNMAPPED)).getByTestId('gap-undo'));
      fireEvent.change(within(item(UNMAPPED)).getByTestId('gap-map-record-type'), {
        target: { value: '*' },
      });
      expect(useForgeStore.getState().config?.recordTypeMappings).toEqual([
        { object: 'Case', from: 'Old_RT', to: null },
      ]);
    });

    it('leaves the object out with its box, hides its gaps and lists the exclusion to take back', () => {
      render(<ReviewGapsTab />);
      fireEvent.click(within(item(REQUIRED)).getByTestId('gap-exclude-object'));

      const state = useForgeStore.getState();
      expect(state.config?.excludedObjects).toEqual(['Account']);
      expect(state.graph?.nodes[0]).toMatchObject({ included: false, leftOutByUser: true });
      expect(screen.queryByTestId(`gap-${REQUIRED.id}`)).toBeNull();
      const kept = screen.getByTestId('gaps-kept-decisions');
      expect(kept.textContent).toContain('Account: left out of the run');
      expect(document.activeElement).toBe(within(kept).getByRole('heading'));

      fireEvent.click(within(kept).getByTestId('gaps-kept-undo'));
      expect(useForgeStore.getState().graph?.nodes[0].included).toBe(true);
      expect(item(REQUIRED)).toBeTruthy();
    });

    it('hides the gaps of an object the user unticked on the graph', () => {
      act(() => useForgeStore.getState().toggleNodeIncluded('Contact'));
      render(<ReviewGapsTab />);

      expect(screen.queryByTestId(`gap-${TOO_LONG.id}`)).toBeNull();
    });

    it('shows a template’s decisions as taken on the gaps they answer, and lists the others', () => {
      act(() =>
        useForgeStore.getState().setConfig({
          ...CONFIG,
          picklistValueMappings: [
            {
              object: 'Case',
              field: 'Reason__c',
              recordType: 'Claim',
              from: 'Other',
              to: 'General',
            },
            { object: 'Lead', field: 'Source__c', from: 'Fair', to: null },
          ],
        }),
      );
      act(() => useForgeStore.getState().setGaps('simulation', [REFUSED]));
      render(<ReviewGapsTab />);

      expect(within(item(REFUSED)).getByTestId('gap-decided').textContent).toBe(
        'Decided: written as “General”',
      );
      expect(screen.getByTestId('gaps-kept-decisions').textContent).toContain(
        'Lead.Source__c: “Fair” left empty',
      );
    });
  });

  describe('the badge', () => {
    it('counts the blocking gaps no decision answers yet, of the objects the run writes', () => {
      useForgeStore.getState().setGaps('simulation', [REFUSED, UNMAPPED, TOO_LONG]);
      const { result } = renderHook(() => useUndecidedBlockingGaps());
      expect(result.current).toBe(2);

      act(() => useForgeStore.getState().decideGap(REFUSED, { kind: 'ignore' }));
      expect(result.current).toBe(1);

      act(() => useForgeStore.getState().toggleNodeIncluded('Case'));
      expect(result.current).toBe(0);
    });
  });

  it('offers to save the run as a template from Review', () => {
    render(<ReviewGapsTab />);
    expect(screen.getByTestId('review-save-template-open')).toBeTruthy();
  });
});
