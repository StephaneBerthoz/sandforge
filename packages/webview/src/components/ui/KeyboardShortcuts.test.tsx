import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { KeyboardShortcuts } from './KeyboardShortcuts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

describe('KeyboardShortcuts', () => {
  it('does not render overlay by default', () => {
    render(<KeyboardShortcuts />);
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).not.toBeInTheDocument();
  });

  it('opens overlay when ? key is pressed', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();
  });

  it('closes overlay when Escape is pressed', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).not.toBeInTheDocument();
  });

  it('closes overlay when ? is pressed again (toggle)', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByTestId('keyboard-shortcuts-overlay')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: '?' });
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).not.toBeInTheDocument();
  });

  it('closes overlay when clicking backdrop', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    fireEvent.click(screen.getByTestId('keyboard-shortcuts-backdrop'));
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).not.toBeInTheDocument();
  });

  it('closes overlay when clicking close button', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    fireEvent.click(screen.getByTestId('keyboard-shortcuts-close'));
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).not.toBeInTheDocument();
  });

  it('does not open when typing in an input', () => {
    render(
      <div>
        <input data-testid="test-input" />
        <KeyboardShortcuts />
      </div>,
    );
    const input = screen.getByTestId('test-input');
    fireEvent.keyDown(input, { key: '?' });
    expect(screen.queryByTestId('keyboard-shortcuts-overlay')).not.toBeInTheDocument();
  });

  it('shows shortcut groups when open', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByText('Navigation')).toBeInTheDocument();
    expect(screen.getByText('Quick Navigation')).toBeInTheDocument();
    expect(screen.getByText('Modules')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('shows Ctrl+1..6 shortcuts in Quick Navigation group', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    // "Go to Monitor" appears in both Quick Nav (Ctrl+1) and Modules (G+M) groups
    expect(screen.getAllByText('Go to Monitor').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Go to Seed').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Go to Sync').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Go to Compare').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Go to DataOps').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Go to Automation').length).toBeGreaterThanOrEqual(2);
  });

  it('shows execute and cancel shortcuts in Actions group', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    expect(screen.getByText('Execute current action')).toBeInTheDocument();
    expect(screen.getByText('Cancel / Close')).toBeInTheDocument();
  });

  it('has correct aria attributes for dialog', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document, { key: '?' });
    const dialog = screen.getByTestId('keyboard-shortcuts-overlay');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
