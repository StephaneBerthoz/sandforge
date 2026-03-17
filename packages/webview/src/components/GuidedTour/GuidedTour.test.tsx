import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  GuidedTour,
  isTourCompleted,
  markTourCompleted,
  BUILT_IN_TOURS,
} from './GuidedTour';
import type { TourStep } from './GuidedTour';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (params) {
        let result = key;
        for (const [k, v] of Object.entries(params)) {
          result = result.replace(`{{${k}}}`, v);
        }
        return result;
      }
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => { store[key] = value; },
    removeItem: (key: string): void => { delete store[key]; },
    reset: (): void => { store = {}; },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

const MOCK_STEPS: TourStep[] = [
  {
    target: '[data-testid="target-1"]',
    titleKey: 'tour.step1Title',
    descriptionKey: 'tour.step1Desc',
    position: 'bottom',
  },
  {
    target: '[data-testid="target-2"]',
    titleKey: 'tour.step2Title',
    descriptionKey: 'tour.step2Desc',
    position: 'right',
  },
  {
    target: '[data-testid="target-3"]',
    titleKey: 'tour.step3Title',
    descriptionKey: 'tour.step3Desc',
    position: 'top',
  },
];

describe('GuidedTour', () => {
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onComplete = vi.fn();
    localStorageMock.reset();
    // Mock querySelector to return a fake element with getBoundingClientRect
    vi.spyOn(document, 'querySelector').mockReturnValue({
      getBoundingClientRect: () => ({
        top: 100,
        left: 200,
        bottom: 150,
        right: 300,
        width: 100,
        height: 50,
        x: 200,
        y: 100,
        toJSON: vi.fn(),
      }),
    } as unknown as Element);
  });

  it('should not render when isActive is false', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={false}
      />,
    );
    expect(screen.queryByTestId('guided-tour')).toBeNull();
  });

  it('should render when isActive is true', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    expect(screen.getByTestId('guided-tour')).toBeDefined();
  });

  it('should render the overlay', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    expect(screen.getByTestId('tour-overlay')).toBeDefined();
  });

  it('should render the spotlight on the target element', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    expect(screen.getByTestId('tour-spotlight')).toBeDefined();
  });

  it('should render the tooltip with step title and description', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    expect(screen.getByTestId('tour-tooltip')).toBeDefined();
    expect(screen.getByText('tour.step1Title')).toBeDefined();
    expect(screen.getByText('tour.step1Desc')).toBeDefined();
  });

  it('should display the step counter', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    const counter = screen.getByTestId('tour-step-counter');
    // The t mock replaces {{current}} and {{total}} in the key
    // The key "guidedTour.stepOf" with params {current: "1", total: "3"}
    // gets returned as "guidedTour.stepOf" since key doesn't contain placeholders
    expect(counter).toBeDefined();
    expect(counter.textContent).toBe('guidedTour.stepOf');
  });

  it('should navigate to the next step when Next is clicked', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    fireEvent.click(screen.getByTestId('tour-next'));
    expect(screen.getByText('tour.step2Title')).toBeDefined();
  });

  it('should not show Previous button on first step', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    expect(screen.queryByTestId('tour-previous')).toBeNull();
  });

  it('should show Previous button on second step', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    fireEvent.click(screen.getByTestId('tour-next'));
    expect(screen.getByTestId('tour-previous')).toBeDefined();
  });

  it('should navigate back when Previous is clicked', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    fireEvent.click(screen.getByTestId('tour-next'));
    expect(screen.getByText('tour.step2Title')).toBeDefined();
    fireEvent.click(screen.getByTestId('tour-previous'));
    expect(screen.getByText('tour.step1Title')).toBeDefined();
  });

  it('should show Finish button on last step', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    fireEvent.click(screen.getByTestId('tour-next')); // step 1 -> 2
    fireEvent.click(screen.getByTestId('tour-next')); // step 2 -> 3
    expect(screen.getByTestId('tour-finish')).toBeDefined();
  });

  it('should call onComplete and persist when Finish is clicked', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    fireEvent.click(screen.getByTestId('tour-next'));
    fireEvent.click(screen.getByTestId('tour-next'));
    fireEvent.click(screen.getByTestId('tour-finish'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(localStorageMock.getItem('sandforge-tour-completed-test-tour')).toBe('true');
  });

  it('should call onComplete and persist when Skip is clicked', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    fireEvent.click(screen.getByTestId('tour-skip'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(localStorageMock.getItem('sandforge-tour-completed-test-tour')).toBe('true');
  });

  it('should always render the Skip button', () => {
    render(
      <GuidedTour
        steps={MOCK_STEPS}
        tourId="test-tour"
        onComplete={onComplete}
        isActive={true}
      />,
    );
    expect(screen.getByTestId('tour-skip')).toBeDefined();
  });
});

describe('isTourCompleted', () => {
  beforeEach(() => {
    localStorageMock.reset();
  });

  it('should return false for uncompleted tours', () => {
    expect(isTourCompleted('my-tour')).toBe(false);
  });

  it('should return true for completed tours', () => {
    localStorageMock.setItem('sandforge-tour-completed-my-tour', 'true');
    expect(isTourCompleted('my-tour')).toBe(true);
  });
});

describe('markTourCompleted', () => {
  beforeEach(() => {
    localStorageMock.reset();
  });

  it('should store tour completion in localStorage', () => {
    markTourCompleted('my-tour');
    expect(localStorageMock.getItem('sandforge-tour-completed-my-tour')).toBe('true');
  });
});

describe('BUILT_IN_TOURS', () => {
  it('should contain 7 built-in tours', () => {
    expect(BUILT_IN_TOURS.length).toBe(7);
  });

  it('should have unique IDs for each tour', () => {
    const ids = BUILT_IN_TOURS.map((tour) => tour.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should include the general tour', () => {
    const generalTour = BUILT_IN_TOURS.find((tour) => tour.id === 'general');
    expect(generalTour).toBeDefined();
  });

  it('should include module-specific tours', () => {
    const moduleIds = ['monitor', 'seed', 'sync', 'compare', 'dataops', 'automation'];
    for (const id of moduleIds) {
      const tour = BUILT_IN_TOURS.find((t) => t.id === id);
      expect(tour).toBeDefined();
    }
  });

  it('should have at least one step per tour', () => {
    for (const tour of BUILT_IN_TOURS) {
      expect(tour.steps.length).toBeGreaterThan(0);
    }
  });
});
