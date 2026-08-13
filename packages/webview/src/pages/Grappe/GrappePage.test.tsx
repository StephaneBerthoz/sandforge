import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import en from '../../i18n/locales/en.json';
import { useAppStore } from '../../stores/useAppStore';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { GrappePage } from './GrappePage';

describe('GrappePage empty state', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'grappe' });
    useGrappeStore.setState({
      active: false,
      totalPartitions: 0,
      totalRecords: 0,
      partitions: new Map(),
      totalProcessed: 0,
      totalFailed: 0,
    });
  });

  it('sends the user to a module whose runs can actually populate this page', () => {
    // Only Seed, Sync and Autopilot emit grappe:* events. The CTA used to open
    // Forge, which emits none — following it could never fill the dashboard it
    // was offered from.
    render(<GrappePage />);
    fireEvent.click(screen.getByTestId('grappe-settings'));
    expect(useAppStore.getState().currentRoute).toBe('seed');
  });

  it('should label the call to action as a module action, not a settings one', () => {
    render(<GrappePage />);
    expect(screen.getByTestId('grappe-settings').textContent).toBe(en.grappe.openSeed);
  });

  it('should not promise a threshold setting that does not exist', () => {
    render(<GrappePage />);
    const page = screen.getByTestId('grappe-page');
    expect(page.textContent).not.toMatch(/threshold/i);
    expect(screen.getByText(en.grappe.emptyDesc)).toBeDefined();
  });
});
