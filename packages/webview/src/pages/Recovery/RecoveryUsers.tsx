import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  RecoveryStatus,
  UsersApplyAnswer,
  UsersAutomation,
  UsersChange,
  UsersConfig,
  UsersPlanAnswer,
} from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { sendBridgeMessage } from '../../bridge/sendBridgeMessage';
import { useLatestRef } from '../../hooks/useLatestRef';
import { formatNumber } from '../../utils/formatters';
import {
  automationOfPlan,
  choiceKeyOf,
  instantWords,
  planVerdictOf,
  userRowsOf,
  usernameKey,
  usersConfigOf,
  usersRefusalKeyOf,
  type UsersAcceptances,
  type UserRow,
} from './recoveryFacts';
import { RecoveryError } from './RecoveryError';
import { useRecoveryUsersBridge } from './useRecoveryBridge';

/**
 * The most users one run sets up, as `sandforge users` takes them
 * (`USERS_MAX`, held to it by the test): a list past it is split.
 */
export const USERS_PER_RUN = 200;

/** The most rows the list draws at once: a filter finds the others. */
const ROWS_SHOWN = 200;

/** No acceptance said: the state a simulation is asked in, and a run starts from. */
const NONE_ACCEPTED: UsersAcceptances = {
  acceptUserEmails: false,
  acceptEmails: false,
  acceptAutomation: false,
};

/** Where the list a run starts from came from: kept for the sandbox, or read from a file. */
type GivenList =
  | { from: 'saved'; config: UsersConfig; savedAt: string }
  | { from: 'file'; config: UsersConfig; fileName: string };

/** One change to a user, as the page words it: never "restored" for an address asked back. */
function changeWords(
  change: UsersChange,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (change.what) {
    case 'email':
      return t('recovery.users.change.email');
    case 'active':
      return t(change.to ? 'recovery.users.change.activated' : 'recovery.users.change.deactivated');
    case 'frozen':
      return t(change.to ? 'recovery.users.change.frozen' : 'recovery.users.change.unfrozen');
    case 'profile':
      return t('recovery.users.change.profile', { from: change.from, to: change.to });
    case 'permissionSet':
      return t(
        change.to === 'added'
          ? 'recovery.users.change.permissionSetAdded'
          : 'recovery.users.change.permissionSetRemoved',
        { name: change.name },
      );
    case 'permissionSetGroup':
      return t(
        change.to === 'added'
          ? 'recovery.users.change.permissionSetGroupAdded'
          : 'recovery.users.change.permissionSetGroupRemoved',
        { name: change.name },
      );
    case 'group':
      return t(
        change.type === 'Queue'
          ? change.to === 'added'
            ? 'recovery.users.change.queueAdded'
            : 'recovery.users.change.queueRemoved'
          : change.to === 'added'
            ? 'recovery.users.change.groupAdded'
            : 'recovery.users.change.groupRemoved',
        { name: change.name },
      );
  }
}

/** The badges of a row: its address as read, inactive, frozen, and where its entry came from. */
const RowFacts: React.FC<{ row: UserRow; given: GivenList | null }> = ({ row, given }) => {
  const { t } = useTranslation();
  const read = row.read;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {read && (
        <Badge variant={read.address === 'invalid' ? 'warning' : 'default'}>
          {t(`recovery.users.address.${read.address}`)}
        </Badge>
      )}
      {read && !read.active && <Badge variant="warning">{t('recovery.users.inactive')}</Badge>}
      {read?.frozen && <Badge variant="warning">{t('recovery.users.frozen')}</Badge>}
      {read?.profile && <span className="text-[11px] text-text-secondary">{read.profile}</span>}
      {row.given && given && (
        <span className="text-[11px] text-text-secondary">
          {given.from === 'file'
            ? t('recovery.users.fromFile', { fileName: given.fileName })
            : t('recovery.users.fromSaved')}
        </span>
      )}
    </span>
  );
};

/**
 * What the org would set off as the users are written, under the acceptance
 * it asks: each flow, trigger, process or rule by its kind, its name, its
 * object and when it runs; then what could not be read, so may fire unnamed.
 */
const AutomationList: React.FC<{ automation: UsersAutomation; alias: string }> = ({
  automation,
  alias,
}) => {
  const { t } = useTranslation();
  return (
    <ul
      className="ml-5 flex list-disc flex-col gap-0.5 pl-4 text-xs text-text-primary"
      data-testid="recovery-users-automation"
    >
      {automation.fired.map((fired, index) => (
        <li key={`${fired.kind}-${fired.objectApiName}-${fired.name}-${index}`}>
          {t('recovery.users.automation.fired', {
            kind: t(`recovery.users.automation.kind.${fired.kind}`),
            name: fired.name,
            object: fired.objectApiName,
            when: t(`recovery.users.automation.when.${fired.when}`),
          })}
        </li>
      ))}
      {(automation.unread ?? []).map((part) => (
        <li key={part}>{t(`recovery.users.automation.unread.${part}`, { alias })}</li>
      ))}
      {automation.notDeduced && <li>{t('recovery.users.automation.notDeduced', { alias })}</li>}
    </ul>
  );
};

/** What a simulation says the run would do, user by user, and what it asks or refuses. */
const PlanView: React.FC<{
  plan: UsersPlanAnswer;
  alias: string;
  accepted: UsersAcceptances;
  onAccept: (acceptance: keyof UsersAcceptances, value: boolean) => void;
}> = ({ plan, alias, accepted, onAccept }) => {
  const { t } = useTranslation();
  const verdict = planVerdictOf(plan);
  const automation = automationOfPlan(plan);
  return (
    <div className="flex flex-col gap-2" data-testid="recovery-users-plan">
      <p className="text-xs font-semibold text-text-primary">
        {t('recovery.users.planTitle', {
          count: plan.apiRequests,
          formatted: formatNumber(plan.apiRequests),
        })}
      </p>
      <ul className="flex flex-col gap-1 text-xs text-text-primary">
        {plan.users.map((user) => (
          <li key={usernameKey(user.username)} data-testid="recovery-users-plan-user">
            <span className="font-semibold">{user.username}</span>:{' '}
            {user.changes.length === 0
              ? t('recovery.users.nothingToChange')
              : user.changes.map((change) => changeWords(change, t)).join(' · ')}
          </li>
        ))}
      </ul>
      {(plan.licenses ?? []).map((license) => (
        <p key={license.name} className="text-xs text-text-secondary">
          {t('recovery.users.license', {
            name: license.name,
            used: formatNumber(license.used),
            total: formatNumber(license.total),
            toUse: formatNumber(license.toUse),
          })}
        </p>
      ))}
      {verdict.blocking.length > 0 && (
        <ul
          className="flex flex-col gap-1 rounded-sm border border-(--sf-error) px-3 py-2 text-xs text-status-error"
          data-testid="recovery-users-refusals"
        >
          {verdict.blocking.map((refusal, index) => (
            <li key={`${refusal.code}-${index}`}>
              {t(usersRefusalKeyOf(refusal.code), {
                alias,
                code: refusal.code,
                username: refusal.username ?? '',
              })}
            </li>
          ))}
        </ul>
      )}
      {verdict.asked.map((acceptance) => (
        <React.Fragment key={acceptance}>
          <label
            className="flex items-start gap-2 text-xs text-text-primary"
            data-testid={`recovery-users-${acceptance}`}
          >
            <input
              type="checkbox"
              className="mt-0.5"
              checked={accepted[acceptance]}
              onChange={(event) => onAccept(acceptance, event.target.checked)}
            />
            <span>
              {t(
                `recovery.users.accept.${acceptance}`,
                // The emails are counted; what the org runs is named below.
                acceptance === 'acceptAutomation'
                  ? { alias }
                  : {
                      alias,
                      count: plan.emailsToPeople,
                      formatted: formatNumber(plan.emailsToPeople),
                    },
              )}
            </span>
          </label>
          {acceptance === 'acceptAutomation' && automation && (
            <AutomationList automation={automation} alias={alias} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

/** What a run did, user by user: an address asked back awaits its owner, never "restored". */
const ResultView: React.FC<{ applied: UsersApplyAnswer; alias: string }> = ({ applied, alias }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" role="status" data-testid="recovery-users-result">
      <p className="text-xs font-semibold text-text-primary">
        {t(`recovery.users.result.${applied.status}`, { run: applied.run, alias })}
      </p>
      {applied.emailsToPeople > 0 && (
        <p className="text-xs text-text-primary">
          {t('recovery.users.result.emails', {
            count: applied.emailsToPeople,
            formatted: formatNumber(applied.emailsToPeople),
          })}
        </p>
      )}
      <ul className="flex flex-col gap-1 text-xs text-text-primary">
        {applied.users.map((user) => (
          <li key={user.userId} data-testid="recovery-users-result-user">
            <span className="font-semibold">{user.username}</span>:{' '}
            {user.done.length === 0
              ? t('recovery.users.nothingChanged')
              : user.done.map((change) => changeWords(change, t)).join(' · ')}
            {user.address === 'awaiting' && (
              <>
                {' '}
                <Badge variant="info">{t('recovery.users.address.awaiting')}</Badge>
              </>
            )}
            {(user.refused ?? []).map((refused, index) => (
              <span key={index} className="block text-status-error">
                {t('recovery.users.result.refusedChange', {
                  change: changeWords(refused.change, t),
                  code: refused.code,
                })}
              </span>
            ))}
          </li>
        ))}
      </ul>
      {(applied.refusals ?? []).length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-status-error">
          {(applied.refusals ?? []).map((refusal, index) => (
            <li key={`${refusal.code}-${index}`}>
              {t(usersRefusalKeyOf(refusal.code), {
                alias,
                code: refusal.code,
                username: refusal.username ?? '',
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** Props of {@link RecoveryUsers}. */
export interface RecoveryUsersProps {
  orgId: string;
  alias: string;
  /** The run a new one replaces, converging from what it set up: the org's last. */
  lastRun?: RecoveryStatus['lastUsersRun'];
  /** A run ended, or the list was kept: the page reads its status again. */
  onChanged: () => void;
}

/**
 * Step 2: the users a refresh left under `.invalid`, frozen or inactive, read
 * in the sandbox, a box each. Simulate plans the users chosen, nothing
 * written; Apply waits for a simulation of the same list, and asks at each
 * run the acceptances it needs — the emails to people among them —, kept
 * nowhere. The list is kept for the sandbox's next refresh, written to a
 * users.json for the command line and CI, or read from one, whose profile,
 * permission sets and groups a run then sets.
 */
export const RecoveryUsers: React.FC<RecoveryUsersProps> = ({
  orgId,
  alias,
  lastRun,
  onChanged,
}) => {
  const { t } = useTranslation();
  const filterId = useId();
  const bridge = useRecoveryUsersBridge();
  const { list, plan, apply, save, exportList, importList, progress } = bridge;
  const [given, setGiven] = useState<GivenList | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [askedKey, setAskedKey] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<{ plan: string | null; values: UsersAcceptances }>({
    plan: null,
    values: NONE_ACCEPTED,
  });
  const [usedPlan, setUsedPlan] = useState<string | null>(null);

  const listUsers = list.mutate;
  useEffect(() => {
    listUsers({ orgId });
  }, [listUsers, orgId]);

  // The list kept for the sandbox is what a run starts from, its users chosen.
  const listed = list.data;
  useEffect(() => {
    if (!listed) return;
    const saved = listed.saved;
    setGiven(saved ? { from: 'saved', config: saved.config, savedAt: saved.savedAt } : null);
    setChosen(new Set(saved?.config.users.map((user) => usernameKey(user.username)) ?? []));
  }, [listed]);

  // A users.json read replaces the list: its users chosen, its entries whole.
  const imported = importList.data;
  useEffect(() => {
    if (imported?.status !== 'read') return;
    setGiven({ from: 'file', config: imported.config, fileName: imported.fileName });
    setChosen(new Set(imported.config.users.map((user) => usernameKey(user.username))));
  }, [imported]);

  // A run that ended, a list kept: the step's status is read again, once per answer.
  const ran = apply.data;
  const kept = save.data;
  const changed = useLatestRef(onChanged);
  useEffect(() => {
    if (ran || kept) changed.current();
  }, [ran, kept, changed]);

  const rows = useMemo(() => userRowsOf(listed?.users ?? [], given?.config), [listed, given]);
  const config = useMemo(() => usersConfigOf(rows, chosen, given?.config), [rows, chosen, given]);
  const key = choiceKeyOf(config);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? rows.filter(
          (row) =>
            row.key.includes(needle) || (row.read?.name?.toLowerCase().includes(needle) ?? false),
        )
      : rows;
    return { rows: matching.slice(0, ROWS_SHOWN), count: matching.length };
  }, [rows, filter]);

  const simulation =
    plan.data && askedKey !== null && plan.requestId !== null
      ? { key: askedKey, plan: plan.data.plan, requestId: plan.requestId }
      : null;
  const current = simulation !== null && simulation.key === key;
  const verdict = simulation ? planVerdictOf(simulation.plan) : null;
  const acceptances =
    simulation && accepted.plan === simulation.requestId ? accepted.values : NONE_ACCEPTED;
  const tooMany = chosen.size > USERS_PER_RUN;
  const replaces = lastRun ? { replaces: lastRun.run } : {};
  const busy = plan.loading || apply.loading;
  const canApply =
    current &&
    verdict !== null &&
    simulation.requestId !== usedPlan &&
    verdict.blocking.length === 0 &&
    verdict.changes &&
    verdict.asked.every((acceptance) => acceptances[acceptance]) &&
    !busy;

  const toggle = (rowKey: string, on: boolean): void => {
    setChosen((was) => {
      const next = new Set(was);
      if (on) next.add(rowKey);
      else next.delete(rowKey);
      return next;
    });
  };

  const simulate = (): void => {
    if (!config) return;
    setAskedKey(key);
    // Asked with no acceptance: the plan then names every one the run needs.
    plan.mutate({ orgId, config, ...NONE_ACCEPTED, ...replaces });
  };

  const run = (): void => {
    if (!config || !simulation) return;
    setUsedPlan(simulation.requestId);
    apply.mutate({ orgId, config, ...acceptances, ...replaces });
  };

  const accept = (acceptance: keyof UsersAcceptances, value: boolean): void => {
    if (!simulation) return;
    setAccepted({ plan: simulation.requestId, values: { ...acceptances, [acceptance]: value } });
  };

  if (list.loading && !listed) {
    return (
      <p className="text-xs text-text-secondary" role="status" data-testid="recovery-users-loading">
        {t('recovery.users.loading', { alias })}
      </p>
    );
  }
  if (list.error) {
    return (
      <RecoveryError
        error={list.error}
        errorCode={list.errorCode}
        alias={alias}
        onRetry={() => listUsers({ orgId })}
        testId="recovery-users-error"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="recovery-users">
      <p className="text-xs text-text-secondary">{t('recovery.users.intro', { alias })}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-text-primary" data-testid="recovery-users-none">
          {t('recovery.users.none', { alias })}
        </p>
      ) : (
        <>
          {rows.length > 10 && (
            <label htmlFor={filterId} className="flex flex-col gap-1 text-xs text-text-primary">
              <span>{t('recovery.users.filter')}</span>
              <input
                id={filterId}
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="rounded-sm border border-subtle bg-(--vscode-input-background,#3c3c3c) px-2 py-1 text-xs text-(--vscode-input-foreground,#ccc)"
                data-testid="recovery-users-filter"
              />
            </label>
          )}
          <ul
            className="flex max-h-80 flex-col gap-1 overflow-y-auto"
            data-testid="recovery-users-list"
          >
            {shown.rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-text-primary">
                  <input
                    type="checkbox"
                    checked={chosen.has(row.key)}
                    onChange={(event) => toggle(row.key, event.target.checked)}
                    data-testid={`recovery-user-${row.key}`}
                  />
                  <span>
                    {row.read?.name ? (
                      <>
                        <span className="font-semibold">{row.read.name}</span> {row.username}
                      </>
                    ) : (
                      row.username
                    )}
                  </span>
                </label>
                <RowFacts row={row} given={given} />
              </li>
            ))}
          </ul>
          {shown.count > shown.rows.length && (
            <p className="text-xs text-text-secondary">
              {t('recovery.users.shown', {
                shown: formatNumber(shown.rows.length),
                count: shown.count,
                formatted: formatNumber(shown.count),
              })}
            </p>
          )}
        </>
      )}
      {listed?.total !== undefined && listed.total > listed.users.length && (
        <p className="text-xs text-status-warning" data-testid="recovery-users-capped">
          {t('recovery.users.capped', {
            count: listed.users.length,
            formatted: formatNumber(listed.users.length),
            total: formatNumber(listed.total),
          })}
        </p>
      )}
      <p className="text-xs text-text-primary" data-testid="recovery-users-chosen">
        {t('recovery.users.chosen', { count: chosen.size, formatted: formatNumber(chosen.size) })}
        {lastRun && (
          <>
            {' '}
            {lastRun.takenBack
              ? t('recovery.users.replacesTakenBack', { run: lastRun.run, alias })
              : t('recovery.users.replaces', { run: lastRun.run })}
          </>
        )}
      </p>
      {tooMany && (
        <p className="text-xs text-status-warning">
          {t('recovery.users.tooMany', { most: formatNumber(USERS_PER_RUN) })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!config || tooMany || busy}
          loading={plan.loading}
          onClick={simulate}
          data-testid="recovery-users-simulate"
        >
          {t('recovery.users.simulate')}
        </Button>
        <Button
          size="sm"
          disabled={!canApply}
          loading={apply.loading}
          onClick={run}
          data-testid="recovery-users-apply"
        >
          {t('recovery.users.apply')}
        </Button>
      </div>
      {!current && config && !busy && (
        <p className="text-xs text-text-secondary" data-testid="recovery-users-simulate-first">
          {t('recovery.users.simulateFirst')}
        </p>
      )}
      {plan.error && (
        <RecoveryError
          error={plan.error}
          errorCode={plan.errorCode}
          alias={alias}
          testId="recovery-users-plan-error"
        />
      )}
      {simulation && current && (
        <PlanView plan={simulation.plan} alias={alias} accepted={acceptances} onAccept={accept} />
      )}
      {apply.loading && (
        <div className="flex flex-col gap-2" data-testid="recovery-users-progress">
          <ProgressBar
            {...(progress
              ? { value: progress.done, max: Math.max(progress.total, 1) }
              : { indeterminate: true as const })}
            label={
              progress
                ? t('recovery.users.progress', {
                    done: formatNumber(progress.done),
                    total: formatNumber(progress.total),
                  })
                : t('recovery.users.running', { alias })
            }
          />
          <Button
            size="sm"
            variant="danger"
            onClick={() => sendBridgeMessage('recovery:users:cancel', { orgId })}
            data-testid="recovery-users-stop"
          >
            {t('common.stopRun')}
          </Button>
        </div>
      )}
      {apply.error && (
        <RecoveryError
          error={apply.error}
          errorCode={apply.errorCode}
          alias={alias}
          // A run the extension refuses after its simulation — an acceptance
          // it no longer holds among them — wrote nothing: simulate again.
          codeKeys={{ FAILED: 'recovery.users.applyRefused' }}
          testId="recovery-users-apply-error"
        />
      )}
      {ran && <ResultView applied={ran.applied} alias={alias} />}
      <div className="flex flex-wrap gap-2 border-t border-subtle pt-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!config || save.loading}
          onClick={() => config && save.mutate({ orgId, config })}
          data-testid="recovery-users-save"
        >
          {t('recovery.users.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!config || exportList.loading}
          onClick={() => config && exportList.mutate({ orgId, config })}
          data-testid="recovery-users-export"
        >
          {t('recovery.users.export')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={importList.loading}
          onClick={() => importList.mutate({ orgId })}
          data-testid="recovery-users-import"
        >
          {t('recovery.users.import')}
        </Button>
      </div>
      {kept && (
        <p className="text-xs text-text-secondary" role="status" data-testid="recovery-users-saved">
          {t('recovery.users.saved', { date: instantWords(kept.savedAt) })}
        </p>
      )}
      {exportList.data?.status === 'saved' && (
        <p
          className="text-xs text-text-secondary"
          role="status"
          data-testid="recovery-users-exported"
        >
          {t('recovery.users.exported', { fileName: exportList.data.fileName })}
        </p>
      )}
      {imported?.status === 'read' && (
        <p
          className="text-xs text-text-secondary"
          role="status"
          data-testid="recovery-users-imported"
        >
          {t('recovery.users.imported', {
            fileName: imported.fileName,
            count: imported.config.users.length,
            formatted: formatNumber(imported.config.users.length),
          })}
        </p>
      )}
      {[save, exportList, importList].map(
        (request, index) =>
          request.error && (
            <RecoveryError
              key={index}
              error={request.error}
              errorCode={request.errorCode}
              alias={alias}
              testId="recovery-users-file-error"
            />
          ),
      )}
    </div>
  );
};
