import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, UserRound } from 'lucide-react';
import type { ForgeGraph, ForgeTargetRecordsResponse } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useAppStore } from '../../stores/useAppStore';
import { useOrgStore } from '../../stores/useOrgStore';
import { Button } from '../../components/ui/Button';
import { uiLocale } from '../../utils/formatters';

/** The id of the line that says the personal fields copied as they are, which Execute is described by. */
export const PERSONAL_AS_IS_ID = 'review-personal-as-is';

/**
 * The personal fields a run copies as they are, per object it writes: those
 * discovery named personal that the run does not anonymize — every one with
 * Anonymize off, those not selected on their node with it on — as the
 * extension's confirmation counts them. An object it writes nothing of, or
 * with none, is left out.
 */
export function personalFieldsAsIs(
  graph: Pick<ForgeGraph, 'nodes'>,
  anonymizePII: boolean,
): Array<{ objectApiName: string; fields: string[] }> {
  return graph.nodes.flatMap((node) => {
    const writes = node.included && (node.recordCount > 0 || node.recordCountUnknown === true);
    if (!writes) return [];
    const anonymized = new Set(anonymizePII ? node.anonymizeFields : []);
    const fields = node.piiFields.filter((field) => !anonymized.has(field));
    return fields.length > 0 ? [{ objectApiName: node.objectApiName, fields }] : [];
  });
}

/** Props for {@link ReviewWholeOrgNotes}. */
export interface ReviewWholeOrgNotesProps {
  graph: ForgeGraph;
  anonymizePII: boolean;
  targetOrgId: string;
  /** The target org, as the user knows it. */
  target: string;
}

/**
 * What Review says of a clone of the whole org before Execute, beside its
 * rows: the personal fields it copies as they are, not anonymized, by
 * object — said before the run, not only in the confirmation — and what the
 * target already holds of the objects it copies, read of the org's own
 * record counts, with where to empty them first: the run adds its records
 * beside those, it does not replace them.
 */
export const ReviewWholeOrgNotes: React.FC<ReviewWholeOrgNotesProps> = ({
  graph,
  anonymizePII,
  targetOrgId,
  target,
}) => {
  const { t } = useTranslation();
  const locale = uiLocale();
  const asIs = useMemo(() => personalFieldsAsIs(graph, anonymizePII), [graph, anonymizePII]);
  const fieldCount = asIs.reduce((sum, { fields }) => sum + fields.length, 0);
  // Every node, included or not, so a node taken in or out asks nothing again:
  // the objects shown are those the run copies.
  const names = useMemo(() => graph.nodes.map((node) => node.objectApiName).sort(), [graph]);
  const held = useBridgeQuery<ForgeTargetRecordsResponse['payload']>(
    'forge:target-records:request',
    { targetOrgId, objectApiNames: names },
    {
      responseType: 'forge:target-records:response',
      errorType: 'forge:target-records:error',
    },
  );
  const copied = useMemo(
    () =>
      new Set(
        graph.nodes
          .filter((node) => node.included && node.recordCount > 0)
          .map((node) => node.objectApiName),
      ),
    [graph],
  );
  const holds = (held.data?.objects ?? []).filter(({ objectApiName }) => copied.has(objectApiName));
  const heldRecords = holds.reduce((sum, { records }) => sum + records, 0);
  const selectOrg = useOrgStore((s) => s.selectOrg);
  const navigate = useAppStore((s) => s.navigate);
  /**
   * Open DataOps → Cleanup on Empty objects with these objects picked, for
   * the target, selected there as everywhere: the org picked on one page is
   * the org picked on all of them.
   */
  const emptyFirst = (): void => {
    selectOrg(targetOrgId);
    sendBridgeMessage('org:select', { orgId: targetOrgId });
    navigate('dataops', {
      targetOrgId,
      emptyObjects: holds.map(({ objectApiName }) => objectApiName),
    });
  };

  return (
    <div data-testid="review-whole-org" className="flex flex-col gap-2 text-sm">
      <div
        className={`flex items-start gap-2 rounded-md border px-3 py-2 ${
          fieldCount > 0 ? 'border-status-warning/40 bg-status-warning/10' : 'border-subtle'
        }`}
      >
        <UserRound size={14} aria-hidden="true" className="mt-1 shrink-0 text-text-secondary" />
        <div className="flex min-w-0 flex-col gap-1">
          <p
            id={PERSONAL_AS_IS_ID}
            data-testid="review-personal-as-is"
            className="text-text-primary"
          >
            {fieldCount === 0
              ? t('forgeRun.review.wholeOrg.personalNone')
              : t('forgeRun.review.wholeOrg.personalAsIs', {
                  count: fieldCount,
                  formatted: fieldCount.toLocaleString(locale),
                  objects: asIs.length.toLocaleString(locale),
                  target,
                })}
          </p>
          {fieldCount > 0 && (
            // On the warning's tint the secondary text falls under AA: the
            // list is said in the primary colour.
            <details data-testid="review-personal-as-is-list" className="text-xs text-text-primary">
              <summary className="cursor-pointer">
                {t('forgeRun.review.wholeOrg.personalList')}
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {asIs.map(({ objectApiName, fields }) => (
                  <li key={objectApiName}>
                    <span className="font-mono text-text-primary">{objectApiName}</span>:{' '}
                    {fields.join(', ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      <div
        className="flex items-start gap-2 rounded-md border border-subtle px-3 py-2"
        data-testid="review-target-holds"
      >
        <Database size={14} aria-hidden="true" className="mt-1 shrink-0 text-text-secondary" />
        <div className="flex min-w-0 flex-col gap-1" role="status">
          {held.error !== null ? (
            <p className="text-text-secondary" data-testid="review-target-holds-failed">
              {t('forgeRun.review.wholeOrg.targetHoldsFailed', { target, message: held.error })}
            </p>
          ) : held.data === null ? (
            <p className="text-text-secondary">
              {t('forgeRun.review.wholeOrg.targetHoldsReading', { target })}
            </p>
          ) : holds.length === 0 ? (
            <p className="text-text-secondary" data-testid="review-target-holds-none">
              {t('forgeRun.review.wholeOrg.targetHoldsNone', { target })}
            </p>
          ) : (
            <>
              <p className="text-text-primary" data-testid="review-target-holds-some">
                {t('forgeRun.review.wholeOrg.targetHolds', {
                  count: heldRecords,
                  formatted: heldRecords.toLocaleString(locale),
                  objects: holds.length.toLocaleString(locale),
                  target,
                })}
              </p>
              {/* Where to empty them, until the panel can open it on them. */}
              <p className="text-text-secondary" data-testid="review-target-holds-empty-first">
                {t('forgeRun.review.wholeOrg.emptyFirst')}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={emptyFirst}
                data-testid="review-target-holds-empty-first-btn"
                className="self-start"
              >
                {t('forgeRun.review.wholeOrg.emptyFirstAction')}
              </Button>
              <details className="text-xs">
                <summary className="cursor-pointer text-text-secondary">
                  {t('forgeRun.review.wholeOrg.targetHoldsList')}
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5 text-text-secondary">
                  {holds.map(({ objectApiName, records }) => (
                    <li key={objectApiName}>
                      <span className="font-mono text-text-primary">{objectApiName}</span>:{' '}
                      {t('forgeRun.review.wholeOrg.aboutRecords', {
                        count: records,
                        formatted: records.toLocaleString(locale),
                      })}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
