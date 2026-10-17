import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutopilotGraph, AutopilotObjectListing, ExecutionPlan } from '@sandforge/shared';
import { AUTOPILOT_COUNTS_PER_REQUEST } from '@sandforge/shared';
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

/** Payload of the `autopilot:objects-listed` bridge response. */
interface ObjectsListedPayload {
  readonly objects: AutopilotObjectListing[];
}

/** Payload of the `autopilot:objects-counted` bridge response. */
interface ObjectsCountedPayload {
  readonly counts: Record<string, number>;
}

/** Payload of the `autopilot:schema-result` bridge response. */
interface SchemaResultPayload {
  readonly graph: AutopilotGraph;
}

/** Payload of the `autopilot:plan-ready` bridge response. */
interface PlanReadyPayload {
  readonly plan: ExecutionPlan;
  readonly graph: AutopilotGraph;
}

/** Available object info for selection. */
export interface AutopilotObjectInfo {
  /** Object API name */
  readonly apiName: string;
  /** Object label */
  readonly label: string;
  /** Records the source holds, once the object is picked and counted. */
  readonly recordCount?: number;
}

/** AutopilotWizard component props. */
export interface AutopilotWizardProps {
  /** Start autopilot execution (owned by the page so it survives wizard unmount). */
  readonly onExecute: () => void;
  /** Whether the execute request is in flight. */
  readonly isExecuting: boolean;
  /**
   * Whether the page brings the wizard back from the running view, the run
   * not started: the review takes the keyboard the view held.
   */
  readonly returnedFromRun?: boolean;
}

/**
 * AutopilotWizard — 4-step wizard wired to the real autopilot bridge flow:
 * list-objects (step 1→2), with count-objects for the objects picked →
 * scan-schema on the selection (step 2→3) → generate-plan (step 3→4) →
 * execute (delegated to the page via {@link AutopilotWizardProps.onExecute}).
 *
 * The object step used to be filled by a scan with nothing selected, which
 * described every object of the org and counted every table before the user
 * had picked one: hundreds of calls on a client sandbox of some six hundred
 * and seventy custom objects. It lists the objects from the two orgs' global
 * describes now, counts each object once it is picked, and scans only what
 * was picked.
 */
export const AutopilotWizard: React.FC<AutopilotWizardProps> = ({
  onExecute,
  isExecuting,
  returnedFromRun = false,
}) => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);

  const step = useAutopilotStore((s) => s.step);
  const sourceOrgId = useAutopilotStore((s) => s.sourceOrgId);
  const targetOrgId = useAutopilotStore((s) => s.targetOrgId);
  const selectedObjects = useAutopilotStore((s) => s.selectedObjects);
  const objectListing = useAutopilotStore((s) => s.objectListing);
  const objectCounts = useAutopilotStore((s) => s.objectCounts);
  const complianceFramework = useAutopilotStore((s) => s.complianceFramework);
  const graph = useAutopilotStore((s) => s.graph);
  const plan = useAutopilotStore((s) => s.plan);
  const errors = useAutopilotStore((s) => s.errors);

  const listMutation = useBridgeMutation<ObjectsListedPayload>('autopilot:list-objects', {
    responseType: 'autopilot:objects-listed',
    errorType: 'autopilot:error',
    timeoutMs: 60_000,
  });
  const countMutation = useBridgeMutation<ObjectsCountedPayload>('autopilot:count-objects', {
    responseType: 'autopilot:objects-counted',
    errorType: 'autopilot:error',
    timeoutMs: 60_000,
  });
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

  // Listing → the object step. Nothing is picked for the user: picked whole,
  // an org's every object made a plan of all of it. What was picked before
  // going back stays picked where the new listing still offers it.
  useEffect(() => {
    const data = listMutation.data;
    if (!data) return;
    const store = useAutopilotStore.getState();
    const listed = new Set(data.objects.map((o) => o.apiName));
    store.setObjectListing(data.objects);
    store.setSelectedObjects(store.selectedObjects.filter((name) => listed.has(name)));
    store.setStep('objects');
  }, [listMutation.data]);

  // The objects picked are counted a page at a time, each once per listing:
  // an object the org would not count is not asked about again.
  const askedCounts = useRef(new Set<string>());
  useEffect(() => {
    askedCounts.current = new Set();
  }, [objectListing]);
  const countLoading = countMutation.loading;
  const countObjects = countMutation.mutate;
  useEffect(() => {
    if (step !== 'objects' || !sourceOrgId || countLoading) return;
    const unknown = selectedObjects
      .filter((name) => objectCounts[name] === undefined && !askedCounts.current.has(name))
      .slice(0, AUTOPILOT_COUNTS_PER_REQUEST);
    if (unknown.length === 0) return;
    for (const name of unknown) askedCounts.current.add(name);
    countObjects({ sourceOrgId, objectApiNames: unknown });
  }, [step, sourceOrgId, selectedObjects, objectCounts, countLoading, countObjects]);
  useEffect(() => {
    const data = countMutation.data;
    if (data) useAutopilotStore.getState().addObjectCounts(data.counts);
  }, [countMutation.data]);

  // Scan of the selection → the compliance step, the selection kept as picked.
  useEffect(() => {
    const data = scanMutation.data;
    if (!data) return;
    const store = useAutopilotStore.getState();
    store.setGraph(data.graph);
    store.setStep('compliance');
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
    objectListing?.map((o) => ({
      apiName: o.apiName,
      label: o.label,
      ...(objectCounts[o.apiName] !== undefined ? { recordCount: objectCounts[o.apiName] } : {}),
    })) ?? [];

  const selectAll =
    availableObjects.length > 0 && selectedObjects.length === availableObjects.length;

  const handleToggleObject = useCallback((apiName: string) => {
    useAutopilotStore.getState().toggleObject(apiName);
  }, []);

  const handleToggleAll = useCallback(() => {
    const store = useAutopilotStore.getState();
    const allNames = (store.objectListing ?? []).map((o) => o.apiName);
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
      if (!sourceOrgId || !targetOrgId) return;
      if (currentStep === 0) {
        listMutation.mutate({ sourceOrgId, targetOrgId, includeStandardObjects: true });
      } else if (currentStep === 1) {
        // The plan is built from the objects picked and the parents their
        // records name: the scan starts from the selection, never the org.
        scanMutation.mutate({
          sourceOrgId,
          targetOrgId,
          selectedObjects: store.selectedObjects,
          includeStandardObjects: true,
        });
      } else if (currentStep === 2) {
        planMutation.mutate({
          complianceFramework: store.complianceFramework,
          maxRecordsPerObject: 0,
          objectFilters: {},
          overrides: [],
        });
      }
    },
    [currentStep, sourceOrgId, targetOrgId, listMutation, scanMutation, planMutation],
  );

  const isPending = listMutation.loading || scanMutation.loading || planMutation.loading;

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
    (graph?.nodes ?? [])
      .filter((n) => selectedObjects.includes(n.objectApiName))
      .reduce((sum, n) => sum + n.recordCount, 0);
  const estimatedApiCalls = plan?.estimatedApiCalls ?? 0;
  const estimatedDurationMin = Math.ceil((plan?.estimatedDurationSec ?? 0) / 60);
  const lastError = errors.length > 0 ? errors[errors.length - 1] : null;

  return (
    <div
      className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)"
      data-testid="autopilot-wizard"
    >
      <h2 className="text-lg font-semibold text-(--sf-text-primary)">
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
        focusStepOnMount={returnedFromRun}
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
            {/* A status, here and below: Next waits on the listing, the scan
                or the plan, and nothing else tells a screen reader why. */}
            {listMutation.loading && (
              <p
                role="status"
                className="text-xs text-text-secondary"
                data-testid="autopilot-scan-loading"
              >
                {t('autopilot.status.listing')}
              </p>
            )}
            {listMutation.error && (
              <ErrorBanner message={listMutation.error} data-testid="autopilot-scan-error" />
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
              <p
                role="status"
                className="text-xs text-text-secondary"
                data-testid="autopilot-scan-loading"
              >
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
              <p
                role="status"
                className="text-xs text-text-secondary"
                data-testid="autopilot-plan-loading"
              >
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
            scope={plan?.scope}
            notCovered={plan?.anonymizationSummary.notCovered}
            onExecute={onExecute}
          />
        )}
      </SeedWizard>
    </div>
  );
};
