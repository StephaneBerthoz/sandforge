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
  /** Confirm: open the page for the recommended action on the orgs it names. */
  confirm: () => void;
  /** Cancel the confirmation dialog. */
  cancelConfirm: () => void;
}

/**
 * Hook that manages the Smart Action analysis lifecycle.
 *
 * Sends a `smart-action:analyze` bridge query on mount when orgs are
 * connected, and provides a confirmation flow before opening the page for the
 * recommended action.
 *
 * Confirming opens the page for that action: the clone wizard on the orgs the
 * recommendation names with its source selected, the quick-seed template
 * gallery (its org is still picked there), or Sync with both named orgs set.
 * It does not run anything: the clone preview and the production guard still
 * come first. It used to only switch route, so the page opened blank.
 *
 * Results are cached for 5 minutes on the extension side.
 */
export function useSmartAction(): SmartActionState {
  const orgs = useOrgStore((s) => s.orgs);
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const navigate = useAppStore((s) => s.navigate);
  const [showConfirmation, setShowConfirmation] = useState(false);

  const connectedOrgs = useMemo(() => orgs.filter((o) => o.status === 'connected'), [orgs]);

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

    const target = recommendation.details.targetOrgId;
    const source = recommendation.details.sourceOrgId ?? sourceOrgId;
    switch (recommendation.action) {
      case 'quick-seed':
        navigate('seed', { seedMode: 'quick-seed' });
        break;
      case 'clone':
        // The wizard writes to the selected org; make it the one the
        // confirmation named.
        selectOrg(target);
        navigate('seed', { seedMode: 'clone', sourceOrgId: source, targetOrgId: target });
        break;
      case 'sync':
        // Sync, not Grappe: Grappe only shows the partitions of a run already
        // going and cannot start one.
        navigate('sync', { sourceOrgId: source, targetOrgId: target });
        break;
      default:
        break;
    }
  }, [recommendation, navigate, selectOrg, sourceOrgId]);

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
