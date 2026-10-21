import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { MailWarning, Workflow } from 'lucide-react';
import type {
  SeedAutomationEntry,
  SeedAutomationPreview,
  SeedEmailEstimate,
} from '@sandforge/shared';
import { seedEmailEstimates } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { formatNumber, uiLocale } from '../../utils/formatters';
import { listWords } from '../../utils/listWords';
import type { SeedAutomationState } from './useSeedAutomation';

/** What runs, by kind. */
const KIND_KEYS: Readonly<Record<SeedAutomationEntry['kind'], string>> = {
  flow: 'seed.automation.kind.flow',
  trigger: 'seed.automation.kind.trigger',
  process: 'seed.automation.kind.process',
  workflowRule: 'seed.automation.kind.workflowRule',
};

/** How each daily email limit is named. */
const LIMIT_KEYS: Readonly<Record<SeedEmailEstimate['limit'], string>> = {
  SingleEmail: 'common.emailLimit.single',
  DailyWorkflowEmails: 'common.emailLimit.workflow',
};

/** What else than an email an entry sends. */
const MESSAGE_KEYS: Readonly<Record<SeedAutomationEntry['messages'][number], string>> = {
  notification: 'seed.automation.notifications',
  outbound: 'seed.automation.outbound',
  sms: 'seed.automation.sms',
};

/** Props for {@link SeedAutomationNotice}. */
export interface SeedAutomationNoticeProps {
  /** What the org runs as the records are created, as `useSeedAutomation` read it. */
  automation: SeedAutomationState;
  /** The org, as the panel names it. */
  orgName: string;
  /** The records the seed creates, by object: what the emails are counted from. */
  records: Readonly<Record<string, number>>;
}

/** The ways out of an estimate past what is left: the bypasses that quiet its senders, and which. */
function bypassesQuieting(
  preview: SeedAutomationPreview,
  senders: readonly string[],
): Array<{ permission: string; permissionSet?: string; quiets: string[] }> {
  return preview.bypasses.flatMap((way) => {
    const quiets = preview.objects
      .flatMap((object) => object.entries)
      .filter(
        (entry) =>
          entry.emails > 0 &&
          senders.includes(entry.name) &&
          entry.bypasses.some((b) => b.name === way.permission),
      )
      .map((entry) => entry.name);
    return quiets.length > 0 ? [{ ...way, quiets: [...new Set(quiets)] }] : [];
  });
}

/**
 * What the org runs as a seed creates its records, said on the confirmation
 * before Start, in plain words: per object, the flows, Apex triggers,
 * processes and workflow rules that fire, which send emails or create
 * records, and the custom permissions that keep them quiet; then the emails
 * the records make the org send against what it has left today, counted from
 * the counts as they are set. Past what is left, the seed would be refused,
 * and the ways out are named. A read that fails is said, and holds nothing
 * back.
 *
 * A seed of 75 contacts left a Developer Edition at -60 of its 15 single
 * emails, a workflow rule emailing each contact, and nothing said so before
 * the run.
 */
export const SeedAutomationNotice: React.FC<SeedAutomationNoticeProps> = ({
  automation,
  orgName,
  records,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const locale = uiLocale();
  const list = (items: readonly string[]): string => listWords(items, (key) => t(key));
  const quoted = (name: string): string => t('common.quoted', { name });
  const org = orgName;

  /*
   * Read again stays where it is whatever the notice shows, and says the read
   * is on its way while it is: it gave way to a line saying so, which left
   * the keyboard on nothing as soon as it was pressed, and what was read
   * before went with it. The notice keeps what it read until the new answer.
   */
  const readAgain = (
    <div className="flex flex-col items-start gap-2">
      {automation.loading && (
        <p role="status" className="text-text-secondary" data-testid="seed-automation-reading">
          {t('seed.automation.reading', { org })}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        loading={automation.loading}
        focusableWhenDisabled
        onClick={automation.readAgain}
        data-testid="seed-automation-read-again"
      >
        {t('seed.automation.readAgain')}
      </Button>
    </div>
  );

  let body: React.ReactNode;
  if (automation.loading && !automation.preview) {
    body = null;
  } else if (automation.error) {
    body = (
      <p role="status" data-testid="seed-automation-unread">
        {t('seed.automation.readFailed', { org, error: automation.error })}
      </p>
    );
  } else if (automation.preview) {
    const preview = automation.preview;
    const written = preview.objects.filter((o) => (records[o.objectApiName] ?? 0) > 0);
    const estimates = seedEmailEstimates(preview, records);
    const alerts = preview.emailsPerRecord.some(
      (sending) =>
        sending.limit === 'DailyWorkflowEmails' && (records[sending.objectApiName] ?? 0) > 0,
    );
    const figures = (estimate: SeedEmailEstimate) => ({
      org,
      limit: t(LIMIT_KEYS[estimate.limit]),
      emails: formatNumber(estimate.emails, locale),
      remaining: formatNumber(estimate.remaining ?? 0, locale),
      max: formatNumber(estimate.max ?? 0, locale),
    });

    body = (
      <div className="flex flex-col gap-2">
        {written.length === 0 ? (
          <p data-testid="seed-automation-nothing">
            {t(preview.blinded ? 'seed.automation.nothingFound' : 'seed.automation.nothing', {
              org,
            })}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="seed-automation-objects">
            {written.map((object) => (
              <li
                key={object.objectApiName}
                className="flex flex-col gap-1"
                data-testid={`seed-automation-object-${object.objectApiName}`}
              >
                <span className="font-medium text-text-primary">{object.objectApiName}</span>
                <ul className="flex flex-col gap-1 ps-3">
                  {object.entries.map((entry) => (
                    <li
                      key={`${entry.kind}-${entry.name}`}
                      className="flex flex-wrap items-center gap-1.5"
                      data-testid={`seed-automation-entry-${object.objectApiName}-${entry.name}`}
                    >
                      <span>
                        {t('seed.automation.entry', {
                          kind: t(KIND_KEYS[entry.kind]),
                          name: entry.name,
                        })}
                      </span>
                      {entry.keptQuiet ? (
                        <Badge variant="success">
                          {t('seed.automation.quietForYou', {
                            permission: list(
                              entry.bypasses.filter((b) => b.held === true).map((b) => b.name),
                            ),
                          })}
                        </Badge>
                      ) : (
                        <>
                          {entry.emails > 0 && (
                            <Badge variant="warning">
                              {t('seed.automation.emailsPerRecord', { count: entry.emails })}
                            </Badge>
                          )}
                          {entry.messages.map((kind) => (
                            <Badge key={kind} variant="warning">
                              {t(MESSAGE_KEYS[kind])}
                            </Badge>
                          ))}
                        </>
                      )}
                      {entry.creates.length > 0 && (
                        <Badge variant="info">
                          {t('seed.automation.creates', { objects: list(entry.creates) })}
                        </Badge>
                      )}
                      {entry.afterCommit && !entry.keptQuiet && (
                        <Badge>{t('seed.automation.afterCommit')}</Badge>
                      )}
                      {!entry.keptQuiet && entry.bypasses.length > 0 && (
                        <Badge>
                          {t('seed.automation.notForHolder', {
                            permission: list(entry.bypasses.map((b) => b.name)),
                          })}
                        </Badge>
                      )}
                      {entry.unread && <Badge>{t('seed.automation.notRead')}</Badge>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        {preview.bypassesHeld.length > 0 && (
          <p data-testid="seed-automation-bypass-held">
            {t('seed.automation.bypassHeld', { permissions: list(preview.bypassesHeld) })}
          </p>
        )}
        {written.length > 0 &&
          preview.bypasses.map((way) => (
            <p key={way.permission} data-testid={`seed-automation-bypass-${way.permission}`}>
              {way.permissionSet
                ? t('seed.automation.bypassSet', {
                    permission: way.permission,
                    set: way.permissionSet,
                  })
                : t('seed.automation.bypassNoSet', { permission: way.permission, org })}
            </p>
          ))}
        {preview.alertsAsSingle && alerts && (
          <p data-testid="seed-automation-alerts-as-single">
            {t('seed.automation.alertsAsSingle', { org })}
          </p>
        )}

        {estimates.map((estimate) => {
          if (estimate.verdict === 'exceeds') {
            const senders = [...new Set(estimate.objects.flatMap((o) => o.sentBy))];
            const ways = bypassesQuieting(preview, senders);
            return (
              <div
                key={estimate.limit}
                role="alert"
                className="flex items-start gap-2 rounded-md border border-status-error/50 bg-status-error/10 px-3 py-2"
                data-testid={`seed-automation-refused-${estimate.limit}`}
              >
                <MailWarning
                  size={14}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-status-error"
                />
                <div className="flex flex-col gap-1">
                  <p>{t('seed.automation.refused', figures(estimate))}</p>
                  <p>
                    {t('seed.automation.waysOut', {
                      objects: list(estimate.objects.map((o) => o.objectApiName)),
                      senders: list(senders.map(quoted)),
                    })}
                  </p>
                  {ways.map((way) => (
                    <p key={way.permission}>
                      {way.permissionSet
                        ? t('seed.automation.wayBypass', {
                            set: way.permissionSet,
                            permission: way.permission,
                            senders: list(way.quiets.map(quoted)),
                          })
                        : t('seed.automation.wayBypassNoSet', {
                            permission: way.permission,
                            senders: list(way.quiets.map(quoted)),
                          })}
                    </p>
                  ))}
                </div>
              </div>
            );
          }
          return (
            <p key={estimate.limit} data-testid={`seed-automation-emails-${estimate.limit}`}>
              {estimate.verdict === 'fits'
                ? t('seed.automation.emailsFit', figures(estimate))
                : t('seed.automation.emailsUnread', {
                    ...figures(estimate),
                    reason: preview.limitsUnread ?? '',
                  })}
            </p>
          );
        })}

        {preview.unread.length > 0 && (
          <p data-testid="seed-automation-part-unread">
            {t('seed.automation.partUnread', {
              org,
              reasons: list([...new Set(preview.unread.map((u) => u.reason))]),
            })}
          </p>
        )}
        {preview.conditionsNotRead > 0 && (
          <p data-testid="seed-automation-conditions-not-read">
            {t('seed.automation.conditionsNotRead', { org })}
          </p>
        )}
      </div>
    );
  } else if (!automation.loading) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-xs text-text-primary"
      data-testid="seed-automation"
    >
      <h3 id={headingId} className="flex items-center gap-1.5 text-xs font-semibold">
        <Workflow size={14} aria-hidden="true" className="text-text-secondary" />
        {t('seed.automation.title', { org })}
      </h3>
      {body && <div aria-busy={automation.loading || undefined}>{body}</div>}
      {readAgain}
    </section>
  );
};
