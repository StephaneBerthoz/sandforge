import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../../i18n';
import { QuickSyncCard } from './QuickSyncCard';

describe('QuickSyncCard', () => {
  it('renders its title and says what Quick Sync does', () => {
    // "Prod to sandbox in 3 clicks" was untrue: any pair of orgs works, and
    // the path takes three screens and about seven actions.
    render(<QuickSyncCard onStart={vi.fn()} />);

    expect(screen.getByText('Quick Sync')).toBeDefined();
    expect(
      screen.getByText(
        'Copy chosen objects from one org to another in three screens; every record is inserted.',
      ),
    ).toBeDefined();
  });

  it('draws its lightning bolt, which the icon font left blank', () => {
    render(<QuickSyncCard onStart={vi.fn()} />);

    const icon = within(screen.getByTestId('quick-sync-card')).getByTestId('icon-zap');
    expect(icon.tagName.toLowerCase()).toBe('svg');
    expect(icon.getAttribute('aria-hidden')).toBe('true');
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
