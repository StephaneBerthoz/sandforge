import React from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../components/ui/Input';

/** Volume config per object. */
export interface ObjectVolume {
  objectApiName: string;
  label: string;
  recordCount: number;
  batchSize: number;
}

/** Step5 props. */
export interface Step5SetVolumesProps {
  volumes: ObjectVolume[];
  onChangeCount: (objectApiName: string, count: number) => void;
  onChangeBatchSize: (objectApiName: string, size: number) => void;
}

/** Step 5 — Set record volumes per object. */
export const Step5SetVolumes: React.FC<Step5SetVolumesProps> = ({
  volumes,
  onChangeCount,
  onChangeBatchSize,
}) => {
  const { t } = useTranslation();

  const totalRecords = volumes.reduce((sum, v) => sum + v.recordCount, 0);

  return (
    <div className="flex flex-col gap-3" data-testid="step-set-volumes">
      <p className="text-xs text-[var(--sf-text-secondary)]">{t('seed.setVolumesDesc')}</p>

      <div className="grid grid-cols-[1fr_120px_120px] gap-2 text-xs">
        <span className="font-medium text-[var(--sf-text-primary)]">{t('seed.selectObjects')}</span>
        <span className="font-medium text-[var(--sf-text-primary)]">{t('seed.recordCount')}</span>
        <span className="font-medium text-[var(--sf-text-primary)]">{t('seed.batchSize')}</span>

        {volumes.map((vol) => (
          <React.Fragment key={vol.objectApiName}>
            <span className="text-[var(--sf-text-primary)] flex items-center">
              {vol.label} ({vol.objectApiName})
            </span>
            <Input
              type="number"
              min={1}
              value={vol.recordCount}
              onChange={(e) => onChangeCount(vol.objectApiName, parseInt(e.target.value, 10) || 0)}
              data-testid={`count-${vol.objectApiName}`}
            />
            <Input
              type="number"
              min={1}
              max={10000}
              value={vol.batchSize}
              onChange={(e) =>
                onChangeBatchSize(vol.objectApiName, parseInt(e.target.value, 10) || 200)
              }
              data-testid={`batch-${vol.objectApiName}`}
            />
          </React.Fragment>
        ))}
      </div>

      <div className="text-xs text-[var(--sf-text-secondary)]" data-testid="total-records">
        {t('seed.totalRecords')}: {totalRecords}
      </div>
    </div>
  );
};
