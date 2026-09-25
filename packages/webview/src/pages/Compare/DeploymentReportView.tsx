import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DeploymentComponentResult, DeploymentReport } from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';

/** Props for {@link DeploymentReportView}. */
export interface DeploymentReportViewProps {
  report: DeploymentReport;
  /** The target org as the page names it. */
  targetLabel: string;
  'data-testid'?: string;
}

const cell = 'py-1 pr-3 text-left align-top';
const headerCell = `${cell} font-medium text-text-secondary`;

const outcomeVariant: Record<DeploymentComponentResult['outcome'], BadgeVariant> = {
  created: 'success',
  changed: 'info',
  unchanged: 'default',
  failed: 'error',
  not_retrieved: 'warning',
};

/** Where in its file a component fails, when the org says. */
function where(
  t: ReturnType<typeof useTranslation>['t'],
  c: DeploymentComponentResult,
): string | undefined {
  if (c.line === undefined) return undefined;
  return c.column === undefined
    ? t('compare.deployment.report.atLine', { line: c.line })
    : t('compare.deployment.report.at', { line: c.line, column: c.column });
}

/**
 * What a validation or a deployment did in the target, as the org reported
 * it: the outcome, where Setup lists it, each component with the line it
 * fails on, and each failed test with its line.
 */
export const DeploymentReportView: React.FC<DeploymentReportViewProps> = ({
  report,
  targetLabel,
  'data-testid': testId = 'deployment-report',
}) => {
  const { t } = useTranslation();
  const notStarted = report.deployId === undefined;
  const missing = report.components.filter((c) => c.outcome === 'not_retrieved').length;

  const verdict = notStarted
    ? t('compare.deployment.report.notStarted', { target: targetLabel })
    : report.checkOnly
      ? report.success
        ? t('compare.deployment.report.validated', { target: targetLabel })
        : t('compare.deployment.report.validationFailed', { target: targetLabel })
      : report.success
        ? t('compare.deployment.report.deployed', { target: targetLabel })
        : t('compare.deployment.report.deployFailed', { target: targetLabel });
  const badge = notStarted
    ? 'notStarted'
    : !report.success
      ? 'failed'
      : report.checkOnly
        ? 'validated'
        : 'deployed';

  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <p className="flex flex-wrap items-center gap-2 text-xs text-text-primary">
        <Badge variant={report.success ? 'success' : 'error'} data-testid={`${testId}-badge`}>
          {t(`compare.deployment.report.badge.${badge}`)}
        </Badge>
        <span data-testid={`${testId}-verdict`}>{verdict}</span>
      </p>

      {missing > 0 && (
        <p className="text-xs text-status-warning" data-testid={`${testId}-missing`}>
          {t('compare.deployment.report.notRetrieved', { count: missing })}
        </p>
      )}
      {report.errorMessage && (
        <p className="text-xs text-status-error" data-testid={`${testId}-error`}>
          {t('compare.deployment.report.stopped', { message: report.errorMessage })}
        </p>
      )}
      {report.deployId && (
        <p className="text-xs text-text-secondary" data-testid={`${testId}-where`}>
          {t('compare.deployment.report.where', { target: targetLabel, id: report.deployId })}
        </p>
      )}
      {!notStarted && (
        <p className="text-xs text-text-secondary" data-testid={`${testId}-counts`}>
          {t('compare.deployment.report.counts', {
            deployed: report.counts.componentsDeployed,
            total: report.counts.componentsTotal,
            errors: report.counts.componentErrors,
          })}{' '}
          {report.counts.testsTotal > 0
            ? t('compare.deployment.report.tests', {
                completed: report.counts.testsCompleted,
                total: report.counts.testsTotal,
                failed: report.counts.testErrors,
              })
            : t('compare.deployment.report.noTests')}
        </p>
      )}

      {report.components.length > 0 && (
        <table className="w-full text-xs" data-testid={`${testId}-components`}>
          <caption className="mb-1 text-left text-xs font-medium text-text-primary">
            {t('compare.deployment.report.componentsCaption')}
          </caption>
          <thead>
            <tr className="border-b border-(--sf-border)">
              <th scope="col" className={headerCell}>
                {t('compare.deployment.report.column.outcome')}
              </th>
              <th scope="col" className={headerCell}>
                {t('compare.deployment.report.column.component')}
              </th>
              <th scope="col" className={headerCell}>
                {t('compare.deployment.report.column.problem')}
              </th>
            </tr>
          </thead>
          <tbody>
            {report.components.map((c) => {
              const at = where(t, c);
              return (
                <tr
                  key={`${c.componentType}:${c.fullName}`}
                  className="border-b border-(--sf-border) last:border-0"
                  data-testid={`${testId}-component-${c.componentType}-${c.fullName}`}
                >
                  <td className={cell}>
                    <Badge variant={outcomeVariant[c.outcome]}>
                      {report.checkOnly
                        ? t(`compare.deployment.report.outcomeCheckOnly.${c.outcome}`)
                        : t(`compare.deployment.report.outcome.${c.outcome}`)}
                    </Badge>
                  </td>
                  <th scope="row" className={`${cell} font-normal text-text-primary`}>
                    <span className="text-text-secondary">{c.componentType}</span>{' '}
                    <span className="font-mono break-all">{c.fullName}</span>
                  </th>
                  <td className={`${cell} text-text-primary`}>
                    {c.problemType === 'Warning' && (
                      <Badge variant="warning" className="mr-1">
                        {t('compare.deployment.report.warning')}
                      </Badge>
                    )}
                    {c.problem}
                    {at && (
                      <span className="ml-1 font-mono text-text-secondary">
                        ({c.fileName ? `${c.fileName}, ` : ''}
                        {at})
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {report.testFailures.length > 0 && (
        <div className="flex flex-col gap-1" data-testid={`${testId}-test-failures`}>
          <h4 className="text-xs font-medium text-text-primary">
            {t('compare.deployment.report.testFailuresTitle', {
              count: report.testFailures.length,
            })}
          </h4>
          <ul className="flex flex-col gap-1">
            {report.testFailures.map((f, index) => (
              <li
                key={`${f.className}.${f.methodName ?? ''}.${index}`}
                className="rounded-sm bg-(--sf-bg-secondary) px-2 py-1 text-xs text-text-primary"
              >
                <span className="font-mono">
                  {f.methodName ? `${f.className}.${f.methodName}` : f.className}
                </span>
                {f.line !== undefined && (
                  <span className="ml-1 font-mono text-text-secondary">
                    ({t('compare.deployment.report.atLine', { line: f.line })})
                  </span>
                )}
                <span className="block">{f.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.coverageWarnings.length > 0 && (
        <div className="flex flex-col gap-1" data-testid={`${testId}-coverage`}>
          <h4 className="text-xs font-medium text-text-primary">
            {t('compare.deployment.report.coverageTitle')}
          </h4>
          <ul className="list-disc pl-4 text-xs text-text-primary">
            {report.coverageWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {report.retrieveProblems && report.retrieveProblems.length > 0 && (
        <div className="flex flex-col gap-1" data-testid={`${testId}-retrieve-problems`}>
          <h4 className="text-xs font-medium text-text-primary">
            {t('compare.deployment.report.retrieveProblemsTitle')}
          </h4>
          <ul className="list-disc pl-4 text-xs text-text-primary">
            {report.retrieveProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};
