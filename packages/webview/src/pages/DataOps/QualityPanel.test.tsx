import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import type { DataQualityObjectResult, DataQualityScanResult } from '@sandforge/shared';
import { QualityPanel, mergeObjectResults, parseStaleDays } from './QualityPanel';
import { LISTED_OBJECTS } from './ObjectPicker';

/* ------------------------------------------------------------------ */
/* Bridge hooks                                                        */
/* ------------------------------------------------------------------ */

let objectsState: {
  data: { objects: Array<{ apiName: string; label: string }> } | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};
let scanState: {
  mutate: ReturnType<typeof vi.fn>;
  data: DataQualityScanResult | null;
  loading: boolean;
  error: string | null;
  reset: () => void;
  requestId: string | null;
};
const queried: Array<{ type: string; payload: unknown; options: unknown }> = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown, options: unknown) => {
    queried.push({ type, payload, options });
    return objectsState;
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => scanState,
}));

const ORG_OBJECTS = [
  { apiName: 'Account', label: 'Account' },
  { apiName: 'Contact', label: 'Contact' },
  { apiName: 'Opportunity', label: 'Opportunity' },
];

const scannedObject = (objectApiName: string, keyField = 'Name'): DataQualityObjectResult => ({
  status: 'scanned',
  objectApiName,
  label: objectApiName,
  totalRecords: 4,
  fields: [{ fieldApiName: 'Name', label: 'Name', filled: 4, required: true }],
  unmeasured: [],
  duplicates: {
    keyField,
    keyLabel: keyField,
    groups: [],
    groupCount: 0,
    recordCount: 0,
    truncated: false,
  },
  stale: { days: 30, records: 1 },
  keyFields: [
    { fieldApiName: 'Name', label: 'Name' },
    { fieldApiName: 'Phone', label: 'Phone' },
  ],
  errors: [],
});

const answer = (objects: DataQualityObjectResult[], staleDays = 30): DataQualityScanResult => ({
  orgId: 'org-1',
  staleDays,
  scannedAt: '2026-09-01T10:00:00.000Z',
  bounds: { duplicateGroupLimit: 2000, duplicateSample: 20, singleFieldQueries: 20 },
  objects,
});

beforeEach(() => {
  queried.length = 0;
  objectsState = {
    data: { objects: ORG_OBJECTS },
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
  scanState = {
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
    requestId: null,
  };
});

describe('parseStaleDays', () => {
  it('reads a whole number of days in range, and nothing else', () => {
    expect(parseStaleDays('365')).toBe(365);
    expect(parseStaleDays(' 30 ')).toBe(30);
    expect(parseStaleDays('0')).toBeNull();
    expect(parseStaleDays('1.5')).toBeNull();
    expect(parseStaleDays('3651')).toBeNull();
    expect(parseStaleDays('')).toBeNull();
  });
});

describe('mergeObjectResults', () => {
  it('replaces the objects an answer carries and keeps the others in place', () => {
    const previous = [scannedObject('Account'), scannedObject('Contact')];
    const merged = mergeObjectResults(previous, [scannedObject('Account', 'Phone')]);

    expect(merged.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
    expect(merged[0].status === 'scanned' && merged[0].duplicates?.keyField).toBe('Phone');
    expect(merged[1]).toBe(previous[1]);
  });
});

describe('QualityPanel', () => {
  it('asks the org for its objects, the ones Seed offers', () => {
    render(<QualityPanel orgId="org-1" />);

    expect(queried[0]).toMatchObject({
      type: 'seed:describe-global',
      payload: { orgId: 'org-1' },
      options: { responseType: 'seed:describe-global:response', errorType: 'seed:error' },
    });
    expect(screen.getByTestId('quality-object-option-Contact')).toBeDefined();
  });

  it('narrows the object list to what the filter matches', () => {
    render(<QualityPanel orgId="org-1" />);

    fireEvent.change(screen.getByLabelText('Filter objects'), { target: { value: 'opp' } });

    expect(screen.getByTestId('quality-object-option-Opportunity')).toBeDefined();
    expect(screen.queryByTestId('quality-object-option-Account')).toBeNull();
  });

  it('lists a bounded number of objects at once and says how many more the filter reaches', () => {
    objectsState.data = {
      objects: Array.from({ length: LISTED_OBJECTS + 7 }, (_, i) => ({
        apiName: `Object${i}__c`,
        label: `Object ${i}`,
      })),
    };
    render(<QualityPanel orgId="org-1" />);

    expect(screen.getAllByRole('checkbox')).toHaveLength(LISTED_OBJECTS);
    expect(screen.getByTestId('quality-more-objects').textContent).toBe(
      `Showing ${LISTED_OBJECTS} of ${LISTED_OBJECTS + 7} objects. Type to narrow the list.`,
    );
  });

  it('scans the objects picked, with the staleness threshold typed', () => {
    render(<QualityPanel orgId="org-1" />);
    const scan = screen.getByTestId('quality-scan-btn') as HTMLButtonElement;
    expect(scan.disabled).toBe(true);

    fireEvent.click(screen.getByTestId('quality-object-option-Account'));
    fireEvent.click(screen.getByTestId('quality-object-option-Contact'));
    fireEvent.change(screen.getByLabelText('Not modified for (days)'), { target: { value: '30' } });
    fireEvent.click(scan);

    expect(scanState.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objects: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
      staleDays: 30,
    });
  });

  it('stops offering objects once a scan holds as many as it reads', () => {
    objectsState.data = {
      objects: Array.from({ length: 12 }, (_, i) => ({ apiName: `O${i}__c`, label: `O${i}` })),
    };
    render(<QualityPanel orgId="org-1" />);

    for (let i = 0; i < 10; i++)
      fireEvent.click(screen.getByTestId(`quality-object-option-O${i}__c`));

    expect((screen.getByTestId('quality-object-option-O10__c') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('quality-object-option-O0__c') as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it('refuses a threshold that is not a whole number of days, and says why', () => {
    render(<QualityPanel orgId="org-1" />);
    fireEvent.click(screen.getByTestId('quality-object-option-Account'));

    fireEvent.change(screen.getByLabelText('Not modified for (days)'), { target: { value: '0' } });

    expect((screen.getByTestId('quality-scan-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe(
      'Enter a whole number of days from 1 to 3650.',
    );
  });

  it('shows every object the scan answered for', () => {
    scanState.data = answer([scannedObject('Account'), scannedObject('Contact')]);
    render(<QualityPanel orgId="org-1" />);

    expect(screen.getByTestId('quality-object-Account')).toBeDefined();
    expect(screen.getByTestId('quality-object-Contact')).toBeDefined();
  });

  it('rescans only the object whose duplicate key changed, at the threshold its results were counted with', () => {
    scanState.data = answer([scannedObject('Account'), scannedObject('Contact')], 30);
    const { rerender } = render(<QualityPanel orgId="org-1" />);
    // Typed after the scan: the rescan of one object must not mix thresholds.
    fireEvent.change(screen.getByLabelText('Not modified for (days)'), { target: { value: '90' } });

    const contact = screen.getByTestId('quality-object-Contact');
    const select = contact.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Phone' } });

    expect(scanState.mutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objects: [{ objectApiName: 'Contact', duplicateKey: 'Phone' }],
      staleDays: 30,
    });

    // The answer for Contact replaces it and leaves Account where it was.
    scanState = { ...scanState, data: answer([scannedObject('Contact', 'Phone')], 30) };
    act(() => rerender(<QualityPanel orgId="org-1" />));

    expect(screen.getByTestId('quality-object-Account')).toBeDefined();
    const rescanned = screen.getByTestId('quality-object-Contact').querySelector('select');
    expect((rescanned as HTMLSelectElement).value).toBe('Phone');
  });

  it('keeps a chosen key for the next full scan', () => {
    scanState.data = answer([scannedObject('Contact')], 30);
    render(<QualityPanel orgId="org-1" />);
    const select = screen.getByTestId('quality-object-Contact').querySelector('select');
    fireEvent.change(select as HTMLSelectElement, { target: { value: 'Phone' } });

    fireEvent.click(screen.getByTestId('quality-object-option-Contact'));
    fireEvent.click(screen.getByTestId('quality-scan-btn'));

    expect(scanState.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ objects: [{ objectApiName: 'Contact', duplicateKey: 'Phone' }] }),
    );
  });

  it('shows why the object list or the scan failed', () => {
    objectsState = { ...objectsState, data: null, error: 'INVALID_SESSION_ID' };
    scanState.error = 'Invalid payload — staleDays: Number must be greater than or equal to 1';
    render(<QualityPanel orgId="org-1" />);

    expect(screen.getByTestId('quality-objects-error').textContent).toContain('INVALID_SESSION_ID');
    expect(screen.getByTestId('quality-scan-error').textContent).toContain('Invalid payload');
  });
});
