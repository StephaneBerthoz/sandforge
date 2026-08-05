import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComplianceFrameworkType } from '@sandforge/shared';
import { SeedWizard } from '../../Seed/SeedWizard';
import type { WizardStep } from '../../Seed/SeedWizard';
import { useOrgStore } from '../../../stores/useOrgStore';
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

/** Available object info for selection. */
export interface AutopilotObjectInfo {
  /** Object API name */
  readonly apiName: string;
  /** Object label */
  readonly label: string;
  /** Approximate record count */
  readonly recordCount: number;
}

/** Mock objects for demo purposes until wired to extension. */
const DEMO_OBJECTS: AutopilotObjectInfo[] = [
  { apiName: 'Account', label: 'Account', recordCount: 5200 },
  { apiName: 'Contact', label: 'Contact', recordCount: 12400 },
  { apiName: 'Opportunity', label: 'Opportunity', recordCount: 3100 },
  { apiName: 'Case', label: 'Case', recordCount: 8700 },
  { apiName: 'Lead', label: 'Lead', recordCount: 4300 },
  { apiName: 'Task', label: 'Task', recordCount: 15600 },
  { apiName: 'Event', label: 'Event', recordCount: 6800 },
  { apiName: 'Product2', label: 'Product', recordCount: 450 },
  { apiName: 'Order', label: 'Order', recordCount: 2100 },
  { apiName: 'Contract', label: 'Contract', recordCount: 980 },
];

/** AutopilotWizard — 4-step wizard for zero-config sandbox seeding. */
export const AutopilotWizard: React.FC = () => {
  const { t } = useTranslation();
  const orgs = useOrgStore((s) => s.orgs);

  const [currentStep, setCurrentStep] = useState(0);
  const [sourceOrgId, setSourceOrgId] = useState('');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [selectedObjects, setSelectedObjects] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(false);
  const [complianceFramework, setComplianceFramework] = useState<ComplianceFrameworkType>('none');
  const [isExecuting, setIsExecuting] = useState(false);

  const availableObjects: AutopilotObjectInfo[] = DEMO_OBJECTS;

  const handleToggleObject = useCallback((apiName: string) => {
    setSelectedObjects((prev) =>
      prev.includes(apiName) ? prev.filter((o) => o !== apiName) : [...prev, apiName],
    );
  }, []);

  const handleToggleAll = useCallback(() => {
    if (selectAll) {
      setSelectedObjects([]);
      setSelectAll(false);
    } else {
      setSelectedObjects(availableObjects.map((o) => o.apiName));
      setSelectAll(true);
    }
  }, [selectAll, availableObjects]);

  const handleExecute = useCallback(() => {
    setIsExecuting(true);
  }, []);

  const canGoNext = (): boolean => {
    switch (currentStep) {
      case 0:
        return !!sourceOrgId && !!targetOrgId && sourceOrgId !== targetOrgId;
      case 1:
        return selectedObjects.length > 0;
      case 2:
        return true;
      case 3:
        return !isExecuting;
      default:
        return true;
    }
  };

  /** Compute estimated stats for the review step. */
  const totalRecords = availableObjects
    .filter((o) => selectedObjects.includes(o.apiName))
    .reduce((sum, o) => sum + o.recordCount, 0);
  const estimatedApiCalls = Math.ceil(totalRecords / 200) * 2;
  const estimatedDurationMin = Math.ceil(totalRecords / 5000);

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
        onStepChange={setCurrentStep}
        canGoNext={canGoNext()}
        isFinished={isExecuting}
        onFinish={handleExecute}
      >
        {currentStep === 0 && (
          <Step1Connect
            orgs={orgs}
            sourceOrgId={sourceOrgId}
            targetOrgId={targetOrgId}
            onSourceSelect={setSourceOrgId}
            onTargetSelect={setTargetOrgId}
          />
        )}
        {currentStep === 1 && (
          <Step2Objects
            availableObjects={availableObjects}
            selectedObjects={selectedObjects}
            selectAll={selectAll}
            onToggleObject={handleToggleObject}
            onToggleAll={handleToggleAll}
          />
        )}
        {currentStep === 2 && (
          <Step3Compliance
            selectedFramework={complianceFramework}
            onSelect={setComplianceFramework}
          />
        )}
        {currentStep === 3 && (
          <Step4Review
            sourceOrgId={sourceOrgId}
            targetOrgId={targetOrgId}
            selectedObjects={selectedObjects}
            totalRecords={totalRecords}
            estimatedApiCalls={estimatedApiCalls}
            estimatedDurationMin={estimatedDurationMin}
            complianceFramework={complianceFramework}
            isExecuting={isExecuting}
            onExecute={handleExecute}
          />
        )}
      </SeedWizard>
    </div>
  );
};
