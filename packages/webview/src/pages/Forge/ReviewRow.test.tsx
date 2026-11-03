import { useEffect, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '../../i18n';
import { ReviewRow, type ReviewRowProps } from './ReviewRow';

/** A row that opens and closes on its button, as Review's do. */
function Row({
  startOpen = false,
  children,
  ...props
}: Partial<ReviewRowProps> & { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <ReviewRow
      id="plan"
      name="Plan"
      summary="2 objects"
      state="ready"
      open={open}
      onToggle={() => setOpen((was) => !was)}
      {...props}
    >
      {children ?? <input aria-label="Inside" data-testid="inside" />}
    </ReviewRow>
  );
}

describe('ReviewRow', () => {
  it('is a button that says it opens, never a tab', () => {
    render(<Row />);
    const row = screen.getByRole('button', { name: /Plan/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('aria-controls')).toBe('tabpanel-plan');
    expect(row.getAttribute('data-testid')).toBe('tab-plan');
    // What it controls is on the page while closed: axe refuses an id it cannot find.
    expect(document.getElementById('tabpanel-plan')).not.toBeNull();
  });

  it('names the part, what it comes to and where it stands, in that order', () => {
    render(<Row />);
    expect(screen.getByTestId('tab-plan').textContent).toBe('Plan2 objectsReady');
  });

  it('draws nothing of what it opens before it is opened', () => {
    const asked = vi.fn();
    const Reads = () => {
      useEffect(asked, []);
      return <p>read</p>;
    };
    render(
      <Row>
        <Reads />
      </Row>,
    );
    expect(asked).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('tab-plan'));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('keeps what it opened, hidden, so a choice made in it is there when it opens again', () => {
    render(<Row />);
    fireEvent.click(screen.getByTestId('tab-plan'));
    fireEvent.change(screen.getByTestId('inside'), { target: { value: 'kept' } });

    fireEvent.click(screen.getByTestId('tab-plan'));
    const panel = document.getElementById('tabpanel-plan') as HTMLElement;
    expect(panel.hidden).toBe(true);

    fireEvent.click(screen.getByTestId('tab-plan'));
    expect(panel.hidden).toBe(false);
    expect(screen.getByTestId('inside')).toHaveProperty('value', 'kept');
  });

  it('opens at once when it asks for a decision', () => {
    render(<Row startOpen state="decide" />);
    expect(screen.getByTestId('inside')).toBeDefined();
    expect(screen.getByTestId('tab-plan').getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['decide', 'Needs you'],
    ['ready', 'Ready'],
    ['working', 'Working…'],
    ['failed', 'Failed'],
    ['toRead', 'To read'],
  ] as const)('says %s in a word, with a mark, never by its colour alone', (state, word) => {
    render(<Row state={state} />);
    const said = screen.getByTestId('review-row-plan-state');
    expect(said.textContent).toBe(word);
    expect(said.querySelector('svg')).not.toBeNull();
  });

  it('says nothing of a state it was not given', () => {
    render(<Row state={undefined} />);
    expect(screen.queryByTestId('review-row-plan-state')).toBeNull();
  });
});
