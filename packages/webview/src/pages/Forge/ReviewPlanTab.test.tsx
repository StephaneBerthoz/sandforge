import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ReviewPlanTab } from './ReviewPlanTab';
import { buildSyntheticForgeGraph } from '@sandforge/shared';
import type { ForgeGraph, ForgePlan } from '@sandforge/shared';

/* ---- Mocks ---- */

let mockPlan: ForgePlan | null = null;
let mockGraph: ForgeGraph | null = null;

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get plan() {
          return mockPlan;
        },
        get graph() {
          return mockGraph;
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
  beforeEach(() => {
    mockGraph = null;
  });

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

  it('gives the plan’s records, and its calls as the estimate they are, in its summary and on each wave', () => {
    // The plan puts a call on each batch of the rows discovery counted, before
    // anything is read: "6 API calls" read as calls counted, where the
    // execution and results tiles already said theirs were estimated.
    mockPlan = makePlan();
    render(<ReviewPlanTab />);
    const summary = screen.getByTestId('review-plan-summary').textContent;
    expect(summary).toContain('350');
    expect(summary).toContain('6 estimated API calls');
    expect(screen.getByTestId('wave-0').textContent).toContain('4 estimated API calls · ~10.5s');
    expect(screen.getByTestId('wave-1').textContent).toContain('2 estimated API calls · ~3.2s');
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

  describe('a graph whose records nobody counted', () => {
    it('says its records are not counted, and reckons no call and no duration from them', () => {
      // A starter template's graph skips discovery, and the plan made of it
      // holds every count at zero: the tab said "0 records · 0 API calls ·
      // ~0s", and its wave "0 API calls · ~0.0s", of a run that reads every
      // object of the template.
      const objects = ['Account', 'Contact', 'Opportunity', 'Case'];
      mockPlan = makePlan({
        waves: [
          {
            order: 0,
            objectApiNames: objects,
            totalRecords: 0,
            estimatedDurationSeconds: 0,
            estimatedApiCalls: 0,
          },
        ],
        totalRecords: 0,
        totalApiCalls: 0,
        estimatedDurationSeconds: 0,
      });
      mockGraph = buildSyntheticForgeGraph(objects);

      render(<ReviewPlanTab />);

      expect(screen.getByTestId('review-plan-summary').textContent).toBe('records not counted');
      const wave = screen.getByTestId('wave-0').textContent;
      expect(wave).not.toMatch(/API call|~\d/);
      expect(wave).toContain('Opportunity');
    });

    it('keeps the estimates of a wave whose objects were all counted', () => {
      mockPlan = makePlan();
      const [account, contact, opportunity] = buildSyntheticForgeGraph([
        'Account',
        'Contact',
        'Opportunity',
      ]).nodes;
      mockGraph = {
        ...buildSyntheticForgeGraph([]),
        nodes: [
          { ...account, recordCountUnknown: undefined, recordCount: 200 },
          { ...contact, recordCountUnknown: undefined, recordCount: 100 },
          opportunity,
        ],
      };

      render(<ReviewPlanTab />);

      expect(screen.getByTestId('review-plan-summary').textContent).toBe('records not counted');
      expect(screen.getByTestId('wave-0').textContent).toContain('4 estimated API calls · ~10.5s');
      expect(screen.getByTestId('wave-1').textContent).not.toContain('API call');
    });
  });
});
