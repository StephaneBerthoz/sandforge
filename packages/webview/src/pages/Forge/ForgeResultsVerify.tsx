import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ShieldCheck } from 'lucide-react';
import { forgeRunCreatedSome } from '@sandforge/shared';
import type {
  ForgeExecutionResult,
  ForgeRunVerification,
  ForgeVerificationLink,
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
  verified: 'forgeRun.verify.verdictVerified',
  partial: 'forgeRun.verify.verdictPartial',
  unstable: 'forgeRun.verify.verdictUnstable',
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
  if (object.error !== undefined)
    return [t('forgeRun.verify.objectUnread', { reason: object.error })];
  const parts = [
    t('forgeRun.verify.present', {
      present: formatNumber(object.present),
      expected: formatNumber(object.expected),
    }),
  ];
  if (object.deleted > 0) parts.push(counted(t, 'forgeRun.verify.deleted', object.deleted));
  if (object.notVisible > 0)
    parts.push(counted(t, 'forgeRun.verify.notVisible', object.notVisible));
  if (object.changed > 0) parts.push(counted(t, 'forgeRun.verify.changed', object.changed));
  // More records of the object than the run wrote, by its user in its window.
  const more = object.moreInTheWindow ?? 0;
  if (more > 0) parts.push(counted(t, 'forgeRun.verify.moreInTheWindow', more));
  // The lookups the target explains: counted apart, never as broken.
  const leftEmpty = object.linksLeftEmptyByFilter ?? 0;
  const byAutomation = object.linksSetByAutomation ?? 0;
  if (object.linksUnchecked !== undefined) {
    parts.push(t('forgeRun.verify.linksUnchecked', { reason: object.linksUnchecked }));
  } else if (object.linksChecked === 0) {
    parts.push(t('forgeRun.verify.noLinks'));
  } else if (object.linksBroken === 0 && leftEmpty + byAutomation === 0) {
    parts.push(counted(t, 'forgeRun.verify.linksHold', object.linksChecked));
  } else if (object.linksBroken === 0) {
    parts.push(
      counted(t, 'forgeRun.verify.linksHoldSome', object.linksChecked - leftEmpty - byAutomation, {
        checked: formatNumber(object.linksChecked),
      }),
    );
  } else {
    parts.push(
      counted(t, 'forgeRun.verify.linksBroken', object.linksBroken, {
        checked: formatNumber(object.linksChecked),
      }),
    );
  }
  if (object.linksUnchecked === undefined) {
    if (leftEmpty > 0) parts.push(counted(t, 'forgeRun.verify.linksLeftEmptyByFilter', leftEmpty));
    if (byAutomation > 0) {
      parts.push(counted(t, 'forgeRun.verify.linksSetByAutomation', byAutomation));
    }
  }
  return parts;
}

/** Whether a lookup of the verification is one the target explains. */
function explainsAny(verification: ForgeRunVerification): boolean {
  return verification.objects.some(
    (object) => (object.linksLeftEmptyByFilter ?? 0) + (object.linksSetByAutomation ?? 0) > 0,
  );
}

/** One lookup that does not point where the run set it, and why when the target says. */
function linkLine(t: TFunction, link: ForgeVerificationLink): string {
  const values = {
    record: link.recordId,
    field: link.field,
    found: link.found ?? '',
    expected: link.expected,
  };
  if (link.cause === 'lookup-filter') return t('forgeRun.verify.linkLeftEmptyByFilter', values);
  if (link.cause === 'automation') return t('forgeRun.verify.linkSetByAutomation', values);
  return t(
    link.found === null ? 'forgeRun.verify.linkEmpty' : 'forgeRun.verify.linkElsewhere',
    values,
  );
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
        {t(
          verification.verdict === 'verified' && explainsAny(verification)
            ? 'forgeRun.verify.verdictVerifiedExplained'
            : VERDICT_KEYS[verification.verdict],
        )}
      </h4>
      <p className="text-text-secondary">
        {counted(t, 'forgeRun.verify.readings', verification.attempts, {
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
            {(object.brokenLinks.length > 0 ||
              (object.explainedLinks ?? []).length > 0 ||
              object.recycleBinUnread !== undefined) && (
              <ul className="ml-3 mt-0.5 list-disc list-inside wrap-break-word">
                {[...object.brokenLinks, ...(object.explainedLinks ?? [])].map((link) => (
                  <li key={`${link.recordId}:${link.field}`}>{linkLine(t, link)}</li>
                ))}
                {object.recycleBinUnread !== undefined && (
                  <li>
                    {t('forgeRun.verify.recycleBinUnread', { reason: object.recycleBinUnread })}
                  </li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {changedCount > 0 && (
        <div data-testid="forge-verification-changed" className="text-text-secondary">
          <p>{counted(t, 'forgeRun.verify.changedTitle', changedCount)}</p>
          <ul className="ml-3 mt-0.5 list-disc list-inside wrap-break-word">
            {changed.map((change) => (
              <li key={change.recordId}>
                {t('forgeRun.verify.changedRecord', {
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
          {t('forgeRun.verify.linksUncheckedRun', { reason: verification.linksUnchecked })}
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
  const created = useMemo(() => forgeRunCreatedSome(run), [run]);
  // A run whose ids were in a journal that is gone has nothing to read back by.
  if (run.dryRun === true || !created || !run.idRemapCreated || run.journalGone) return null;

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
        {verification ? t('forgeRun.verify.again') : t('forgeRun.verify.action')}
      </Button>
      <p id={hintId} className="text-xs text-text-secondary">
        {t('forgeRun.verify.hint')}
      </p>
      {verify.loading && (
        <p
          role="status"
          data-testid="forge-results-verifying"
          className="text-xs text-text-secondary"
        >
          {t('forgeRun.verify.verifying')}
        </p>
      )}
      {verify.error && (
        <ErrorBanner
          message={verify.error}
          code={verify.errorCode}
          module="forge"
          data-testid="forge-results-verify-error"
        />
      )}
      {verification && <ForgeVerificationView verification={verification} />}
    </div>
  );
};
