import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { QuickSyncObjectStep } from './QuickSyncObjectStep';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
const mockSuggestions = [
  { objectApiName: 'Account', label: 'Account', isAvailable: true, isAlreadySelected: false },
  { objectApiName: 'Contact', label: 'Contact', isAvailable: true, isAlreadySelected: false },
  { objectApiName: 'Opportunity', label: 'Opportunity', isAvailable: true, isAlreadySelected: false },
  { objectApiName: 'Lead', label: 'Lead', isAvailable: true, isAlreadySelected: false },
  { objectApiName: 'Case', label: 'Case', isAvailable: false, isAlreadySelected: false },
];

vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: mockSuggestions,
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

describe('QuickSyncObjectStep', () => {
  const defaultProps = {
    selectedObjects: [] as string[],
    parentObjects: [] as string[],
    sourceOrgId: 'org-1',
    onAddObject: vi.fn(),
    onRemoveObject: vi.fn(),
    onAddParentObject: vi.fn(),
    onNext: vi.fn(),
    canGoNext: false,
    onBack: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders suggestion chips', () => {
    render(<QuickSyncObjectStep {...defaultProps} />);

    expect(screen.getByTestId('quick-sync-suggestions')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
    expect(screen.getByText('Opportunity')).toBeDefined();
    expect(screen.getByText('Lead')).toBeDefined();
    expect(screen.getByText('Case')).toBeDefined();
  });

  it('clicking a suggestion chip calls onAddObject', () => {
    const onAddObject = vi.fn();
    render(<QuickSyncObjectStep {...defaultProps} onAddObject={onAddObject} />);

    fireEvent.click(screen.getByTestId('suggestion-chip-Account'));

    expect(onAddObject).toHaveBeenCalledWith('Account');
  });

  it('shows selected objects as removable badges', () => {
    render(
      <QuickSyncObjectStep
        {...defaultProps}
        selectedObjects={['Account', 'Contact']}
      />,
    );

    const selectedArea = screen.getByTestId('quick-sync-selected-objects');
    expect(selectedArea).toBeDefined();
    expect(screen.getByTestId('remove-object-Account')).toBeDefined();
    expect(screen.getByTestId('remove-object-Contact')).toBeDefined();
  });

  it('next button disabled when no objects selected', () => {
    render(<QuickSyncObjectStep {...defaultProps} canGoNext={false} />);

    const btn = screen.getByTestId('quick-sync-object-next');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('next button enabled when objects are selected', () => {
    const onNext = vi.fn();
    render(
      <QuickSyncObjectStep
        {...defaultProps}
        selectedObjects={['Account']}
        canGoNext={true}
        onNext={onNext}
      />,
    );

    const btn = screen.getByTestId('quick-sync-object-next');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
