import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../i18n';
import { ReplayOwners } from './ReplayOwners';

describe('ReplayOwners', () => {
  it('offers the records’ owners where the other org has them first, then the person who replays, each saying what it does there', () => {
    const onChange = vi.fn();
    render(<ReplayOwners value="same" onChange={onChange} target="QA" testId="owners" />);

    expect(screen.getByRole('group', { name: 'Who owns the records' })).toBeInTheDocument();
    expect(screen.getByTestId('owners-same')).toBeChecked();
    expect(screen.getByTestId('owners').textContent).toContain(
      'Kept when QA has the same active user; otherwise you.',
    );
    expect(screen.getByTestId('owners').textContent).toContain(
      'Every record replayed is yours in QA.',
    );
    fireEvent.click(screen.getByTestId('owners-me'));
    expect(onChange).toHaveBeenCalledWith('me');
  });

  it('names the other org generically before one is picked', () => {
    render(<ReplayOwners value="me" onChange={vi.fn()} target="" testId="owners" />);
    expect(screen.getByTestId('owners-me')).toBeChecked();
    expect(screen.getByTestId('owners').textContent).toContain(
      'Kept when the other org has the same active user; otherwise you.',
    );
  });
});
