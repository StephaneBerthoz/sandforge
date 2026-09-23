import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { RemovalPlanObject } from '@sandforge/shared';
import { plannedRecords, RemovalOutcomeView, RemovalPlanView } from './RemovalPlanView';

const contactPlan: RemovalPlanObject = {
  objectApiName: 'Contact',
  label: 'Contact',
  records: 2,
  fields: [
    { fieldApiName: 'Email', label: 'Email', method: 'fake' },
    { fieldApiName: 'Fax', label: 'Fax', method: 'nullify' },
  ],
  kept: [{ fieldApiName: 'Birthdate', label: 'Birthdate' }],
};

describe('RemovalPlanView', () => {
  it('names each field an erasure overwrites and how, and the ones it cannot write', () => {
    render(<RemovalPlanView mode="anonymize" plan={[contactPlan]} />);

    expect(screen.getByTestId('removal-plan-fields').textContent).toBe(
      'Overwrites: Email (made up), Fax (emptied)',
    );
    expect(screen.getByTestId('removal-plan-kept').textContent).toContain('Birthdate');
    expect(screen.getByTestId('removal-plan-Contact').textContent).toContain('2 records');
  });

  it('names what the org deletes along with the records, and what it would not count', () => {
    render(
      <RemovalPlanView
        mode="delete"
        plan={[
          {
            objectApiName: 'Account',
            label: 'Account',
            records: 1,
            related: [
              { objectApiName: 'Contact', label: 'Contact', records: 4 },
              { objectApiName: 'Task', label: 'Task', records: 1 },
            ],
            uncounted: ['Actionable List Member'],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('removal-plan-related').textContent).toBe(
      'The org deletes along with them: Contact: 4 records, Task: 1 record',
    );
    expect(screen.getByTestId('removal-plan-uncounted').textContent).toContain(
      'Actionable List Member',
    );
    expect(screen.getByTestId('removal-plan-Account').textContent).toContain('1 record');
  });

  it('says why an object is left alone', () => {
    render(
      <RemovalPlanView
        mode="delete"
        plan={[
          {
            objectApiName: 'Lead',
            label: 'Lead',
            records: 0,
            refused: 'The connected user may not delete Lead records.',
          },
        ]}
      />,
    );

    expect(screen.getByTestId('removal-plan-refused').textContent).toBe(
      'Left alone: The connected user may not delete Lead records.',
    );
  });

  it('counts only the records of the objects a run acts on', () => {
    expect(
      plannedRecords([
        contactPlan,
        { objectApiName: 'Lead', label: 'Lead', records: 5, refused: 'no' },
      ]),
    ).toBe(2);
  });
});

describe('RemovalOutcomeView', () => {
  it('says how many were written and how many the org refused, with what it said', () => {
    render(
      <RemovalOutcomeView
        mode="delete"
        outcome={{
          status: 'partial',
          done: 3,
          failed: 1,
          objects: [{ objectApiName: 'Contact', done: 3, failed: 1 }],
          errors: [{ objectApiName: 'Contact', message: 'DELETE_FAILED: associated with cases' }],
        }}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      '3 records deleted. 1 refused by the org, and left as it was.',
    );
    expect(screen.getByTestId('removal-outcome-errors').textContent).toBe(
      'Contact: DELETE_FAILED: associated with cases',
    );
  });

  it('says a clean erasure in place overwrote every record', () => {
    render(
      <RemovalOutcomeView
        mode="anonymize"
        outcome={{
          status: 'success',
          done: 1,
          failed: 0,
          objects: [{ objectApiName: 'Contact', done: 1, failed: 0 }],
          errors: [],
        }}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('1 record overwritten.');
  });
});
