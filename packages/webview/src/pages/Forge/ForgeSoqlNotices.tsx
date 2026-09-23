import React from 'react';
import { useTranslation } from 'react-i18next';
import { soqlFilterRefused, soqlRootFilter, SOQL_UNSCOPED_RECORD_CAP } from './forgeUtils';

/** Props for the ForgeSoqlNotices component. */
export interface ForgeSoqlNoticesProps {
  /** The query the run would send: typed, saved in a template, or drafted by the AI. */
  query: string;
  /** The object after FROM is not an API name the extension accepts. */
  objectNameRefused: boolean;
}

/**
 * The verdicts a SOQL-mode run carries, under whichever field holds its query.
 *
 * The WHERE clause filters the object after FROM, and nothing else: related
 * objects are read from their whole tables. A user who wrote — or was given —
 * a filter would otherwise expect the whole graph to follow it. A clause the
 * extension would refuse, and an object name its schema would refuse, are
 * said here before Discover, which stays off, rather than after the trip.
 */
export const ForgeSoqlNotices: React.FC<ForgeSoqlNoticesProps> = ({ query, objectNameRefused }) => {
  const { t } = useTranslation();
  const root = soqlRootFilter(query);
  const whereRefused = soqlFilterRefused(query);

  return (
    <>
      {whereRefused && (
        <div
          data-testid="forge-soql-filter-refused"
          role="alert"
          className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
        >
          {t(root?.unresolvedAlias ? 'forge.soqlAliasRefused' : 'forge.soqlFilterRefused')}
        </div>
      )}
      {objectNameRefused && root && (
        <div
          data-testid="forge-soql-object-invalid"
          role="alert"
          className="mt-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-text-primary"
        >
          {t('forge.soqlObjectNameInvalid', { object: root.objectApiName })}
        </div>
      )}
      {root?.where && !whereRefused && !objectNameRefused && (
        <div
          data-testid="forge-soql-where-warning"
          role="status"
          className="mt-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary"
        >
          <strong className="font-semibold">
            {t('forge.soqlUnscopedWarnTitle', { object: root.objectApiName })}
          </strong>{' '}
          {t('forge.soqlUnscopedWarnBody', { cap: SOQL_UNSCOPED_RECORD_CAP })}
        </div>
      )}
    </>
  );
};
