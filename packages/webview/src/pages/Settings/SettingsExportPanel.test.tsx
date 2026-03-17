import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { SettingsExportPanel } from './SettingsExportPanel';

const mockSettings = JSON.stringify({ language: 'en', theme: 'dark' }, null, 2);

describe('SettingsExportPanel', () => {
  it('should render the panel', () => {
    render(<SettingsExportPanel />);
    expect(screen.getByTestId('settings-export-panel')).toBeDefined();
  });

  it('should show export and import buttons', () => {
    render(<SettingsExportPanel />);
    expect(screen.getByTestId('export-btn')).toBeDefined();
    expect(screen.getByTestId('import-btn')).toBeDefined();
  });

  it('should show textarea for import', () => {
    render(<SettingsExportPanel />);
    expect(screen.getByTestId('import-textarea')).toBeDefined();
  });

  it('should call onExport and populate textarea', () => {
    const onExport = vi.fn().mockReturnValue(mockSettings);
    render(<SettingsExportPanel onExport={onExport} />);
    fireEvent.click(screen.getByTestId('export-btn'));
    expect(onExport).toHaveBeenCalled();
    const textarea = screen.getByTestId('import-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(mockSettings);
  });

  it('should call onImport with textarea content', () => {
    const onImport = vi.fn().mockReturnValue(true);
    render(<SettingsExportPanel onImport={onImport} />);
    const textarea = screen.getByTestId('import-textarea');
    fireEvent.change(textarea, { target: { value: mockSettings } });
    fireEvent.click(screen.getByTestId('import-btn'));
    expect(onImport).toHaveBeenCalledWith(mockSettings);
  });

  it('should show success message on successful import', () => {
    const onImport = vi.fn().mockReturnValue(true);
    render(<SettingsExportPanel onImport={onImport} />);
    fireEvent.change(screen.getByTestId('import-textarea'), { target: { value: mockSettings } });
    fireEvent.click(screen.getByTestId('import-btn'));
    expect(screen.getByTestId('import-success')).toBeDefined();
  });

  it('should show error message on failed import', () => {
    const onImport = vi.fn().mockReturnValue(false);
    render(<SettingsExportPanel onImport={onImport} />);
    fireEvent.change(screen.getByTestId('import-textarea'), { target: { value: 'invalid' } });
    fireEvent.click(screen.getByTestId('import-btn'));
    expect(screen.getByTestId('import-error')).toBeDefined();
  });

  it('should disable import button when textarea is empty', () => {
    render(<SettingsExportPanel />);
    const importBtn = screen.getByTestId('import-btn') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
  });

  it('should enable import button when textarea has content', () => {
    render(<SettingsExportPanel />);
    fireEvent.change(screen.getByTestId('import-textarea'), { target: { value: '{}' } });
    const importBtn = screen.getByTestId('import-btn') as HTMLButtonElement;
    expect(importBtn.disabled).toBe(false);
  });

  it('should reset status when textarea changes', () => {
    const onImport = vi.fn().mockReturnValue(true);
    render(<SettingsExportPanel onImport={onImport} />);
    fireEvent.change(screen.getByTestId('import-textarea'), { target: { value: mockSettings } });
    fireEvent.click(screen.getByTestId('import-btn'));
    expect(screen.getByTestId('import-success')).toBeDefined();
    fireEvent.change(screen.getByTestId('import-textarea'), { target: { value: 'new' } });
    expect(screen.queryByTestId('import-success')).toBeNull();
  });

  it('should show copy button', () => {
    render(<SettingsExportPanel />);
    expect(screen.getByTestId('copy-btn')).toBeDefined();
  });
});
