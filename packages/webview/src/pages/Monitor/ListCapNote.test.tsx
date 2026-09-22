import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ListCapNote } from './ListCapNote';

describe('ListCapNote', () => {
  it('says where the list stops, and that its counts stop there too', () => {
    render(<ListCapNote shown={2000} testId="list-cap" />);

    expect(screen.getByTestId('list-cap').textContent).toBe(
      'Only the 2,000 most recent are read here: the list and its counts stop there.',
    );
  });
});
