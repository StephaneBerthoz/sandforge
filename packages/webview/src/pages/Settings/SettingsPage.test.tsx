import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
import { SettingsPage, defaultSettings } from './SettingsPage';
import { stubLocaleBridge } from '../../i18n/testing/mockLocaleBridge';

/* The i18n module posts `i18n:locale` through this api for lazy locales. */
const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

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

/** Request types issued through useBridgeQuery, in call order. */
const bridgeQueryTypes: string[] = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    bridgeQueryTypes.push(type);
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
    bridgeQueryTypes.length = 0;
    // Auto-answer lazy locale requests with the real bundles.
    stubLocaleBridge(mockPostMessage);
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

  it('should update language', async () => {
    const onSave = vi.fn();
    render(<SettingsPage onSave={onSave} />);
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'fr' } });
    // The lazy locale load crosses the (stubbed) bridge — wait for the live
    // i18n language; handleSave persists that value, not the local snapshot.
    await waitFor(() => expect(i18n.language).toBe('fr'));
    fireEvent.click(screen.getByTestId('save-settings-btn'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr' }));
    // Restore English so later tests in this file keep English labels —
    // the language select applies i18n.changeLanguage immediately.
    fireEvent.change(screen.getByTestId('language-select'), { target: { value: 'en' } });
    await waitFor(() => expect(i18n.language).toBe('en'));
  });

  it('should not ship a plugins tab — the plugin manager never existed', () => {
    render(<SettingsPage />);
    expect(screen.queryByText('Plugins')).toBeNull();
    expect(screen.queryByTestId('plugins-settings')).toBeNull();
  });

  it('should offer the implemented tabs and no plugins tab', () => {
    render(<SettingsPage />);
    const tabLabels = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabLabels).toEqual(
      expect.arrayContaining(['General', 'AI', 'Advanced', 'Profiles', 'Telemetry']),
    );
    expect(tabLabels).not.toContain('Plugins');
  });

  it('should mount the config profile panel on the profiles tab', () => {
    render(<SettingsPage />);
    expect(screen.queryByTestId('config-profile-panel')).toBeNull();

    fireEvent.click(screen.getByText('Profiles'));

    const panel = screen.getByTestId('profiles-settings');
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-profiles');
    expect(screen.getByTestId('config-profile-panel')).toBeDefined();
    expect(screen.getByTestId('config-export-section')).toBeDefined();
    expect(screen.getByTestId('config-import-section')).toBeDefined();
  });

  it('should request config:categories once the profiles tab is opened', () => {
    render(<SettingsPage />);
    expect(bridgeQueryTypes).not.toContain('config:categories');

    fireEvent.click(screen.getByText('Profiles'));

    expect(bridgeQueryTypes).toContain('config:categories');
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
