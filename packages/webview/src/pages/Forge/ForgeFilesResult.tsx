import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeFileLeftOutReason, ForgeFileObject, ForgeFilesReport } from '@sandforge/shared';
import { formatFileSize } from '../../utils/formatters';

/** What a user calls the files of each object. */
const OBJECT_LABEL_KEYS: Record<ForgeFileObject, string> = {
  ContentDocument: 'forge.files.result.salesforceFiles',
  Attachment: 'forge.files.result.attachments',
};

/** Why a file was left out, in the user's words. */
const REASON_KEYS: Record<ForgeFileLeftOutReason, string> = {
  'too-large': 'forge.files.result.tooLarge',
  external: 'forge.files.result.external',
  'record-not-created': 'forge.files.result.recordNotCreated',
};

/** Props for {@link ForgeFilesResult}. */
export interface ForgeFilesResultProps {
  /** What the run did with the files of the records it cloned. */
  files: ForgeFilesReport;
}

/**
 * What a run did with the files of the records it cloned: per object, how
 * many it copied of the ones it set out to copy and their size, the links it
 * wrote to the other cloned records, and every file it left out with why — a
 * file over the size set is listed, never cut short.
 */
export const ForgeFilesResult: React.FC<ForgeFilesResultProps> = ({ files }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const cap = formatFileSize(files.maxFileBytes);
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-results-files"
      className="rounded border border-subtle px-4 py-2 text-xs text-text-secondary"
    >
      <h3 id={headingId} className="font-medium text-text-primary">
        {t('forge.files.title')}
      </h3>
      <ul className="mt-1 space-y-0.5">
        {files.objects.map((entry) => (
          <li key={entry.objectApiName} data-testid={`forge-results-files-${entry.objectApiName}`}>
            <span className="text-text-primary">{t(OBJECT_LABEL_KEYS[entry.objectApiName])}</span>
            {' — '}
            {t('forge.files.result.copied', {
              count: entry.copied,
              planned: entry.planned,
              size: formatFileSize(entry.plannedBytes),
            })}
            {entry.failed > 0 && (
              <span className="text-status-error">
                {' — '}
                {t('forge.files.result.failed', { count: entry.failed })}
              </span>
            )}
          </li>
        ))}
        {files.objects.length === 0 && <li>{t('forge.files.result.none')}</li>}
      </ul>
      {files.links > 0 && (
        <p className="mt-0.5">{t('forge.files.result.links', { count: files.links })}</p>
      )}
      {files.leftOut.length > 0 && (
        <>
          <p className="mt-1 font-medium text-text-primary">
            {t('forge.files.result.leftOut', { count: files.leftOut.length })}
          </p>
          <ul className="mt-0.5 space-y-0.5" data-testid="forge-results-files-left-out">
            {files.leftOut.map((file) => (
              <li key={`${file.objectApiName}-${file.sourceId}`}>
                <span className="text-text-primary break-all">{file.name}</span>
                {` (${formatFileSize(file.bytes)}) — `}
                {t(REASON_KEYS[file.reason], { max: cap })}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};
