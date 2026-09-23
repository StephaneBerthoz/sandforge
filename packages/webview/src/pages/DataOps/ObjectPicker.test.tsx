import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ObjectPicker, LISTED_OBJECTS } from './ObjectPicker';

let objectsState: {
  data: { objects: Array<{ apiName: string; label: string }> } | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};
const queried: Array<{ type: string; payload: unknown }> = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload: unknown) => {
    queried.push({ type, payload });
    return objectsState;
  },
}));

const OBJECTS = [
  { apiName: 'Account', label: 'Account' },
  { apiName: 'Contact', label: 'Contact' },
  { apiName: 'Patient__c', label: 'Patient' },
];

beforeEach(() => {
  queried.length = 0;
  objectsState = { data: { objects: OBJECTS }, loading: false, error: null, refetch: vi.fn() };
});

function picker(selected: string[] = [], onChange = vi.fn(), max = 2) {
  render(
    <ObjectPicker
      orgId="org-1"
      selected={selected}
      onChange={onChange}
      max={max}
      legend="Objects to look in"
      testIdPrefix="compliance"
    />,
  );
  return onChange;
}

describe('ObjectPicker', () => {
  it('offers the objects Seed offers, for the org it is given', () => {
    picker();

    expect(queried[0]).toEqual({ type: 'seed:describe-global', payload: { orgId: 'org-1' } });
    expect(screen.getByRole('group', { name: 'Objects to look in' })).toBeDefined();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });

  it('adds and removes an object as it is ticked', () => {
    const onChange = picker(['Account']);

    fireEvent.click(screen.getByTestId('compliance-object-option-Contact'));
    expect(onChange).toHaveBeenLastCalledWith(['Account', 'Contact']);

    fireEvent.click(screen.getByTestId('compliance-object-option-Account'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('lets no more be picked than the bound, and says how many are', () => {
    picker(['Account', 'Contact']);

    expect(
      (screen.getByTestId('compliance-object-option-Patient__c') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId('compliance-selected').textContent).toBe(
      '2 of 2 selected: Account, Contact',
    );
  });

  it('narrows the list to what the filter matches, by label or API name', () => {
    picker();

    fireEvent.change(screen.getByLabelText('Filter objects'), { target: { value: 'patient__' } });

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText('Patient__c')).toBeDefined();
  });

  it('lists a bounded number at once and says how many more the filter reaches', () => {
    objectsState.data = {
      objects: Array.from({ length: LISTED_OBJECTS + 3 }, (_, i) => ({
        apiName: `Object${i}__c`,
        label: `Object ${i}`,
      })),
    };

    picker();

    expect(screen.getAllByRole('checkbox')).toHaveLength(LISTED_OBJECTS);
    expect(screen.getByTestId('compliance-more-objects').textContent).toBe(
      `Showing ${LISTED_OBJECTS} of ${LISTED_OBJECTS + 3} objects. Type to narrow the list.`,
    );
  });

  it('says why the list is missing when the org would not give it', () => {
    objectsState = { data: null, loading: false, error: 'INVALID_SESSION_ID', refetch: vi.fn() };

    picker();

    expect(screen.getByTestId('compliance-objects-error').textContent).toContain(
      'INVALID_SESSION_ID',
    );
  });
});
