import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useNotificationStore, resetNotificationCounter } from '../../stores/useNotificationStore';
import { NotificationCenter } from './NotificationCenter';

describe('NotificationCenter', () => {
  beforeEach(() => {
    resetNotificationCounter();
    useNotificationStore.setState({ notifications: [] });
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
});
