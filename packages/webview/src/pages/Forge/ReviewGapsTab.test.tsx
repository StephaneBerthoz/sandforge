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

    it('names under a rule the permission set that keeps it quiet, with the command that assigns it', () => {
      const rule: ForgeGap = {
        id: forgeGapId('validation_rule', 'Contact', 'Email', undefined, 'Email_Required'),
        kind: 'validation_rule',
        severity: 'warning',
        source: 'metadata',
        objectApiName: 'Contact',
        field: 'Email',
        value: 'Email_Required',
        rows: 0,
        detail: {
          rule: 'Email_Required',
          bypasses: ['$Permission.Bypass_VR'],
          assign: ['Bypass_VR=Bypass,Admin_Tools'],
        },
        decisions: ['leave_empty', 'ignore'],
      };
      act(() => useForgeStore.getState().setGaps('metadata', [REQUIRED, rule]));
      const { rerender } = render(
        <ReviewGapsTab target={{ alias: 'TGT', username: 'loader@example.com' }} />,
      );
      const gap = item(rule);

      expect(within(gap).getByTestId('bypass-assistant-Bypass_VR').textContent).toContain(
        'Bypass is the smallest permission set of the target org that holds Bypass_VR.',
      );
      expect(within(gap).getByTestId('bypass-assistant-command').textContent).toBe(
        'sf org assign permset --name Bypass --target-org TGT --on-behalf-of loader@example.com',
      );
      // Said once, in its own words: the entry is not repeated as a raw detail.
      expect(within(gap).getByTestId('gap-detail').textContent).not.toContain('assign');
      expect(within(item(REQUIRED)).queryByTestId('bypass-assistant')).toBeNull();

      // Without the org's alias and user, the permission set is named and no command shown.
      rerender(<ReviewGapsTab />);
      expect(within(item(rule)).getByTestId('bypass-assistant-Bypass_VR')).toBeTruthy();
      expect(within(item(rule)).queryByTestId('bypass-assistant-command')).toBeNull();
    });

    describe('reading the target again', () => {
      // The tab showed what Review read as it opened: a bypass assigned with
      // the command it copied showed as not held until Review opened again.
      const RULE: ForgeGap = {
        id: forgeGapId('validation_rule', 'Contact', 'Email', undefined, 'Email_Required'),
        kind: 'validation_rule',
        severity: 'warning',
        source: 'metadata',
        objectApiName: 'Contact',
        field: 'Email',
        value: 'Email_Required',
        rows: 0,
        detail: {
          rule: 'Email_Required',
          bypasses: ['$Permission.Bypass_VR'],
          assign: ['Bypass_VR=Bypass'],
        },
        decisions: ['leave_empty', 'ignore'],
      };
      const TARGET = { alias: 'TGT', username: 'loader@example.com' };

      it('offers it under the command that assigns the bypass, and asks for it', () => {
        act(() => useForgeStore.getState().setGaps('metadata', [RULE]));
        const onReadAgain = vi.fn();
        render(<ReviewGapsTab target={TARGET} onReadAgain={onReadAgain} />);

        const assistant = within(item(RULE)).getByTestId('bypass-assistant');
        expect(assistant.textContent).toContain(
          'Once the command has run, read the target org again: the bypass then shows as held.',
        );
        const readAgain = within(assistant).getByTestId('bypass-assistant-read-again');
        expect(readAgain.textContent).toBe('Read the target org again');
        fireEvent.click(readAgain);

        expect(onReadAgain).toHaveBeenCalledTimes(1);
      });

      it('says it is reading while the read is on its way, keeps the gap shown, and asks nothing more meanwhile', () => {
        act(() => useForgeStore.getState().setGaps('metadata', [RULE]));
        const onReadAgain = vi.fn();
        render(<ReviewGapsTab target={TARGET} onReadAgain={onReadAgain} readingAgain />);

        const readAgain = within(item(RULE)).getByTestId('bypass-assistant-read-again');
        expect(readAgain.textContent).toBe('Reading again…');
        expect(readAgain.getAttribute('aria-busy')).toBe('true');
        fireEvent.click(readAgain);
        expect(onReadAgain).not.toHaveBeenCalled();
        expect(within(item(RULE)).getByTestId('bypass-assistant-command')).toBeTruthy();
      });

      it('shows the rule kept quiet once the read finds the bypass held', () => {
        act(() => useForgeStore.getState().setGaps('metadata', [RULE]));
        render(<ReviewGapsTab target={TARGET} onReadAgain={vi.fn()} />);

        // What the read answers once the permission set is assigned.
        act(() =>
          useForgeStore.getState().setGaps('metadata', [
            {
              ...RULE,
              severity: 'info',
              detail: {
                rule: 'Email_Required',
                bypasses: ['$Permission.Bypass_VR'],
                heldBypasses: ['Bypass_VR'],
              },
            },
          ]),
        );

        expect(within(item(RULE)).queryByTestId('bypass-assistant')).toBeNull();
        expect(
          within(screen.getByTestId('gaps-severity-info')).getByTestId(`gap-${RULE.id}`),
        ).toBeTruthy();
        expect(
          within(screen.getByTestId('gaps-severity-warning')).queryByTestId(`gap-${RULE.id}`),
        ).toBeNull();
      });

      it('offers nothing when nobody can ask for the read', () => {
        act(() => useForgeStore.getState().setGaps('metadata', [RULE]));
        render(<ReviewGapsTab target={TARGET} />);

        expect(screen.queryByTestId('bypass-assistant-read-again')).toBeNull();
      });
    });

    it('names an object the target user may not create, and leaves it out in one click', () => {
      // Nothing said it before Execute, which wrote the objects before it,
      // then skipped it.
      const closed: ForgeGap = {
        id: forgeGapId('object_not_createable', 'Case'),
        kind: 'object_not_createable',
        severity: 'blocking',
        source: 'metadata',
        objectApiName: 'Case',
        rows: 0,
        decisions: ['exclude_object'],
      };
      act(() => useForgeStore.getState().setGaps('metadata', [closed]));
      render(<ReviewGapsTab />);

      expect(
        within(item(closed)).getByText(
          'Object the user the clone writes as may not create in the target',
        ),
      ).toBeTruthy();
      fireEvent.click(within(item(closed)).getByTestId('gap-exclude-object'));
      expect(useForgeStore.getState().config?.excludedObjects).toEqual(['Case']);
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

    it('holds back the rows of a value where the read offers it, and lists it kept once its gap goes', () => {
      const skippable: ForgeGap = { ...REFUSED, decisions: [...REFUSED.decisions, 'skip_rows'] };
      act(() => useForgeStore.getState().setGaps('simulation', [skippable]));
      render(<ReviewGapsTab />);
      // Not offered on a gap whose read does not offer it.
      expect(within(item(REQUIRED)).queryByTestId('gap-skip-rows')).toBeNull();

      fireEvent.click(within(item(skippable)).getByTestId('gap-skip-rows'));

      expect(useForgeStore.getState().config?.skippedRows).toEqual([
        { object: 'Case', gapId: REFUSED.id },
      ]);
      expect(within(item(skippable)).getByTestId('gap-decided').textContent).toBe(
        'Decided: these rows held back',
      );

      act(() => useForgeStore.getState().setGaps('simulation', []));
      expect(screen.getByTestId('gaps-kept-decisions').textContent).toContain(
        'Picklist value the record type refuses · Case · Reason__c · Claim · Other: rows held back',
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

  describe("the list for the target's admin", () => {
    /** A picklist value the target's field does not hold, for the record type its rows go in with. */
    const NOT_IN_TARGET: ForgeGap = {
      id: forgeGapId('picklist_value_refused', 'Case', 'Origin', 'Claim', 'Fax'),
      kind: 'picklist_value_refused',
      severity: 'warning',
      source: 'simulation',
      objectApiName: 'Case',
      field: 'Origin',
      recordType: 'Claim',
      value: 'Fax',
      rows: 2,
      detail: { reason: 'not-in-target' },
      decisions: ['map_value', 'ignore'],
    };

    it('lists, by object and record type, what the target would need changed, and copies it', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      useForgeStore.getState().setGaps('metadata', [REQUIRED]);
      useForgeStore.getState().setGaps('simulation', [NOT_IN_TARGET, TOO_LONG, UNMAPPED]);
      render(<ReviewGapsTab />);

      const admin = screen.getByTestId('gaps-admin');
      expect(within(admin).getByRole('heading', { level: 3 }).textContent).toBe(
        "For the target's admin",
      );
      expect(within(admin).getByTestId('gaps-admin-list').textContent).toContain(
        'Show the 4 changes',
      );
      const expected = [
        'Changes to make in the Setup of the target org for the records SandForge clones to go in as they are:',
        '',
        'Account',
        '- Region__c: make it optional, or give it a default value (Setup > Object Manager > Account > Fields & Relationships > Region__c).',
        '',
        'Case',
        '- Create record type Old_RT (Setup > Object Manager > Case > Record Types > New). (5 rows)',
        '',
        'Case, record type Claim',
        '- Origin: add or activate the value “Fax”, then select it for record type Claim (Setup > Object Manager > Case > Fields & Relationships > Origin > Values, then Record Types > Claim). (2 rows)',
        '',
        'Contact',
        // No longest value measured: the field is said to be lengthened, to no number.
        '- Description: make it longer, to hold the longest value the rows carry (Setup > Object Manager > Contact > Fields & Relationships > Description). (3 rows)',
      ].join('\n');
      expect(within(admin).getByTestId('gaps-admin-text').textContent).toBe(expected);

      await act(async () => {
        fireEvent.click(within(admin).getByTestId('gaps-admin-copy'));
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith(expected);
      expect(within(admin).getByTestId('gaps-admin-copied').textContent).toBe('Copied');
    });

    it('is absent when no gap asks a change of the target, or its object is left out', () => {
      useForgeStore.getState().setGaps('simulation', [TOO_LONG]);
      const { unmount } = render(<ReviewGapsTab />);
      // A text longer than its field asks the field be lengthened.
      expect(screen.getByTestId('gaps-admin')).toBeTruthy();
      unmount();

      act(() => useForgeStore.getState().toggleNodeIncluded('Contact'));
      render(<ReviewGapsTab />);
      expect(screen.queryByTestId('gaps-admin')).toBeNull();
    });
  });

  it('offers to save the run as a template from Review', () => {
    render(<ReviewGapsTab />);
    expect(screen.getByTestId('review-save-template-open')).toBeTruthy();
  });
});
