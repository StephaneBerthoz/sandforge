import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { QuickSyncCard } from './QuickSyncCard';

describe('QuickSyncCard', () => {
  it('renders title and subtitle', () => {
    render(<QuickSyncCard onStart={vi.fn()} />);

    expect(screen.getByText('Quick Sync')).toBeDefined();
    expect(screen.getByText('Prod to sandbox in 3 clicks')).toBeDefined();
  });

  it('renders start button', () => {
    render(<QuickSyncCard onStart={vi.fn()} />);

    expect(screen.getByTestId('quick-sync-start-btn')).toBeDefined();
    expect(screen.getByText('Start Quick Sync')).toBeDefined();
  });

  it('calls onStart callback when button clicked', () => {
    const onStart = vi.fn();
    render(<QuickSyncCard onStart={onStart} />);

    fireEvent.click(screen.getByTestId('quick-sync-start-btn'));

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('has the card test id for integration testing', () => {
    render(<QuickSyncCard onStart={vi.fn()} />);

    expect(screen.getByTestId('quick-sync-card')).toBeDefined();
  });
});
