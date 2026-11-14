import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/Button';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { sendBridgeMessage } from '../../../bridge/sendBridgeMessage';
import { useAppStore } from '../../../stores/useAppStore';
import { useOrgStore } from '../../../stores/useOrgStore';

/** What a Quick Sync picked: its two orgs and its objects, parents included. */
export interface QuickSyncPick {
  sourceOrgId: string;
  targetOrgId: string;
  objects: string[];
}

/** Props for {@link QuickSyncRefusal}. */
export interface QuickSyncRefusalProps {
  /** The error, as the page words it. */
  message: string;
  /** The code it came with, or null. */
  code: string | null;
  /** What the flow picked, which the ways out take with them. */
  pick: QuickSyncPick;
  /** Open the pair and the objects in the wizard, where each object takes a filter. */
  onOpenInWizard: (pick: QuickSyncPick) => void;
}

/**
 * Why a Quick Sync stopped, and where to go from there.
 *
 * The error was shown as raw text. A run refused for the data storage the
 * target has left was told, in the wizard's words, to simulate it and narrow
 * the objects' filters: Quick Sync has neither, and its Back to wizard left
 * the pair and the objects behind. The refusal now says what this flow can
 * do — leave objects out, open them in the wizard to filter them — and the
 * two ways the product has to a copy that fits: a sample of the source from
 * Forge's Depth ALL, or the objects emptied in the target first. Any other
 * error is shown with what the error catalogue says of it.
 */
export const QuickSyncRefusal: React.FC<QuickSyncRefusalProps> = ({
  message,
  code,
  pick,
  onOpenInWizard,
}) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const selectOrg = useOrgStore((s) => s.selectOrg);

  if (code !== 'SYNC_STORAGE_EXCEEDED') {
    return <ErrorBanner message={message} code={code} data-testid="quick-sync-error" />;
  }

  /*
   * Empty objects on the target, these objects picked, the target selected
   * there as everywhere: the org picked on one page is the org picked on all.
   */
  const emptyFirst = (): void => {
    selectOrg(pick.targetOrgId);
    sendBridgeMessage('org:select', { orgId: pick.targetOrgId });
    navigate('dataops', { targetOrgId: pick.targetOrgId, emptyObjects: pick.objects });
  };

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-sm bg-(--sf-error-bg) p-2 text-xs"
      data-testid="quick-sync-storage-refusal"
    >
      <p className="text-status-error">{t('quickSync.refusal.storage')}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onOpenInWizard(pick)}
          data-testid="quick-sync-open-in-wizard"
        >
          {t('quickSync.refusal.openInWizard')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate('forge')}
          data-testid="quick-sync-open-forge"
        >
          {t('quickSync.refusal.openForge')}
        </Button>
        <Button variant="ghost" size="sm" onClick={emptyFirst} data-testid="quick-sync-empty-first">
          {t('quickSync.refusal.emptyFirst')}
        </Button>
      </div>
    </div>
  );
};
