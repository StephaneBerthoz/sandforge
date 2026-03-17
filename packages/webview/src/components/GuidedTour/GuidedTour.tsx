import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';

/** localStorage prefix for completed tours. */
const TOUR_COMPLETED_PREFIX = 'sandforge-tour-completed-';

/** Position of the tooltip relative to the target element. */
export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

/** A single step in a guided tour. */
export interface TourStep {
  /** CSS selector for the target element to highlight. */
  target: string;
  /** i18n key for the step title. */
  titleKey: string;
  /** i18n key for the step description. */
  descriptionKey: string;
  /** Tooltip position relative to target. */
  position?: TooltipPosition;
}

/** Built-in tour definition. */
export interface TourDefinition {
  /** Unique tour identifier. */
  id: string;
  /** i18n key for the tour name. */
  nameKey: string;
  /** i18n key for the tour description. */
  descriptionKey: string;
  /** Steps comprising this tour. */
  steps: TourStep[];
}

/** Props for the GuidedTour component. */
export interface GuidedTourProps {
  /** Tour steps to display. */
  steps: TourStep[];
  /** Unique tour identifier for persistence. */
  tourId: string;
  /** Called when the tour is completed or skipped. */
  onComplete: () => void;
  /** Whether the tour is currently active. */
  isActive: boolean;
}

/** Computed position for the tooltip overlay. */
interface TooltipStyle {
  top: number;
  left: number;
}

/** 7 built-in tour definitions (general + one per module). */
export const BUILT_IN_TOURS: TourDefinition[] = [
  {
    id: 'general',
    nameKey: 'guidedTour.general',
    descriptionKey: 'guidedTour.generalDesc',
    steps: [
      { target: '[data-testid="sidebar"]', titleKey: 'nav.home', descriptionKey: 'guidedTour.generalDesc', position: 'right' },
      { target: '[data-testid="status-bar"]', titleKey: 'status.connectedOrgs', descriptionKey: 'guidedTour.generalDesc', position: 'top' },
    ],
  },
  {
    id: 'monitor',
    nameKey: 'guidedTour.monitorTour',
    descriptionKey: 'guidedTour.monitorTourDesc',
    steps: [
      { target: '[data-testid="monitor-health"]', titleKey: 'monitor.health', descriptionKey: 'guidedTour.monitorTourDesc', position: 'bottom' },
    ],
  },
  {
    id: 'seed',
    nameKey: 'guidedTour.seedTour',
    descriptionKey: 'guidedTour.seedTourDesc',
    steps: [
      { target: '[data-testid="seed-wizard"]', titleKey: 'seed.title', descriptionKey: 'guidedTour.seedTourDesc', position: 'bottom' },
    ],
  },
  {
    id: 'sync',
    nameKey: 'guidedTour.syncTour',
    descriptionKey: 'guidedTour.syncTourDesc',
    steps: [
      { target: '[data-testid="sync-wizard"]', titleKey: 'sync.title', descriptionKey: 'guidedTour.syncTourDesc', position: 'bottom' },
    ],
  },
  {
    id: 'compare',
    nameKey: 'guidedTour.compareTour',
    descriptionKey: 'guidedTour.compareTourDesc',
    steps: [
      { target: '[data-testid="compare-page"]', titleKey: 'compare.title', descriptionKey: 'guidedTour.compareTourDesc', position: 'bottom' },
    ],
  },
  {
    id: 'dataops',
    nameKey: 'guidedTour.dataopsTour',
    descriptionKey: 'guidedTour.dataopsTourDesc',
    steps: [
      { target: '[data-testid="dataops-page"]', titleKey: 'dataops.title', descriptionKey: 'guidedTour.dataopsTourDesc', position: 'bottom' },
    ],
  },
  {
    id: 'automation',
    nameKey: 'guidedTour.automationTour',
    descriptionKey: 'guidedTour.automationTourDesc',
    steps: [
      { target: '[data-testid="automation-page"]', titleKey: 'automation.title', descriptionKey: 'guidedTour.automationTourDesc', position: 'bottom' },
    ],
  },
];

/**
 * Check if a tour has been completed via localStorage.
 * @param tourId - The unique tour identifier.
 * @returns Whether the tour has been completed.
 */
export function isTourCompleted(tourId: string): boolean {
  return localStorage.getItem(`${TOUR_COMPLETED_PREFIX}${tourId}`) === 'true';
}

/**
 * Mark a tour as completed in localStorage.
 * @param tourId - The unique tour identifier.
 */
export function markTourCompleted(tourId: string): void {
  localStorage.setItem(`${TOUR_COMPLETED_PREFIX}${tourId}`, 'true');
}

/**
 * Calculate the tooltip position based on the target element and desired position.
 * @param targetRect - The bounding rect of the target element.
 * @param position - The desired tooltip position.
 * @returns The computed top and left pixel values.
 */
function calculateTooltipPosition(
  targetRect: DOMRect,
  position: TooltipPosition,
): TooltipStyle {
  const TOOLTIP_OFFSET = 12;

  switch (position) {
    case 'top':
      return {
        top: targetRect.top - TOOLTIP_OFFSET,
        left: targetRect.left + targetRect.width / 2,
      };
    case 'bottom':
      return {
        top: targetRect.bottom + TOOLTIP_OFFSET,
        left: targetRect.left + targetRect.width / 2,
      };
    case 'left':
      return {
        top: targetRect.top + targetRect.height / 2,
        left: targetRect.left - TOOLTIP_OFFSET,
      };
    case 'right':
      return {
        top: targetRect.top + targetRect.height / 2,
        left: targetRect.right + TOOLTIP_OFFSET,
      };
  }
}

/**
 * Tooltip-based guided tour with spotlight effect on target elements.
 * Supports navigation (Next, Previous, Skip, Finish) and persists
 * completed tours in localStorage.
 */
export const GuidedTour: React.FC<GuidedTourProps> = ({
  steps,
  tourId,
  onComplete,
  isActive,
}) => {
  const { t } = useTranslation();
  const [currentStep, setCurrentStep] = useState(0);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipStyle>({ top: 0, left: 0 });
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const step = steps[currentStep];
  const position = step?.position ?? 'bottom';
  const isLastStep = currentStep === steps.length - 1;

  const updatePosition = useCallback(() => {
    if (!step) return;
    const target = document.querySelector(step.target);
    if (target) {
      const rect = target.getBoundingClientRect();
      setTargetRect(rect);
      setTooltipPosition(calculateTooltipPosition(rect, position));
    } else {
      setTargetRect(null);
    }
  }, [step, position]);

  useEffect(() => {
    if (!isActive) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition);
    };
  }, [isActive, updatePosition]);

  const handleNext = useCallback((): void => {
    if (isLastStep) {
      markTourCompleted(tourId);
      onComplete();
    } else {
      setCurrentStep((prev) => prev + 1);
    }
  }, [isLastStep, tourId, onComplete]);

  const handlePrevious = useCallback((): void => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1);
    }
  }, [currentStep]);

  const handleSkip = useCallback((): void => {
    markTourCompleted(tourId);
    onComplete();
  }, [tourId, onComplete]);

  if (!isActive || !step) {
    return null;
  }

  return (
    <div data-testid="guided-tour" className="fixed inset-0 z-[9999]">
      {/* Spotlight overlay */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0, 0, 0, 0.6)',
          pointerEvents: 'none',
        }}
        data-testid="tour-overlay"
      />

      {/* Spotlight cutout on target */}
      {targetRect && (
        <div
          className="absolute rounded-lg"
          data-testid="tour-spotlight"
          style={{
            top: targetRect.top - 4,
            left: targetRect.left - 4,
            width: targetRect.width + 8,
            height: targetRect.height + 8,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
            pointerEvents: 'none',
            border: '2px solid var(--sf-accent, #E8A838)',
            zIndex: 10000,
          }}
        />
      )}

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="absolute z-[10001] rounded-lg p-4 shadow-xl max-w-xs"
        data-testid="tour-tooltip"
        role="dialog"
        aria-label={t(step.titleKey)}
        style={{
          top: tooltipPosition.top,
          left: tooltipPosition.left,
          background: 'var(--vscode-editorWidget-background, #252526)',
          border: '1px solid var(--sf-accent, #E8A838)',
          color: 'var(--vscode-editor-foreground, #d4d4d4)',
          animation: 'fadeIn 0.3s ease-out',
          transform: position === 'top' || position === 'bottom' ? 'translateX(-50%)' : 'translateY(-50%)',
        }}
      >
        <h3
          className="text-sm font-semibold mb-1"
          style={{ color: 'var(--sf-accent, #E8A838)' }}
        >
          {t(step.titleKey)}
        </h3>
        <p
          className="text-xs mb-3"
          style={{ color: 'var(--sf-text-secondary, #868686)' }}
        >
          {t(step.descriptionKey)}
        </p>

        {/* Step counter */}
        <p
          className="text-xs mb-3"
          style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}
          data-testid="tour-step-counter"
        >
          {t('guidedTour.stepOf', {
            current: String(currentStep + 1),
            total: String(steps.length),
          })}
        </p>

        {/* Navigation buttons */}
        <div className="flex items-center gap-2">
          {currentStep > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrevious}
              data-testid="tour-previous"
            >
              {t('guidedTour.previous')}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleNext}
            data-testid={isLastStep ? 'tour-finish' : 'tour-next'}
          >
            {isLastStep ? t('guidedTour.finish') : t('guidedTour.next')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            data-testid="tour-skip"
          >
            {t('guidedTour.skip')}
          </Button>
        </div>
      </div>
    </div>
  );
};
