import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../i18n';
import { EmptyObjectList, LISTED_OBJECTS } from './EmptyObjectList';

const say = (count: number): string => `${count} ticked`;

describe('EmptyObjectList', () => {
  it('ticks and unticks an object, in the order ticked', () => {
    const onChange = vi.fn();
    render(
      <EmptyObjectList
        objects={['Account', 'Contact']}
        selected={['Contact']}
        onChange={onChange}
        legend="Objects to empty"
        tickedLine={say}
        testIdPrefix="pick"
      />,
    );
    fireEvent.click(screen.getByTestId('pick-option-Account'));
    expect(onChange).toHaveBeenLastCalledWith(['Contact', 'Account']);
    fireEvent.click(screen.getByTestId('pick-option-Contact'));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByTestId('pick-ticked')).toHaveTextContent('1 ticked: Contact');
  });

  it('lists a bounded number at once, the filter reaching the others', () => {
    const objects = Array.from({ length: LISTED_OBJECTS + 5 }, (_, i) => `Thing${i}__c`);
    render(
      <EmptyObjectList
        objects={objects}
        selected={[]}
        onChange={vi.fn()}
        legend="Objects"
        tickedLine={say}
        testIdPrefix="pick"
      />,
    );
    expect(screen.getByTestId('pick-list').querySelectorAll('li')).toHaveLength(LISTED_OBJECTS);
    expect(screen.getByTestId('pick-more')).toHaveTextContent(
      `${LISTED_OBJECTS} of ${LISTED_OBJECTS + 5} shown`,
    );
    fireEvent.change(screen.getByTestId('pick-filter'), { target: { value: 'thing54' } });
    expect(screen.getByTestId('pick-list').querySelectorAll('li')).toHaveLength(1);
    expect(screen.getByTestId('pick-option-Thing54__c')).toBeInTheDocument();
  });

  it('is named by its legend, each box by its object', () => {
    render(
      <EmptyObjectList
        objects={['Account']}
        selected={[]}
        onChange={vi.fn()}
        legend="Objects to leave out"
        tickedLine={say}
        testIdPrefix="pick"
      />,
    );
    const group = screen.getByRole('group', { name: 'Objects to leave out' });
    expect(group).toContainElement(screen.getByRole('checkbox', { name: 'Account' }));
  });
});
