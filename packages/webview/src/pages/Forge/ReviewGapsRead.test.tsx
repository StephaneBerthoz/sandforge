import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ReviewGapsRead } from './ReviewGapsRead';
import type { ForgeGapsReadSummary } from './useForgeGaps';

const READ: ForgeGapsReadSummary = {
  count: 4,
  blocking: 1,
  formulasNotRead: 2,
  unread: [{ part: 'duplicateRuleActions', reason: 'INSUFFICIENT_ACCESS' }],
  requests: 11,
};

describe('ReviewGapsRead', () => {
  it('shows nothing before a read was asked', () => {
    const { container } = render(
      <ReviewGapsRead gaps={{ pending: false, read: null, error: null }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('says the read is under way', () => {
    render(<ReviewGapsRead gaps={{ pending: true, read: null, error: null }} />);
    expect(screen.getByTestId('forge-gaps-read').textContent).toBe(
      'Reading what the target org holds against the rows…',
    );
  });

  it('says how many gaps were read, how many refuse rows, and what it cost', () => {
    render(<ReviewGapsRead gaps={{ pending: false, read: READ, error: null }} />);
    expect(screen.getByTestId('forge-gaps-read-found').textContent).toBe(
      "4 gaps read from the target org's metadata. 1 of them refuses rows. " +
        'Read in 11 requests to the target org.',
    );
  });

  it('says what the read left unread and what the target would not give', () => {
    render(<ReviewGapsRead gaps={{ pending: false, read: READ, error: null }} />);
    const items = [...screen.getByTestId('forge-gaps-read-unread').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    expect(items).toEqual([
      '2 validation rule formulas not read: the read takes 25 at most, one request each.',
      'What the duplicate rules do on insert could not be read: INSUFFICIENT_ACCESS',
    ]);
  });

  it('leaves out the blocking count and the unread list when there are none', () => {
    render(
      <ReviewGapsRead
        gaps={{
          pending: false,
          read: { ...READ, count: 1, blocking: 0, formulasNotRead: 0, unread: [], requests: 1 },
          error: null,
        }}
      />,
    );
    expect(screen.getByTestId('forge-gaps-read-found').textContent).toBe(
      "1 gap read from the target org's metadata. Read in 1 request to the target org.",
    );
    expect(screen.queryByTestId('forge-gaps-read-unread')).toBeNull();
  });

  it('says why the read could not run', () => {
    render(<ReviewGapsRead gaps={{ pending: false, read: null, error: 'session expired' }} />);
    expect(screen.getByTestId('forge-gaps-read-error').textContent).toBe(
      'What the target org holds against the rows could not be read: session expired',
    );
  });
});
