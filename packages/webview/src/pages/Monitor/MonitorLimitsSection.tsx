import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import type { ApiLimit, StorageObjectEntry } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { Select } from '../../components/ui/Select';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useOrgStore } from '../../stores/useOrgStore';
import type { useAnomalyScan } from '../../hooks/useAIFeatures';
import { SectionHeader } from './SectionHeader';
import { PanelOverlay } from './PanelOverlay';
import { usageVariant, usageBadge } from './monitorUtils';
import { formatNumber } from '../../utils/formatters';

/**
 * Object the scan targets until the user picks another one. Account exists in
 * every org, so the control always has a valid value — including before the
 * object list arrives and on an org whose objects are all empty.
 */
const DEFAULT_SCAN_OBJECT = 'Account';

/** The slice of `monitor:storage` this section reads: objects that hold records. */
interface ScanTargetsData {
  objects: StorageObjectEntry[];
}

/** Props for the MonitorLimitsSection section. */
export interface MonitorLimitsSectionProps {
  /** Limits sorted by usage percentage descending. */
  sortedLimits: ApiLimit[];
  /** Limits at or above 60% usage (shown as header count). */
  criticalLimits: ApiLimit[];
  /** Whether a background refresh is in progress. */
  isRefreshing: boolean;
  /** AI anomaly scan mutation (trigger + loading state). */
  anomalyScan: ReturnType<typeof useAnomalyScan>;
}

/**
 * Governor limits panel with collapsible rows and the anomaly scan action.
 * Subscribes to the selected org itself and owns its expanded state, the
 * scanned object and the list of objects offered as targets.
 * Memoized — re-renders only when its own slices change.
 */
export const MonitorLimitsSection: React.FC<MonitorLimitsSectionProps> = React.memo(
  ({ sortedLimits, criticalLimits, isRefreshing, anomalyScan }) => {
    const { t } = useTranslation();
    const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
    const [limitsExpanded, setLimitsExpanded] = useState(false);
    const [scanObject, setScanObject] = useState(DEFAULT_SCAN_OBJECT);
    const { reset: resetScan } = anomalyScan;

    // Same channel the storage panel reads: the org's objects that hold
    // records, biggest first. Each Monitor panel queries for itself — no store
    // caches bridge responses — so this is a second `monitor:storage` call per
    // page, which is what feeding the picker from live org data costs.
    const { data: scanTargets, loading: scanTargetsLoading } = useBridgeQuery<ScanTargetsData>(
      'monitor:storage',
      selectedOrgId ? { orgId: selectedOrgId } : undefined,
      { responseType: 'monitor:storage:response', skip: !selectedOrgId },
    );

    // The page keeps this section mounted when the org changes, so the target
    // has to be dropped here: a custom object of the org just left does not
    // exist in the one just entered, and scanning it fails. Adjusted during
    // render rather than in an effect, so no click can land on the stale
    // target between the switch and the correction.
    const [targetOrgId, setTargetOrgId] = useState(selectedOrgId);
    if (targetOrgId !== selectedOrgId) {
      setTargetOrgId(selectedOrgId);
      setScanObject(DEFAULT_SCAN_OBJECT);
    }

    // The report carries no org of its own, so leaving it up would relabel the
    // previous org's findings as the new one's. Clearing it is a state update
    // in the parent, which a render may not do — hence the effect.
    useEffect(() => {
      resetScan();
    }, [selectedOrgId, resetScan]);

    // API names, not labels: the scan reports its findings per field API name,
    // and the button repeats the value this list holds. The default target
    // leads, because it is where every org starts and it is not guaranteed to
    // hold records; the rest follow in the order the org returned them,
    // largest first.
    const objectOptions = useMemo(() => {
      // Until the list for the org just entered arrives, the hook still holds
      // the previous org's answer: offering it would let a scan go out for an
      // object this org does not have.
      const fromOrg = scanTargetsLoading
        ? []
        : (scanTargets?.objects ?? []).map((o) => o.objectName);
      const names = [DEFAULT_SCAN_OBJECT, ...fromOrg];
      return [...new Set(names)].map((name) => ({ value: name, label: name }));
    }, [scanTargets?.objects, scanTargetsLoading]);

    // A scan that answers with nothing on screen is a scan the user cannot
    // tell from one that never ran: both failure channels are rendered, and
    // so is a clean run that found nothing.
    const scanFailed = anomalyScan.error !== null || anomalyScan.data?.success === false;
    const scanFailure = scanFailed
      ? (anomalyScan.error ??
        anomalyScan.data?.error ??
        t('monitor.anomalyScanFailed', 'Anomaly scan failed'))
      : null;
    const scanFoundNothing =
      anomalyScan.data?.success === true && (anomalyScan.data.anomalies?.length ?? 0) === 0;

    return (
      <PanelOverlay isRefreshing={isRefreshing}>
        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <SectionHeader
            title={t('monitor.governorLimits', 'Governor Limits')}
            count={criticalLimits.length > 0 ? criticalLimits.length : undefined}
            collapsed={!limitsExpanded}
            onToggle={() => setLimitsExpanded(!limitsExpanded)}
            actions={
              <div className="flex items-center gap-2">
                <Select
                  options={objectOptions}
                  value={scanObject}
                  onChange={(e) => {
                    // The report below the panel carries no object of its own:
                    // leaving it on screen would relabel an Account scan as
                    // the object just picked. Switching target clears it.
                    setScanObject(e.target.value);
                    anomalyScan.reset();
                  }}
                  aria-label={t('monitor.anomalyScanObject', 'Object to scan for anomalies')}
                  disabled={anomalyScan.loading}
                  className="w-44 py-1 text-xs"
                  data-testid="anomaly-scan-object"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    anomalyScan.mutate({ orgId: selectedOrgId, objectName: scanObject })
                  }
                  disabled={anomalyScan.loading || !selectedOrgId}
                  loading={anomalyScan.loading}
                  data-testid="anomaly-scan-btn"
                >
                  <Search className="w-3.5 h-3.5 mr-1" />
                  {t('monitor.scanAnomaliesOn', 'Scan {{object}}', { object: scanObject })}
                </Button>
              </div>
            }
          />

          {scanFailure !== null && (
            <p
              className="text-xs text-[var(--sf-error)] mt-2"
              role="alert"
              data-testid="anomaly-scan-error"
            >
              {scanFailure}
            </p>
          )}

          {scanFoundNothing && (
            <p
              className="text-xs text-text-muted mt-2"
              role="status"
              data-testid="anomaly-scan-empty"
            >
              {t('monitor.noAnomalies', 'No anomalies found in {{object}}', {
                object: scanObject,
              })}
            </p>
          )}

          {limitsExpanded && (
            <div className="flex flex-col gap-1.5">
              {sortedLimits.length === 0 ? (
                <p className="text-xs text-text-muted text-center py-4">
                  {t('monitor.noLimits', 'No limits data available')}
                </p>
              ) : (
                sortedLimits.map((l) => {
                  const used = l.max - l.remaining;
                  return (
                    <div
                      key={l.name}
                      className="flex items-center gap-3 px-3 py-1.5 rounded hover:bg-surface-2 transition-colors"
                      data-testid={`limit-${l.name}`}
                    >
                      <span className="text-xs font-medium text-text-primary w-48 truncate shrink-0">
                        {l.name}
                      </span>
                      <div className="flex-1">
                        <ProgressBar
                          value={l.usedPercent}
                          variant={usageVariant(l.usedPercent)}
                          size="sm"
                        />
                      </div>
                      <span className="text-xs tabular-nums text-text-secondary w-24 text-right shrink-0">
                        {formatNumber(used)} / {formatNumber(l.max)}
                      </span>
                      <span className="w-12 text-right shrink-0">
                        <Badge variant={usageBadge(l.usedPercent)}>
                          {Math.round(l.usedPercent)}%
                        </Badge>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </PanelOverlay>
    );
  },
);

MonitorLimitsSection.displayName = 'MonitorLimitsSection';
