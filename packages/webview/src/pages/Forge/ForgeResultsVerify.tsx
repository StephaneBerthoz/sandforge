import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ShieldCheck } from 'lucide-react';
import { forgeRunCreatedRecords } from '@sandforge/shared';
import type {
  ForgeExecutionResult,
  ForgeRunVerification,
  ForgeVerificationObject,
  ForgeVerificationVerdict,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { Button } from '../../components/ui/Button';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { cn } from '../../theme';
import { formatNumber, formatStoredDate } from '../../utils/formatters';

/**
 * How long a verification may take: every record is read back, after a pause
 * and again until two readings agree, two hundred ids a query.
 */
const VERIFY_TIMEOUT_MS = 300_000;

/** What `forge:verify:request` answers. */
interface VerifyAnswer {
  verification: ForgeRunVerification;
}

/** What each verdict says, in the words of its heading. */
const VERDICT_KEYS: Record<ForgeVerificationVerdict, string> = {
  verified: 'forge.verify.verdictVerified',
  partial: 'forge.verify.verdictPartial',
  unstable: 'forge.verify.verdictUnstable',
};

/** The colour each verdict is said in. */
const VERDICT_CLASSES: Record<ForgeVerificationVerdict, string> = {
  verified: 'text-status-success',
  partial: 'text-status-warning',
  unstable: 'text-status-warning',
};

/** A count in a sentence: the plural the count picks, the number as the reader writes it. */
function counted(
  t: TFunction,
  key: string,
  count: number,
  extra: Record<string, string> = {},
): string {
  return t(key, { count, formatted: formatNumber(count), ...extra });
}

/** What became of one object's records, in reading order: there, not there, changed, its lookups. */
function objectParts(t: TFunction, object: ForgeVerificationObject): string[] {
  if (object.error !== undefined) return [t('forge.verify.objectUnread', { reason: object.error })];
  const parts = [
    t('forge.verify.present', {
      present: formatNumber(object.present),
      expected: formatNumber(object.expected),
    }),
  ];
  if (object.deleted > 0) parts.push(counted(t, 'forge.verify.deleted', object.deleted));
  if (object.notVisible > 0) parts.push(counted(t, 'forge.verify.notVisible', object.notVisible));
  if (object.changed > 0) parts.push(counted(t, 'forge.verify.changed', object.changed));
  if (object.linksUnchecked !== undefined) {
    parts.push(t('forge.verify.linksUnchecked', { reason: object.linksUnchecked }));
  } else if (object.linksChecked === 0) {
    parts.push(t('forge.verify.noLinks'));
  } else if (object.linksBroken === 0) {
    parts.push(counted(t, 'forge.verify.linksHold', object.linksChecked));
  } else {
    parts.push(
      counted(t, 'forge.verify.linksBroken', object.linksBroken, {
        checked: formatNumber(object.linksChecked),
      }),
    );
  }
  return parts;
}

/** Props for {@link ForgeVerificationView}. */
export interface ForgeVerificationViewProps {
  verification: ForgeRunVerification;
}

/**
 * What a verification of the run found: its verdict, how many readings it
 * took, per object the records there and those not, the lookups that do not
 * hold, and the records changed since the run, which a removal keeps.
 */
export const ForgeVerificationView: React.FC<ForgeVerificationViewProps> = ({ verification }) => {
  const { t } = useTranslation();
  const headingId = useId();
  const changed = verification.objects.flatMap((object) =>
    object.changedRecords.map((change) => ({ objectApiName: object.objectApiName, ...change })),
  );
  const changedCount = verification.objects.reduce((sum, object) => sum + object.changed, 0);
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-verification"
      className="flex flex-col gap-1 text-[11px]"
    >
      <h4
        id={headingId}
        data-testid="forge-verification-verdict"
        className={cn('text-[11px] font-semibold', VERDICT_CLASSES[verification.verdict])}
      >
        {t(VERDICT_KEYS[verification.verdict])}
      </h4>
      <p className="text-text-secondary">
        {counted(t, 'forge.verify.readings', verification.attempts, {
          date:
            formatStoredDate(verification.verifiedAt, 'yyyy-MM-dd HH:mm') ??
            t('common.dateUnknown'),
        })}
      </p>
      <ul className="flex flex-col gap-1">
        {verification.objects.map((object) => (
          <li
            key={object.objectApiName}
            data-testid={`forge-verification-${object.objectApiName}`}
            className="text-text-secondary"
          >
            <span className="font-mono text-text-primary">{object.objectApiName}</span>
            {': '}
            {objectParts(t, object).join(' · ')}
            {(object.brokenLinks.length > 0 || object.recycleBinUnread !== undefined) && (
              <ul className="ml-3 mt-0.5 list-disc list-inside wrap-break-word">
                {object.brokenLinks.map((link) => (
                  <li key={`${link.recordId}:${link.field}`}>
                    {t(
                      link.found === null ? 'forge.verify.linkEmpty' : 'forge.verify.linkElsewhere',
                      {
                        record: link.recordId,
                        field: link.field,
                        found: link.found ?? '',
                        expected: link.expected,
                      },
                    )}
                  </li>
                ))}
                {object.recycleBinUnread !== undefined && (
                  <li>{t('forge.verify.recycleBinUnread', { reason: object.recycleBinUnread })}</li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {changedCount > 0 && (
        <div data-testid="forge-verification-changed" className="text-text-secondary">
          <p>{counted(t, 'forge.verify.changedTitle', changedCount)}</p>
          <ul className="ml-3 mt-0.5 list-disc list-inside wrap-break-word">
            {changed.map((change) => (
              <li key={change.recordId}>
                {t('forge.verify.changedRecord', {
                  object: change.objectApiName,
                  record: change.recordId,
                  date: change.modifiedAt,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {verification.linksUnchecked !== undefined && (
        <p data-testid="forge-verification-links-unchecked" className="text-status-warning">
          {t('forge.verify.linksUncheckedRun', { reason: verification.linksUnchecked })}
        </p>
      )}
    </section>
  );
};

/** Props for {@link ForgeResultsVerify}. */
export interface ForgeResultsVerifyProps {
  /** The run the results show. */
  run: ForgeExecutionResult;
}

/**
 * The verification of what the run on screen created, from its results: the
 * extension reads back from the target every record the run's history entry
 * says it created, once the target has settled, and the verdict is shown in
 * place — and kept on the entry. A simulation wrote nothing, and a run that
 * created nothing, or was kept before runs said what they created, has
 * nothing to verify: no action is offered.
 */
export const ForgeResultsVerify: React.FC<ForgeResultsVerifyProps> = ({ run }) => {
  const { t } = useTranslation();
  const hintId = useId();
  const verify = useBridgeMutation<VerifyAnswer>('forge:verify:request', {
    responseType: 'forge:verify:response',
    errorType: 'forge:verify:error',
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  const created = useMemo(() => forgeRunCreatedRecords(run).length > 0, [run]);
  if (run.dryRun === true || !created || !run.idRemapCreated) return null;

  const verification = verify.data?.verification ?? run.verification;
  return (
    <div data-testid="forge-results-verify" className="flex flex-col gap-1.5">
      <Button
        variant="secondary"
        size="md"
        icon={<ShieldCheck size={14} />}
        loading={verify.loading}
        disabled={verify.loading}
        onClick={() => verify.mutate({ forgeId: run.forgeId })}
        aria-describedby={hintId}
        data-testid="forge-results-verify-run"
        className="self-start"
      >
        {verification ? t('forge.verify.again') : t('forge.verify.action')}
      </Button>
      <p id={hintId} className="text-xs text-text-secondary">
        {t('forge.verify.hint')}
      </p>
      {verify.loading && (
        <p
          role="status"
          data-testid="forge-results-verifying"
          className="text-xs text-text-secondary"
        >
          {t('forge.verify.verifying')}
        </p>
      )}
      {verify.error && (
        <ErrorBanner message={verify.error} data-testid="forge-results-verify-error" />
      )}
      {verification && <ForgeVerificationView verification={verification} />}
    </div>
  );
};
