import React from 'react';
import { useTranslation } from 'react-i18next';
import type { StorageRecommendation } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatFileSize } from '../../utils/formatters';

/** CleanupPanel component props. */
export interface CleanupPanelProps {
  recommendations?: StorageRecommendation[];
  onCleanup?: (objectApiName: string, action: string) => void;
  onMassDelete?: () => void;
  onArchive?: () => void;
  isRunning?: boolean;
}

const RECOMMENDATION_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> =
  {
    archive: 'info',
    delete: 'error',
    compress: 'warning',
    optimize: 'success',
  };

/** Panel for cleanup and storage optimization. */
export const CleanupPanel: React.FC<CleanupPanelProps> = ({
  recommendations = [],
  onCleanup,
  onMassDelete,
  onArchive,
  isRunning = false,
}) => {
  const { t } = useTranslation();

  const totalSavings = recommendations.reduce((sum, r) => sum + r.estimatedSaving, 0);

  return (
    <div className="flex flex-col gap-3" data-testid="cleanup-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">{t('dataops.cleanup')}</h2>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onArchive} data-testid="archive-btn">
            {t('dataops.archive')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onMassDelete}
            data-testid="mass-delete-btn"
          >
            {t('dataops.massDelete')}
          </Button>
        </div>
      </div>

      {recommendations.length === 0 && (
        <EmptyState
          icon="🧹"
          title={t('dataops.cleanupDesc')}
          description={t('dataops.storageOptimizer')}
        />
      )}

      {recommendations.length > 0 && (
        <div className="text-xs text-text-secondary" data-testid="savings-summary">
          {t('dataops.storageSaved')}: {formatFileSize(totalSavings)}
        </div>
      )}

      {recommendations.map((rec) => (
        <div key={rec.objectApiName} data-testid={`rec-${rec.objectApiName}`}>
          <Card>
            <CardHeader
              title={rec.objectApiName}
              subtitle={`${t('common.recordCount', { count: rec.currentRecords })} · ${formatFileSize(rec.currentSize)}`}
              action={
                <Badge variant={RECOMMENDATION_VARIANT[rec.recommendation] ?? 'default'}>
                  {rec.recommendation}
                </Badge>
              }
            />
            <CardBody>
              <div className="flex items-center justify-between">
                <div className="text-xs text-text-secondary">
                  <p>{rec.reason}</p>
                  <p className="mt-1">
                    {t('dataops.storageSaved')}: {formatFileSize(rec.estimatedSaving)}
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onCleanup?.(rec.objectApiName, rec.recommendation)}
                  disabled={isRunning}
                  data-testid={`cleanup-${rec.objectApiName}`}
                >
                  {t('common.confirm')}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      ))}
    </div>
  );
};
