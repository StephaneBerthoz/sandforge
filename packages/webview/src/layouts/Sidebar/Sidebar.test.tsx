import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import { Sidebar } from './Sidebar';

describe('Sidebar', () => {
  beforeEach(() => {
    useAppStore.setState({
      currentRoute: 'home',
      sidebarCollapsed: false,
    });
    useRecentOpsStore.setState({ ops: [] });
  });

  it('should render navigation items', () => {
    render(<Sidebar />);
    expect(screen.getByText('Home')).toBeDefined();
    expect(screen.getByText('Monitor')).toBeDefined();
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('should highlight the active route', () => {
    useAppStore.setState({ currentRoute: 'monitor' });
    render(<Sidebar />);
    const monitorBtn = screen.getByText('Monitor').closest('button')!;
    expect(monitorBtn.className).toContain('bg-surface-3');
  });

  it('should navigate on click', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('Monitor'));
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });

  it('should render badges when provided', () => {
    render(<Sidebar badges={{ orgs: 3 }} />);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('should collapse to icon-only mode with w-14', () => {
    useAppStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar.className).toContain('w-14');
  });

  it('should show full width w-56 when not collapsed', () => {
    render(<Sidebar />);
    const sidebar = screen.getByTestId('sidebar');
    expect(sidebar.className).toContain('w-56');
  });

  it('should render the Forge hero section', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-forge-hero')).toBeDefined();
    expect(screen.getByText('Forge')).toBeDefined();
  });

  it('should render Lucide icons instead of emoji', () => {
    render(<Sidebar />);
    const sidebar = screen.getByTestId('sidebar');
    // SVGs should be present (Lucide renders as SVG)
    const svgs = sidebar.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
  });

  it('should show "No recent ops" when no operations', () => {
    render(<Sidebar />);
    expect(screen.getByTestId('sidebar-no-recent-ops')).toBeDefined();
  });

  it('should display recent operations from the store', () => {
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'forge',
          label: 'Forge Account',
          status: 'success',
          timestamp: Date.now() - 60_000,
        },
        {
          id: 'op-2',
          type: 'forge',
          label: 'Forge Contacts',
          status: 'running',
          timestamp: Date.now() - 120_000,
        },
      ],
    });
    render(<Sidebar />);
    expect(screen.getByText('Forge Account')).toBeDefined();
    expect(screen.getByText('Forge Contacts')).toBeDefined();
    expect(screen.getAllByTestId('sidebar-recent-op-item')).toHaveLength(2);
  });

  it('should toggle sidebar on Ctrl+B', () => {
    render(<Sidebar />);
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });
});
