import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuickSyncFlow } from './useQuickSyncFlow';
import { QuickSyncOrgStep } from './QuickSyncOrgStep';
import { QuickSyncObjectStep } from './QuickSyncObjectStep';
import { QuickSyncPreviewStep } from './QuickSyncPreviewStep';
import { Badge } from '../../../components/ui/Badge';

/** Props for the QuickSyncFlow component. */
export interface QuickSyncFlowProps {
  /** Callback to return to the full wizard. */
  onBack: () => void;
}

/**
 * Container component that orchestrates the Quick Sync 3-screen flow.
 *
 * Renders a step indicator and conditionally renders the appropriate
 * step component based on the current flow state.
 */
export const QuickSyncFlow: React.FC<QuickSyncFlowProps> = ({ onBack }) => {
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

  return (
    <div className="flex flex-col gap-4" data-testid="quick-sync-flow">
      {/* Back to wizard link */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-[var(--sf-text-link)] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--sf-accent)] self-start"
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
          onExecute={flow.execute}
          onReset={flow.reset}
          onBack={() => flow.goToObjects()}
        />
      )}

      {/* Error display */}
      {state.error && (
        <div
          className="text-xs text-[var(--sf-error)] p-2 rounded bg-[var(--sf-error-bg)]"
          data-testid="quick-sync-error"
        >
          {state.error}
        </div>
      )}
    </div>
  );
};
