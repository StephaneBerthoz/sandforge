import React from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { EnvAuditResult } from '@sandforge/shared';
import { formatNumber } from '../../utils/formatters';
import { instantWords, setupPageOfEndpoint, setupUrlOf, type SetupPage } from './recoveryFacts';

/** The audit a step reads: the deliverability, the scheduled jobs, the endpoints. */
export type AuditStep = 'deliverability' | 'scheduledJobs' | 'endpoints';

/** Where the org's Setup is reached. */
export interface SetupHost {
  myDomainHost?: string;
  instanceUrl?: string;
}

/** Props of {@link RecoveryAudit}. */
export interface RecoveryAuditProps {
  step: AuditStep;
  audit: EnvAuditResult;
  alias: string;
  setup: SetupHost;
}

/**
 * A link to a Setup page of the org, opened in the browser, or nothing when
 * its host is not one SandForge opens. In the text's own colour, told apart
 * by its underline and its icon, as the other links that leave the panel are.
 */
const SetupLink: React.FC<{
  page: SetupPage;
  setup: SetupHost;
  label: string;
  /** The name a screen reader says, the visible words first: one per endpoint found. */
  ariaLabel?: string;
  testId: string;
}> = ({ page, setup, label, ariaLabel, testId }) => {
  const url = setupUrlOf(page, setup);
  if (!url) return null;
  return (
    <a
      href={url}
      className="inline-flex items-center gap-1 text-xs text-text-primary underline"
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {label}
      <ExternalLink size={10} aria-hidden="true" className="shrink-0" />
    </a>
  );
};

/**
 * What a step's audit read, in a list a person checks against Setup: the
 * deliverability, the jobs gone or stuck since the inventory of before, and
 * the places that still name production, each with its Setup page. One the
 * org would not answer says it could not be read, never that it found
 * nothing.
 */
export const RecoveryAudit: React.FC<RecoveryAuditProps> = ({ step, audit, alias, setup }) => {
  const { t } = useTranslation();

  if (step === 'deliverability') {
    const read = audit.deliverability?.read;
    return (
      <div className="flex flex-col gap-1" data-testid="recovery-audit-deliverability">
        <p className="text-xs text-text-primary">
          {read === 'open'
            ? t('recovery.audit.deliverability.open', { alias })
            : read === 'closed'
              ? t('recovery.audit.deliverability.closed', { alias })
              : t('recovery.audit.unread')}
        </p>
        <SetupLink
          page="deliverability"
          setup={setup}
          label={t('recovery.action.openSetup')}
          testId="recovery-setup-deliverability"
        />
      </div>
    );
  }

  if (step === 'scheduledJobs') {
    const schedules = audit.schedules;
    if (!schedules || schedules.unread !== undefined) {
      return (
        <p className="text-xs text-text-primary" data-testid="recovery-audit-scheduledJobs">
          {t('recovery.audit.unread')}
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-1" data-testid="recovery-audit-scheduledJobs">
        <p className="text-xs text-text-primary">
          {schedules.against
            ? t('recovery.audit.jobs.against', {
                count: schedules.now,
                formatted: formatNumber(schedules.now),
                date: instantWords(schedules.against.savedAt),
              })
            : t('recovery.audit.jobs.noInventory', {
                count: schedules.now,
                formatted: formatNumber(schedules.now),
              })}
        </p>
        {schedules.jobs.length > 0 && (
          <ul className="flex flex-col gap-1 pl-4 list-disc text-xs text-text-primary">
            {schedules.jobs.map((job) => (
              <li key={`${job.status}-${job.name}`} data-testid="recovery-audit-job">
                <span className="font-semibold">{job.name}</span> ({job.type}):{' '}
                {t(`recovery.audit.jobs.status.${job.status}`)}
                {job.owner && <> · {job.owner}</>}
              </li>
            ))}
          </ul>
        )}
        {schedules.against && (
          <p className="text-xs text-text-secondary">
            {t('recovery.audit.jobs.kept', {
              count: schedules.kept,
              formatted: formatNumber(schedules.kept),
            })}
          </p>
        )}
        {schedules.saved !== undefined && (
          <p className="text-xs text-text-secondary" data-testid="recovery-audit-inventory-kept">
            {t('recovery.audit.jobs.saved')}
          </p>
        )}
        <SetupLink
          page="scheduledJobs"
          setup={setup}
          label={t('recovery.action.openSetup')}
          testId="recovery-setup-scheduledJobs"
        />
      </div>
    );
  }

  const endpoints = audit.endpoints;
  if (!endpoints || endpoints.unread !== undefined) {
    return (
      <p className="text-xs text-text-primary" data-testid="recovery-audit-endpoints">
        {t('recovery.audit.unread')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="recovery-audit-endpoints">
      <p className="text-xs text-text-primary">
        {endpoints.found.length === 0
          ? t('recovery.audit.endpoints.none', { alias })
          : t('recovery.audit.endpoints.found', {
              count: endpoints.found.length,
              formatted: formatNumber(endpoints.found.length),
            })}
      </p>
      {endpoints.notDeduced !== undefined && (
        <p className="text-xs text-text-secondary">
          {t('recovery.audit.endpoints.notDeduced', { alias })}
        </p>
      )}
      {endpoints.found.length > 0 && (
        <ul className="flex flex-col gap-1 pl-4 list-disc text-xs text-text-primary">
          {endpoints.found.map((found) => (
            <li
              key={`${found.source}-${found.name}`}
              className="flex flex-wrap items-baseline gap-x-2"
              data-testid="recovery-audit-endpoint"
            >
              <span>
                {t(`recovery.audit.endpoints.source.${found.source}`)}{' '}
                <span className="font-semibold">{found.name}</span>: {found.host} (
                {t(`recovery.audit.endpoints.why.${found.why}`)})
              </span>
              <SetupLink
                page={setupPageOfEndpoint(found)}
                setup={setup}
                label={t('recovery.action.openSetup')}
                ariaLabel={t('recovery.action.openSetupFor', { name: found.name })}
                testId="recovery-setup-endpoint"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
