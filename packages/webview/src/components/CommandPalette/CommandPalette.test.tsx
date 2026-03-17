import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useCommandStore } from '../../stores/useCommandStore';
import { CommandPalette } from './CommandPalette';

/** Polyfill ResizeObserver and scrollIntoView for jsdom (required by cmdk). */
beforeAll(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {
      /* noop */
    }
    unobserve(): void {
      /* noop */
    }
    disconnect(): void {
      /* noop */
    }
  };
  Element.prototype.scrollIntoView = vi.fn();
});

describe('CommandPalette', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home' });
    useCommandStore.setState({ open: false, items: [] });
    sessionStorage.clear();
  });

  afterEach(() => {
    useCommandStore.setState({ open: false, items: [] });
    sessionStorage.clear();
  });

  /** Helper to open the palette via keyboard shortcut. */
  function openPalette(): void {
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
  }

  it('should not render when closed', () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
  });

  it('should open on Ctrl+K', () => {
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette-overlay')).toBeDefined();
  });

  it('should open on Meta+K (Cmd+K)', () => {
    render(<CommandPalette />);
    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    expect(screen.getByTestId('command-palette-overlay')).toBeDefined();
  });

  it('should close on Escape', async () => {
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette-overlay')).toBeDefined();

    const input = screen.getByTestId('command-palette-input');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
    });
  });

  it('should close on backdrop click', async () => {
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette-overlay')).toBeDefined();

    fireEvent.click(screen.getByTestId('command-palette-overlay'));
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
    });
  });

  it('should show search input with placeholder', () => {
    render(<CommandPalette />);
    openPalette();
    const input = screen.getByTestId('command-palette-input');
    expect(input).toBeDefined();
    expect(input.getAttribute('placeholder')).toBe('Search commands...');
  });

  it('should show navigation items', () => {
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette-item-nav-home')).toBeDefined();
    expect(screen.getByTestId('command-palette-item-nav-forge')).toBeDefined();
    expect(screen.getByTestId('command-palette-item-nav-settings')).toBeDefined();
  });

  it('should show action items', () => {
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette-item-quick-forge')).toBeDefined();
    expect(screen.getByTestId('command-palette-item-refresh-monitor')).toBeDefined();
  });

  it('should filter items based on query', () => {
    render(<CommandPalette />);
    openPalette();
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'Home' } });

    // Should show items matching "Home"
    expect(screen.getByTestId('command-palette-item-nav-home')).toBeDefined();
    // Should not show unrelated items
    expect(screen.queryByTestId('command-palette-item-nav-monitor')).toBeNull();
  });

  it('should show no results message when nothing matches', () => {
    render(<CommandPalette />);
    openPalette();
    const input = screen.getByTestId('command-palette-input');
    fireEvent.change(input, { target: { value: 'xyznonexistent' } });

    expect(screen.getByTestId('command-palette-no-results')).toBeDefined();
    expect(screen.getByText('No results found')).toBeDefined();
  });

  it('should navigate on item click', async () => {
    render(<CommandPalette />);
    openPalette();
    fireEvent.click(screen.getByTestId('command-palette-item-nav-forge'));
    expect(useAppStore.getState().currentRoute).toBe('forge');
    // Palette should close after selection
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
    });
  });

  it('should navigate with keyboard Enter', async () => {
    render(<CommandPalette />);
    openPalette();
    const input = screen.getByTestId('command-palette-input');

    // Type to filter to a single item, then press Enter
    fireEvent.change(input, { target: { value: 'Home' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useAppStore.getState().currentRoute).toBe('home');
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
    });
  });

  it('should navigate with arrow keys', () => {
    render(<CommandPalette />);
    openPalette();
    const input = screen.getByTestId('command-palette-input');

    // Move down one item
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // There should be at least one selected item
    const results = screen.getByTestId('command-palette-results');
    const selectedItems = results.querySelectorAll('[data-selected="true"]');
    expect(selectedItems.length).toBeGreaterThanOrEqual(1);
  });

  it('should toggle closed with Ctrl+K when already open', async () => {
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette-overlay')).toBeDefined();

    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
    });
  });

  it('should accept dynamically registered items via store', () => {
    const action = vi.fn();
    useCommandStore.getState().registerItems([
      {
        id: 'custom-action',
        label: 'Custom Action',
        group: 'actions',
        icon: 'star',
        action,
      },
    ]);
    render(<CommandPalette />);
    openPalette();
    expect(screen.getByTestId('command-palette-item-custom-action')).toBeDefined();
  });

  it('should group items by category', () => {
    render(<CommandPalette />);
    openPalette();
    // Should have Navigation and Actions category headers
    expect(screen.getAllByText('Navigation').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Actions').length).toBeGreaterThanOrEqual(1);
  });

  it('should use the command store open state', async () => {
    render(<CommandPalette />);
    expect(screen.queryByTestId('command-palette-overlay')).toBeNull();

    act(() => {
      useCommandStore.getState().setOpen(true);
    });
    expect(screen.getByTestId('command-palette-overlay')).toBeDefined();

    act(() => {
      useCommandStore.getState().setOpen(false);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('command-palette-overlay')).toBeNull();
    });
  });
});
