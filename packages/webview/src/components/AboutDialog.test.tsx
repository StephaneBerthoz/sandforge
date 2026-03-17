import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AboutDialog } from './AboutDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('./EasterEgg/MojitoOverlay', () => ({
  MojitoOverlay: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="mojito-overlay" onClick={onClose} />
  ),
}));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

describe('AboutDialog', () => {
  it('should render the dialog when open', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByTestId('about-dialog')).toBeDefined();
  });

  it('should display version text', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByText('SandForge v1.0.0')).toBeDefined();
  });

  it('should display the tagline', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByText('Forge your Salesforce sandboxes with confidence.')).toBeDefined();
  });

  it('should render the Logo component', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    const logo = screen.getByRole('img');
    expect(logo).toBeDefined();
  });

  it('should render Documentation link', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByText('Documentation')).toBeDefined();
  });

  it('should display credits', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    expect(screen.getByText('Crafted with passion by the SandForge team')).toBeDefined();
  });

  it('should call onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<AboutDialog isOpen onClose={onClose} />);
    const closeBtn = screen.getByText('common.close');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('should call showModal when opened', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
  });

  it('should have proper aria attributes', () => {
    render(<AboutDialog isOpen onClose={vi.fn()} />);
    const dialog = screen.getByTestId('about-dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe('about-dialog-title');
  });
});
