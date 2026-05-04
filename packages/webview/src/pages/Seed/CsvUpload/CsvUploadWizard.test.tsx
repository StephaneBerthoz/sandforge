import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n/index';
import { useOrgStore } from '../../../stores/useOrgStore';
import { CsvUploadWizard } from './CsvUploadWizard';

/* -------------------------------------------------------------------------- */
/* Mocks                                                                       */
/* -------------------------------------------------------------------------- */

vi.mock('papaparse', () => ({
  default: {
    parse: vi.fn((input: string, opts?: { preview?: number }) => {
      const lines = input
        .replace(/^\uFEFF/, '')
        .split('\n')
        .filter(Boolean);
      const fields = (lines[0] ?? '').split(',');
      const dataLines = lines.slice(1);
      const limited = opts?.preview ? dataLines.slice(0, opts.preview) : dataLines;
      const data = limited.map((line) => {
        const values = line.split(',');
        const row: Record<string, string> = {};
        fields.forEach((f, i) => {
          row[f] = values[i] ?? '';
        });
        return row;
      });
      return { data, meta: { fields } };
    }),
  },
}));

vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: {
      objects: [
        { apiName: 'Account', label: 'Account' },
        { apiName: 'Contact', label: 'Contact' },
      ],
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

const mockOrgs = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.sf.com',
    orgType: 'sandbox' as const,
    status: 'connected' as const,
    safetyTier: 'low' as const,
    apiVersion: '59.0',
    lastConnected: '2024-01-01T00:00:00Z',
  },
];

describe('CsvUploadWizard', () => {
  const onBack = vi.fn();

  beforeEach(() => {
    onBack.mockClear();
    useOrgStore.setState({ orgs: mockOrgs });
  });

  it('should render 4-step wizard with step indicator', () => {
    render(<CsvUploadWizard onBack={onBack} />);
    expect(screen.getByTestId('csv-upload-wizard')).toBeDefined();
    expect(screen.getByTestId('csv-step-indicator')).toBeDefined();
    expect(screen.getByTestId('csv-indicator-upload')).toBeDefined();
    expect(screen.getByTestId('csv-indicator-map')).toBeDefined();
    expect(screen.getByTestId('csv-indicator-validate')).toBeDefined();
    expect(screen.getByTestId('csv-indicator-execute')).toBeDefined();
  });

  it('should show FileDropZone and org/object selectors on first step', () => {
    render(<CsvUploadWizard onBack={onBack} />);
    expect(screen.getByTestId('csv-step-upload')).toBeDefined();
    expect(screen.getByTestId('csv-org-selector')).toBeDefined();
    expect(screen.getByTestId('file-drop-zone')).toBeDefined();
  });

  it('should show object selector after org is selected', () => {
    render(<CsvUploadWizard onBack={onBack} />);
    const orgSelect = screen.getByTestId('csv-org-selector');
    fireEvent.change(orgSelect, { target: { value: 'org-1' } });
    expect(screen.getByTestId('csv-object-selector')).toBeDefined();
  });

  it('should call onBack when cancel button is clicked', () => {
    render(<CsvUploadWizard onBack={onBack} />);
    fireEvent.click(screen.getByTestId('csv-cancel-button'));
    expect(onBack).toHaveBeenCalled();
  });

  it('should have next button disabled when no file or org selected', () => {
    render(<CsvUploadWizard onBack={onBack} />);
    const nextBtn = screen.getByTestId('csv-next-button');
    expect(nextBtn).toHaveProperty('disabled', true);
  });
});
