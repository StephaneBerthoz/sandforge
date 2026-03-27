import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { SeedPage } from './SeedPage';

const mockOrgs = [
  { id: 'org-1', alias: 'dev1', username: 'user@dev1.com', instanceUrl: 'https://dev1.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
  { id: 'org-2', alias: 'dev2', username: 'user@dev2.com', instanceUrl: 'https://dev2.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
];

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockDescribeGlobalRefetch = vi.fn();
const mockDescribeFieldsMutate = vi.fn();
const mockDescribeFieldsReset = vi.fn();
const mockExecuteSeedMutate = vi.fn();
const mockExecuteSeedReset = vi.fn();

/** Mutable query state for describe-global. */
let mockDescribeGlobalState = {
  data: null as { objects: Array<{ apiName: string; label: string; recordCount: number; dependencies: string[] }> } | null,
  loading: false,
  error: null as string | null,
  refetch: mockDescribeGlobalRefetch,
};

/** Mutable mutation state for describe-fields. */
let mockDescribeFieldsState = {
  mutate: mockDescribeFieldsMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockDescribeFieldsReset,
};

/** Mutable mutation state for seed:execute. */
let mockExecuteSeedState = {
  mutate: mockExecuteSeedMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteSeedReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'seed:describe-global') {
      return mockDescribeGlobalState;
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'seed:describe-object') {
      return mockDescribeFieldsState;
    }
    if (type === 'seed:execute') {
      return mockExecuteSeedState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/* Mock PersonaGallery to avoid bridge hooks in unit tests */
vi.mock('./Persona/PersonaGallery', () => ({
  PersonaGallery: ({ onPersonaSelected }: { onPersonaSelected: (p: unknown) => void }) => (
    <div data-testid="persona-gallery">
      <button data-testid="mock-persona-select" onClick={() => onPersonaSelected({ id: 'test', name: 'Test', description: 'Test', industry: 'tech', locale: 'en_US', dataPatterns: {} })}>
        Select Persona
      </button>
    </div>
  ),
}));

/* Mock InfoTooltip to simplify DOM assertions */
vi.mock('../../components/ui/InfoTooltip', () => ({
  InfoTooltip: ({ id }: { id: string; content: string }) => (
    <span data-testid={`info-tooltip-${id}`} />
  ),
}));

describe('SeedPage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    mockDescribeGlobalRefetch.mockClear();
    mockDescribeFieldsMutate.mockClear();
    mockExecuteSeedMutate.mockClear();
    // Reset to default idle state
    mockDescribeGlobalState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockDescribeGlobalRefetch,
    };
    mockDescribeFieldsState = {
      mutate: mockDescribeFieldsMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockDescribeFieldsReset,
    };
    mockExecuteSeedState = {
      mutate: mockExecuteSeedMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteSeedReset,
    };
  });

  it('should show empty state when no orgs', () => {
    render(<SeedPage />);
    expect(screen.getByText('No organizations connected')).toBeDefined();
  });

  it('should render seed page with mode selector', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('seed-page')).toBeDefined();
    expect(screen.getByTestId('seed-mode-selector')).toBeDefined();
  });

  it('should show title in page header', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Seed Data')).toBeDefined();
  });

  it('should render 3 mode cards in selector', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('mode-card-ai')).toBeDefined();
    expect(screen.getByTestId('mode-card-csv')).toBeDefined();
    expect(screen.getByTestId('mode-card-clone')).toBeDefined();
  });

  it('should show AI fork selector when clicking AI card', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    expect(screen.getByTestId('ai-fork-selector')).toBeDefined();
    expect(screen.getByTestId('fork-card-persona')).toBeDefined();
    expect(screen.getByTestId('fork-card-scratch')).toBeDefined();
    expect(screen.queryByTestId('seed-mode-selector')).toBeNull();
  });

  it('should show CsvUploadWizard when clicking CSV card', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-csv'));
    expect(screen.getByTestId('csv-upload-wizard')).toBeDefined();
    expect(screen.queryByTestId('seed-mode-selector')).toBeNull();
  });

  it('should show CloneWizard when clicking Clone card', () => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: 'org-1' });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-clone'));
    expect(screen.getByTestId('clone-wizard-container')).toBeDefined();
    expect(screen.queryByTestId('seed-mode-selector')).toBeNull();
  });

  it('should return to mode selector when clicking back', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-csv'));
    expect(screen.getByTestId('csv-upload-wizard')).toBeDefined();

    fireEvent.click(screen.getByTestId('back-to-modes'));
    expect(screen.getByTestId('seed-mode-selector')).toBeDefined();
  });

  it('should show wizard with org selector after navigating AI > Start from Scratch', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));
    expect(screen.getByTestId('seed-step-select-content')).toBeDefined();
    expect(screen.getByTestId('org-selector')).toBeDefined();
  });

  it('should show PersonaGallery after navigating AI > Choose a Persona', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-persona'));
    expect(screen.getByTestId('persona-gallery')).toBeDefined();
  });

  it('should navigate back from AI sub-mode to fork selector', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));
    expect(screen.getByTestId('seed-wizard')).toBeDefined();

    fireEvent.click(screen.getByTestId('back-to-modes'));
    expect(screen.getByTestId('ai-fork-selector')).toBeDefined();
  });

  it('should display error from bridge query', () => {
    mockDescribeGlobalState = {
      data: null,
      loading: false,
      error: 'Connection failed',
      refetch: mockDescribeGlobalRefetch,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    // Switch to AI scratch mode to trigger error display
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));

    expect(screen.getByTestId('seed-error')).toBeDefined();
    expect(screen.getByText('Connection failed')).toBeDefined();
  });

  it('should show InfoTooltip on the Select step header', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-scratch'));
    expect(screen.getByTestId('info-tooltip-help.seed.selectObjects')).toBeDefined();
  });

  it('should switch to wizard when persona is selected from gallery', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    fireEvent.click(screen.getByTestId('mode-card-ai'));
    fireEvent.click(screen.getByTestId('fork-card-persona'));
    fireEvent.click(screen.getByTestId('mock-persona-select'));
    // After persona selection, should switch to ai-scratch mode (wizard)
    expect(screen.getByTestId('seed-wizard')).toBeDefined();
  });
});
