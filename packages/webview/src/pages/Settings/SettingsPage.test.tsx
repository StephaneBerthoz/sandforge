import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SettingsPage, defaultSettings } from './SettingsPage';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockSettingsRefetch = vi.fn();
const mockSettingsUpdateMutate = vi.fn();
const mockSettingsUpdateReset = vi.fn();
const mockTelemetryMutate = vi.fn();
const mockTelemetryRefetch = vi.fn();

/** Mutable telemetry status state returned by the useBridgeQuery mock. */
const mockTelemetryStatus: {
  data: { enabled: boolean; eventCount: number; bufferSize: number } | null;
  error: string | null;
} = { data: null, error: null };

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'telemetry:status') {
      return {
        data: mockTelemetryStatus.data,
        loading: false,
        error: mockTelemetryStatus.error,
        refetch: mockTelemetryRefetch,
      };
    }
    return {
      data: null,
      loading: false,
      error: null,
      refetch: mockSettingsRefetch,
    };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'telemetry:toggle') {
      return {
        mutate: mockTelemetryMutate,
        data: null,
        loading: false,
        error: null,
        reset: vi.fn(),
      };
    }
    return {
      mutate: mockSettingsUpdateMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockSettingsUpdateReset,
    };
  },
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    mockTelemetryStatus.data = null;
    mockTelemetryStatus.error = null;
    mockTelemetryMutate.mockClear();
    mockTelemetryRefetch.mockClear();
  });

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

  it('should switch to advanced tab', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByTestId('advanced-settings')).toBeDefined();
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

  it('should update language', () => {
    const onSave = vi.fn();
    render(<SettingsPage onSave={onSave} />);
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'fr' } });
    fireEvent.click(screen.getByTestId('save-settings-btn'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr' }));
    // Restore English so later tests in this file keep English labels —
    // the language select applies i18n.changeLanguage immediately.
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'en' } });
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

  it('should display the mocked telemetry status and real event count', () => {
    mockTelemetryStatus.data = { enabled: true, eventCount: 42, bufferSize: 0 };
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Telemetry'));
    expect(screen.getByText('Enabled')).toBeDefined();
    expect(screen.getByTestId('telemetry-events').textContent).toBe('42');
  });

  it('should dispatch the telemetry:toggle mutation when toggle clicked', () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Telemetry'));
    fireEvent.click(screen.getByTestId('telemetry-toggle-btn'));
    expect(mockTelemetryMutate).toHaveBeenCalledWith({ enabled: true });
  });

  it('should dispatch enabled:false when telemetry is currently on', () => {
    mockTelemetryStatus.data = { enabled: true, eventCount: 7, bufferSize: 0 };
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Telemetry'));
    fireEvent.click(screen.getByTestId('telemetry-toggle-btn'));
    expect(mockTelemetryMutate).toHaveBeenCalledWith({ enabled: false });
  });

  it('should show an honest unavailable state when the extension does not answer', () => {
    mockTelemetryStatus.error = "Bridge query 'telemetry:status' timed out after 5000ms";
    render(<SettingsPage />);
    fireEvent.click(screen.getByText('Telemetry'));
    expect(screen.getByTestId('telemetry-unavailable')).toBeDefined();
    expect(screen.queryByText('Disabled')).toBeNull();
    const toggleBtn = screen.getByTestId('telemetry-toggle-btn') as HTMLButtonElement;
    expect(toggleBtn.disabled).toBe(true);
  });
});
