import { useEffect } from 'react';

import type { TFunction } from 'i18next';

import { useNotificationStore } from '../../stores/useNotificationStore';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import type { PIIObjectResult } from './useSeedWizardState';

/** PII scan response payload. */
interface PIIScanPayload {
  success: boolean;
  results?: PIIObjectResult[];
  error?: string;
}

/** Return type for the useSeedPIIScan hook. */
export interface SeedPIIScanState {
  /** PII scan results per object. */
  piiResults: PIIObjectResult[];
  /** Whether any object has PII warnings. */
  hasPiiWarnings: boolean;
  /** Whether the PII scan is in progress. */
  piiLoading: boolean;
  /** Error from the PII scan mutation, if any. */
  piiError: string | undefined;
}

/**
 * Hook managing PII (Personally Identifiable Information) scanning for
 * the Seed wizard.
 *
 * Triggers a PII scan when entering the configure step and surfaces
 * errors as toast notifications.
 */
export function useSeedPIIScan(
  selectedOrgId: string,
  selectedObjects: string[],
  currentStep: number,
  t: TFunction,
): SeedPIIScanState {
  const addNotification = useNotificationStore((s) => s.addNotification);

  const piiScanMutation = useBridgeMutation<PIIScanPayload>('precheck:pii-scan');

  const piiResults: PIIObjectResult[] = piiScanMutation.data?.results ?? [];
  const hasPiiWarnings = piiResults.some((r: PIIObjectResult) => r.piiFields.length > 0);

  const piiScanMutate = piiScanMutation.mutate;

  /* Trigger PII scan when entering configure step */
  useEffect(() => {
    if (currentStep === 1 && selectedOrgId && selectedObjects.length > 0) {
      piiScanMutate({ orgId: selectedOrgId, objectNames: selectedObjects });
    }
  }, [currentStep, selectedOrgId, selectedObjects, piiScanMutate]);

  /* Surface bridge errors as notifications */
  useEffect(() => {
    const bridgeError = piiScanMutation.error;
    if (bridgeError) {
      addNotification({ level: 'error', title: t('seed.title'), message: bridgeError, autoDismissMs: 5000 });
    }
  }, [piiScanMutation.error, addNotification, t]);

  return {
    piiResults,
    hasPiiWarnings,
    piiLoading: piiScanMutation.loading,
    piiError: piiScanMutation.error ?? undefined,
  };
}
