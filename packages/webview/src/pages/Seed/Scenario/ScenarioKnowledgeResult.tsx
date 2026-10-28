import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedKnowledgeOutcome, SeedKnowledgeStep, SeedObjectResult } from '@sandforge/shared';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';

/** Props of a scenario's Knowledge results. */
export interface ScenarioKnowledgeResultProps {
  /** What the run did with its articles once every record was written (`result.knowledge`). */
  knowledge: SeedKnowledgeOutcome | undefined;
  /** The result of the articles' object, whose own card says why none was written. */
  articles: SeedObjectResult | undefined;
}

/** One step of the results: how many of those asked were done, and each not, with why. */
const StepLine: React.FC<{ label: string; step: SeedKnowledgeStep; testId: string }> = ({
  label,
  step,
  testId,
}) => (
  <div data-testid={testId}>
    <p className={step.notDone.length > 0 ? 'text-status-warning' : undefined}>{label}</p>
    {step.notDone.length > 0 && (
      <ul className="list-disc pl-4 text-(--sf-text-secondary)">
        {step.notDone.map(({ key, reason }) => (
          <li key={key} className="break-words">
            <code>{key}</code>: {reason}
          </li>
        ))}
      </ul>
    )}
  </div>
);

/**
 * What a scenario's run did with its Knowledge articles once every record
 * was written: how many it published, how many closed cases it linked to the
 * article that answers them, and each it did not, with why — in the org's
 * words when the org refused. An article left a draft is one an agent's data
 * library does not index, and the user is told what to do about it. Nothing
 * when no article was written — skipped without Knowledge, or every one
 * refused —, which the articles' own card says, or when the run was asked
 * neither.
 */
export const ScenarioKnowledgeResult: React.FC<ScenarioKnowledgeResultProps> = ({
  knowledge,
  articles,
}) => {
  const { t } = useTranslation();
  if (!knowledge) return null;
  if (knowledge.skipped !== undefined && (articles?.recordsCreated ?? 0) === 0) return null;
  const { publish, links, skipped } = knowledge;
  return (
    <Card data-testid="scenario-results-knowledge">
      <CardHeader title={t('seed.scenario.results.knowledge.title')} />
      <CardBody>
        <div className="flex flex-col gap-2 text-xs text-(--sf-text-primary)">
          {skipped !== undefined && (
            <div data-testid="scenario-knowledge-skipped">
              <p className="text-status-warning">{t('seed.scenario.results.knowledge.skipped')}</p>
              <p className="break-words text-(--sf-text-secondary)">{skipped}</p>
            </div>
          )}
          {publish && (
            <StepLine
              label={t('seed.scenario.results.knowledge.published', {
                done: publish.done,
                total: publish.asked,
              })}
              step={publish}
              testId="scenario-knowledge-published"
            />
          )}
          {links && (
            <StepLine
              label={t('seed.scenario.results.knowledge.linked', {
                done: links.done,
                total: links.asked,
              })}
              step={links}
              testId="scenario-knowledge-linked"
            />
          )}
          {publish && publish.notDone.length > 0 && (
            <p className="text-(--sf-text-secondary)" data-testid="scenario-knowledge-drafts-left">
              {t('seed.scenario.results.knowledge.draftsLeft')}
            </p>
          )}
        </div>
      </CardBody>
    </Card>
  );
};
