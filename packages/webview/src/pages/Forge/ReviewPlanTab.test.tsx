import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ReviewPlanTab } from './ReviewPlanTab';
import type { ForgePlan } from '@sandforge/shared';

/* ---- Mocks ---- */

let mockPlan: ForgePlan | null = null;

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get plan() {
          return mockPlan;
        },
        updateNodeBatchStrategy: vi.fn(),
      }),
    {
      getState: () => ({
        plan: mockPlan,
        updateNodeBatchStrategy: vi.fn(),
      }),
    },
  );
  return { useForgeStore: store };
});

/* ---- Helpers ---- */

const makePlan = (overrides: Partial<ForgePlan> = {}): ForgePlan => ({
  waves: [
    {
      order: 0,
      objectApiNames: ['Account', 'Contact'],
      totalRecords: 300,
      estimatedDurationSeconds: 10.5,
      estimatedApiCalls: 4,
    },
    {
      order: 1,
      objectApiNames: ['Opportunity'],
      totalRecords: 50,
      estimatedDurationSeconds: 3.2,
      estimatedApiCalls: 2,
    },
  ],
  totalRecords: 350,
  totalApiCalls: 6,
  estimatedDurationSeconds: 13.7,
  cycleResolutions: [],
  ...overrides,
});

/* ---- Tests ---- */

describe('ReviewPlanTab', () => {
  it('should render loading state when plan is null', () => {
    mockPlan = null;
    render(<ReviewPlanTab />);
    expect(screen.getByTestId('plan-loading')).toBeDefined();
  });

  it('should render wave cards when plan exists', () => {
    mockPlan = makePlan();
    render(<ReviewPlanTab />);
    expect(screen.getByTestId('review-plan-tab')).toBeDefined();
    expect(screen.getByTestId('wave-0')).toBeDefined();
    expect(screen.getByTestId('wave-1')).toBeDefined();
  });

  it('should display total records and API calls in summary', () => {
    mockPlan = makePlan();
    render(<ReviewPlanTab />);
    const tab = screen.getByTestId('review-plan-tab');
    expect(tab.textContent).toContain('350');
    expect(tab.textContent).toContain('6 API calls');
  });

  it('should display object names inside wave cards', () => {
    mockPlan = makePlan();
    render(<ReviewPlanTab />);
    const wave0 = screen.getByTestId('wave-0');
    expect(wave0.textContent).toContain('Account');
    expect(wave0.textContent).toContain('Contact');
    const wave1 = screen.getByTestId('wave-1');
    expect(wave1.textContent).toContain('Opportunity');
  });

  it('should show cycle resolutions when present', () => {
    mockPlan = makePlan({
      cycleResolutions: [
        {
          objects: ['Account', 'Contact'],
          strategy: 'two_pass',
          description: 'Two-pass insert to resolve cycle',
        },
      ],
    });
    render(<ReviewPlanTab />);
    expect(screen.getByTestId('cycle-resolutions')).toBeDefined();
    expect(screen.getByTestId('cycle-resolutions').textContent).toContain('Two-pass insert');
  });

  it('should not render cycle resolutions section when none exist', () => {
    mockPlan = makePlan({ cycleResolutions: [] });
    render(<ReviewPlanTab />);
    expect(screen.queryByTestId('cycle-resolutions')).toBeNull();
  });
});
