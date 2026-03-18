import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useAppStore } from '../../stores/useAppStore';
import { useCommandStore } from '../../stores/useCommandStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { TopBar } from './TopBar';

describe('TopBar', () => {
  beforeEach(() => {
    useAppStore.setState({
      currentRoute: 'home',
      sidebarCollapsed: false,
    });
    useCommandStore.setState({ open: false });
    useNotificationStore.setState({ notifications: [] });
  });

  it('should have testid topbar', () => {
    render(<TopBar />);
    expect(screen.getByTestId('topbar')).toBeDefined();
  });

  it('should render the app logo with Flame icon', () => {
    render(<TopBar />);
    const logo = screen.getByTestId('app-logo');
    expect(logo).toBeDefined();
    expect(logo.textContent).toContain('SandForge');
  });

  it('should render the search trigger', () => {
    render(<TopBar />);
    const trigger = screen.getByTestId('topbar-search-trigger');
    expect(trigger).toBeDefined();
    expect(trigger.textContent).toContain('Ctrl+K');
  });

  it('should open command palette when search trigger is clicked', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-search-trigger'));
    expect(useCommandStore.getState().open).toBe(true);
  });

  it('should render the org switcher', () => {
    render(<TopBar />);
    expect(screen.getByTestId('org-switcher')).toBeDefined();
  });

  it('should render notification bell', () => {
    render(<TopBar />);
    expect(screen.getByTestId('topbar-notifications')).toBeDefined();
  });

  it('should render settings gear', () => {
    render(<TopBar />);
    expect(screen.getByTestId('topbar-settings')).toBeDefined();
  });

  it('should navigate to settings when gear is clicked', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('topbar-settings'));
    expect(useAppStore.getState().currentRoute).toBe('settings');
  });

  it('should toggle sidebar on button click', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByLabelText('Toggle sidebar'));
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it('should call onNotificationsToggle when bell is clicked', () => {
    const onToggle = vi.fn();
    render(<TopBar onNotificationsToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('topbar-notifications'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('should show unread badge when notifications exist', () => {
    useNotificationStore.setState({
      notifications: [
        { id: 'n1', level: 'info', title: 'Test', message: 'msg', timestamp: Date.now(), read: false },
        { id: 'n2', level: 'info', title: 'Test2', message: 'msg2', timestamp: Date.now(), read: false },
      ],
    });
    render(<TopBar />);
    const bell = screen.getByTestId('topbar-notifications');
    expect(bell.textContent).toContain('2');
  });

  it('should not show badge when unread count is 0', () => {
    useNotificationStore.setState({
      notifications: [
        { id: 'n1', level: 'info', title: 'Test', message: 'msg', timestamp: Date.now(), read: true },
      ],
    });
    render(<TopBar />);
    const bell = screen.getByTestId('topbar-notifications');
    expect(bell.textContent).not.toContain('1');
  });
});
