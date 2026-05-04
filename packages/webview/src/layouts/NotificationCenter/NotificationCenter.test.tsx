import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useNotificationStore, resetNotificationCounter } from '../../stores/useNotificationStore';
import { NotificationCenter } from './NotificationCenter';

describe('NotificationCenter', () => {
  beforeEach(() => {
    resetNotificationCounter();
    useNotificationStore.setState({
      notifications: [],
      filterLevel: 'all',
      filterCategory: 'all',
      searchQuery: '',
    });
  });

  it('should not render when closed', () => {
    render(<NotificationCenter open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('notification-center')).toBeNull();
  });

  it('should render when open', () => {
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByTestId('notification-center')).toBeDefined();
  });

  it('should show empty state when no notifications', () => {
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByText('No notifications')).toBeDefined();
  });

  it('should display notifications', () => {
    useNotificationStore.getState().addNotification({
      level: 'info',
      title: 'Test Notification',
      message: 'Test message body',
    });
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByText('Test Notification')).toBeDefined();
    expect(screen.getByText('Test message body')).toBeDefined();
  });

  it('should call onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<NotificationCenter open onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should remove notification on dismiss', () => {
    useNotificationStore.getState().addNotification({
      level: 'success',
      title: 'Done',
      message: 'Completed',
    });
    render(<NotificationCenter open onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('should show Mark all read and Clear all buttons when notifications exist', () => {
    useNotificationStore.getState().addNotification({
      level: 'info',
      title: 'Info',
      message: 'Msg',
    });
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByText('Mark all as read')).toBeDefined();
    expect(screen.getByText('Clear all')).toBeDefined();
  });

  // ── Level filter tabs ──

  it('should render level filter tabs', () => {
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByTestId('notification-level-filters')).toBeDefined();
    expect(screen.getByTestId('filter-level-all')).toBeDefined();
    expect(screen.getByTestId('filter-level-info')).toBeDefined();
    expect(screen.getByTestId('filter-level-error')).toBeDefined();
  });

  it('should filter notifications by level when clicking tab', () => {
    useNotificationStore
      .getState()
      .addNotification({ level: 'info', title: 'Info notif', message: 'msg' });
    useNotificationStore
      .getState()
      .addNotification({ level: 'error', title: 'Error notif', message: 'msg' });
    render(<NotificationCenter open onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('filter-level-error'));
    expect(screen.getByText('Error notif')).toBeDefined();
    expect(screen.queryByText('Info notif')).toBeNull();
  });

  it('should show all when "All" filter is clicked', () => {
    useNotificationStore
      .getState()
      .addNotification({ level: 'info', title: 'Info notif', message: 'msg' });
    useNotificationStore
      .getState()
      .addNotification({ level: 'error', title: 'Error notif', message: 'msg' });
    useNotificationStore.getState().setFilterLevel('error');
    render(<NotificationCenter open onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('filter-level-all'));
    expect(screen.getByText('Info notif')).toBeDefined();
    expect(screen.getByText('Error notif')).toBeDefined();
  });

  // ── Category filter ──

  it('should render category filter buttons', () => {
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByTestId('notification-category-filters')).toBeDefined();
    expect(screen.getByTestId('filter-category-sync')).toBeDefined();
    expect(screen.getByTestId('filter-category-system')).toBeDefined();
  });

  // ── Search ──

  it('should filter notifications by search query', () => {
    useNotificationStore
      .getState()
      .addNotification({ level: 'info', title: 'Deploy done', message: 'ok' });
    useNotificationStore
      .getState()
      .addNotification({ level: 'info', title: 'Sync failed', message: 'timeout' });
    render(<NotificationCenter open onClose={vi.fn()} />);

    const search = screen.getByTestId('notification-search');
    fireEvent.change(search, { target: { value: 'deploy' } });
    expect(screen.getByText('Deploy done')).toBeDefined();
    expect(screen.queryByText('Sync failed')).toBeNull();
  });

  // ── Date grouping ──

  it('should show Today header for notifications from today', () => {
    useNotificationStore
      .getState()
      .addNotification({ level: 'info', title: 'Recent', message: 'msg' });
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByTestId('date-group-today')).toBeDefined();
    expect(screen.getByText('Today')).toBeDefined();
  });

  it('should show Earlier header for old notifications', () => {
    // Manually add a notification with yesterday's timestamp
    const yesterday = Date.now() - 86400000 * 2;
    useNotificationStore.setState({
      notifications: [
        {
          id: 'old-1',
          level: 'info',
          title: 'Old notif',
          message: 'old msg',
          timestamp: yesterday,
          read: false,
          category: 'system',
        },
      ],
    });
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByTestId('date-group-earlier')).toBeDefined();
    expect(screen.getByText('Earlier')).toBeDefined();
  });

  // ── Empty state with active filters ──

  it('should show no matching message when filters yield zero results', () => {
    useNotificationStore
      .getState()
      .addNotification({ level: 'info', title: 'Info', message: 'msg' });
    useNotificationStore.getState().setFilterLevel('error');
    render(<NotificationCenter open onClose={vi.fn()} />);
    expect(screen.getByTestId('notification-empty-state')).toBeDefined();
    expect(screen.getByText('No matching notifications')).toBeDefined();
  });
});
