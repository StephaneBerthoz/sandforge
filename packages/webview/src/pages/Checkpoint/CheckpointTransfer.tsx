import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type {
  CheckpointExportResponse,
  CheckpointImportReadResponse,
  CheckpointImportResponse,
  SalesforceOrg,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { WRITE_RUN_TIMEOUT_MS } from '../../hooks/writeRunTimeout';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { formatDate, formatFileSize, formatNumber, formatStoredDate } from '../../utils/formatters';
import { CHECKPOINT_KEEP_DAYS } from './checkpointFacts';

/** A checkpoint saved to a file: what `checkpoint:export` answered, with the key it shows once. */
type CheckpointExported = Extract<CheckpointExportResponse['payload'], { status: 'saved' }>;

/** A checkpoint file read: what `checkpoint:import-read` answered, before any key. */
type CheckpointFileRead = Extract<CheckpointImportReadResponse['payload'], { status: 'read' }>;

/** Props for {@link ExportCheckpoint}. */
export interface ExportCheckpointProps {
  /** The file written, and the key it is encrypted under. */
  exported: CheckpointExported;
  /** What the checkpoint is called. */
  name: string;
  /** The org it is of, as the page names it. */
  orgName: string;
  /** Done: the key goes with the dialog, and nothing keeps it. */
  onClose: () => void;
}

/** How long "Key copied" is said after Copy before the button says Copy again. */
const COPIED_FOR_MS = 2000;

/**
 * A checkpoint exported, and the key its file is encrypted under, shown this
 * once: in the groups the extension draws it in, with Copy, and what the
 * person must know before sending either. Nothing keeps the key once Done
 * closes the dialog: a lost key is a file nobody can read, and a new export
 * draws another.
 */
export const ExportCheckpoint: React.FC<ExportCheckpointProps> = ({
  exported,
  name,
  orgName,
  onClose,
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
  const copy = (): void => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(exported.key).then(
      () => {
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
      },
      () => {
        // Refused by the host: no copy is claimed that never happened.
      },
    );
  };
  const records = t('checkpoint.list.records', {
    count: exported.records,
    formatted: formatNumber(exported.records),
  });
  const objects = t('checkpoint.take.objects', {
    count: exported.objects,
    formatted: formatNumber(exported.objects),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('checkpoint.transfer.exported.title', { name })}
      description={t('checkpoint.transfer.exported.saved', {
        file: exported.fileName,
        records,
        objects,
        size: formatFileSize(exported.bytes),
      })}
      footer={
        <Button variant="primary" onClick={onClose} data-testid="checkpoint-export-done">
          {t('checkpoint.transfer.exported.done')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 text-xs text-text-primary">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t('checkpoint.transfer.exported.key')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="rounded-sm border border-subtle bg-surface-1 px-2 py-1 font-mono text-sm break-all select-all"
              data-testid="checkpoint-export-key"
            >
              {exported.key}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={copy}
              data-testid="checkpoint-export-copy"
            >
              {copied
                ? t('checkpoint.transfer.exported.copied')
                : t('checkpoint.transfer.exported.copy')}
            </Button>
          </div>
          <span aria-live="polite" className="sr-only">
            {copied ? t('checkpoint.transfer.exported.copied') : ''}
          </span>
        </div>
        <p className="flex items-start gap-2" data-testid="checkpoint-export-warning">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <span>
            {t('checkpoint.transfer.exported.whoReads', {
              count: exported.records,
              formatted: formatNumber(exported.records),
              org: orgName,
            })}
          </span>
        </p>
        <p data-testid="checkpoint-export-no-expiry">
          {t('checkpoint.transfer.exported.noExpiry')}
        </p>
      </div>
    </Dialog>
  );
};

/** Props for {@link ImportCheckpoint}. */
export interface ImportCheckpointProps {
  /** The file read, its header's facts, and the orgs it can be imported for. */
  read: CheckpointFileRead;
  /** The orgs registered here, which the file's org is named among. */
  orgs: readonly SalesforceOrg[];
  /** The org the page shows: the one the import is for, when the file is of it. */
  currentOrgId: string;
  /** Kept on this machine: the list is read again. */
  onImported: () => void;
  /** Closed: what was typed goes with the dialog. */
  onClose: () => void;
}

/**
 * What the person must know before importing, each its own line: a field the
 * importer's user cannot see is not compared by a rewind from this machine,
 * two machines rewinding the org at once fight each other, and the Undo of
 * the rewinds made elsewhere stayed there.
 */
const IMPORT_WARNING_KEYS = [
  'checkpoint.transfer.importDialog.notCompared',
  'checkpoint.transfer.importDialog.lock',
  'checkpoint.transfer.importDialog.undoStays',
] as const;

/** How the person knows an org: its alias, else its username. */
function orgNameOf(org: Pick<SalesforceOrg, 'alias' | 'username'>): string {
  return org.alias || org.username;
}

/**
 * A `.sfcheckpoint` file another machine exported, as its header says it,
 * before anything is decrypted: the org it is of, the records it holds, when
 * it was taken, which SandForge made it and in which format. The extension
 * has already asked the org whether the file may be imported for it — the
 * file's own org, no production org, a user who sees all data — and the
 * dialog offers the orgs that said yes; none, when the file's org is not
 * connected here. The key is typed hidden, kept by the dialog alone while it
 * is open, and sent once, with the import; every check is made again then,
 * in the engine's order, and a refusal says why with nothing kept.
 */
export const ImportCheckpoint: React.FC<ImportCheckpointProps> = ({
  read,
  orgs,
  currentOrgId,
  onImported,
  onClose,
}) => {
  const { t } = useTranslation();
  const keyId = useId();
  const importable = read.orgIds
    .map((orgId) => orgs.find((org) => org.id === orgId))
    .filter((org): org is SalesforceOrg => org !== undefined);
  const [orgId, setOrgId] = useState(
    () => importable.find((org) => org.id === currentOrgId)?.id ?? importable[0]?.id ?? '',
  );
  const [key, setKey] = useState('');
  const [keepForever, setKeepForever] = useState(false);
  // An import decrypts the whole file and indexes it again: as long as a
  // large checkpoint takes, which is no request's thirty seconds.
  const importing = useBridgeMutation<CheckpointImportResponse['payload']>('checkpoint:import', {
    timeoutMs: WRITE_RUN_TIMEOUT_MS,
  });
  const done = importing.data;
  const announceImported = useLatestRef(onImported);
  useEffect(() => {
    if (done) announceImported.current();
  }, [done, announceImported]);

  const org = importable.find((candidate) => candidate.id === orgId);
  const orgName = org ? orgNameOf(org) : read.summary.organizationId;
  const { summary } = read;
  const records = t('checkpoint.list.records', {
    count: summary.records,
    formatted: formatNumber(summary.records),
  });
  const objects = t('checkpoint.take.objects', {
    count: summary.objects,
    formatted: formatNumber(summary.objects),
  });
  const facts: Array<[string, string, string]> = [
    ['org', t('checkpoint.transfer.importDialog.org'), orgName],
    [
      'records',
      t('checkpoint.transfer.importDialog.records'),
      t('checkpoint.transfer.importDialog.recordsValue', { records, objects }),
    ],
    [
      'taken',
      t('checkpoint.transfer.importDialog.taken'),
      formatStoredDate(summary.takenAt, (d) => formatDate(d)) ?? t('common.dateUnknown'),
    ],
    [
      'made-by',
      t('checkpoint.transfer.importDialog.madeBy'),
      t('checkpoint.transfer.importDialog.madeByValue', { version: summary.sandforgeVersion }),
    ],
    [
      'format',
      t('checkpoint.transfer.importDialog.format'),
      t('checkpoint.transfer.importDialog.formatValue', {
        fileFormat: summary.formatVersion,
        dataFormat: summary.checkpointFormat,
      }),
    ],
    ['size', t('checkpoint.transfer.importDialog.size'), formatFileSize(summary.bytes)],
  ];
  const until = formatDate(new Date(Date.now() + CHECKPOINT_KEEP_DAYS * 86_400_000));
  const send = (): void => {
    if (!org || key.trim() === '') return;
    importing.mutate({
      token: read.token,
      orgId: org.id,
      key: key.trim(),
      keepDays: keepForever ? 0 : CHECKPOINT_KEEP_DAYS,
    });
  };

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (done) {
    const kept = done.checkpoint.expiresAt;
    const keptOn = kept !== null ? formatStoredDate(kept, (d) => formatDate(d)) : null;
    body = (
      <p
        role="status"
        className="text-xs text-text-primary"
        data-testid="checkpoint-import-outcome"
      >
        {done.outcome === 'alreadyKept'
          ? t('checkpoint.transfer.importDialog.alreadyKept', { name: done.checkpoint.name })
          : kept === null
            ? t('checkpoint.transfer.importDialog.importedForever', {
                name: done.checkpoint.name,
                org: orgName,
              })
            : t('checkpoint.transfer.importDialog.importedUntil', {
                name: done.checkpoint.name,
                org: orgName,
                date: keptOn ?? t('common.dateUnknown'),
              })}
      </p>
    );
    footer = (
      <Button variant="primary" onClick={onClose} data-testid="checkpoint-import-done">
        {t('checkpoint.transfer.importDialog.done')}
      </Button>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3 text-xs text-text-primary">
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1"
          data-testid="checkpoint-import-facts"
        >
          {facts.map(([id, label, value]) => (
            <React.Fragment key={id}>
              <dt className="text-text-secondary">{label}</dt>
              <dd className="break-words" data-testid={`checkpoint-import-fact-${id}`}>
                {value}
              </dd>
            </React.Fragment>
          ))}
        </dl>
        {read.keptHere && (
          <p data-testid="checkpoint-import-kept-here">
            {t('checkpoint.transfer.importDialog.keptHere')}
          </p>
        )}
        {importable.length === 0 ? (
          <p data-testid="checkpoint-import-not-connected">
            {t('checkpoint.transfer.importDialog.notConnected', {
              id: summary.organizationId,
            })}
          </p>
        ) : (
          <>
            {importable.length > 1 && (
              <Select
                label={t('checkpoint.transfer.importDialog.importFor')}
                value={orgId}
                onChange={(event) => setOrgId(event.target.value)}
                options={importable.map((candidate) => ({
                  value: candidate.id,
                  label: orgNameOf(candidate),
                }))}
                data-testid="checkpoint-import-org"
              />
            )}
            <Input
              id={keyId}
              type="password"
              label={t('checkpoint.transfer.importDialog.key')}
              hint={t('checkpoint.transfer.importDialog.keyHint')}
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') send();
              }}
              data-testid="checkpoint-import-key"
            />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={keepForever}
                onChange={(event) => setKeepForever(event.target.checked)}
                data-testid="checkpoint-import-keep"
              />
              <span>{t('checkpoint.keep')}</span>
            </label>
            {!keepForever && (
              <p className="text-text-secondary">
                {t('checkpoint.transfer.importDialog.keptFor', { date: until })}
              </p>
            )}
            <ul className="flex flex-col gap-1" data-testid="checkpoint-import-warnings">
              {IMPORT_WARNING_KEYS.map((warning) => (
                <li key={warning} className="flex items-start gap-2">
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
                    aria-hidden="true"
                  />
                  <span>{t(warning, { org: orgName })}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {importing.error && (
          <ErrorBanner
            message={importing.error}
            code={importing.errorCode}
            data-testid="checkpoint-import-error"
          />
        )}
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={onClose} data-testid="checkpoint-import-cancel">
          {importable.length === 0 ? t('common.close') : t('common.cancel')}
        </Button>
        {importable.length > 0 && (
          <Button
            variant="primary"
            onClick={send}
            loading={importing.loading}
            disabled={importing.loading || key.trim() === ''}
            data-testid="checkpoint-import-confirm"
          >
            {t('checkpoint.transfer.importDialog.confirm')}
          </Button>
        )}
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('checkpoint.transfer.importDialog.title')}
      description={t('checkpoint.transfer.importDialog.read', { file: read.fileName })}
      footer={footer}
    >
      {body}
    </Dialog>
  );
};
