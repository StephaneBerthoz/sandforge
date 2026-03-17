import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgHealthPanel } from './OrgHealthPanel';

// Mock stores and hooks
const mockSelectedOrgId = vi.fn<() => string | null>().mockReturnValue('org-1');
vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ selectedOrgId: mockSelectedOrgId() }),
}));

const mockMutate = vi.fn();
const mockMutationData = vi.fn<() => Record<string, unknown> | null>().mockReturnValue(null);
const mockMutationLoading = vi.fn<() => boolean>().mockReturnValue(false);
const mockMutationError = vi.fn<() => string | null>().mockReturnValue(null);

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockMutate,
    data: mockMutationData(),
    loading: mockMutationLoading(),
    error: mockMutationError(),
    reset: vi.fn(),
  }),
}));

describe('OrgHealthPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedOrgId.mockReturnValue('org-1');
    mockMutationData.mockReturnValue(null);
    mockMutationLoading.mockReturnValue(false);
    mockMutationError.mockReturnValue(null);
  });

  it('should render the panel', () => {
    render(<OrgHealthPanel />);
    expect(screen.getByTestId('org-health-panel')).toBeDefined();
  });

  it('should show empty state when no data', () => {
    render(<OrgHealthPanel />);
    expect(screen.getByTestId('health-empty')).toBeDefined();
  });

  it('should show scan button', () => {
    render(<OrgHealthPanel />);
    expect(screen.getByTestId('scan-health-btn')).toBeDefined();
  });

  it('should call mutate when scan clicked', () => {
    render(<OrgHealthPanel />);
    fireEvent.click(screen.getByTestId('scan-health-btn'));
    expect(mockMutate).toHaveBeenCalledWith({ orgId: 'org-1' });
  });

  it('should disable scan button when no org selected', () => {
    mockSelectedOrgId.mockReturnValue(null);
    render(<OrgHealthPanel />);
    const btn = screen.getByTestId('scan-health-btn');
    expect(btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('should show error message', () => {
    mockMutationError.mockReturnValue('Failed to compute health score');
    render(<OrgHealthPanel />);
    expect(screen.getByTestId('health-error')).toBeDefined();
    expect(screen.getByText('Failed to compute health score')).toBeDefined();
  });

  it('should render radar chart when data available', () => {
    mockMutationData.mockReturnValue({
      success: true,
      overallScore: 78,
      dimensions: [
        { name: 'apiUsage', score: 85, label: 'API Usage', detail: '30% used', recommendation: 'OK' },
        { name: 'storageUsage', score: 70, label: 'Storage Usage', detail: '60% used', recommendation: 'Monitor' },
        { name: 'metadataComplexity', score: 80, label: 'Metadata Complexity', detail: '50 objects', recommendation: 'OK' },
        { name: 'codeCoverage', score: 90, label: 'Code Coverage', detail: '92% coverage', recommendation: 'OK' },
        { name: 'securitySettings', score: 65, label: 'Security Settings', detail: '2 issues', recommendation: 'Fix' },
      ],
      recommendations: ['Enable MFA', 'Increase password length'],
    });

    render(<OrgHealthPanel />);
    expect(screen.getByTestId('radar-chart')).toBeDefined();
    expect(screen.getByTestId('overall-score')).toBeDefined();
    expect(screen.getByText('78')).toBeDefined();
  });

  it('should render dimension cards', () => {
    mockMutationData.mockReturnValue({
      success: true,
      overallScore: 78,
      dimensions: [
        { name: 'apiUsage', score: 85, label: 'API Usage', detail: '30% used', recommendation: 'OK' },
        { name: 'storageUsage', score: 70, label: 'Storage', detail: '60% used', recommendation: 'Monitor' },
        { name: 'metadataComplexity', score: 80, label: 'Metadata', detail: '50 objects', recommendation: 'OK' },
        { name: 'codeCoverage', score: 90, label: 'Coverage', detail: '92%', recommendation: 'OK' },
        { name: 'securitySettings', score: 65, label: 'Security', detail: '2 issues', recommendation: 'Fix' },
      ],
      recommendations: [],
    });

    render(<OrgHealthPanel />);
    expect(screen.getByTestId('dimension-cards')).toBeDefined();
    expect(screen.getByTestId('dim-apiUsage')).toBeDefined();
    expect(screen.getByTestId('dim-securitySettings')).toBeDefined();
  });

  it('should render recommendations', () => {
    mockMutationData.mockReturnValue({
      success: true,
      overallScore: 55,
      dimensions: [
        { name: 'apiUsage', score: 40, label: 'API Usage', detail: '85% used', recommendation: 'Optimize' },
        { name: 'storageUsage', score: 70, label: 'Storage', detail: '60% used', recommendation: 'OK' },
        { name: 'metadataComplexity', score: 80, label: 'Metadata', detail: '50', recommendation: 'OK' },
        { name: 'codeCoverage', score: 45, label: 'Coverage', detail: '50%', recommendation: 'Improve' },
        { name: 'securitySettings', score: 30, label: 'Security', detail: '4 issues', recommendation: 'Fix' },
      ],
      recommendations: ['API usage is at 85%', 'Code coverage is 50%'],
    });

    render(<OrgHealthPanel />);
    expect(screen.getByTestId('recommendations')).toBeDefined();
    expect(screen.getByText('API usage is at 85%')).toBeDefined();
  });
});
