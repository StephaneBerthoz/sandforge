import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { helpSearchUrlOf } from '@sandforge/shared';
import i18n from '../../i18n';
import { RecordErrorGroups } from './RecordErrorGroups';

describe('RecordErrorGroups', () => {
  it('shows one line per reason, its count and the fields it named, in place of one per record', () => {
    render(
      <RecordErrorGroups
        testIdPrefix="seed-result"
        module="seed"
        objectApiName="PricebookEntry"
        errors={Array.from(
          { length: 50 },
          () => 'STANDARD_PRICE_NOT_DEFINED: No standard price defined for this product',
        )}
        recordsFailed={50}
      />,
    );

    const errors = screen.getByTestId('seed-result-errors-PricebookEntry');
    expect(within(errors).getAllByRole('group')).toHaveLength(1);
    expect(errors.querySelector('summary')?.textContent).toBe('50 × STANDARD_PRICE_NOT_DEFINED');
    expect(within(errors).getAllByText(/No standard price defined/)).toHaveLength(1);
  });

  it('says what to do about a code a seed meets, in words of a seed', () => {
    render(
      <RecordErrorGroups
        testIdPrefix="seed-result"
        module="seed"
        objectApiName="Contact"
        errors={['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]']}
        recordsFailed={1}
      />,
    );

    const group = screen.getByTestId('seed-result-error-group-Contact-0');
    expect(group.querySelector('summary')?.textContent).toBe(
      '1 × REQUIRED_FIELD_MISSING (LastName)',
    );
    const hint = within(group).getByTestId('error-hint').textContent ?? '';
    expect(hint).toContain('Configure step');
    // Forge's hint for the code speaks of a clone's depth, which a seed has not.
    expect(hint).not.toMatch(/clone|depth|parents/i);
  });

  it('says what a code every module meets means, in the shared wording, under its example', () => {
    render(
      <RecordErrorGroups
        testIdPrefix="sync-result"
        objectApiName="Account"
        errors={['ENTITY_IS_LOCKED: the entity is locked for editing']}
        recordsFailed={1}
      />,
    );

    const group = screen.getByTestId('sync-result-error-group-Account-0');
    expect(within(group).getByTestId('error-hint').textContent).toContain(
      i18n.t('errors.entityLocked.action'),
    );
    expect(screen.getByText('ENTITY_IS_LOCKED: the entity is locked for editing')).toBeDefined();
  });

  it('links a code the catalogue does not know to a search of Salesforce Help, and keeps the example as the org wrote it', () => {
    render(
      <RecordErrorGroups
        testIdPrefix="sync-result"
        objectApiName="Account"
        errors={['SOMETHING_NEW: the org said this']}
      />,
    );

    expect(screen.getByRole('link').getAttribute('href')).toBe(helpSearchUrlOf('SOMETHING_NEW'));
    expect(screen.getByText('SOMETHING_NEW: the org said this')).toBeDefined();
  });

  it('reads a Bulk API refusal by its code', () => {
    render(
      <RecordErrorGroups
        testIdPrefix="sync-result"
        objectApiName="Contact"
        errors={[
          'REQUIRED_FIELD_MISSING:Required fields are missing: [LastName]:LastName --',
          'REQUIRED_FIELD_MISSING:Required fields are missing: [LastName]:LastName --',
        ]}
      />,
    );

    const group = screen.getByTestId('sync-result-error-group-Contact-0');
    expect(group.querySelector('summary')?.textContent).toBe(
      '2 × REQUIRED_FIELD_MISSING (LastName)',
    );
    expect(within(group).getByTestId('error-hint').textContent).toContain(
      i18n.t('errors.requiredFieldMissing.action'),
    );
  });

  it('writes its reasons at the size of the page’s text, not ten pixels', () => {
    render(
      <RecordErrorGroups testIdPrefix="sync-result" objectApiName="Account" errors={['A_B: a']} />,
    );
    const section = screen.getByTestId('sync-result-errors-Account');
    expect(section.className).toContain('text-xs');
    expect(section.outerHTML).not.toContain('text-[10px]');
  });

  it('says nothing of how many it was given when the run counted none', () => {
    render(
      <RecordErrorGroups testIdPrefix="sync-result" objectApiName="Account" errors={['A_B: a']} />,
    );
    expect(screen.queryByTestId('sync-result-errors-listed-Account')).toBeNull();
  });

  it('names a reason with no code by its words, once', () => {
    render(
      <RecordErrorGroups
        testIdPrefix="seed-result"
        module="seed"
        objectApiName="Account"
        errors={['Insert failed after retries', 'Insert failed after retries']}
        recordsFailed={2}
      />,
    );

    const group = screen.getByTestId('seed-result-error-group-Account-0');
    expect(group.textContent).toBe('2 × Insert failed after retries');
  });

  it('opens the three largest groups and folds the others', () => {
    render(
      <RecordErrorGroups
        testIdPrefix="seed-result"
        module="seed"
        objectApiName="Account"
        errors={[
          'A_A: a',
          'A_A: a',
          'A_A: a',
          'A_A: a',
          'B_B: b',
          'B_B: b',
          'B_B: b',
          'C_C: c',
          'C_C: c',
          'D_D: d',
        ]}
        recordsFailed={10}
      />,
    );

    const open = [0, 1, 2, 3].map(
      (i) =>
        (screen.getByTestId(`seed-result-error-group-Account-${i}`) as HTMLDetailsElement).open,
    );
    expect(open).toEqual([true, true, true, false]);
  });

  it('says the groups are of the first refusals only when the run posted fewer than it counted', () => {
    const { rerender } = render(
      <RecordErrorGroups
        testIdPrefix="seed-result"
        module="seed"
        objectApiName="Account"
        errors={['A: a', 'A: a']}
        recordsFailed={2}
      />,
    );
    expect(screen.queryByTestId('seed-result-errors-listed-Account')).toBeNull();

    rerender(
      <RecordErrorGroups
        testIdPrefix="seed-result"
        module="seed"
        objectApiName="Account"
        errors={['A: a', 'A: a']}
        recordsFailed={4000}
      />,
    );
    expect(screen.getByTestId('seed-result-errors-listed-Account').textContent).toBe(
      'Grouped from the first 2 of the 4000 records refused.',
    );
  });

  it('draws nothing for an object nothing refused', () => {
    const { container } = render(
      <RecordErrorGroups
        testIdPrefix="seed-result"
        module="seed"
        objectApiName="Account"
        errors={[]}
        recordsFailed={0}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
