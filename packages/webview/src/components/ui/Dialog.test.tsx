import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dialog } from './Dialog';

// jsdom doesn't implement dialog.showModal/close natively
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

describe('Dialog', () => {
  it('should render title when open', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Confirm">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByText('Confirm')).toBeDefined();
  });

  it('should render description when provided', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Title" description="Some description">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByText('Some description')).toBeDefined();
  });

  it('should render children content', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Title">
        <p>Dialog body content</p>
      </Dialog>,
    );
    expect(screen.getByText('Dialog body content')).toBeDefined();
  });

  it('should render footer when provided', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Title" footer={<button>OK</button>}>
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.getByText('OK')).toBeDefined();
  });

  it('should call showModal when opened', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Title">
        <p>Body</p>
      </Dialog>,
    );
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
  });

  it('should call onClose when dialog fires close event', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Title">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalled();
  });

  it('should have aria-modal attribute', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Title">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('should have aria-labelledby pointing to the title', () => {
    render(
      <Dialog open onClose={vi.fn()} title="My Title">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy as string);
    expect(titleEl?.textContent).toBe('My Title');
  });

  it('should have aria-describedby when description is provided', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Title" description="Helpful description">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const descEl = document.getElementById(describedBy as string);
    expect(descEl?.textContent).toBe('Helpful description');
  });

  it('should not have aria-describedby when no description', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Title">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-describedby')).toBeNull();
  });

  it('should use role="alertdialog" when danger prop is true', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Delete?" danger>
        <p>Are you sure?</p>
      </Dialog>,
    );
    expect(screen.getByRole('alertdialog')).toBeDefined();
  });

  it('should use default dialog role when danger is false', () => {
    render(
      <Dialog open onClose={vi.fn()} title="Info">
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('role')).toBeNull();
  });
});
