import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isSubjectEmail,
  isSubjectName,
  isSubjectPhone,
  SUBJECT_PHONE_MATCH_DIGITS,
  SUBJECT_PHONE_MIN_DIGITS,
  SUBJECT_SEARCH_LIMIT,
} from '@sandforge/shared';
import type {
  RemovalOutcome,
  RemovalPlanObject,
  SubjectEraseMode,
  SubjectSearchObject,
  SubjectSearchResult,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useLatestRef } from '../../hooks/useLatestRef';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { Input } from '../../components/ui/Input';
import { formatNumber } from '../../utils/formatters';
import { RemovalOutcomeView, RemovalPlanView, plannedRecords } from './RemovalPlanView';

/**
 * How long an export or an erasure may wait on the host: the Save dialog and
 * Production Guard's confirmation both wait on a person.
 */
const WAIT_ON_A_PERSON_MS = 600_000;

/** Props for {@link SubjectRequestSection}. */
export interface SubjectRequestSectionProps {
  orgId: string;
  /** The objects a search looks in: those the inventory read that hold something to look for. */
  objects: string[];
  /** Told when the request log has something new. */
  onLogged: () => void;
}

/** What `dataops:dsr:export` answers. */
interface ExportAnswer {
  requestId: string;
  records: number;
  saved:
    | { status: 'saved'; path: string }
    | { status: 'cancelled' }
    | { status: 'error'; message: string };
}

/** What `dataops:dsr:erase` answers. */
interface EraseAnswer {
  requestId: string;
  mode: SubjectEraseMode;
  dryRun: boolean;
  plan: RemovalPlanObject[];
  outcome?: RemovalOutcome;
}

/** A record's key in the selection: its object and its Id. */
function recordKey(objectApiName: string, id: string): string {
  return `${objectApiName}:${id}`;
}

/**
 * The records to erase, per object, from the selection: what an erasure
 * request names. Objects with nothing selected are left out.
 */
export function selectedRecords(
  objects: readonly SubjectSearchObject[],
  selection: ReadonlySet<string>,
): Array<{ objectApiName: string; ids: string[] }> {
  return objects.flatMap((object) => {
    if (object.status !== 'searched') return [];
    const ids = object.records
      .map((r) => r.id)
      .filter((id) => selection.has(recordKey(object.objectApiName, id)));
    return ids.length > 0 ? [{ objectApiName: object.objectApiName, ids }] : [];
  });
}

/**
 * A data subject request: find one person's records by their email address,
 * name or phone number, export them to a file, and erase them — overwritten
 * with the DataOps anonymizer, or deleted — after a review of what the
 * erasure will do and a typed confirmation.
 *
 * What is typed here stays on this page: the extension searches with it and
 * keeps none of it. The request log keeps counts only.
 */
export const SubjectRequestSection: React.FC<SubjectRequestSectionProps> = ({
  orgId,
  objects,
  onLogged,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const modeName = useId();
  const emailId = useId();
  const nameId = useId();
  const phoneId = useId();
  const number = (n: number): string => formatNumber(n);

  const search = useBridgeMutation<SubjectSearchResult>('dataops:dsr:search', {
    responseType: 'dataops:dsr:search:response',
    errorType: 'dataops:error',
    // A count and a read per object, one object after the other.
    timeoutMs: 300_000,
  });
  const exportRecords = useBridgeMutation<ExportAnswer>('dataops:dsr:export', {
    responseType: 'dataops:dsr:export:response',
    errorType: 'dataops:error',
    timeoutMs: WAIT_ON_A_PERSON_MS,
  });
  const review = useBridgeMutation<EraseAnswer>('dataops:dsr:erase', {
    responseType: 'dataops:dsr:erase:response',
    errorType: 'dataops:error',
    timeoutMs: 300_000,
  });
  const erase = useBridgeMutation<EraseAnswer>('dataops:dsr:erase', {
    responseType: 'dataops:dsr:erase:response',
    errorType: 'dataops:error',
    timeoutMs: WAIT_ON_A_PERSON_MS,
  });

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<SubjectEraseMode>('anonymize');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const result = search.data;
  const found = useMemo(() => result?.objects ?? [], [result]);

  // Each answer is taken up once: the effects below run on the answer alone.
  const startRequest = useLatestRef((answer: SubjectSearchResult) => {
    // A new search answers for a new selection: every record it found.
    const all = new Set<string>();
    for (const object of answer.objects) {
      if (object.status !== 'searched') continue;
      for (const record of object.records) all.add(recordKey(object.objectApiName, record.id));
    }
    setSelection(all);
    review.reset();
    erase.reset();
    exportRecords.reset();
    onLogged();
  });
  useEffect(() => {
    if (result) startRequest.current(result);
  }, [result, startRequest]);

  const logged = useLatestRef(onLogged);
  const exported = exportRecords.data;
  useEffect(() => {
    if (exported?.saved.status === 'saved') logged.current();
  }, [exported, logged]);
  const erased = erase.data;
  useEffect(() => {
    if (erased) logged.current();
  }, [erased, logged]);

  const trimmed = { email: email.trim(), name: name.trim(), phone: phone.trim() };
  const invalid = {
    email: trimmed.email !== '' && !isSubjectEmail(trimmed.email),
    name: trimmed.name !== '' && !isSubjectName(trimmed.name),
    phone: trimmed.phone !== '' && !isSubjectPhone(trimmed.phone),
  };
  const anyGiven = trimmed.email !== '' || trimmed.name !== '' || trimmed.phone !== '';
  const canSearch =
    objects.length > 0 && anyGiven && !invalid.email && !invalid.name && !invalid.phone;

  const runSearch = (): void => {
    if (!canSearch) return;
    search.mutate({
      orgId,
      objects,
      ...(trimmed.email ? { email: trimmed.email } : {}),
      ...(trimmed.name ? { name: trimmed.name } : {}),
      ...(trimmed.phone ? { phone: trimmed.phone } : {}),
      // A second search of the same person adds to the request it belongs to.
      ...(result ? { requestId: result.requestId } : {}),
    });
  };

  const newRequest = (): void => {
    search.reset();
    review.reset();
    erase.reset();
    exportRecords.reset();
    setSelection(new Set());
    setEmail('');
    setName('');
    setPhone('');
  };

  const targets = selectedRecords(found, selection);
  const selectedCount = targets.reduce((sum, target) => sum + target.ids.length, 0);
  const foundCount = found.reduce(
    (sum, object) => sum + (object.status === 'searched' ? object.records.length : 0),
    0,
  );
  const plan = review.data?.dryRun ? review.data.plan : null;
  const toErase = plan ? plannedRecords(plan) : 0;

  const toggle = (key: string): void => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // A plan answers for the records it was asked about.
    review.reset();
  };

  const changeMode = (next: SubjectEraseMode): void => {
    setMode(next);
    review.reset();
  };

  const requestReview = (): void => {
    if (!result || targets.length === 0) return;
    erase.reset();
    review.mutate({ orgId, requestId: result.requestId, mode, records: targets, dryRun: true });
  };

  const confirmErase = (): void => {
    setConfirmOpen(false);
    if (!result || targets.length === 0) return;
    erase.mutate({ orgId, requestId: result.requestId, mode, records: targets, dryRun: false });
    review.reset();
  };

  const exportStatus = exportRecords.data?.saved;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-(--sf-border) p-3"
      data-testid="dsr-section"
    >
      <h2 id={headingId} className="text-sm font-semibold text-text-primary">
        {t('dataops.dsr.title')}
      </h2>
      <p className="text-xs text-text-secondary">{t('dataops.dsr.intro')}</p>

      {objects.length === 0 ? (
        <p className="text-xs text-text-secondary" data-testid="dsr-needs-inventory">
          {t('dataops.dsr.needsInventory')}
        </p>
      ) : (
        <p className="text-xs text-text-secondary" data-testid="dsr-objects">
          {t('dataops.dsr.searchesIn', { objects: objects.join(', ') })}
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Input
          id={emailId}
          type="email"
          label={t('dataops.dsr.email')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          error={invalid.email ? t('dataops.dsr.emailInvalid') : undefined}
          data-testid="dsr-email"
        />
        <Input
          id={nameId}
          label={t('dataops.dsr.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          error={invalid.name ? t('dataops.dsr.nameInvalid') : undefined}
          data-testid="dsr-name"
        />
        <Input
          id={phoneId}
          type="tel"
          label={t('dataops.dsr.phone')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="off"
          error={
            invalid.phone
              ? t('dataops.dsr.phoneInvalid', { min: SUBJECT_PHONE_MIN_DIGITS })
              : undefined
          }
          data-testid="dsr-phone"
        />
      </div>
      <p className="text-xs text-text-secondary">
        {t('dataops.dsr.howItSearches', {
          digits: SUBJECT_PHONE_MATCH_DIGITS,
          limit: number(SUBJECT_SEARCH_LIMIT),
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={runSearch}
          loading={search.loading}
          disabled={!canSearch}
          data-testid="dsr-search-btn"
        >
          {t('dataops.dsr.search')}
        </Button>
        {result && (
          <Button
            variant="secondary"
            size="sm"
            onClick={newRequest}
            data-testid="dsr-new-request-btn"
          >
            {t('dataops.dsr.newRequest')}
          </Button>
        )}
      </div>

      {search.error && <ErrorBanner message={search.error} data-testid="dsr-search-error" />}

      {result && (
        <div className="flex flex-col gap-3" data-testid="dsr-results">
          <p className="text-xs text-text-primary" data-testid="dsr-request">
            {t('dataops.dsr.request', { id: result.requestId.slice(0, 8) })}{' '}
            {t('dataops.dsr.found', { count: foundCount, formatted: number(foundCount) })}
          </p>
          {found.map((object) => (
            <SubjectObject
              key={object.objectApiName}
              object={object}
              limit={result.limit}
              selection={selection}
              onToggle={toggle}
            />
          ))}

          {foundCount > 0 && (
            <>
              <div className="flex flex-col gap-1">
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => exportRecords.mutate({ orgId, requestId: result.requestId })}
                    loading={exportRecords.loading}
                    data-testid="dsr-export-btn"
                  >
                    {t('dataops.dsr.export', { count: foundCount, formatted: number(foundCount) })}
                  </Button>
                </div>
                <p className="text-xs text-text-secondary">{t('dataops.dsr.exportHint')}</p>
                <p aria-live="polite" className="text-xs" data-testid="dsr-export-status">
                  {exportStatus?.status === 'saved' &&
                    t('dataops.dsr.exported', {
                      count: exportRecords.data?.records ?? 0,
                      formatted: number(exportRecords.data?.records ?? 0),
                      path: exportStatus.path,
                    })}
                  {exportStatus?.status === 'cancelled' && t('dataops.dsr.exportCancelled')}
                  {exportStatus?.status === 'error' && exportStatus.message}
                </p>
                {exportRecords.error && (
                  <ErrorBanner message={exportRecords.error} data-testid="dsr-export-error" />
                )}
              </div>

              <fieldset className="flex flex-col gap-2" data-testid="dsr-erase">
                <legend className="mb-1 text-xs font-medium text-text-primary">
                  {t('dataops.dsr.eraseLegend')}
                </legend>
                {(['anonymize', 'delete'] as const).map((option) => (
                  <label key={option} className="flex items-start gap-2 text-xs text-text-primary">
                    <input
                      type="radio"
                      name={modeName}
                      value={option}
                      checked={mode === option}
                      onChange={() => changeMode(option)}
                      className="mt-0.5"
                      data-testid={`dsr-mode-${option}`}
                    />
                    <span>
                      {t(
                        option === 'anonymize'
                          ? 'dataops.dsr.modeAnonymize'
                          : 'dataops.dsr.modeDelete',
                      )}
                    </span>
                  </label>
                ))}
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={requestReview}
                    loading={review.loading}
                    disabled={selectedCount === 0}
                    data-testid="dsr-review-btn"
                  >
                    {t('dataops.dsr.review', {
                      count: selectedCount,
                      formatted: number(selectedCount),
                    })}
                  </Button>
                </div>
              </fieldset>
            </>
          )}

          {review.error && <ErrorBanner message={review.error} data-testid="dsr-review-error" />}

          {plan && (
            <div className="flex flex-col gap-2" data-testid="dsr-plan">
              <p className="text-xs font-medium text-text-primary">
                {t(mode === 'delete' ? 'dataops.dsr.planDelete' : 'dataops.dsr.planAnonymize')}
              </p>
              <RemovalPlanView mode={mode} plan={plan} />
              <div>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setConfirmOpen(true)}
                  disabled={toErase === 0}
                  loading={erase.loading}
                  data-testid="dsr-erase-btn"
                >
                  {t('dataops.dsr.erase', { count: toErase, formatted: number(toErase) })}
                </Button>
              </div>
            </div>
          )}

          {erase.error && <ErrorBanner message={erase.error} data-testid="dsr-erase-error" />}
          {erase.data?.outcome && (
            <RemovalOutcomeView mode={erase.data.mode} outcome={erase.data.outcome} />
          )}

          <DangerConfirm
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            onConfirm={confirmErase}
            title={t('dataops.dsr.confirmTitle', { count: toErase, formatted: number(toErase) })}
            description={t(
              mode === 'delete' ? 'dataops.dsr.confirmDelete' : 'dataops.dsr.confirmAnonymize',
            )}
            confirmText={t('dataops.dsr.confirmWord')}
          />
        </div>
      )}
    </section>
  );
};

/** Props for {@link SubjectObject}. */
interface SubjectObjectProps {
  object: SubjectSearchObject;
  limit: number;
  selection: ReadonlySet<string>;
  onToggle: (key: string) => void;
}

/** One object of a subject search: the records found, each to keep or leave out. */
const SubjectObject: React.FC<SubjectObjectProps> = ({ object, limit, selection, onToggle }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const number = (n: number): string => formatNumber(n);

  if (object.status === 'failed') {
    return (
      <p className="text-xs text-status-error" data-testid={`dsr-object-${object.objectApiName}`}>
        {t('dataops.dsr.objectFailed', { object: object.objectApiName, message: object.message })}
      </p>
    );
  }
  if (object.status === 'skipped') {
    return (
      <p className="text-xs text-text-secondary" data-testid={`dsr-object-${object.objectApiName}`}>
        {t('dataops.dsr.objectSkipped', { object: object.label })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid={`dsr-object-${object.objectApiName}`}>
      <h3 id={headingId} className="text-xs font-semibold text-text-primary">
        {object.label}{' '}
        <span className="font-normal text-text-secondary">
          {t('dataops.dsr.objectFound', {
            count: object.records.length,
            formatted: number(object.records.length),
          })}
        </span>
      </h3>
      <p className="text-xs text-text-secondary">
        {t('dataops.dsr.lookedIn', { fields: object.searched.map((s) => s.label).join(', ') })}
      </p>
      {object.records.length > 0 && (
        <table className="w-full text-xs" aria-labelledby={headingId}>
          <thead>
            <tr className="border-b border-(--sf-border)">
              <th scope="col" className="py-1 pr-3 text-left font-medium text-text-secondary">
                {t('dataops.dsr.selectColumn')}
              </th>
              <th scope="col" className="py-1 pr-3 text-left font-medium text-text-secondary">
                {t('dataops.dsr.recordName')}
              </th>
              <th scope="col" className="py-1 pr-3 text-left font-medium text-text-secondary">
                {t('dataops.dsr.recordId')}
              </th>
              <th scope="col" className="py-1 pr-3 text-left font-medium text-text-secondary">
                {t('dataops.dsr.matchedOn')}
              </th>
            </tr>
          </thead>
          <tbody>
            {object.records.map((record) => {
              const key = recordKey(object.objectApiName, record.id);
              return (
                <tr key={record.id} className="border-b border-(--sf-border) last:border-0">
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      checked={selection.has(key)}
                      onChange={() => onToggle(key)}
                      // Two records of one person often share a name: the Id
                      // tells their boxes apart.
                      aria-label={t('dataops.dsr.keepRecord', {
                        record: record.name ? `${record.name} (${record.id})` : record.id,
                      })}
                      data-testid={`dsr-select-${record.id}`}
                    />
                  </td>
                  <th scope="row" className="py-1 pr-3 text-left font-normal text-text-primary">
                    {record.name ?? '—'}
                  </th>
                  <td className="py-1 pr-3 font-mono text-text-primary">{record.id}</td>
                  <td className="py-1 pr-3 text-text-primary">{record.matchedBy.join(', ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {object.truncated && (
        <p className="text-xs text-status-warning" data-testid="dsr-object-truncated">
          {t('dataops.dsr.truncated', {
            counted: number(object.counted),
            limit: number(limit),
          })}
        </p>
      )}
    </div>
  );
};
