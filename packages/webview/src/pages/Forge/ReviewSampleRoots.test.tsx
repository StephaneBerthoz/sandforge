import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import type { BaseMessage, ForgeSampleOptions } from '@sandforge/shared';
import '../../i18n';
import {
  ReviewSampleRoots,
  openSampleRoots,
  rootConditionsOf,
  useSampleRootsAsk,
} from './ReviewSampleRoots';

/* ---- Bridge double: what the block posts, and a way to answer it ---- */
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

/** The describes the block asked for, their payloads. */
function describes(): Array<{ id: string; payload: { objectApiName: string } }> {
  return mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage & { payload: unknown } }).payload)
    .filter((message) => message.type === 'sync:describe-fields')
    .map((message) => ({
      id: message.id,
      payload: message.payload as { objectApiName: string },
    }));
}

/** The extension answering the last describe with `fields` of the source. */
function answerFields(
  objectApiName: string,
  fields: Array<{ apiName: string; type: string }>,
): void {
  const asked = describes();
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-fields',
          type: 'sync:describe-fields:response',
          timestamp: Date.now(),
          correlationId: asked[asked.length - 1].id,
          payload: {
            objectApiName,
            sourceFields: fields.map((field) => ({ ...field, label: field.apiName })),
            targetFields: [],
          },
        },
      }),
    );
  });
}

/** The options the block holds, as the config would. */
let held: ForgeSampleOptions = {};

/** The block over `sample`, its changes kept as Review keeps them. */
function Harness({ sample, objects }: { sample: ForgeSampleOptions; objects: string[] }) {
  const [options, setOptions] = useState(sample);
  held = options;
  return (
    <ReviewSampleRoots
      sample={options}
      change={(next) =>
        setOptions((current) => {
          const changed = next(current);
          const kept: ForgeSampleOptions = {};
          for (const [key, value] of Object.entries(changed)) {
            if (value !== undefined) Object.assign(kept, { [key]: value });
          }
          held = kept;
          return kept;
        })
      }
      objects={objects}
      sourceOrgId="org-src"
      targetOrgId="org-tgt"
    />
  );
}

function renderBlock(sample: ForgeSampleOptions = {}, objects = ['Account', 'Lead']): void {
  held = sample;
  render(<Harness sample={sample} objects={objects} />);
  fireEvent.click(screen.getByText('Which roots'));
}

/*
 * Review's Which roots: a window of dates, a condition on an object's roots,
 * and strata, each choosing the roots a sample draws among — never what
 * comes under them, nor a record of the copy.
 */
describe('ReviewSampleRoots', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('says in its summary every root, or how many conditions choose them', () => {
    renderBlock();
    expect(screen.getByTestId('review-sample-roots-summary').textContent).toBe('every root');

    fireEvent.click(screen.getByTestId('review-sample-window-last-90'));
    fireEvent.click(screen.getByTestId('review-sample-strata-record-type'));

    expect(screen.getByTestId('review-sample-roots-summary').textContent).toBe('2 conditions');
    expect(
      rootConditionsOf({
        window: { field: 'CreatedDate', lastDays: 1 },
        rootWhere: { Account: 'X = 1', Lead: 'Y = 2' },
        strata: ['RecordTypeId'],
      }),
    ).toBe(4);
  });

  it('draws among the roots made in a window of days, the last one taken whole, in UTC', () => {
    renderBlock();

    fireEvent.change(screen.getByTestId('review-sample-window-from'), {
      target: { value: '2025-01-01' },
    });
    expect(held.window).toEqual({ field: 'CreatedDate', from: '2025-01-01T00:00:00Z' });
    fireEvent.change(screen.getByTestId('review-sample-window-to'), {
      target: { value: '2025-06-30' },
    });

    expect(held.window).toEqual({
      field: 'CreatedDate',
      from: '2025-01-01T00:00:00Z',
      to: '2025-07-01T00:00:00Z',
    });
    fireEvent.change(screen.getByTestId('review-sample-window-field'), {
      target: { value: 'LastModifiedDate' },
    });
    expect(held.window?.field).toBe('LastModifiedDate');
  });

  it('shows a window set elsewhere, its end as the last day it takes', () => {
    renderBlock({
      window: { field: 'CreatedDate', from: '2025-01-01T00:00:00Z', to: '2025-07-01T00:00:00Z' },
    });

    expect((screen.getByTestId('review-sample-window-from') as HTMLInputElement).value).toBe(
      '2025-01-01',
    );
    expect((screen.getByTestId('review-sample-window-to') as HTMLInputElement).value).toBe(
      '2025-06-30',
    );
  });

  it('refuses a window that starts after its end where it is typed, and changes nothing', () => {
    renderBlock({ window: { field: 'CreatedDate', from: '2025-03-01T00:00:00Z' } });

    fireEvent.change(screen.getByTestId('review-sample-window-to'), {
      target: { value: '2025-02-01' },
    });

    const to = screen.getByTestId('review-sample-window-to');
    expect(to.getAttribute('aria-invalid')).toBe('true');
    const refused = screen.getByRole('alert');
    expect(refused.textContent).toBe(
      'The window starts after its end: set its start on or before its last day. It was not changed.',
    );
    expect(to.getAttribute('aria-describedby')).toContain(refused.id);
    expect(held.window).toEqual({ field: 'CreatedDate', from: '2025-03-01T00:00:00Z' });
  });

  it('takes the last days as days, which follow the day the sample is drawn on, and clears the window', () => {
    renderBlock();

    fireEvent.click(screen.getByTestId('review-sample-window-last-30'));

    expect(held.window).toEqual({ field: 'CreatedDate', lastDays: 30 });
    expect(screen.getByTestId('review-sample-window-last-30').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByTestId('review-sample-window-following').textContent).toBe(
      'The roots of the last 30 days, counted back from when the sample is drawn: run again another day, the window follows that day.',
    );
    fireEvent.click(screen.getByTestId('review-sample-window-clear'));
    expect(held).toEqual({});
  });

  it('draws an object’s roots among those a condition keeps, and says it is not the object’s filter', () => {
    renderBlock();
    const where = screen.getByTestId('review-sample-where');
    expect(within(where).getByText(/use the object's filter in Review → Controls/)).toBeTruthy();

    fireEvent.change(screen.getByTestId('review-sample-where-object'), {
      target: { value: 'Account' },
    });
    fireEvent.change(screen.getByTestId('review-sample-where-text'), {
      target: { value: "  BillingCountry = 'France' " },
    });
    fireEvent.click(screen.getByTestId('review-sample-where-apply'));

    expect(held.rootWhere).toEqual({ Account: "BillingCountry = 'France'" });
    expect(screen.getByTestId('review-sample-where-Account').textContent).toContain(
      "Account: BillingCountry = 'France'",
    );
    fireEvent.click(screen.getByTestId('review-sample-where-remove-Account'));
    expect(held).toEqual({});
  });

  it('refuses a condition the run would refuse, and applies nothing', () => {
    renderBlock();
    fireEvent.change(screen.getByTestId('review-sample-where-object'), {
      target: { value: 'Lead' },
    });
    fireEvent.change(screen.getByTestId('review-sample-where-text'), {
      target: { value: "Status = 'Open' -- all" },
    });
    fireEvent.click(screen.getByTestId('review-sample-where-apply'));

    expect(screen.getByTestId('review-sample-where-refused').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('review-sample-where-text').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(held).toEqual({});
  });

  it('says a condition on an object it no longer draws would refuse the run, with its removal', () => {
    renderBlock({ rootWhere: { Contact: "LastName = 'X'" } }, ['Account']);

    expect(screen.getByTestId('review-sample-where-not-drawn-Contact').textContent).toBe(
      'Contact is left out of the run or copied whole: it has no root to filter, and the run would be refused with this filter. Remove it.',
    );
  });

  it('stratifies every object by its record type, or one object by a field of few values the source describes', () => {
    renderBlock({ strata: ['Lead.Status'] });

    fireEvent.click(screen.getByTestId('review-sample-strata-record-type'));
    expect(held.strata).toEqual(['Lead.Status', 'RecordTypeId']);

    fireEvent.change(screen.getByTestId('review-sample-stratum-object'), {
      target: { value: 'Account' },
    });
    expect(describes().slice(-1)[0].payload).toEqual({
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      objectApiName: 'Account',
    });
    answerFields('Account', [
      { apiName: 'Name', type: 'string' },
      { apiName: 'Type', type: 'picklist' },
      { apiName: 'OwnerId', type: 'reference' },
      { apiName: 'IsPartner', type: 'boolean' },
      { apiName: 'Description', type: 'textarea' },
    ]);
    const fields = screen.getByTestId('review-sample-stratum-field') as HTMLSelectElement;
    // Only a field of few values: no text, no long text.
    expect([...fields.options].map((option) => option.value)).toEqual([
      '',
      'IsPartner',
      'OwnerId',
      'Type',
    ]);
    fireEvent.change(fields, { target: { value: 'Type' } });
    fireEvent.click(screen.getByTestId('review-sample-stratum-add'));

    expect(held.strata).toEqual(['Lead.Status', 'RecordTypeId', 'Account.Type']);
    expect(screen.getByTestId('review-sample-stratum-Account.Type').textContent).toContain(
      'Account by Type',
    );
    expect(screen.getByTestId('review-sample-stratum-RecordTypeId').textContent).toContain(
      'RecordTypeId, on every object that has it',
    );

    // One field of an object: another takes its place.
    fireEvent.change(fields, { target: { value: 'IsPartner' } });
    fireEvent.click(screen.getByTestId('review-sample-stratum-add'));
    expect(held.strata).toEqual(['Lead.Status', 'RecordTypeId', 'Account.IsPartner']);

    fireEvent.click(screen.getByTestId('review-sample-strata-record-type'));
    expect(held.strata).toEqual(['Lead.Status', 'Account.IsPartner']);
  });

  it('says an object has no field of few values the run writes', () => {
    renderBlock();
    fireEvent.change(screen.getByTestId('review-sample-stratum-object'), {
      target: { value: 'Lead' },
    });
    answerFields('Lead', [{ apiName: 'LastName', type: 'string' }]);

    expect(screen.getByTestId('review-sample-stratum-none').textContent).toBe(
      'Lead has no picklist, checkbox or lookup the run writes.',
    );
  });

  it('opens and takes the keyboard when the notice of a draw refused asks for it', () => {
    held = {};
    render(<Harness sample={{}} objects={['Account']} />);
    const block = screen.getByTestId('review-sample-roots') as HTMLDetailsElement;
    expect(block.open).toBe(false);

    act(() => openSampleRoots());

    expect(block.open).toBe(true);
    expect(document.activeElement?.tagName).toBe('SUMMARY');
    expect(useSampleRootsAsk.getState().asked).toBeGreaterThan(0);
  });
});
