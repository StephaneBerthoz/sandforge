import { useMemo, useState, useCallback } from 'react';
import type { SmartActionRecommendation } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';

/** Payload returned by the smart-action:analyze bridge response. */
interface SmartActionPayload {
  recommendation: SmartActionRecommendation;
}

/** State exposed by the useSmartAction hook. */
export interface SmartActionState {
  /** The current recommendation, or null if not yet loaded. */
  recommendation: SmartActionRecommendation | null;
  /** Whether the analysis is in flight. */
  loading: boolean;
  /** Error message if analysis failed. */
  error: string | null;
  /** Whether the confirmation dialog is showing. */
  showConfirmation: boolean;
  /** Show the confirmation dialog before executing. */
  requestConfirm: () => void;
  /** Confirm and execute the recommended action. */
  confirm: () => void;
  /** Cancel the confirmation dialog. */
  cancelConfirm: () => void;
}

/**
 * Hook that manages the Smart Action analysis lifecycle.
 *
 * Sends a `smart-action:analyze` bridge query on mount when orgs are
 * connected, and provides a confirmation flow before executing the
 * recommended action.
 *
 * Results are cached for 5 minutes on the extension side.
 */
export function useSmartAction(): SmartActionState {
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useAppStore((s) => s.navigate);
  const [showConfirmation, setShowConfirmation] = useState(false);

  const connectedOrgs = useMemo(
    () => orgs.filter((o) => o.status === 'connected'),
    [orgs],
  );

  const targetOrgId = connectedOrgs.length > 0 ? connectedOrgs[0].id : '';
  const sourceOrgId = connectedOrgs.length > 1 ? connectedOrgs[1].id : undefined;

  const queryPayload = useMemo(
    () => ({
      targetOrgId,
      ...(sourceOrgId ? { sourceOrgId } : {}),
    }),
    [targetOrgId, sourceOrgId],
  );

  const { data, loading, error } = useBridgeQuery<SmartActionPayload>(
    'smart-action:analyze',
    queryPayload,
    { skip: !targetOrgId },
  );

  const recommendation = data?.recommendation ?? null;

  const requestConfirm = useCallback(() => {
    setShowConfirmation(true);
  }, []);

  const cancelConfirm = useCallback(() => {
    setShowConfirmation(false);
  }, []);

  const confirm = useCallback(() => {
    setShowConfirmation(false);
    if (!recommendation) return;

    switch (recommendation.action) {
      case 'quick-seed':
        navigate('seed');
        break;
      case 'clone':
        navigate('seed');
        break;
      case 'sync':
        navigate('grappe');
        break;
      default:
        break;
    }
  }, [recommendation, navigate]);

  return {
    recommendation,
    loading,
    error,
    showConfirmation,
    requestConfirm,
    confirm,
    cancelConfirm,
  };
}
