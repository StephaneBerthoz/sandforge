import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SettingsPage, defaultSettings } from './SettingsPage';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockSettingsRefetch = vi.fn();
const mockSettingsUpdateMutate = vi.fn();
const mockSettingsUpdateReset = vi.fn();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: mockSettingsRefetch,
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockSettingsUpdateMutate,
    data: null,
    loading: false,
    error: null,
    reset: mockSettingsUpdateReset,
  }),
}));

describe('SettingsPage', () => {
  it('should render the page', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('settings-page')).toBeDefined();
  });

  it('should show page title', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('should show tabs', () => {
    render(<SettingsPage />);
    expect(screen.getAllByText('General').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Notifications').length).toBeGreaterThan(0);
    expect(screen.getByText('Advanced')).toBeDefined();
  });

  it('should show general settings by default', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('general-settings')).toBeDefined();
  });

  it('should show language select', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('language-select')).toBeDefined();
  });

  it('should show theme select', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('theme-select')).toBeDefined();
  });

  it('should switch to notifications tab', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Notifications'));
    expect(screen.getByTestId('notification-settings')).toBeDefined();
  });

  it('should show notification checkboxes', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Notifications'));
    expect(screen.getByTestId('enable-notifications-checkbox')).toBeDefined();
    expect(screen.getByTestId('sound-alerts-checkbox')).toBeDefined();
  });

  it('should switch to advanced tab', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByTestId('advanced-settings')).toBeDefined();
  });

  it('should show grappe settings in advanced', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByTestId('enable-grappe-checkbox')).toBeDefined();
    expect(screen.getByTestId('grappe-threshold-input')).toBeDefined();
  });

  it('should show log level select in advanced', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByTestId('log-level-select')).toBeDefined();
  });

  it('should call onSave and trigger mutation when save clicked', () => {
    const onSave = vi.fn();
    render(<SettingsPage onSave={onSave} />);
    fireEvent.click(screen.getByTestId('save-settings-btn'));
    expect(onSave).toHaveBeenCalledWith(defaultSettings);
    expect(mockSettingsUpdateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'settings' }),
    );
  });

  it('should call onReset when reset clicked', () => {
    const onReset = vi.fn();
    render(<SettingsPage onReset={onReset} />);
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.click(screen.getByTestId('reset-btn'));
    expect(onReset).toHaveBeenCalled();
  });

  it('should call onClearCache when clear cache clicked', () => {
    const onClearCache = vi.fn();
    render(<SettingsPage onClearCache={onClearCache} />);
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.click(screen.getByTestId('clear-cache-btn'));
    expect(onClearCache).toHaveBeenCalled();
  });

  it('should update batch size', () => {
    const onSave = vi.fn();
    render(<SettingsPage onSave={onSave} />);
    fireEvent.change(screen.getByTestId('batch-size-input'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('save-settings-btn'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ defaultBatchSize: 500 }));
  });

  it('should toggle enable notifications', () => {
    const onSave = vi.fn();
    render(<SettingsPage onSave={onSave} />);
    fireEvent.click(screen.getByText('Notifications'));
    fireEvent.click(screen.getByTestId('enable-notifications-checkbox'));
    fireEvent.click(screen.getByTestId('save-settings-btn'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ enableNotifications: false }));
  });

  it('should show plugins tab with no plugins message', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Plugins'));
    expect(screen.getByTestId('plugins-settings')).toBeDefined();
    expect(screen.getByText('No plugins installed')).toBeDefined();
  });

  it('should show telemetry tab with disabled status', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Telemetry'));
    expect(screen.getByTestId('telemetry-settings')).toBeDefined();
    expect(screen.getByText('Disabled')).toBeDefined();
    expect(screen.getByTestId('telemetry-toggle-btn')).toBeDefined();
  });

  it('should toggle telemetry state', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Telemetry'));
    expect(screen.getByText('Disabled')).toBeDefined();
    fireEvent.click(screen.getByTestId('telemetry-toggle-btn'));
    expect(screen.getByText('Enabled')).toBeDefined();
  });
});
