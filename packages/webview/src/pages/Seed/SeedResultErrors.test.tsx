import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import { SeedResultErrors } from './SeedResultErrors';

describe('SeedResultErrors', () => {
  it('shows one line per reason, its count and the fields it named, in place of one per record', () => {
    render(
      <SeedResultErrors
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
      <SeedResultErrors
        objectApiName="Contact"
        errors={['REQUIRED_FIELD_MISSING: Required fields are missing: [LastName]']}
        recordsFailed={1}
      />,
    );

    const group = screen.getByTestId('seed-result-error-group-Contact-0');
    expect(group.querySelector('summary')?.textContent).toBe(
      '1 × REQUIRED_FIELD_MISSING (LastName)',
    );
    const hint = within(group).getByTestId('seed-result-error-hint').textContent ?? '';
    expect(hint).toContain('Configure step');
    // Forge's hint for the code speaks of a clone's depth, which a seed has not.
    expect(hint).not.toMatch(/clone|depth|parents/i);
  });

  it('gives no hint for a code it has none for, and keeps the example as the org wrote it', () => {
    render(
      <SeedResultErrors
        objectApiName="Account"
        errors={['ENTITY_IS_LOCKED: the entity is locked for editing']}
        recordsFailed={1}
      />,
    );

    expect(screen.queryByTestId('seed-result-error-hint')).toBeNull();
    expect(screen.getByText('ENTITY_IS_LOCKED: the entity is locked for editing')).toBeDefined();
  });

  it('names a reason with no code by its words, once', () => {
    render(
      <SeedResultErrors
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
      <SeedResultErrors
        objectApiName="Account"
        errors={['A: a', 'A: a', 'A: a', 'A: a', 'B: b', 'B: b', 'B: b', 'C: c', 'C: c', 'D: d']}
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
      <SeedResultErrors objectApiName="Account" errors={['A: a', 'A: a']} recordsFailed={2} />,
    );
    expect(screen.queryByTestId('seed-result-errors-listed-Account')).toBeNull();

    rerender(
      <SeedResultErrors objectApiName="Account" errors={['A: a', 'A: a']} recordsFailed={4000} />,
    );
    expect(screen.getByTestId('seed-result-errors-listed-Account').textContent).toBe(
      'Grouped from the first 2 of the 4000 records refused.',
    );
  });

  it('draws nothing for an object nothing refused', () => {
    const { container } = render(
      <SeedResultErrors objectApiName="Account" errors={[]} recordsFailed={0} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
