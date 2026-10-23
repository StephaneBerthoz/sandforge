import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuickSyncFlow } from './useQuickSyncFlow';
import { QuickSyncOrgStep } from './QuickSyncOrgStep';
import { QuickSyncObjectStep } from './QuickSyncObjectStep';
import { QuickSyncPreviewStep } from './QuickSyncPreviewStep';
import { Badge } from '../../../components/ui/Badge';
import { ProgressAnnouncer } from '../../../components/ui/ProgressBar';
import { useFocusOnChange } from '../../../hooks/useFocusOnChange';

/** Props for the QuickSyncFlow component. */
export interface QuickSyncFlowProps {
  /** Callback to return to the full wizard. */
  onBack: () => void;
  /** Open the history entry of a run the flow made, by its operation id. */
  onOpenHistory?: (operationId: string) => void;
}

/**
 * Container component that orchestrates the Quick Sync 3-screen flow.
 *
 * Renders a step indicator and conditionally renders the appropriate
 * step component based on the current flow state.
 */
export const QuickSyncFlow: React.FC<QuickSyncFlowProps> = ({ onBack, onOpenHistory }) => {
  const { t } = useTranslation();
  const flow = useQuickSyncFlow();
  const { state } = flow;

  const steps = [
    { id: 'orgs' as const, label: t('quickSync.orgs') },
    { id: 'objects' as const, label: t('quickSync.objects') },
    { id: 'preview' as const, label: t('quickSync.preview') },
  ];

  const stepIndex = steps.findIndex((s) => s.id === state.step);
  const activeIndex = state.step === 'executing' || state.step === 'results' ? 2 : stepIndex;

  /*
   * Each screen is drawn in place of the last, with the button that moved on
   * (Next, Sync Now): the keyboard goes to the screen, named after what it
   * shows, as the wizard's steps take it.
   */
  const flowRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  useFocusOnChange(stepRef, state.step, { scope: flowRef });
  const stepName: Record<typeof state.step, string> = {
    orgs: t('quickSync.selectOrgs'),
    objects: t('quickSync.selectObjects'),
    preview: t('quickSync.preview'),
    executing: t('quickSync.executing'),
    results: t('sync.results'),
  };

  /*
   * The run's start and its end, said: the bar has no figure to read out, and
   * the results replace it in the pass that ends the run.
   */
  const { result } = state;
  const spoken =
    state.step === 'executing'
      ? t('quickSync.executing')
      : result
        ? t('a11y.runOutcome', {
            outcome: result.cancelled
              ? t('home.opStatus.cancelled')
              : result.status === 'success'
                ? t('quickSync.complete')
                : result.status === 'partial'
                  ? t('syncParts.partial')
                  : t('syncParts.failed'),
            written: result.totalSuccess,
            total: result.totalProcessed,
          })
        : '';

  return (
    <div ref={flowRef} className="flex flex-col gap-4" data-testid="quick-sync-flow">
      <ProgressAnnouncer message={spoken} immediate testId="quick-sync-status" />
      {/* Back to wizard link */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-(--sf-text-link) hover:underline focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-(--sf-accent) self-start"
        data-testid="quick-sync-back-to-wizard"
      >
        <span className="codicon codicon-arrow-left" aria-hidden="true" />
        {t('quickSync.backToWizard')}
      </button>

      {/* Step indicator */}
      <div className="flex items-center gap-2" data-testid="quick-sync-step-indicator">
        {steps.map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && (
              <span
                className="codicon codicon-chevron-right text-[10px] text-text-secondary"
                aria-hidden="true"
              />
            )}
            <Badge variant={i === activeIndex ? 'info' : i < activeIndex ? 'success' : 'default'}>
              {s.label}
            </Badge>
          </React.Fragment>
        ))}
      </div>

      {/* Step content */}
      <div
        ref={stepRef}
        tabIndex={-1}
        role="group"
        aria-label={stepName[state.step]}
        data-testid="quick-sync-step"
      >
        {state.step === 'orgs' && (
          <QuickSyncOrgStep
            sourceOrgId={state.sourceOrgId}
            targetOrgId={state.targetOrgId}
            onSourceChange={flow.setSourceOrg}
            onTargetChange={flow.setTargetOrg}
            onNext={flow.goToObjects}
            canGoNext={flow.canGoToObjects}
          />
        )}

        {state.step === 'objects' && (
          <QuickSyncObjectStep
            selectedObjects={state.selectedObjects}
            parentObjects={state.parentObjects}
            sourceOrgId={state.sourceOrgId}
            onAddObject={flow.addObject}
            onRemoveObject={flow.removeObject}
            onAddParentObject={flow.addParentObject}
            onNext={flow.goToPreview}
            canGoNext={flow.canGoToPreview}
            onBack={() => flow.reset()}
          />
        )}

        {(state.step === 'preview' || state.step === 'executing' || state.step === 'results') && (
          <QuickSyncPreviewStep
            preview={state.preview}
            result={state.result}
            isExecuting={state.isExecuting}
            runOperationId={state.runOperationId}
            onExecute={flow.execute}
            onReset={flow.reset}
            onBack={() => flow.goToObjects()}
            sourceOrgId={state.sourceOrgId}
            targetOrgId={state.targetOrgId}
            {...(onOpenHistory ? { onOpenHistory } : {})}
          />
        )}
      </div>

      {/* Error display: an alert, said when it appears wherever the focus is. */}
      {state.error && (
        <div
          role="alert"
          className="text-xs text-status-error p-2 rounded-sm bg-(--sf-error-bg)"
          data-testid="quick-sync-error"
        >
          {state.error}
        </div>
      )}
    </div>
  );
};
