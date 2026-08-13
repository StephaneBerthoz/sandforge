import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { QuickSyncFlow } from './QuickSyncFlow';
import { QuickSyncObjectStep } from './QuickSyncObjectStep';
import { useOrgStore } from '../../../stores/useOrgStore';

/**
 * Ring tokens copied from Button.tsx: the QuickSync controls are bare
 * <button>s with no native chrome, so removing the outline without adding
 * these back leaves keyboard users with no focus indicator at all.
 */
const RING_CLASSES = [
  'focus-visible:outline-none',
  'focus-visible:ring-1',
  'focus-visible:ring-[var(--sf-accent)]',
];

/** Asserts the element replaced the suppressed outline with a focus-visible ring. */
function expectFocusRing(el: HTMLElement): void {
  const missing = RING_CLASSES.filter((cls) => !el.classList.contains(cls));
  expect(missing).toEqual([]);
  expect(el.classList.contains('focus:outline-none')).toBe(false);
}

const mockSuggestions = [
  { objectApiName: 'Account', label: 'Account', isAvailable: true, isAlreadySelected: false },
  { objectApiName: 'Contact', label: 'Contact', isAvailable: true, isAlreadySelected: false },
];

const mockUseBridgeQuery = vi.fn();
vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (...args: unknown[]) => mockUseBridgeQuery(...args),
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

vi.mock('../../../hooks/useWebviewPersistedState', () => {
  const states: Record<string, unknown> = {};
  return {
    useWebviewPersistedState: (key: string, initial: unknown) => {
      if (!(key in states)) {
        states[key] = initial;
      }
      return [
        states[key],
        (val: unknown) => {
          states[key] = val;
        },
      ];
    },
  };
});

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

const objectStepProps = {
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

describe('QuickSync focus indicators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBridgeQuery.mockReturnValue({
      data: { suggestions: mockSuggestions },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    useOrgStore.setState({ orgs: mockOrgs });
  });

  it('rings the "back to wizard" link', () => {
    render(<QuickSyncFlow onBack={vi.fn()} />);

    expectFocusRing(screen.getByTestId('quick-sync-back-to-wizard'));
  });

  it('rings the suggestion chips', () => {
    render(<QuickSyncObjectStep {...objectStepProps} />);

    expectFocusRing(screen.getByTestId('suggestion-chip-Account'));
  });

  it('rings the search result rows', () => {
    render(<QuickSyncObjectStep {...objectStepProps} />);

    fireEvent.change(screen.getByTestId('quick-sync-object-search'), {
      target: { value: 'Acc' },
    });

    expectFocusRing(screen.getByTestId('search-result-Account'));
  });

  it('rings the remove-object buttons', () => {
    render(<QuickSyncObjectStep {...objectStepProps} selectedObjects={['Account']} />);

    expectFocusRing(screen.getByTestId('remove-object-Account'));
  });
});
