import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Square } from 'lucide-react';
import type {
  SalesforceOrg,
  ScenarioDraftAgent,
  ScenarioPack,
  SeedScenarioAgentsResponse,
} from '@sandforge/shared';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { useAppStore } from '../../../stores/useAppStore';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { Select } from '../../../components/ui/Select';
import { cn } from '../../../theme';
import { orgOptionLabel } from '../../../utils/orgFormatters';
import { useScenarioDraft } from './useScenarioDraft';

/** Props of a scenario's draft. */
export interface ScenarioDraftProps {
  orgs: SalesforceOrg[];
  /** The pack drafted whole: its review opens, nothing written yet. */
  onDrafted: (pack: ScenarioPack) => void;
  onBack: () => void;
}

/** The languages a pack is drafted in, as Salesforce writes them. */
const LANGUAGES = ['en_US', 'fr', 'de', 'es', 'pt_BR', 'ja'] as const;

/** Most characters of the scenario text a draft sends. */
const MAX_TEXT = 8_000;

const FIELD_CLASSES = cn(
  'w-full px-3 py-2 rounded-md text-sm resize-y',
  'bg-(--sf-bg-input) text-(--sf-text-input)',
  'border border-(--sf-border-input)',
  'focus:outline-hidden focus:border-(--vscode-focusBorder,#007fd4)',
);

/**
 * A scenario pack drafted from the user's own text by the AI provider: the
 * page says what leaves and shows the text as it will be sent, its addresses
 * and numbers masked; the draft can be stopped, and goes on from the topics
 * written before; the pack it makes opens in its review, saved before it is
 * seeded. There is no stand-in for what the model did not write.
 */
export const ScenarioDraft: React.FC<ScenarioDraftProps> = ({ orgs, onDrafted, onBack }) => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const [text, setText] = useState('');
  const [language, setLanguage] = useState<string>('en_US');
  const [orgId, setOrgId] = useState('');
  const [agentName, setAgentName] = useState('');
  const draft = useScenarioDraft();
  const org = useBridgeQuery<SeedScenarioAgentsResponse['payload']>(
    'seed:scenario:agents',
    useMemo(() => ({ orgId }), [orgId]),
    { skip: !orgId },
  );
  const agents = org.data?.agents.kind === 'agents' ? org.data.agents.agents : [];
  const agent = agents.find((a) => a.name === agentName);

  useEffect(() => {
    if (draft.pack) onDrafted(draft.pack);
  }, [draft.pack, onDrafted]);

  const told: ScenarioDraftAgent | undefined = agent
    ? {
        topics: agent.topics.map((topic) => ({
          name: topic.name,
          ...(topic.label ? { label: topic.label } : {}),
          ...(topic.description ? { description: topic.description } : {}),
          actions: topic.actions.map((action) => ({
            name: action.name,
            ...(action.label ? { label: action.label } : {}),
            ...(action.description ? { description: action.description } : {}),
          })),
        })),
      }
    : undefined;
  const ask = (resume: boolean): void =>
    draft.draft({
      text,
      language,
      ...(orgId && org.data?.casePicklists ? { casePicklists: org.data.casePicklists } : {}),
      ...(told ? { agent: told } : {}),
      resume,
    });
  const canDraft = text.trim().length > 0 && !draft.busy;

  return (
    <Card data-testid="scenario-draft">
      <CardHeader title={t('seed.scenario.draftCard.title')} />
      <CardBody>
        <div className="flex flex-col gap-3 text-xs text-(--sf-text-primary)">
          <label htmlFor="scenario-draft-text" className="font-medium">
            {t('seed.scenario.describe.label')}
          </label>
          <textarea
            id="scenario-draft-text"
            data-testid="scenario-draft-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('seed.scenario.describe.placeholder')}
            rows={6}
            maxLength={MAX_TEXT}
            aria-describedby="scenario-draft-sends"
            className={FIELD_CLASSES}
          />
          <p id="scenario-draft-sends" className="text-(--sf-text-secondary)">
            {t('seed.scenario.describe.sends')}
          </p>
          <Select
            label={t('seed.scenario.describe.language')}
            options={LANGUAGES.map((code) => ({ value: code, label: code }))}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            data-testid="scenario-draft-language"
          />
          <Select
            label={t('seed.scenario.describe.org')}
            options={[
              { value: '', label: t('seed.scenario.describe.noOrg') },
              ...orgs.map((o) => ({ value: o.id, label: orgOptionLabel(o, t) })),
            ]}
            value={orgId}
            onChange={(e) => {
              setOrgId(e.target.value);
              setAgentName('');
            }}
            data-testid="scenario-draft-org"
          />
          {agents.length > 0 && (
            <Select
              label={t('seed.scenario.describe.agent')}
              options={[
                { value: '', label: t('seed.scenario.describe.noAgent') },
                ...agents.map((a) => ({ value: a.name, label: a.label ?? a.name })),
              ]}
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              data-testid="scenario-draft-agent"
            />
          )}

          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={text.trim().length === 0}
              onClick={() => draft.preview(text)}
              data-testid="btn-scenario-draft-preview"
            >
              {t('seed.scenario.describe.preview')}
            </Button>
          </div>
          {draft.sentText !== null && (
            <div data-testid="scenario-draft-masked">
              <p className="font-medium">{t('seed.scenario.describe.masked')}</p>
              <pre className="whitespace-pre-wrap break-words rounded-sm bg-(--sf-bg-input) p-2">
                {draft.sentText}
              </pre>
            </div>
          )}

          {draft.notConfigured && (
            <div className="flex flex-col gap-2" data-testid="scenario-draft-not-configured">
              <p className="text-status-warning">{t('seed.scenario.draft.notConfigured')}</p>
              <div>
                <Button variant="secondary" size="sm" onClick={() => navigate('settings')}>
                  {t('seed.scenario.draft.openSettings')}
                </Button>
              </div>
            </div>
          )}
          {draft.error && (
            <ErrorBanner
              message={draft.error}
              code={null}
              module="seed"
              data-testid="scenario-draft-error"
            />
          )}
          {draft.failure && (
            <div role="alert" className="text-status-error" data-testid="scenario-draft-failure">
              <p>{t('seed.scenario.draft.failed', { error: draft.failure.error })}</p>
              {draft.failure.issues.length > 0 && (
                <ul className="list-disc pl-4">
                  {draft.failure.issues.map((issue) => (
                    <li key={issue} className="break-words">
                      {issue}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {draft.stopped && (
            <p role="status" data-testid="scenario-draft-stopped">
              {t('seed.scenario.draft.stopped')}
            </p>
          )}
          {draft.partial && (
            <div data-testid="scenario-draft-partial">
              <p className="font-medium">{t('seed.scenario.draft.topics')}</p>
              <ul className="flex flex-col gap-1">
                {draft.partial.topics.map((topic) => (
                  <li key={topic.key} className="flex items-center gap-2">
                    <span>{topic.label}</span>
                    {topic.article && topic.caseTemplates ? (
                      <Badge variant="success">{t('seed.scenario.draft.written')}</Badge>
                    ) : (
                      <Badge variant="warning">{t('seed.scenario.draft.incomplete')}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draft.busy && (
            <p aria-busy="true" role="status" data-testid="scenario-draft-busy">
              {t('seed.scenario.draft.busy')}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={onBack}
              data-testid="btn-scenario-draft-back"
            >
              {t('common.back')}
            </Button>
            {draft.busy ? (
              <Button
                variant="danger"
                size="sm"
                icon={<Square className="w-3 h-3" aria-hidden="true" />}
                onClick={draft.stop}
                data-testid="btn-scenario-draft-stop"
              >
                {t('seed.scenario.draft.stop')}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={!canDraft}
                  icon={<Sparkles className="w-3 h-3" aria-hidden="true" />}
                  onClick={() => ask(false)}
                  data-testid="btn-scenario-draft-start"
                >
                  {t('seed.scenario.draft.start')}
                </Button>
                {draft.partial && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!canDraft}
                    onClick={() => ask(true)}
                    data-testid="btn-scenario-draft-resume"
                  >
                    {t('seed.scenario.draft.resume')}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
};
