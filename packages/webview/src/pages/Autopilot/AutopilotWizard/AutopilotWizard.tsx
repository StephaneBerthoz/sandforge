import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutopilotGraph, ExecutionPlan } from '@sandforge/shared';
import { SeedWizard } from '../../Seed/SeedWizard';
import type { WizardStep } from '../../Seed/SeedWizard';
import { useOrgStore } from '../../../stores/useOrgStore';
import { useAutopilotStore } from '../../../stores/useAutopilotStore';
import type { AutopilotStep } from '../../../stores/useAutopilotStore';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { Step1Connect } from './Step1_Connect';
import { Step2Objects } from './Step2_Objects';
import { Step3Compliance } from './Step3_Compliance';
import { Step4Review } from './Step4_Review';

/** Steps definition for the Autopilot wizard. */
const AUTOPILOT_STEPS: WizardStep[] = [
  {
    id: 'connect',
    labelKey: 'autopilot.step1.title',
    descriptionKey: 'autopilot.step1.description',
  },
  {
    id: 'objects',
    labelKey: 'autopilot.step2.title',
    descriptionKey: 'autopilot.step2.description',
  },
  {
    id: 'compliance',
    labelKey: 'autopilot.step3.title',
    descriptionKey: 'autopilot.step3.description',
  },
  {
    id: 'review',
    labelKey: 'autopilot.step4.title',
    descriptionKey: 'autopilot.step4.description',
  },
];

/** Wizard step ids in navigation order (subset of {@link AutopilotStep}). */
const WIZARD_STEP_IDS = [
  'connect',
  'objects',
  'compliance',
  'review',
] as const satisfies readonly AutopilotStep[];

/** Payload of the `autopilot:schema-result` bridge response. */
interface SchemaResultPayload {
  readonly graph: AutopilotGraph;
}

/** Payload of the `autopilot:plan-ready` bridge response. */
interface PlanReadyPayload {
  readonly plan: ExecutionPlan;
  readonly graph: AutopilotGraph;
}

/** Where the wizard lands once a scan completes (initial scan vs re-scan). */
type ScanTarget = 'objects' | 'compliance';

/** Available object info for selection. */
export interface AutopilotObjectInfo {
  /** Object API name */
  readonly apiName: string;
  /** Object label */
  readonly label: string;
  /** Approximate record count */
  readonly recordCount: number;
}

/** AutopilotWizard component props. */
export interface AutopilotWizardProps {
  /** Start autopilot execution (owned by the page so it survives wizard unmount). */
  readonly onExecute: () => void;
  /** Whether the execute request is in flight. */
  readonly isExecuting: boolean;
}

/**
 * AutopilotWizard — 4-step wizard wired to the real autopilot bridge flow:
 * scan-schema (step 1→2, and re-scan on a narrowed selection) → generate-plan
 * (step 3→4) → execute (delegated to the page via {@link AutopilotWizardProps.onExecute}).
 */
export const AutopilotWizard: React.FC<AutopilotWizardProps> = ({ onExecute, isExecuting }) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);

  const step = useAutopilotStore((s) => s.step);
  const sourceOrgId = useAutopilotStore((s) => s.sourceOrgId);
  const targetOrgId = useAutopilotStore((s) => s.targetOrgId);
  const selectedObjects = useAutopilotStore((s) => s.selectedObjects);
  const complianceFramework = useAutopilotStore((s) => s.complianceFramework);
  const graph = useAutopilotStore((s) => s.graph);
  const plan = useAutopilotStore((s) => s.plan);
  const errors = useAutopilotStore((s) => s.errors);

  const scanMutation = useBridgeMutation<SchemaResultPayload>('autopilot:scan-schema', {
    responseType: 'autopilot:schema-result',
    errorType: 'autopilot:error',
    // Schema describes on large orgs can take well over the 30 s default.
    timeoutMs: 120_000,
  });
  const planMutation = useBridgeMutation<PlanReadyPayload>('autopilot:generate-plan', {
    responseType: 'autopilot:plan-ready',
    errorType: 'autopilot:error',
    timeoutMs: 60_000,
  });

  const currentStep = Math.max(
    0,
    WIZARD_STEP_IDS.indexOf(step as (typeof WIZARD_STEP_IDS)[number]),
  );

  /** Where the in-flight scan should land once its response arrives. */
  const scanTargetRef = useRef<ScanTarget>('objects');

  // Scan response → sync the store and advance (initial scan initializes the
  // selection to every discovered object; a re-scan keeps the user's subset).
  useEffect(() => {
    const data = scanMutation.data;
    if (!data) return;
    const store = useAutopilotStore.getState();
    store.setGraph(data.graph);
    if (scanTargetRef.current === 'objects') {
      store.setSelectedObjects(data.graph.nodes.map((n) => n.objectApiName));
    }
    store.setStep(scanTargetRef.current);
  }, [scanMutation.data]);

  // Plan response → sync the store and land on the review step.
  useEffect(() => {
    const data = planMutation.data;
    if (!data) return;
    const store = useAutopilotStore.getState();
    store.setPlan(data.plan);
    store.setGraph(data.graph);
    store.setStep('review');
  }, [planMutation.data]);

  const availableObjects: AutopilotObjectInfo[] =
    graph?.nodes.map((n) => ({
      apiName: n.objectApiName,
      label: n.objectApiName,
      recordCount: n.recordCount,
    })) ?? [];

  const selectAll =
    availableObjects.length > 0 && selectedObjects.length === availableObjects.length;

  const startScan = useCallback(
    (target: ScanTarget, objects: string[]) => {
      if (!sourceOrgId || !targetOrgId) return;
      scanTargetRef.current = target;
      scanMutation.mutate({
        sourceOrgId,
        targetOrgId,
        selectedObjects: objects,
        includeStandardObjects: true,
      });
    },
    [scanMutation, sourceOrgId, targetOrgId],
  );

  const handleToggleObject = useCallback((apiName: string) => {
    useAutopilotStore.getState().toggleObject(apiName);
  }, []);

  const handleToggleAll = useCallback(() => {
    const store = useAutopilotStore.getState();
    const allNames = (store.graph?.nodes ?? []).map((n) => n.objectApiName);
    const allSelected = allNames.length > 0 && store.selectedObjects.length === allNames.length;
    store.setSelectedObjects(allSelected ? [] : allNames);
  }, []);

  const handleStepChange = useCallback(
    (next: number) => {
      const store = useAutopilotStore.getState();
      if (next < currentStep) {
        // Free backward navigation — state lives in the store and survives it.
        store.setStep(WIZARD_STEP_IDS[next]);
        return;
      }
      if (next !== currentStep + 1) return;
      if (currentStep === 0) {
        startScan('objects', []);
      } else if (currentStep === 1) {
        if (selectAll) {
          // The initial scan already covers every discovered object.
          store.setStep('compliance');
        } else {
          // Narrowed selection — re-scan with the explicit subset so the plan
          // is built from the filtered graph.
          startScan('compliance', store.selectedObjects);
        }
      } else if (currentStep === 2) {
        planMutation.mutate({
          complianceFramework: store.complianceFramework,
          maxRecordsPerObject: 0,
          objectFilters: {},
          overrides: [],
        });
      }
    },
    [currentStep, selectAll, startScan, planMutation],
  );

  const isPending = scanMutation.loading || planMutation.loading;

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 0:
        return !!sourceOrgId && !!targetOrgId && sourceOrgId !== targetOrgId && !isPending;
      case 1:
        return selectedObjects.length > 0 && !isPending;
      case 2:
        return !isPending;
      case 3:
        return !isExecuting;
      default:
        return true;
    }
  };

  /** Review-step stats: real plan numbers when available, scan fallback otherwise. */
  const totalRecords =
    plan?.totalRecords ??
    availableObjects
      .filter((o) => selectedObjects.includes(o.apiName))
      .reduce((sum, o) => sum + o.recordCount, 0);
  const estimatedApiCalls = plan?.estimatedApiCalls ?? 0;
  const estimatedDurationMin = Math.ceil((plan?.estimatedDurationSec ?? 0) / 60);
  const lastError = errors.length > 0 ? errors[errors.length - 1] : null;

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]"
      data-testid="autopilot-wizard"
    >
      <h2 className="text-lg font-semibold text-[var(--sf-text-primary)]">
        {t('autopilot.wizard.title')}
      </h2>

      <SeedWizard
        steps={AUTOPILOT_STEPS}
        currentStep={currentStep}
        onStepChange={handleStepChange}
        canGoNext={canGoNext()}
        canGoBack={!isPending}
        isFinished={isExecuting}
        onFinish={onExecute}
      >
        {currentStep === 0 && (
          <>
            <Step1Connect
              orgs={orgs}
              sourceOrgId={sourceOrgId ?? ''}
              targetOrgId={targetOrgId ?? ''}
              onSourceSelect={(id) => useAutopilotStore.getState().setSourceOrg(id)}
              onTargetSelect={(id) => useAutopilotStore.getState().setTargetOrg(id)}
            />
            {scanMutation.loading && (
              <p className="text-xs text-text-secondary" data-testid="autopilot-scan-loading">
                {t('autopilot.status.scanning')}
              </p>
            )}
            {scanMutation.error && (
              <ErrorBanner message={scanMutation.error} data-testid="autopilot-scan-error" />
            )}
          </>
        )}
        {currentStep === 1 && (
          <>
            <Step2Objects
              availableObjects={availableObjects}
              selectedObjects={selectedObjects}
              selectAll={selectAll}
              onToggleObject={handleToggleObject}
              onToggleAll={handleToggleAll}
            />
            {scanMutation.loading && (
              <p className="text-xs text-text-secondary" data-testid="autopilot-scan-loading">
                {t('autopilot.status.scanning')}
              </p>
            )}
            {scanMutation.error && (
              <ErrorBanner message={scanMutation.error} data-testid="autopilot-scan-error" />
            )}
          </>
        )}
        {currentStep === 2 && (
          <>
            <Step3Compliance
              selectedFramework={complianceFramework}
              onSelect={(framework) =>
                useAutopilotStore.getState().setComplianceFramework(framework)
              }
            />
            {planMutation.loading && (
              <p className="text-xs text-text-secondary" data-testid="autopilot-plan-loading">
                {t('autopilot.status.planning')}
              </p>
            )}
            {planMutation.error && (
              <ErrorBanner message={planMutation.error} data-testid="autopilot-plan-error" />
            )}
          </>
        )}
        {currentStep === 3 && (
          <Step4Review
            sourceOrgId={sourceOrgId ?? ''}
            targetOrgId={targetOrgId ?? ''}
            selectedObjects={selectedObjects}
            totalRecords={totalRecords}
            estimatedApiCalls={estimatedApiCalls}
            estimatedDurationMin={estimatedDurationMin}
            waves={plan?.waves.length ?? 0}
            piiFields={plan?.anonymizationSummary.totalPiiFields ?? 0}
            anonymizedFields={plan?.anonymizationSummary.totalFieldsToAnonymize ?? 0}
            complianceFramework={complianceFramework}
            isExecuting={isExecuting}
            error={lastError}
            onExecute={onExecute}
          />
        )}
      </SeedWizard>
    </div>
  );
};
