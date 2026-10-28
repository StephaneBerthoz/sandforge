import React from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, PenLine } from 'lucide-react';
import type { SeedScenarioPacksResponse } from '@sandforge/shared';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { useAppStore } from '../../../stores/useAppStore';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { Skeleton } from '../../../components/ui/Skeleton';
import { builtInPackKeys, sourceOf, type ScenarioPicked } from './scenarioPacks';

/** Props of the scenario cards. */
export interface ScenarioCardsProps {
  /** A pack picked: its review opens, nothing is written yet. */
  onPick: (picked: ScenarioPicked) => void;
  /** The card that drafts a pack from the user's own text: shown with AI on. */
  onDraft: () => void;
}

/**
 * The Seed gallery's test data for an Agentforce agent: a card for each pack
 * SandForge ships and each the workspace holds, and one that drafts a pack
 * from the user's own text when AI is on. Each opens the pack's review;
 * nothing is written to an org before the review, the confirmation and Start.
 */
export const ScenarioCards: React.FC<ScenarioCardsProps> = ({ onPick, onDraft }) => {
  const { t } = useTranslation();
  const aiAvailable = useAppStore((s) => s.aiAvailable);
  const packs = useBridgeQuery<SeedScenarioPacksResponse['payload']>('seed:scenario:packs', {});
  const entries = packs.data?.packs ?? [];

  return (
    <section
      className="flex flex-col gap-(--sf-space-3)"
      aria-labelledby="seed-scenarios-title"
      data-testid="seed-scenarios"
    >
      <div>
        <h2 id="seed-scenarios-title" className="text-sm font-semibold text-(--sf-text-primary)">
          {t('seed.scenario.section.title')}
        </h2>
        <p className="text-xs text-(--sf-text-secondary) mt-0.5">
          {t('seed.scenario.section.subtitle')}
        </p>
      </div>
      {packs.error && (
        <ErrorBanner
          message={packs.error}
          code={packs.errorCode}
          module="seed"
          data-testid="seed-scenarios-error"
        />
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {entries.map((entry) => {
          if (entry.source === 'workspace' && 'issues' in entry) {
            return (
              <Card key={entry.path} data-testid={`scenario-card-invalid-${entry.relativePath}`}>
                <CardHeader
                  title={entry.relativePath}
                  action={<Badge variant="warning">{t('seed.scenario.card.invalid')}</Badge>}
                />
                <CardBody>
                  <ul className="flex flex-col gap-1 text-xs text-(--sf-text-secondary)">
                    {entry.issues.map((issue) => (
                      <li key={issue} className="break-words">
                        {issue}
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
            );
          }
          const { pack } = entry;
          const keys = entry.source === 'built-in' ? builtInPackKeys(pack.id) : undefined;
          const name = keys ? t(keys.name) : pack.name;
          const description = keys ? t(keys.description) : pack.businessContext;
          return (
            <Card
              key={entry.source === 'built-in' ? pack.id : entry.path}
              data-testid={`scenario-card-${pack.id}`}
            >
              <CardHeader
                title={name}
                action={<Badge variant="info">{t('seed.scenario.card.badge')}</Badge>}
              />
              <CardBody>
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-(--sf-text-secondary)">{description}</p>
                  {entry.source === 'workspace' && (
                    <p className="text-[11px] text-(--sf-text-secondary) break-all">
                      {t('seed.scenario.card.file', { path: entry.relativePath })}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="default">
                      {t('seed.scenario.card.topics', { count: pack.topics.length })}
                    </Badge>
                    <Badge variant="default">
                      {t('seed.scenario.card.customers', { count: pack.customers.count })}
                    </Badge>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Bot className="w-3.5 h-3.5" aria-hidden="true" />}
                    onClick={() => onPick({ pack, source: sourceOf(entry) })}
                    aria-label={t('seed.scenario.card.reviewNamed', { name })}
                    data-testid="btn-review-scenario"
                  >
                    {t('seed.scenario.card.review')}
                  </Button>
                </div>
              </CardBody>
            </Card>
          );
        })}
        {packs.loading && entries.length === 0 && (
          <div data-testid="seed-scenarios-skeleton">
            <Skeleton variant="rect" height="160px" />
          </div>
        )}
        {aiAvailable && (
          <Card data-testid="scenario-card-draft">
            <CardHeader title={t('seed.scenario.draftCard.title')} />
            <CardBody>
              <div className="flex flex-col gap-3">
                <p className="text-xs text-(--sf-text-secondary)">
                  {t('seed.scenario.draftCard.description')}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<PenLine className="w-3.5 h-3.5" aria-hidden="true" />}
                  onClick={onDraft}
                  data-testid="btn-draft-scenario"
                >
                  {t('seed.scenario.draftCard.start')}
                </Button>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </section>
  );
};
