import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TeamSharingPanel } from './TeamSharingPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue: string, params?: Record<string, unknown>) => {
      if (params) {
        let result = defaultValue;
        for (const [k, v] of Object.entries(params)) {
          result = result.replace(`{{${k}}}`, String(v));
        }
        return result;
      }
      return defaultValue;
    },
  }),
}));

const mockCategories = [
  { id: 'syncMappings', label: 'Sync Mappings', entryCount: 5 },
  { id: 'forgePlans', label: 'Forge Plans', entryCount: 3 },
  { id: 'settings', label: 'Settings', entryCount: 10 },
];

describe('TeamSharingPanel', () => {
  it('renders the panel', () => {
    render(<TeamSharingPanel />);
    expect(screen.getByTestId('team-sharing-panel')).toBeTruthy();
  });

  it('renders share categories', () => {
    render(<TeamSharingPanel categories={mockCategories} />);
    expect(screen.getByTestId('share-categories')).toBeTruthy();
    expect(screen.getByTestId('category-syncMappings')).toBeTruthy();
    expect(screen.getByTestId('category-forgePlans')).toBeTruthy();
    expect(screen.getByTestId('category-settings')).toBeTruthy();
  });

  it('toggles category selection', () => {
    render(<TeamSharingPanel categories={mockCategories} />);
    const checkbox = screen.getByTestId('category-syncMappings') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it('disables share button when no categories selected', () => {
    render(<TeamSharingPanel categories={mockCategories} />);
    const btn = screen.getByTestId('share-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables share button when categories are selected', () => {
    render(<TeamSharingPanel categories={mockCategories} />);
    fireEvent.click(screen.getByTestId('category-syncMappings'));
    const btn = screen.getByTestId('share-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('calls onShare with selected categories', () => {
    const onShare = vi.fn();
    render(<TeamSharingPanel categories={mockCategories} onShare={onShare} />);
    fireEvent.click(screen.getByTestId('category-syncMappings'));
    fireEvent.click(screen.getByTestId('share-btn'));
    expect(onShare).toHaveBeenCalledWith(['syncMappings'], undefined);
  });

  it('includes author name in share call', () => {
    const onShare = vi.fn();
    render(<TeamSharingPanel categories={mockCategories} onShare={onShare} />);
    fireEvent.click(screen.getByTestId('category-syncMappings'));
    fireEvent.change(screen.getByTestId('author-input'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('share-btn'));
    expect(onShare).toHaveBeenCalledWith(['syncMappings'], 'Alice');
  });

  it('shows generated bundle', () => {
    render(<TeamSharingPanel sharedBundle="base64encodeddata" />);
    expect(screen.getByTestId('shared-bundle')).toBeTruthy();
    const textarea = screen.getByTestId('bundle-output') as HTMLTextAreaElement;
    expect(textarea.value).toBe('base64encodeddata');
  });

  it('shows copy button for shared bundle', () => {
    render(<TeamSharingPanel sharedBundle="data" />);
    expect(screen.getByTestId('copy-bundle-btn')).toBeTruthy();
  });

  it('renders import textarea', () => {
    render(<TeamSharingPanel />);
    expect(screen.getByTestId('import-textarea')).toBeTruthy();
  });

  it('disables import button when textarea is empty', () => {
    render(<TeamSharingPanel />);
    const btn = screen.getByTestId('import-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls onImport with bundle and strategy', () => {
    const onImport = vi.fn();
    render(<TeamSharingPanel onImport={onImport} />);
    fireEvent.change(screen.getByTestId('import-textarea'), { target: { value: 'bundledata' } });
    fireEvent.click(screen.getByTestId('import-btn'));
    expect(onImport).toHaveBeenCalledWith('bundledata', 'keep-remote');
  });

  it('calls onPreview when preview button clicked', () => {
    const onPreview = vi.fn();
    render(<TeamSharingPanel onPreview={onPreview} />);
    fireEvent.change(screen.getByTestId('import-textarea'), { target: { value: 'bundledata' } });
    fireEvent.click(screen.getByTestId('preview-btn'));
    expect(onPreview).toHaveBeenCalledWith('bundledata');
  });

  it('shows conflicts', () => {
    const conflicts = [{ key: 'sync:mapping1', localValue: 'A', remoteValue: 'B' }];
    render(<TeamSharingPanel conflicts={conflicts} />);
    expect(screen.getByTestId('import-conflicts')).toBeTruthy();
    expect(screen.getByTestId('conflict-sync:mapping1')).toBeTruthy();
  });

  it('shows successful import result', () => {
    render(<TeamSharingPanel importResult={{ success: true, keysImported: 5, keysSkipped: 2 }} />);
    expect(screen.getByTestId('import-result')).toBeTruthy();
    expect(screen.getByText('Imported 5 keys, skipped 2')).toBeTruthy();
  });

  it('shows failed import result', () => {
    render(
      <TeamSharingPanel
        importResult={{ success: false, keysImported: 0, keysSkipped: 0, error: 'Invalid bundle' }}
      />,
    );
    expect(screen.getByTestId('import-result')).toBeTruthy();
    expect(screen.getByText('Invalid bundle')).toBeTruthy();
  });

  it('shows loading state', () => {
    render(<TeamSharingPanel loading={true} categories={mockCategories} />);
    const shareBtn = screen.getByTestId('share-btn') as HTMLButtonElement;
    expect(shareBtn.disabled).toBe(true);
  });
});
