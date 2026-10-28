import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { scenarioPackSchema } from '@sandforge/shared';
import type { ScenarioPack } from '@sandforge/shared';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { cn } from '../../../theme';
import type { ScenarioSaveOutcome } from './useScenarioSeed';
import type { ScenarioSource } from './scenarioPacks';

/** Props of a pack's review. */
export interface ScenarioReviewProps {
  pack: ScenarioPack;
  source: ScenarioSource;
  /** Why the pack is saved before it can be seeded: drafted, or edited since. */
  mustSave: boolean;
  onEdit: (pack: ScenarioPack) => void;
  onSave: (overwrite?: boolean) => void;
  saving: boolean;
  saved: ScenarioSaveOutcome | null;
  onContinue: () => void;
  onBack: () => void;
  /** Handed the title, which takes the keyboard as the review opens. */
  titleRef?: React.Ref<HTMLHeadingElement>;
}

const FIELD_CLASSES = cn(
  'w-full px-3 py-2 rounded-md text-xs font-mono resize-y',
  'bg-(--sf-bg-input) text-(--sf-text-input)',
  'border border-(--sf-border-input)',
  'focus:outline-hidden focus:border-(--vscode-focusBorder,#007fd4)',
);

/** A pack's text as the editor shows it, its file's own. */
const textOf = (pack: ScenarioPack): string => JSON.stringify(pack, null, 2);

/**
 * A pack before anything is written from it: what its business is, each
 * topic with the article that answers it, what customers say and what the
 * agent should do, its decoy and what no topic covers. Edited as its file is
 * written, checked by the pack's own schema, which names the field a change
 * breaks; a pack drafted or edited is saved in the workspace before it is
 * seeded, as its test file is written from it after the run.
 */
export const ScenarioReview: React.FC<ScenarioReviewProps> = ({
  pack,
  source,
  mustSave,
  onEdit,
  onSave,
  saving,
  saved,
  onContinue,
  onBack,
  titleRef,
}) => {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const apply = (): void => {
    if (editing === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(editing);
    } catch (err: unknown) {
      setProblems([err instanceof Error ? err.message : String(err)]);
      return;
    }
    const parsed = scenarioPackSchema.safeParse(raw);
    if (!parsed.success) {
      setProblems(
        parsed.error.issues.map(
          (issue) =>
            `${issue.path.join('.') || t('seed.scenario.review.wholePack')}: ${issue.message}`,
        ),
      );
      return;
    }
    setProblems([]);
    setEditing(null);
    onEdit(parsed.data);
  };

  const origin =
    source.kind === 'built-in'
      ? t('seed.scenario.review.source.builtIn')
      : source.kind === 'workspace'
        ? t('seed.scenario.review.source.file', { path: source.relativePath })
        : t('seed.scenario.review.source.draft');

  return (
    <Card data-testid="scenario-review">
      <CardHeader
        titleRef={titleRef}
        title={t('seed.scenario.review.title', { name: pack.name })}
        subtitle={origin}
        action={
          <Badge variant="default">
            {t('seed.scenario.review.language', { language: pack.language })}
          </Badge>
        }
      />
      <CardBody>
        <div className="flex flex-col gap-3 text-xs text-(--sf-text-primary)">
          <p data-testid="scenario-review-context">{pack.businessContext}</p>
          <p className="text-(--sf-text-secondary)">
            {t('seed.scenario.review.customers', {
              count: pack.customers.count,
              industry: pack.customers.industry,
            })}
          </p>

          {editing === null ? (
            <>
              <ul className="flex flex-col gap-2" data-testid="scenario-review-topics">
                {pack.topics.map((topic) => (
                  <li key={topic.key} className="rounded-sm border border-subtle p-2">
                    <details>
                      <summary className="cursor-pointer font-semibold">
                        {t('seed.scenario.review.topic', {
                          label: topic.label,
                          title: topic.article.title,
                        })}
                      </summary>
                      <div className="mt-2 flex flex-col gap-2">
                        <p className="text-(--sf-text-secondary)">{topic.article.summary}</p>
                        <div>
                          <span className="font-medium">{t('seed.scenario.review.facts')}</span>
                          <ul className="list-disc pl-4">
                            {topic.article.facts.map((fact) => (
                              <li key={fact}>{fact}</li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <span className="font-medium">
                            {t('seed.scenario.review.utterances')}
                          </span>
                          <ul className="list-disc pl-4">
                            {topic.utterances.map((utterance) => (
                              <li key={utterance.text}>
                                {utterance.text}{' '}
                                <span className="text-(--sf-text-secondary)">
                                  → {utterance.expectedOutcome}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <p className="text-(--sf-text-secondary)">
                          {t('seed.scenario.review.cases', {
                            count: topic.caseTemplates.length,
                          })}
                        </p>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
              <p className="text-(--sf-text-secondary)">
                {t('seed.scenario.review.decoy', {
                  title: pack.decoy.title,
                  topic:
                    pack.topics.find((topic) => topic.key === pack.decoy.resembles)?.label ??
                    pack.decoy.resembles,
                })}
              </p>
              <p className="text-(--sf-text-secondary)">
                {t('seed.scenario.review.outOfScope', { count: pack.outOfScope.length })}
              </p>
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setProblems([]);
                    setEditing(textOf(pack));
                  }}
                  data-testid="btn-scenario-edit"
                >
                  {t('seed.scenario.review.edit')}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="scenario-review-text" className="font-medium">
                {t('seed.scenario.review.editLabel')}
              </label>
              <textarea
                id="scenario-review-text"
                data-testid="scenario-review-text"
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                rows={18}
                spellCheck={false}
                aria-describedby={problems.length > 0 ? 'scenario-review-problems' : undefined}
                className={FIELD_CLASSES}
              />
              {problems.length > 0 && (
                <div
                  id="scenario-review-problems"
                  role="alert"
                  className="text-status-error"
                  data-testid="scenario-review-problems"
                >
                  <p>{t('seed.scenario.review.invalid')}</p>
                  <ul className="list-disc pl-4">
                    {problems.map((problem) => (
                      <li key={problem} className="break-words">
                        {problem}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={apply} data-testid="btn-scenario-apply">
                  {t('seed.scenario.review.apply')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setProblems([]);
                    setEditing(null);
                  }}
                  data-testid="btn-scenario-cancel-edit"
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {saved && (
            <p
              role="status"
              className={saved.kind === 'saved' ? 'text-status-success' : 'text-status-warning'}
              data-testid="scenario-review-saved"
            >
              {saved.kind === 'saved'
                ? t('seed.scenario.review.saved', { path: saved.relativePath })
                : saved.kind === 'exists'
                  ? t('seed.scenario.review.exists', { path: saved.relativePath })
                  : t('seed.scenario.review.noWorkspace')}
            </p>
          )}
          {mustSave && (
            <p className="text-(--sf-text-secondary)" id="scenario-review-must-save">
              {t('seed.scenario.review.saveFirst')}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={onBack} data-testid="btn-scenario-back">
              {t('common.back')}
            </Button>
            {editing === null && (
              <Button
                variant="secondary"
                size="sm"
                loading={saving}
                onClick={() => onSave(false)}
                data-testid="btn-scenario-save"
              >
                {t('seed.scenario.review.save')}
              </Button>
            )}
            {editing === null && saved?.kind === 'exists' && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => onSave(true)}
                data-testid="btn-scenario-overwrite"
              >
                {t('seed.scenario.review.overwrite')}
              </Button>
            )}
            <Button
              size="sm"
              disabled={mustSave || editing !== null}
              aria-describedby={mustSave ? 'scenario-review-must-save' : undefined}
              onClick={onContinue}
              data-testid="btn-scenario-continue"
            >
              {t('seed.scenario.review.continue')}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
};
