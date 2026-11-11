import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
      }),
    {
      getState: () => ({
        plan: mockPlan,
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
    expect(screen.getByTestId('wave-0').textContent).toContain('4 estimated API calls · ~11s');
    expect(screen.getByTestId('wave-1').textContent).toContain('2 estimated API calls · ~3s');
    // Rounded, as "~14s" was said of 13.7 before the hours and minutes.
    expect(screen.getByTestId('review-plan-duration').textContent).toBe('~14s');
  });

  // "~7260s" said nothing at a glance of a clone of the whole org's two hours.
  it('says the plan’s duration in hours, minutes and seconds, as the rest of the page does', () => {
    mockPlan = makePlan({ estimatedDurationSeconds: 7_260 });
    render(<ReviewPlanTab />);
    expect(screen.getByTestId('review-plan-duration').textContent).toBe('~2h 1min');
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
      expect(screen.getByTestId('wave-0').textContent).toContain('4 estimated API calls · ~11s');
      expect(screen.getByTestId('wave-1').textContent).not.toContain('API call');
    });
  });

  describe('what a clone of the whole org leaves out', () => {
    /** A clone of the whole org's graph, with the objects it leaves out. */
    function wholeOrgGraph(): ForgeGraph {
      return {
        ...buildSyntheticForgeGraph([]),
        leftOut: [
          { objectApiName: 'UserRole', reason: 'setup', detail: 'noLayout' },
          { objectApiName: 'AccountHistory', reason: 'history' },
          { objectApiName: 'Asset', reason: 'empty' },
          { objectApiName: 'PermissionSet', reason: 'setup' },
          { objectApiName: 'Invoice__c', reason: 'missingInTarget' },
          {
            objectApiName: 'Secret__c',
            reason: 'unreadable',
            detail: 'INSUFFICIENT_ACCESS: no access to Secret__c',
          },
          { objectApiName: 'ContentVersion', reason: 'files', detail: 'withTheirRecords' },
        ],
      };
    }

    it('names nothing of a graph walked from a root, which leaves no object out', () => {
      mockPlan = makePlan();
      mockGraph = buildSyntheticForgeGraph(['Account']);
      render(<ReviewPlanTab />);
      expect(screen.queryByTestId('review-left-out')).toBeNull();
    });

    it('counts them folded, and lists them by why once opened, what the target lacks first', () => {
      mockPlan = makePlan();
      mockGraph = wholeOrgGraph();
      render(<ReviewPlanTab />);

      const toggle = screen.getByTestId('review-left-out-toggle');
      expect(toggle.textContent).toBe('Left out: 7 objects of the source org');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // Folded, not one name is in the page: there may be thousands.
      expect(screen.queryByTestId('review-left-out-setup')).toBeNull();

      fireEvent.click(toggle);

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const groups = [
        ...screen
          .getByTestId('review-left-out')
          .querySelectorAll('[data-testid^="review-left-out-"]'),
      ]
        .map((group) => group.getAttribute('data-testid'))
        .filter((id) => id !== 'review-left-out-toggle');
      expect(groups).toEqual([
        'review-left-out-missingInTarget',
        'review-left-out-unreadable',
        'review-left-out-empty',
        'review-left-out-setup',
        'review-left-out-history',
        'review-left-out-files',
      ]);
      // By name within a group, the word the page translates in brackets.
      expect(screen.getByTestId('review-left-out-setup').textContent).toBe(
        'Setup, users, permissions, logs and jobs (2)PermissionSet, UserRole (no page layout)',
      );
      expect(screen.getByTestId('review-left-out-files').textContent).toContain(
        'ContentVersion (copied with the records it hangs on)',
      );
      // The org's own words, as it said them.
      expect(screen.getByTestId('review-left-out-unreadable').textContent).toContain(
        'Secret__c: INSUFFICIENT_ACCESS: no access to Secret__c',
      );
    });

    it('still says them while the plan is coming, or could not be made', () => {
      mockGraph = wholeOrgGraph();
      mockPlan = null;
      const { unmount } = render(<ReviewPlanTab />);
      expect(screen.getByTestId('plan-loading')).toBeDefined();
      expect(screen.getByTestId('review-left-out')).toBeDefined();
      unmount();

      render(<ReviewPlanTab error="no plan" />);
      expect(screen.getByTestId('plan-error')).toBeDefined();
      expect(screen.getByTestId('review-left-out')).toBeDefined();
    });
  });
});
