import { useEffect, useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../i18n';
import { DangerConfirm } from './DangerConfirm';

describe('DangerConfirm', () => {
  const baseProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    title: 'Delete All Data',
    description: 'This will permanently delete all records.',
    confirmText: 'DELETE',
  };

  it('should not render when closed', () => {
    render(<DangerConfirm {...baseProps} open={false} />);
    expect(screen.queryByText('Delete All Data')).toBeNull();
  });

  it('should render title and description when open', () => {
    render(<DangerConfirm {...baseProps} />);
    expect(screen.getByText('Delete All Data')).toBeDefined();
    expect(screen.getByText('This will permanently delete all records.')).toBeDefined();
  });

  it('should display the confirm text to type', () => {
    render(<DangerConfirm {...baseProps} />);
    expect(screen.getByText('DELETE')).toBeDefined();
  });

  it('shows what a sentence cannot say under the description, and still asks for the word', () => {
    render(
      <DangerConfirm {...baseProps}>
        <ul>
          <li>Contact: 2 records</li>
        </ul>
      </DangerConfirm>,
    );

    expect(screen.getByTestId('danger-details').textContent).toBe('Contact: 2 records');
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds no details block when there is nothing to add', () => {
    render(<DangerConfirm {...baseProps} />);
    expect(screen.queryByTestId('danger-details')).toBeNull();
  });

  it('should disable confirm button until text matches', () => {
    render(<DangerConfirm {...baseProps} />);
    const confirmBtn = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('should enable confirm button when text matches', () => {
    render(<DangerConfirm {...baseProps} />);
    const input = screen.getByTestId('danger-input');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    const confirmBtn = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });

  it('should call onConfirm when text matches and button clicked', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('should not call onConfirm when text does not match', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'WRONG' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('should call onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<DangerConfirm {...baseProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<DangerConfirm {...baseProps} onClose={onClose} />);
    const overlay = screen.getByTestId('danger-overlay');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should show warning colors when variant is warning', () => {
    render(<DangerConfirm {...baseProps} variant="warning" />);
    const titleEl = screen.getByTestId('danger-title');
    expect(titleEl.className).toContain('text-status-warning');
  });

  it('should show info colors when variant is info', () => {
    render(<DangerConfirm {...baseProps} variant="info" />);
    const titleEl = screen.getByTestId('danger-title');
    expect(titleEl.className).toContain('text-status-info');
  });

  it('should confirm on Enter key when text matches', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    const input = screen.getByTestId('danger-input');
    fireEvent.change(input, { target: { value: 'DELETE' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('should not confirm on Enter key when text does not match', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    const input = screen.getByTestId('danger-input');
    fireEvent.change(input, { target: { value: 'WRONG' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // The word to type sat in the field as its placeholder, in grey: the empty
  // field read as filled in while Confirm stayed disabled, and the field's
  // only name was "Confirm", the button's.
  it('leaves its field empty to the eye, named by the sentence that says what to type', () => {
    render(<DangerConfirm {...baseProps} />);

    const field = screen.getByRole('textbox', { name: 'Type DELETE to confirm:' });
    expect(field).toBe(screen.getByTestId('danger-input'));
    expect((field as HTMLInputElement).value).toBe('');
    expect(field.hasAttribute('placeholder')).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Confirm' })).toBeNull();
  });

  it('does not keep the typed text when its parent closes and reopens it', () => {
    // A parent that closes the dialog itself — a refresh removing what the
    // confirmation was about — never runs handleClose, so `typed` survived and
    // the next open came up already confirmed: one click, nothing typed.
    const onConfirm = vi.fn();
    const { rerender } = render(<DangerConfirm {...baseProps} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DELETE' } });

    rerender(<DangerConfirm {...baseProps} onConfirm={onConfirm} open={false} />);
    rerender(<DangerConfirm {...baseProps} onConfirm={onConfirm} open />);

    const confirmBtn = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement;
    expect((screen.getByTestId('danger-input') as HTMLInputElement).value).toBe('');
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

/*
 * Stopping one's own run asked to type "Cancel" — the label of the button
 * beside it, which closes the dialog and stops nothing — for a stop that
 * writes nothing.
 */
describe('DangerConfirm as a plain question', () => {
  const plainProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    title: 'Cancel run',
    description: 'Stop the running seed? Records already inserted stay in the org.',
    confirmLabel: 'Stop the run',
    dismissLabel: 'Keep running',
  };

  it('asks for nothing to be typed, and its buttons say what each does', () => {
    render(<DangerConfirm {...plainProps} />);

    expect(screen.queryByTestId('danger-input')).toBeNull();
    expect(screen.queryByText(/to confirm/)).toBeNull();
    const confirm = screen.getByTestId('danger-confirm-btn') as HTMLButtonElement;
    expect(confirm.textContent).toBe('Stop the run');
    expect(confirm.disabled).toBe(false);
    expect(screen.getByTestId('danger-dismiss-btn').textContent).toBe('Keep running');
  });

  it('confirms with one click', () => {
    const onConfirm = vi.fn();
    render(<DangerConfirm {...plainProps} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Stop the run' }));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('closes without confirming from the button that keeps the run going', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<DangerConfirm {...plainProps} onClose={onClose} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('hands the focus to the button that keeps the run going, so Enter on opening stops nothing', async () => {
    render(<DangerConfirm {...plainProps} />);

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('danger-dismiss-btn')),
    );
  });

  it('still says Cancel and Confirm where no labels are given', () => {
    render(<DangerConfirm {...plainProps} dismissLabel={undefined} confirmLabel="Remove" />);

    expect(screen.getByTestId('danger-dismiss-btn').textContent).toBe('Cancel');
    expect(screen.getByTestId('danger-confirm-btn').textContent).toBe('Remove');
  });

  it('keeps asking for the word where one is given', async () => {
    render(
      <DangerConfirm
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        title="Delete"
        description="Deletes the run's records."
        confirmText="DevSandbox"
      />,
    );

    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('danger-input')));
  });
});

/*
 * Radix gives the focus back to a Dialog.Trigger, which this dialog never
 * has: every answer left the keyboard on <body>.
 */
describe('DangerConfirm and the keyboard', () => {
  /** A button that asks, and, once confirmed, a heading the page hands the keyboard to. */
  function Asking({ headingOnConfirm = false }: { headingOnConfirm?: boolean }) {
    const [open, setOpen] = useState(false);
    const [done, setDone] = useState(false);
    const heading = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
      if (done) heading.current?.focus();
    }, [done]);
    return (
      <>
        <button onClick={() => setOpen(true)}>Delete the run</button>
        {done && (
          <h2 ref={heading} tabIndex={-1}>
            Deleting
          </h2>
        )}
        <DangerConfirm
          open={open}
          onClose={() => setOpen(false)}
          onConfirm={() => {
            setOpen(false);
            if (headingOnConfirm) setDone(true);
          }}
          title="Delete the run?"
          description="Deletes what the run created."
          confirmText="DevSandbox"
        />
      </>
    );
  }

  async function openFrom(opener: HTMLElement): Promise<void> {
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('danger-input')));
  }

  it('gives the keyboard back to the button that asked, on Cancel and on Confirm', async () => {
    render(<Asking />);
    const opener = screen.getByRole('button', { name: 'Delete the run' });

    await openFrom(opener);
    fireEvent.click(screen.getByTestId('danger-dismiss-btn'));
    await waitFor(() => expect(screen.queryByTestId('danger-input')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));

    await openFrom(opener);
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DevSandbox' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('danger-input')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('leaves the keyboard where the page put it as the dialog closed', async () => {
    render(<Asking headingOnConfirm />);
    await openFrom(screen.getByRole('button', { name: 'Delete the run' }));

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'DevSandbox' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('danger-input')).toBeNull());
    // The dialog gives the focus back a task after it leaves the page.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Deleting' }));
  });
});
