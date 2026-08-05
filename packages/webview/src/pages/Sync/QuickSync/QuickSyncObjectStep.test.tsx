import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import type { RelationshipSuggestion } from '@sandforge/shared';
import { QuickSyncObjectStep } from './QuickSyncObjectStep';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
const mockSuggestions = [
  { objectApiName: 'Account', label: 'Account', isAvailable: true, isAlreadySelected: false },
  { objectApiName: 'Contact', label: 'Contact', isAvailable: true, isAlreadySelected: false },
  {
    objectApiName: 'Opportunity',
    label: 'Opportunity',
    isAvailable: true,
    isAlreadySelected: false,
  },
  { objectApiName: 'Lead', label: 'Lead', isAvailable: true, isAlreadySelected: false },
  { objectApiName: 'Case', label: 'Case', isAvailable: false, isAlreadySelected: false },
];

const mockUseBridgeQuery = vi.fn();
vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (...args: unknown[]) => mockUseBridgeQuery(...args),
}));

const mockDetectMutate = vi.fn();
let mockDetectState: {
  mutate: typeof mockDetectMutate;
  data: { suggestions: RelationshipSuggestion[] } | null;
  loading: boolean;
  error: string | null;
  reset: ReturnType<typeof vi.fn>;
};

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => mockDetectState,
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
    // The handler answers with a wrapped payload: { suggestions: [...] }
    mockUseBridgeQuery.mockReturnValue({
      data: { suggestions: mockSuggestions },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDetectState = {
      mutate: mockDetectMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  });

  it('requests suggestions with the canonical { orgId, alreadySelected } payload', () => {
    render(<QuickSyncObjectStep {...defaultProps} selectedObjects={['Lead']} />);

    expect(mockUseBridgeQuery).toHaveBeenCalledWith(
      'quicksync:suggest-objects',
      { orgId: 'org-1', alreadySelected: ['Lead'] },
      { skip: false },
    );
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

  it('posts the canonical detect-relationships payload when an object is added', () => {
    render(<QuickSyncObjectStep {...defaultProps} selectedObjects={['Lead']} />);

    fireEvent.click(screen.getByTestId('suggestion-chip-Account'));

    expect(mockDetectMutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objectApiName: 'Account',
      alreadySelected: ['Lead', 'Account'],
    });
  });

  it('shows the relationship banner when detection returns a parent suggestion', () => {
    mockDetectState.data = {
      suggestions: [
        {
          childObject: 'Contact',
          parentObject: 'Account',
          lookupField: 'AccountId',
          relationshipType: 'lookup',
          suggestedInsertOrder: 0,
        },
      ],
    };
    render(<QuickSyncObjectStep {...defaultProps} selectedObjects={['Contact']} />);

    expect(screen.getByTestId('relationship-banner')).toBeDefined();
  });

  it('adding the parent from the banner calls onAddParentObject', () => {
    const onAddParentObject = vi.fn();
    mockDetectState.data = {
      suggestions: [
        {
          childObject: 'Contact',
          parentObject: 'Account',
          lookupField: 'AccountId',
          relationshipType: 'lookup',
          suggestedInsertOrder: 0,
        },
      ],
    };
    render(
      <QuickSyncObjectStep
        {...defaultProps}
        selectedObjects={['Contact']}
        onAddParentObject={onAddParentObject}
      />,
    );

    fireEvent.click(screen.getByTestId('relationship-add-btn'));

    expect(onAddParentObject).toHaveBeenCalledWith('Account');
  });

  it('does not show the banner when the parent is already selected', () => {
    mockDetectState.data = {
      suggestions: [
        {
          childObject: 'Contact',
          parentObject: 'Account',
          lookupField: 'AccountId',
          relationshipType: 'lookup',
          suggestedInsertOrder: 0,
        },
      ],
    };
    render(
      <QuickSyncObjectStep
        {...defaultProps}
        selectedObjects={['Contact', 'Account']}
        parentObjects={['Account']}
      />,
    );

    expect(screen.queryByTestId('relationship-banner')).toBeNull();
  });

  it('shows selected objects as removable badges', () => {
    render(<QuickSyncObjectStep {...defaultProps} selectedObjects={['Account', 'Contact']} />);

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
