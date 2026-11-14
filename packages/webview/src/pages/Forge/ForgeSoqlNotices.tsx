import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FORGE_ROOTS_MAX, soqlRootFilter } from '@sandforge/shared';
import type { SoqlRootIssue } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { uiLocale } from '../../utils/formatters';
import { newestQueryOf } from './forgeUtils';
import type { RootsPreviewState } from './useRootsPreview';

/** The setting that bounds the records a query chooses. */
const MAX_ROOTS_SETTING = 'sandforge.forge.maxRoots';

/** Props for the ForgeSoqlNotices component. */
export interface ForgeSoqlNoticesProps {
  /** The query the run would send: typed, saved in a template, or drafted by the AI. */
  query: string;
  /** Why the query cannot choose the records a clone takes; nothing when it can. */
  issue: SoqlRootIssue | undefined;
  /** What the query chooses, read before Discover; absent where nothing reads it. */
  roots?: RootsPreviewState;
  /**
   * Put the newest of the records the query chooses in its place, as many as
   * a run takes; absent where the query is not the user's to change here.
   */
  onTakeNewest?: (cap: number) => void;
  /** The query is a template's, or a past run's, saved before 1.81.0. */
  before181?: boolean;
}

/** Why the query cannot choose records, in the panel's language. */
export function rootIssueWords(t: TFunction, issue: SoqlRootIssue): string {
  switch (issue.kind) {
    case 'noObject':
      return t('forge.roots.issue.noObject');
    case 'object':
      return t('forge.roots.issue.object', { object: issue.objectApiName });
    case 'refused':
      return issue.clause === 'aggregate'
        ? t('forge.roots.issue.aggregate')
        : t('forge.roots.issue.refused', { clause: issue.clause });
    case 'alias':
      return t('forge.roots.issue.alias');
    case 'where':
      return t('forge.roots.issue.where');
    case 'orderBy':
      return t('forge.roots.issue.orderBy');
    case 'limit':
      return t('forge.roots.issue.limit', { most: FORGE_ROOTS_MAX.toLocaleString(uiLocale()) });
  }
}

/**
 * What the input says of a query, under whichever field holds it.
 *
 * The query chooses the records the run clones, each with what the clone of
 * that record copies: its WHERE chooses them, and no longer filters the
 * object's other reads. What that means is said once the query reads as one
 * — a related record comes with them, another record of their object only as
 * a parent one of them names —, with what it chooses, read in the source
 * before Discover: how many, none, or more than a run takes, with the ways
 * through — the newest of them written into the query, or the setting —
 * before the run is refused for it. A query that cannot choose records is
 * said here, and Discover stays off, rather than refused after the trip.
 *
 * A query saved before 1.81.0 read each related table whole, 200 rows at
 * most: it is run the new way, and said so, to be simulated first.
 */
export const ForgeSoqlNotices: React.FC<ForgeSoqlNoticesProps> = ({
  query,
  issue,
  roots,
  onTakeNewest,
  before181 = false,
}) => {
  const { t } = useTranslation();
  const typed = query.trim().length > 0;
  const object = soqlRootFilter(query)?.objectApiName;
  const preview = roots?.status === 'read' ? roots.preview : undefined;
  const newest =
    preview?.more && onTakeNewest ? newestQueryOf(query, preview.cap) !== undefined : false;

  return (
    <>
      {typed && issue && (
        <div
          data-testid="forge-roots-issue"
          role="alert"
          className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
        >
          {rootIssueWords(t, issue)}
        </div>
      )}
      {before181 && (
        <div
          data-testid="forge-roots-before-181"
          role="status"
          className="mt-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
        >
          {t('forge.roots.before181')}
        </div>
      )}
      {typed && !issue && object && (
        <p
          data-testid="forge-roots-info"
          className="mt-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs text-text-primary"
        >
          {t('forge.roots.info', { object })}
        </p>
      )}
      {typed && !issue && roots && roots.status !== 'idle' && (
        <div
          data-testid="forge-roots-line"
          className={
            preview && (preview.more || preview.chosen === 0)
              ? 'mt-2 flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary'
              : 'mt-2 flex flex-col gap-2 text-xs text-text-primary'
          }
        >
          <p role="status" data-testid="forge-roots-said">
            {roots.status === 'reading'
              ? t('forge.roots.reading')
              : roots.status === 'failed'
                ? t('forge.roots.failed', { message: roots.error ?? '' })
                : !preview
                  ? ''
                  : preview.more
                    ? preview.limit !== undefined
                      ? t('forge.roots.moreThanLimit', {
                          object: preview.objectApiName,
                          cap: preview.cap.toLocaleString(uiLocale()),
                          limit: preview.limit.toLocaleString(uiLocale()),
                        })
                      : t('forge.roots.more', {
                          object: preview.objectApiName,
                          cap: preview.cap.toLocaleString(uiLocale()),
                        })
                    : preview.chosen === 0
                      ? t('forge.roots.none', { object: preview.objectApiName })
                      : t('forge.roots.chosen', {
                          count: preview.chosen,
                          formatted: preview.chosen.toLocaleString(uiLocale()),
                          object: preview.objectApiName,
                          cap: preview.cap.toLocaleString(uiLocale()),
                        })}
          </p>
          {(preview?.more || roots.status === 'failed') && (
            <div className="flex flex-wrap gap-2">
              {preview && newest && onTakeNewest && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid="forge-roots-newest"
                  onClick={() => onTakeNewest(preview.cap)}
                >
                  {t(
                    preview.orderBy !== undefined
                      ? 'forge.roots.firstInOrder'
                      : 'forge.roots.newest',
                    { cap: preview.cap.toLocaleString(uiLocale()) },
                  )}
                </Button>
              )}
              {preview?.more && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid="forge-roots-setting"
                  onClick={() =>
                    sendBridgeMessage<{ setting: string }>('workbench:open-setting', {
                      setting: MAX_ROOTS_SETTING,
                    })
                  }
                >
                  {t('forge.roots.setting', {
                    most: FORGE_ROOTS_MAX.toLocaleString(uiLocale()),
                  })}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="forge-roots-read-again"
                onClick={roots.readAgain}
              >
                {t('forge.roots.readAgain')}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
};
