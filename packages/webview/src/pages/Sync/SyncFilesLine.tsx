import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncFilesOutcome, SyncFilesStorage } from '@sandforge/shared';
import { formatFileSize } from '../../utils/formatters';

/** Props for {@link SyncFilesLine}. */
export interface SyncFilesLineProps {
  /** What became of the files of one object's records. */
  files: SyncFilesOutcome;
  /** A simulation's line: what a run would copy. */
  simulated?: boolean;
  /** Test id of the line. */
  testId?: string;
}

/**
 * What became of the files of one object's records, as the results step, the
 * history detail and a simulation say it: "2 files copied · 1 new version ·
 * 52 B · 1 unchanged · 1 past the run's cap". What was skipped or failed is
 * always said, never left out of the line.
 */
export const SyncFilesLine: React.FC<SyncFilesLineProps> = ({ files, simulated, testId }) => {
  const { t } = useTranslation();
  const parts = [
    simulated
      ? t('sync.files.wouldCopy', { count: files.copied })
      : t('sync.files.copied', { count: files.copied }),
  ];
  if (files.versions > 0) {
    parts.push(
      simulated
        ? t('sync.files.wouldVersion', { count: files.versions })
        : t('sync.files.versions', { count: files.versions }),
    );
  }
  parts.push(formatFileSize(files.bytes));
  if (files.unchanged > 0) parts.push(t('sync.files.unchanged', { count: files.unchanged }));

  const skipped: string[] = [];
  if (files.tooLarge > 0) skipped.push(t('sync.files.tooLarge', { count: files.tooLarge }));
  if (files.pastRunCap > 0) skipped.push(t('sync.files.pastRunCap', { count: files.pastRunCap }));
  if (files.external > 0) skipped.push(t('sync.files.external', { count: files.external }));
  if (files.recordNotWritten > 0) {
    skipped.push(t('sync.files.recordNotWritten', { count: files.recordNotWritten }));
  }

  return (
    <div className="flex flex-col gap-0.5 text-[10px]" data-testid={testId}>
      <p className="text-text-primary">{parts.join(' · ')}</p>
      {skipped.length > 0 && <p className="text-status-warning">{skipped.join(' · ')}</p>}
      {files.failed > 0 && (
        <p className="text-status-error">{t('sync.files.failed', { count: files.failed })}</p>
      )}
    </div>
  );
};

/** Props for {@link SyncFilesSummary}. */
export interface SyncFilesSummaryProps {
  /** What became of the files of each object of the run. */
  outcomes: readonly SyncFilesOutcome[];
  /** Test id of the line. */
  testId?: string;
}

/** The files of a whole run, as one line: "3 files, 1.2 MB copied, 1 skipped past the caps". */
export const SyncFilesSummary: React.FC<SyncFilesSummaryProps> = ({ outcomes, testId }) => {
  const { t } = useTranslation();
  let count = 0;
  let bytes = 0;
  let skipped = 0;
  for (const files of outcomes) {
    count += files.copied + files.versions;
    bytes += files.bytes;
    skipped += files.tooLarge + files.pastRunCap;
  }
  return (
    <p className="text-xs text-text-primary" data-testid={testId}>
      {t('sync.files.summary', { count, size: formatFileSize(bytes), skipped })}
    </p>
  );
};

/** Props for {@link SyncFilesStorageLine}. */
export interface SyncFilesStorageLineProps {
  /** The target's file storage, and what the files take of it. */
  storage: SyncFilesStorage;
  /** Test id of the line. */
  testId?: string;
}

/**
 * What a simulation's files take of the target's file storage, and, when
 * they do not fit, that a run would be refused.
 */
export const SyncFilesStorageLine: React.FC<SyncFilesStorageLineProps> = ({ storage, testId }) => {
  const { t } = useTranslation();
  const values = {
    size: formatFileSize(storage.plannedBytes),
    left: formatFileSize(Math.max(0, storage.remainingBytes)),
  };
  return storage.shortfall ? (
    <p className="text-xs text-status-error" role="alert" data-testid={testId}>
      {t('sync.files.wouldNotFit', values)}
    </p>
  ) : (
    <p className="text-xs text-text-secondary" data-testid={testId}>
      {t('sync.files.storage', values)}
    </p>
  );
};
