import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SalesforceOrg } from '@sandforge/shared';
import { Badge, type BadgeVariant } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { DangerConfirm } from '../../../components/ui/DangerConfirm';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { Input } from '../../../components/ui/Input';
import { ProgressAnnouncer } from '../../../components/ui/ProgressBar';
import { RecordErrorGroups } from '../../../components/ui/RecordErrorGroups';
import { Select } from '../../../components/ui/Select';
import { TakeCheckpointNow } from '../../../components/ui/TakeCheckpointNow';
import { useFocusOnChange } from '../../../hooks/useFocusOnChange';
import { orgOptionLabel } from '../../../utils/orgFormatters';
import { SeedAutomationNotice } from '../SeedAutomationNotice';
import { SeedObjectBadge } from '../SeedObjectBadge';
import { SeedOpenRecord } from '../SeedOpenRecord';
import { SeedRunRemoval } from '../SeedRunRemoval';
import { Step7Execute } from '../Step7_Execute';
import { refusedForEmails, useSeedAutomation } from '../useSeedAutomation';
import { ScenarioReview } from './ScenarioReview';
import { ScenarioTestFile } from './ScenarioTestFile';
import { useScenarioSeed } from './useScenarioSeed';
import type { ScenarioPicked } from './scenarioPacks';

/** Props of a scenario's flow. */
export interface ScenarioFlowProps {
  /** The pack picked in the gallery, or drafted. */
  picked: ScenarioPicked;
  orgs: SalesforceOrg[];
  /** Back to the gallery. */
  onClose: () => void;
}

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};

/** The object a scenario's articles are written to. */
const ARTICLES = 'Knowledge__kav';

/** The largest seed a pack is compiled with. */
const MAX_SEED = 2 ** 32 - 1;

/**
 * A scenario pack from its review to its results: the review, then the org
 * it is written to with what the run writes there — read of the org: its
 * case statuses, its Knowledge —, the seed's own gates and Start, the run,
 * which can be stopped, and its results with the agent's test file.
 */
export const ScenarioFlow: React.FC<ScenarioFlowProps> = ({ picked, orgs, onClose }) => {
  const { t } = useTranslation();
  const scenario = useScenarioSeed(picked);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { preparation, phase, result } = scenario;

  const objects = preparation?.objects.map((object) => object.objectApiName) ?? [];
  const automation = useSeedAutomation(phase === 'confirm' ? scenario.orgId : '', objects);
  const records = Object.fromEntries(
    (preparation?.objects ?? []).map((object) => [object.objectApiName, object.recordCount]),
  );
  const refused = refusedForEmails(automation, records);
  const runOrg = orgs.find((org) => org.id === scenario.orgId);
  const runOrgName = runOrg ? runOrg.alias || runOrg.username : '';
  const total = Object.values(records).reduce((sum, count) => sum + count, 0);

  // Each phase is drawn in place of the last, and the button that moved on
  // went with it: the keyboard goes to what the new phase shows.
  const flowRef = useRef<HTMLDivElement>(null);
  const phaseTarget = useRef<HTMLElement | null>(null);
  const showsPhase = useCallback((element: HTMLElement | null) => {
    phaseTarget.current = element;
  }, []);
  useFocusOnChange(phaseTarget, phase, { scope: flowRef, onMount: true });

  const knowledge = preparation?.knowledge;
  const articlesWritten =
    result?.objectResults.find((object) => object.objectApiName === ARTICLES)?.recordsCreated ?? 0;
  const runInfo = result?.scenario;

  const outcomeSpoken = result
    ? t('a11y.runOutcome', {
        outcome: result.cancelled
          ? t('home.opStatus.cancelled')
          : result.status === 'success'
            ? t('seed.complete')
            : result.status === 'partial'
              ? t('seed.partial')
              : t('seed.failed'),
        written: result.totalRecordsCreated,
        total: Math.max(total, result.totalRecordsCreated + result.totalRecordsFailed),
      })
    : '';

  return (
    <div ref={flowRef} className="flex flex-col gap-(--sf-space-3)" data-testid="scenario-flow">
      {scenario.error && (
        <ErrorBanner
          message={scenario.error}
          code={null}
          module="seed"
          onDismiss={() => scenario.setError(null)}
          data-testid="scenario-error"
        />
      )}

      {phase === 'review' && (
        <ScenarioReview
          titleRef={showsPhase}
          pack={scenario.pack}
          source={scenario.source}
          mustSave={scenario.mustSave}
          onEdit={scenario.edit}
          onSave={scenario.save}
          saving={scenario.saving}
          saved={scenario.saved}
          onContinue={scenario.toConfirm}
          onBack={onClose}
        />
      )}

      {phase === 'confirm' && (
        <Card data-testid="scenario-confirm">
          <CardHeader
            titleRef={showsPhase}
            title={t('seed.scenario.confirm.title', { name: scenario.pack.name })}
            action={
              preparation ? (
                <Badge variant="default">{t('seed.gallery.records', { count: total })}</Badge>
              ) : undefined
            }
          />
          <CardBody>
            <div className="flex flex-col gap-3 text-xs text-(--sf-text-primary)">
              <Select
                label={t('seed.quickSeed.selectOrg')}
                options={orgs.map((org) => ({ value: org.id, label: orgOptionLabel(org, t) }))}
                value={scenario.orgId}
                onChange={(e) => scenario.selectOrg(e.target.value)}
                placeholder={t('seed.quickSeed.selectOrg')}
                data-testid="scenario-org-selector"
              />
              <Input
                id="scenario-seed"
                type="number"
                min={0}
                label={t('seed.scenario.confirm.seed')}
                hint={t('seed.scenario.confirm.seedHint')}
                value={scenario.seed}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isInteger(value) && value >= 0 && value <= MAX_SEED) {
                    scenario.setSeed(value);
                  }
                }}
                className="w-32"
                data-testid="scenario-seed"
              />
              {knowledge?.available === true && knowledge.bodyFields.length > 1 && (
                <Select
                  label={t('seed.scenario.knowledge.bodyField')}
                  options={knowledge.bodyFields.map((field) => ({ value: field, label: field }))}
                  value={scenario.bodyField ?? knowledge.bodyFields[0]}
                  onChange={(e) => scenario.setBodyField(e.target.value)}
                  data-testid="scenario-body-field"
                />
              )}
              {scenario.orgId && scenario.preparing && (
                <p aria-busy="true" data-testid="scenario-preparing">
                  {t('seed.scenario.confirm.preparing')}
                </p>
              )}
              {scenario.issues.length > 0 && (
                <div role="alert" className="text-status-error" data-testid="scenario-issues">
                  <p>{t('seed.scenario.confirm.issues')}</p>
                  <ul className="list-disc pl-4">
                    {scenario.issues.map((issue) => (
                      <li key={issue} className="break-words">
                        {issue}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preparation && (
                <div className="flex flex-col gap-2" data-testid="scenario-plan">
                  <span className="font-medium">{t('seed.scenario.confirm.objects')}</span>
                  <ul className="flex flex-col gap-0.5">
                    {preparation.objects.map((object) => (
                      <li key={object.objectApiName} className="flex gap-3">
                        <span className="w-40 truncate">{object.objectApiName}</span>
                        <span>{object.recordCount}</span>
                        {object.optional && (
                          <span className="text-(--sf-text-secondary)">
                            {t('seed.scenario.confirm.optional')}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p>{t('seed.scenario.confirm.tests', { count: preparation.tests })}</p>
                  <p data-testid="scenario-statuses">
                    {preparation.caseStatusFrom.from === 'org'
                      ? t('seed.scenario.confirm.statusOrg', {
                          open: preparation.options.caseStatus.open,
                          closed: preparation.options.caseStatus.closed,
                        })
                      : t('seed.scenario.confirm.statusDefault', {
                          reason: preparation.caseStatusFrom.reason,
                        })}
                  </p>
                  {preparation.knowledge.available ? (
                    <>
                      <p>
                        {preparation.options.articleBodyField
                          ? t('seed.scenario.knowledge.body', {
                              field: preparation.options.articleBodyField,
                            })
                          : t('seed.scenario.knowledge.summaryFallback')}
                      </p>
                      <p className="text-(--sf-text-secondary)">
                        {t('seed.scenario.knowledge.drafts')}
                      </p>
                    </>
                  ) : (
                    <p className="text-status-warning" data-testid="scenario-knowledge-absent">
                      {t('seed.scenario.knowledge.absent')}
                    </p>
                  )}
                  <p className="text-(--sf-text-secondary)">{t('seed.scenario.confirm.gates')}</p>
                  <p className="text-(--sf-text-secondary)">
                    {t('seed.scenario.knowledge.notRewound')}
                  </p>
                  <p className="text-(--sf-text-secondary)">{t('seed.scenario.confirm.notInV1')}</p>
                </div>
              )}
              {scenario.orgId && preparation && (
                <SeedAutomationNotice
                  automation={automation}
                  orgName={runOrgName}
                  records={records}
                />
              )}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={scenario.backToReview}
                  data-testid="btn-scenario-confirm-back"
                >
                  {t('common.back')}
                </Button>
                <Button
                  size="sm"
                  disabled={!scenario.orgId || !preparation || scenario.preparing || refused}
                  onClick={scenario.execute}
                  data-testid="btn-scenario-start"
                >
                  {t('seed.scenario.confirm.start')}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {phase === 'executing' && (
        <div
          ref={showsPhase}
          tabIndex={-1}
          role="group"
          aria-label={t('seed.running')}
          className="flex flex-col gap-(--sf-space-3)"
          data-testid="scenario-executing"
        >
          <Step7Execute
            isRunning={scenario.isRunning}
            objectProgress={scenario.objectProgress}
            overallPercent={scenario.overallPercent}
            elapsedMs={scenario.elapsedMs}
          />
          {scenario.isRunning && scenario.operationId && (
            <div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmCancel(true)}
                data-testid="btn-scenario-cancel"
              >
                {t('common.cancelRun')}
              </Button>
            </div>
          )}
          {!scenario.isRunning && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={onClose}
                data-testid="btn-scenario-back-after-error"
              >
                {t('seed.quickSeed.backToGallery')}
              </Button>
            </div>
          )}
        </div>
      )}

      {phase === 'results' && result && (
        <div className="flex flex-col gap-(--sf-space-3)" data-testid="scenario-results">
          <ProgressAnnouncer message={outcomeSpoken} immediate testId="scenario-result-status" />
          <div
            ref={showsPhase}
            tabIndex={-1}
            role="group"
            aria-label={t('seed.stepResults')}
            className="flex items-center gap-3 text-xs"
            data-testid="scenario-result-summary"
          >
            {result.cancelled ? (
              <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
            ) : (
              <Badge variant={STATUS_VARIANT[result.status]}>
                {result.status === 'success'
                  ? t('seed.complete')
                  : result.status === 'partial'
                    ? t('seed.partial')
                    : t('seed.failed')}
              </Badge>
            )}
            <span className="text-(--sf-text-primary)">
              {t('seed.recordsCreated')}: <strong>{result.totalRecordsCreated}</strong>
            </span>
            {result.totalRecordsFailed > 0 && (
              <span className="text-status-error">
                {t('seed.recordsFailed')}: <strong>{result.totalRecordsFailed}</strong>
              </span>
            )}
          </div>

          {result.objectResults.map((object) => (
            <Card key={object.objectApiName}>
              <CardHeader
                title={object.objectApiName}
                action={<SeedObjectBadge result={object} />}
              />
              {object.errors.length > 0 && (
                <CardBody>
                  <RecordErrorGroups
                    objectApiName={object.objectApiName}
                    errors={object.errors}
                    recordsFailed={object.recordsFailed}
                    module="seed"
                    testIdPrefix="scenario-result"
                  />
                </CardBody>
              )}
            </Card>
          ))}

          {articlesWritten > 0 && runInfo && !runInfo.articlesPublished && (
            <p className="text-xs text-status-warning" data-testid="scenario-articles-drafts">
              {t('seed.scenario.knowledge.drafts')}
            </p>
          )}

          {result.totalRecordsCreated > 0 && <SeedRunRemoval runId={result.operationId} />}

          {runInfo && (
            <Card data-testid="scenario-results-tests">
              <CardBody>
                <p className="mb-2 text-xs text-(--sf-text-secondary)">
                  {t('seed.scenario.results.openCases', {
                    written: runInfo.openCasesWritten,
                    total: runInfo.openCases,
                  })}
                </p>
                {runInfo.companion.kind === 'kept' ? (
                  <ScenarioTestFile
                    runId={result.operationId}
                    orgId={scenario.orgId}
                    packId={runInfo.packId}
                    topics={scenario.pack.topics.map((topic) => ({
                      key: topic.key,
                      label: topic.label,
                    }))}
                  />
                ) : (
                  <p className="text-xs text-status-warning" data-testid="scenario-results-no-file">
                    {runInfo.companion.kind === 'none'
                      ? t('seed.scenario.results.noCase')
                      : t('seed.scenario.results.companionFailed', {
                          message: runInfo.companion.message,
                        })}
                  </p>
                )}
              </CardBody>
            </Card>
          )}

          <div className="flex flex-wrap gap-2 pt-2" data-testid="scenario-result-actions">
            <SeedOpenRecord result={result} orgName={runOrgName} />
            <Button
              variant="secondary"
              size="sm"
              onClick={onClose}
              data-testid="btn-scenario-back-to-gallery"
            >
              {t('seed.quickSeed.backToGallery')}
            </Button>
          </div>

          <TakeCheckpointNow
            orgId={scenario.orgId}
            wrote={result.totalRecordsCreated > 0}
            testId="scenario-checkpoint-now"
          />
        </div>
      )}

      <DangerConfirm
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          scenario.cancel();
        }}
        title={t('common.cancelRun')}
        description={t('seed.cancelRunConfirm')}
        confirmLabel={t('common.stopRun')}
        dismissLabel={t('common.keepRunning')}
      />
    </div>
  );
};
