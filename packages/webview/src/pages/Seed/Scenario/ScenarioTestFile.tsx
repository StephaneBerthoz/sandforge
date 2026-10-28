import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentDefinition,
  AgentTestChoice,
  SeedScenarioAgentsResponse,
  SeedScenarioPacksResponse,
  SeedScenarioTestFileResponse,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../../hooks/useBridgeQuery';
import { Button } from '../../../components/ui/Button';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { Select } from '../../../components/ui/Select';

/** A topic of the scenario, as the test file matches it to one of the agent's. */
export interface ScenarioTopicName {
  key: string;
  label: string;
}

/** Props of a run's test file section. */
export interface ScenarioTestFileProps {
  /** The scenario's run: its companion file holds the ids of its open cases. */
  runId: string;
  /** The org the run wrote to, whose agents are read. */
  orgId: string;
  /** The pack it was seeded from, by its id: its topics are looked up when not given. */
  packId: string;
  /** The topics of the pack, when the page has it. */
  topics?: readonly ScenarioTopicName[];
  /** The run was removed: its file names cases that are gone. */
  stale?: boolean;
}

/** The agent's topic a test of what no topic covers is expected to answer from, when it has one. */
const GUARD_TOPIC = 'Off_Topic';

/** What the user matched each topic of the scenario to: an agent topic and the actions expected. */
type Matches = Record<string, { agentTopic: string; actions: string[] }>;

/**
 * The Agentforce test file of a scenario's run, written into the workspace
 * and never deployed or run: the org's agents read by SOQL, each topic of
 * the scenario matched to one of the agent's by the user — nothing guessed
 * —, the file written, and the two commands that create the test in the org
 * and run it shown for the user to start. Without an agent in the org, the
 * data is written and the file is not, and the section says what to do.
 */
export const ScenarioTestFile: React.FC<ScenarioTestFileProps> = ({
  runId,
  orgId,
  packId,
  topics: givenTopics,
  stale = false,
}) => {
  const { t } = useTranslation();
  const agents = useBridgeQuery<SeedScenarioAgentsResponse['payload']>('seed:scenario:agents', {
    orgId,
  });
  const packs = useBridgeQuery<SeedScenarioPacksResponse['payload']>(
    'seed:scenario:packs',
    {},
    { skip: givenTopics !== undefined },
  );
  const topics = useMemo<readonly ScenarioTopicName[]>(() => {
    if (givenTopics) return givenTopics;
    const entry = packs.data?.packs.find((e) => 'pack' in e && e.pack.id === packId);
    return entry && 'pack' in entry
      ? entry.pack.topics.map((topic) => ({ key: topic.key, label: topic.label }))
      : [];
  }, [givenTopics, packs.data, packId]);

  const read = agents.data?.agents;
  const list: AgentDefinition[] = read?.kind === 'agents' ? read.agents : [];
  const [agentName, setAgentName] = useState('');
  const agent = list.find((a) => a.name === agentName) ?? list[0];
  const [matches, setMatches] = useState<Matches>({});
  const [guard, setGuard] = useState<string | null | undefined>(undefined);
  const [runner, setRunner] = useState<AgentTestChoice['runner']>('testing-center');
  // Another agent's topics are not this one's: the matches start again.
  useEffect(() => {
    setMatches({});
    setGuard(undefined);
  }, [agent?.name]);
  const guardTopic =
    guard !== undefined
      ? guard
      : agent?.topics.some((topic) => topic.name === GUARD_TOPIC)
        ? GUARD_TOPIC
        : null;

  const write =
    useBridgeMutation<SeedScenarioTestFileResponse['payload']>('seed:scenario:test-file');
  const outcome = write.data?.runId === runId ? write.data.outcome : undefined;
  const unmatched = topics.filter((topic) => !matches[topic.key]?.agentTopic);
  const project = agents.data?.project;
  const canWrite =
    agent !== undefined && topics.length > 0 && unmatched.length === 0 && project?.kind !== 'none';

  const send = (overwrite: boolean): void => {
    if (!agent) return;
    const choice: AgentTestChoice = {
      agent: agent.name,
      runner,
      topics: topics.map((topic) => ({
        packTopic: topic.key,
        agentTopic: matches[topic.key]?.agentTopic ?? '',
        actions: matches[topic.key]?.actions ?? [],
      })),
      guardTopic,
    };
    write.mutate({ runId, choice, ...(overwrite ? { overwrite: true } : {}) });
  };

  return (
    <section
      className="flex flex-col gap-2 text-xs text-(--sf-text-primary)"
      aria-labelledby={`scenario-tests-title-${runId}`}
      data-testid="scenario-test-file"
    >
      <h3 id={`scenario-tests-title-${runId}`} className="text-sm font-semibold">
        {t('seed.scenario.tests.title')}
      </h3>
      {stale && (
        <p className="text-status-warning" data-testid="scenario-tests-stale">
          {t('seed.scenario.tests.stale')}
        </p>
      )}
      <p className="text-(--sf-text-secondary)">{t('seed.scenario.tests.noPromise')}</p>

      {agents.loading && !agents.data && (
        <p aria-busy="true" data-testid="scenario-tests-reading">
          {t('seed.scenario.tests.reading')}
        </p>
      )}
      {agents.error && (
        <ErrorBanner
          message={agents.error}
          code={agents.errorCode}
          module="seed"
          data-testid="scenario-tests-error"
        />
      )}
      {read && read.kind !== 'agents' && (
        <div className="flex flex-col gap-2" data-testid="scenario-tests-no-agent">
          <p className="text-status-warning">
            {read.kind === 'unreadable'
              ? t('seed.scenario.tests.unreadable', { message: read.message })
              : read.reason === 'no-agentforce'
                ? t('seed.scenario.tests.noAgentforce')
                : t('seed.scenario.tests.noAgent')}
          </p>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={agents.refetch}
              data-testid="btn-scenario-tests-read-again"
            >
              {t('seed.scenario.tests.readAgain')}
            </Button>
          </div>
        </div>
      )}

      {agent && (
        <div className="flex flex-col gap-3" data-testid="scenario-tests-form">
          <Select
            label={t('seed.scenario.tests.agent')}
            options={list.map((a) => ({ value: a.name, label: a.label ?? a.name }))}
            value={agent.name}
            onChange={(e) => setAgentName(e.target.value)}
            data-testid="scenario-tests-agent"
          />
          {topics.map((topic) => {
            const match = matches[topic.key];
            const agentTopic = agent.topics.find((at) => at.name === match?.agentTopic);
            return (
              <fieldset
                key={topic.key}
                className="flex flex-col gap-1 rounded-sm border border-subtle p-2"
                data-testid={`scenario-tests-topic-${topic.key}`}
              >
                <legend className="px-1 font-medium">{topic.label}</legend>
                <Select
                  label={t('seed.scenario.tests.mapTopic', { topic: topic.label })}
                  placeholder={t('seed.scenario.tests.choose')}
                  options={agent.topics.map((at) => ({
                    value: at.name,
                    label: at.label ? `${at.label} (${at.name})` : at.name,
                  }))}
                  value={match?.agentTopic ?? ''}
                  onChange={(e) =>
                    setMatches((before) => ({
                      ...before,
                      [topic.key]: { agentTopic: e.target.value, actions: [] },
                    }))
                  }
                  data-testid={`scenario-tests-map-${topic.key}`}
                />
                {agentTopic && agentTopic.actions.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span>{t('seed.scenario.tests.mapActions')}</span>
                    {agentTopic.actions.map((action) => {
                      const checked = match?.actions.includes(action.name) ?? false;
                      return (
                        <label key={action.name} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setMatches((before) => {
                                const current = before[topic.key];
                                if (!current) return before;
                                const actions = checked
                                  ? current.actions.filter((name) => name !== action.name)
                                  : [...current.actions, action.name];
                                return { ...before, [topic.key]: { ...current, actions } };
                              })
                            }
                            data-testid={`scenario-tests-action-${topic.key}-${action.name}`}
                          />
                          <span>
                            {action.label ? `${action.label} (${action.name})` : action.name}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            );
          })}
          <Select
            label={t('seed.scenario.tests.guard')}
            options={[
              { value: '', label: t('seed.scenario.tests.noGuard') },
              ...agent.topics.map((at) => ({ value: at.name, label: at.label ?? at.name })),
            ]}
            value={guardTopic ?? ''}
            onChange={(e) => setGuard(e.target.value === '' ? null : e.target.value)}
            data-testid="scenario-tests-guard"
          />
          <Select
            label={t('seed.scenario.tests.runner')}
            options={[
              { value: 'testing-center', label: t('seed.scenario.tests.runnerTestingCenter') },
              { value: 'agentforce-studio', label: t('seed.scenario.tests.runnerStudio') },
            ]}
            value={runner}
            onChange={(e) => setRunner(e.target.value as AgentTestChoice['runner'])}
            data-testid="scenario-tests-runner"
          />
          {project?.kind === 'none' && (
            <p className="text-status-warning">{t('seed.scenario.tests.noWorkspace')}</p>
          )}
          {project?.kind === 'folder' && (
            <p className="text-(--sf-text-secondary)">{t('seed.scenario.tests.notDx')}</p>
          )}
          {unmatched.length > 0 && (
            <p className="text-(--sf-text-secondary)" id={`scenario-tests-unmatched-${runId}`}>
              {t('seed.scenario.tests.unmatched')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canWrite}
              loading={write.loading}
              aria-describedby={
                unmatched.length > 0 ? `scenario-tests-unmatched-${runId}` : undefined
              }
              onClick={() => send(false)}
              data-testid="btn-scenario-tests-write"
            >
              {t('seed.scenario.tests.write')}
            </Button>
            {outcome?.kind === 'exists' && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => send(true)}
                data-testid="btn-scenario-tests-overwrite"
              >
                {t('seed.scenario.tests.overwrite')}
              </Button>
            )}
          </div>
        </div>
      )}

      {write.error && (
        <ErrorBanner
          message={write.error}
          code={write.errorCode}
          module="seed"
          data-testid="scenario-tests-write-error"
        />
      )}
      {outcome && (
        <div role="status" className="flex flex-col gap-1" data-testid="scenario-tests-outcome">
          {outcome.kind === 'written' && (
            <>
              <p className="text-status-success">
                {t('seed.scenario.tests.written', { path: outcome.path })}
              </p>
              {outcome.leftOut.length > 0 && (
                <div>
                  <p>{t('seed.scenario.tests.leftOut')}</p>
                  <ul className="list-disc pl-4">
                    {outcome.leftOut.map((left) => (
                      <li key={left.test}>{left.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {outcome.commands ? (
                <>
                  <p>{t('seed.scenario.tests.command')}</p>
                  <code
                    className="block break-all rounded-sm bg-(--sf-bg-input) p-2"
                    data-testid="scenario-tests-create"
                  >
                    {outcome.commands.create}
                  </code>
                  <code
                    className="block break-all rounded-sm bg-(--sf-bg-input) p-2"
                    data-testid="scenario-tests-run"
                  >
                    {outcome.commands.run}
                  </code>
                </>
              ) : (
                <p className="text-(--sf-text-secondary)">{t('seed.scenario.tests.notDx')}</p>
              )}
            </>
          )}
          {outcome.kind === 'exists' && (
            <p className="text-status-warning">
              {t('seed.scenario.tests.exists', { path: outcome.specPath })}
            </p>
          )}
          {outcome.kind === 'refused' && (
            <div className="text-status-error">
              <p>{t('seed.scenario.tests.refused')}</p>
              <ul className="list-disc pl-4">
                {outcome.refusals.map((refusal) => (
                  <li key={`${refusal.code}-${refusal.name}`}>{refusal.message}</li>
                ))}
              </ul>
            </div>
          )}
          {outcome.kind === 'no-agent' && (
            <p className="text-status-warning">{t('seed.scenario.tests.noAgent')}</p>
          )}
          {outcome.kind === 'unavailable' && (
            <p className="text-status-warning">
              {t('seed.scenario.tests.unavailable', { message: outcome.message })}
            </p>
          )}
        </div>
      )}
    </section>
  );
};
