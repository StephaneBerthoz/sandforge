import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RemovalOutcome, RemovalPlanObject, SubjectEraseMode } from '@sandforge/shared';
import { formatNumber } from '../../utils/formatters';

/** Props for {@link RemovalPlanView}. */
export interface RemovalPlanViewProps {
  /** Overwritten in place, or deleted. */
  mode: SubjectEraseMode;
  plan: RemovalPlanObject[];
}

/** Total records a plan acts on, the objects it leaves alone aside. */
export function plannedRecords(plan: readonly RemovalPlanObject[]): number {
  return plan.reduce((sum, object) => sum + (object.refused ? 0 : object.records), 0);
}

/**
 * What an erasure or a delete will do, object by object, before it does it:
 * the fields it overwrites and how, the ones it cannot, or what the org
 * deletes along with the records. Read from the extension's dry run, which
 * wrote nothing.
 */
export const RemovalPlanView: React.FC<RemovalPlanViewProps> = ({ mode, plan }) => {
  const { t } = useTranslation();
  const number = (n: number): string => formatNumber(n);

  return (
    <ul className="flex flex-col gap-2" data-testid="removal-plan">
      {plan.map((object) => (
        <li
          key={object.objectApiName}
          className="flex flex-col gap-1 rounded-sm border border-(--sf-border) p-2 text-xs"
          data-testid={`removal-plan-${object.objectApiName}`}
        >
          <p className="font-semibold text-text-primary">
            {object.label}{' '}
            <span className="font-normal text-text-secondary">
              {t('dataops.removal.records', {
                count: object.records,
                formatted: number(object.records),
              })}
            </span>
          </p>
          {object.refused ? (
            <p className="text-status-error" data-testid="removal-plan-refused">
              {t('dataops.removal.refused', { reason: object.refused })}
            </p>
          ) : mode === 'anonymize' ? (
            <>
              {object.fields && object.fields.length > 0 ? (
                <p className="text-text-primary" data-testid="removal-plan-fields">
                  {t('dataops.removal.overwrites')}{' '}
                  {object.fields
                    .map((f) =>
                      t(
                        f.method === 'fake' ? 'dataops.removal.madeUp' : 'dataops.removal.emptied',
                        {
                          field: f.label,
                        },
                      ),
                    )
                    .join(', ')}
                </p>
              ) : (
                <p className="text-text-secondary">{t('dataops.removal.nothingToOverwrite')}</p>
              )}
              {object.kept && object.kept.length > 0 && (
                <p className="text-status-warning" data-testid="removal-plan-kept">
                  {t('dataops.removal.kept')} {object.kept.map((f) => f.label).join(', ')}
                </p>
              )}
            </>
          ) : (
            <>
              {object.related && object.related.length > 0 ? (
                <p className="text-status-warning" data-testid="removal-plan-related">
                  {t('dataops.removal.related')}{' '}
                  {object.related
                    .map((r) =>
                      t('dataops.removal.relatedRecords', {
                        count: r.records,
                        formatted: number(r.records),
                        label: r.label,
                      }),
                    )
                    .join(', ')}
                </p>
              ) : (
                <p className="text-text-secondary">{t('dataops.removal.noRelated')}</p>
              )}
              {object.uncounted && object.uncounted.length > 0 && (
                <p className="text-text-secondary" data-testid="removal-plan-uncounted">
                  {t('dataops.removal.uncounted')} {object.uncounted.join(', ')}
                </p>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
};

/** Props for {@link RemovalOutcomeView}. */
export interface RemovalOutcomeViewProps {
  mode: SubjectEraseMode;
  outcome: RemovalOutcome;
}

/** What an erasure or a delete did, and what the org said about the records it refused. */
export const RemovalOutcomeView: React.FC<RemovalOutcomeViewProps> = ({ mode, outcome }) => {
  const { t } = useTranslation();
  const number = (n: number): string => formatNumber(n);
  return (
    <div className="flex flex-col gap-1 text-xs" role="status" data-testid="removal-outcome">
      <p className={outcome.failed > 0 ? 'text-status-warning' : 'text-status-success'}>
        {t(mode === 'delete' ? 'dataops.removal.deleted' : 'dataops.removal.overwritten', {
          count: outcome.done,
          formatted: number(outcome.done),
        })}
        {outcome.failed > 0 &&
          ` ${t('dataops.removal.refusedByOrg', {
            count: outcome.failed,
            formatted: number(outcome.failed),
          })}`}
      </p>
      {outcome.errors.length > 0 && (
        <ul
          className="flex flex-col gap-0.5 text-text-secondary"
          data-testid="removal-outcome-errors"
        >
          {outcome.errors.map((error, index) => (
            <li key={`${error.objectApiName}-${index}`}>
              {error.objectApiName}: {error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
