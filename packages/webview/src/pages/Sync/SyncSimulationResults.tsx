import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncObjectSimulation, SyncSimulationResult } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

/** Props for {@link SyncSimulationResults}. */
export interface SyncSimulationResultsProps {
  /** What the simulation found. */
  simulation: SyncSimulationResult;
  /** Run the sync for real, with the configuration just simulated. */
  onRun: () => void;
}

/** The counts of every object, added up. */
function totalsOf(objects: readonly SyncObjectSimulation[]) {
  const totals = { insert: 0, update: 0, delete: 0, skipped: 0, refused: 0, conflicts: 0 };
  for (const o of objects) {
    totals.insert += o.insert;
    totals.update += o.update;
    totals.delete += o.delete;
    totals.skipped += o.skipped;
    totals.refused += o.refused;
    totals.conflicts += o.conflicts;
  }
  return totals;
}

/**
 * The results step in its simulation state: what a run would insert, update,
 * delete, skip, see refused or find in conflict, object by object, with
 * nothing written. The run's own results take the same place once it runs.
 */
export const SyncSimulationResults: React.FC<SyncSimulationResultsProps> = ({
  simulation,
  onRun,
}) => {
  const { t } = useTranslation();
  const totals = totalsOf(simulation.objects);
  const bidirectional = simulation.direction === 'bidirectional';
  const deletes = simulation.objects.some((o) => o.operation === 'delete');
  const strategy = t(`sync.conflicts.${simulation.conflictStrategy}`);

  return (
    <div className="flex flex-col gap-3" data-testid="sync-simulation-results">
      <div
        className="flex items-center gap-3 text-xs flex-wrap"
        data-testid="sync-simulation-summary"
      >
        <Badge variant="info">
          {simulation.cancelled ? t('sync.simulation.cancelled') : t('sync.simulation.badge')}
        </Badge>
        <span>
          {t('sync.simulation.insert')}: <strong>{totals.insert}</strong>
        </span>
        <span>
          {t('sync.simulation.update')}: <strong>{totals.update}</strong>
        </span>
        {deletes && (
          <span>
            {t('sync.simulation.delete')}: <strong>{totals.delete}</strong>
          </span>
        )}
        <span>
          {t('sync.simulation.skipped')}: <strong>{totals.skipped}</strong>
        </span>
        {totals.refused > 0 && (
          <span className="text-status-warning">
            {t('sync.simulation.refused')}: <strong>{totals.refused}</strong>
          </span>
        )}
        {bidirectional && (
          <span>
            {t('sync.simulation.conflicts')}: <strong>{totals.conflicts}</strong>
          </span>
        )}
      </div>
      <p className="text-xs text-text-secondary">{t('sync.simulation.nothingWritten')}</p>

      {simulation.error && (
        <p className="text-xs text-status-error" role="alert" data-testid="sync-simulation-error">
          {t('sync.simulation.stoppedAt', {
            object: simulation.failedObject ?? '',
            error: simulation.error,
          })}
        </p>
      )}

      {simulation.objects.map((o) => (
        <Card key={o.objectApiName} data-testid={`sync-simulation-object-${o.objectApiName}`}>
          <CardHeader
            title={o.objectApiName}
            subtitle={`${t(`sync.operations.${o.operation}`)} — ${t('sync.simulation.read', {
              count: o.read,
            })}`}
          />
          <CardBody>
            <ul className="flex gap-x-4 gap-y-1 flex-wrap text-xs text-text-primary">
              {o.operation !== 'delete' && (
                <li>
                  {t('sync.simulation.insert')}: <strong>{o.insert}</strong>
                </li>
              )}
              {(o.operation === 'upsert' || o.operation === 'update') && (
                <li>
                  {t('sync.simulation.update')}: <strong>{o.update}</strong>
                </li>
              )}
              {o.operation === 'delete' && (
                <li>
                  {t('sync.simulation.delete')}: <strong>{o.delete}</strong>
                </li>
              )}
              <li>
                {t('sync.simulation.skipped')}: <strong>{o.skipped}</strong>
              </li>
              {o.refused > 0 && (
                <li className="text-status-warning">
                  {t('sync.simulation.refused')}: <strong>{o.refused}</strong>
                </li>
              )}
              {bidirectional && (
                <li>
                  {t('sync.simulation.conflicts')}: <strong>{o.conflicts}</strong>
                </li>
              )}
            </ul>
            {bidirectional && o.conflicts > 0 && (
              <p className="text-xs text-text-secondary mt-2">
                {t('sync.simulation.settledBy', { count: o.conflicts, strategy })}
                {o.conflictFields.length > 0 &&
                  ` ${t('sync.simulation.conflictFields', { fields: o.conflictFields.join(', ') })}`}
              </p>
            )}
            {o.notes.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {o.notes.map((note, i) => (
                  <li key={i} className="text-[10px] text-text-secondary">
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      ))}

      <p className="text-[10px] text-text-secondary">{t('sync.simulation.notChecked')}</p>
      <div className="flex gap-(--sf-space-2)">
        <Button variant="primary" size="sm" onClick={onRun} data-testid="sync-run-after-simulation">
          {t('sync.simulation.runNow')}
        </Button>
      </div>
    </div>
  );
};
