import React, { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ForgeFiredOnWrite,
  ForgeTargetAutomation,
  ForgeTargetAutomationUnread,
} from '@sandforge/shared';
import {
  bypassAssignmentsOf,
  firedOnRemovalOf,
  heldBypassPermissionsOf,
  removalBypassesOf,
} from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOrgStore } from '../../stores/useOrgStore';
import { BypassAssistant } from './BypassAssistant';

/** How long the read may take: the read before a run gives up after 60 seconds. */
const READ_TIMEOUT_MS = 90_000;

/** What `forge:undo-automation:request` answers. */
interface RemovalAutomationAnswer {
  forgeId: string;
  automation: ForgeTargetAutomation;
  drafted: string[];
}

/** What fires, by its kind, as the Automation tab names it. */
const KIND_KEYS: Readonly<Record<ForgeFiredOnWrite['kind'], string>> = {
  flow: 'forge.review.automation.flow',
  trigger: 'forge.review.automation.trigger',
  process: 'forge.review.automation.process',
  workflowRule: 'forge.review.automation.workflowRule',
};

/** When what fires on a delete runs. */
const DELETE_WHEN_KEYS: Readonly<Record<ForgeFiredOnWrite['when'], string>> = {
  before: 'forge.review.automation.beforeDelete',
  after: 'forge.review.automation.afterDelete',
  beforeAndAfter: 'forge.review.automation.beforeAndAfterDelete',
};

/**
 * The parts of the read whose refusal leaves what fires unknown, and the
 * permission sets a bypass's command is read from, as the Automation tab
 * says each.
 */
const UNREAD_KEYS: Partial<Record<ForgeTargetAutomationUnread['part'], string>> = {
  flows: 'forge.review.automation.unreadFlows',
  triggers: 'forge.review.automation.unreadTriggers',
  processes: 'forge.review.automation.unreadProcesses',
  workflowRules: 'forge.review.automation.unreadWorkflowRules',
  permissionSets: 'forge.review.automation.unreadPermissionSets',
};

/** Props for {@link ForgeRemovalAutomation}. */
export interface ForgeRemovalAutomationProps {
  /** The run whose removal is being confirmed; nothing is read while there is none. */
  forgeId: string | undefined;
  /** The org it wrote to, as the user knows it. */
  org: string;
  /** The org it wrote to, by its id in the registry: the user the command names is its. */
  targetOrgId: string | undefined;
}

/**
 * What the target runs as a removal takes a run's records back, read as its
 * confirmation opens and listed before the user types the org's name: what
 * fires before and after each delete, and as an activated order is set back
 * to Draft for its delete; or that nothing does; what could not be read; and,
 * for a bypass the user does not hold, the permission set that would keep it
 * quiet and the command that assigns it.
 *
 * A removal deletes, and the target's automation runs on each delete as it
 * runs on each insert: the removal's confirmation named the records it takes
 * and nothing of what they would set off.
 */
export const ForgeRemovalAutomation: React.FC<ForgeRemovalAutomationProps> = ({
  forgeId,
  org,
  targetOrgId,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const target = useOrgStore((s) => s.orgs.find((o) => o.id === targetOrgId));
  const read = useBridgeMutation<RemovalAutomationAnswer>('forge:undo-automation:request', {
    responseType: 'forge:undo-automation:response',
    errorType: 'forge:undo-automation:error',
    timeoutMs: READ_TIMEOUT_MS,
  });
  const { mutate, reset } = read;
  useEffect(() => {
    if (forgeId) mutate({ forgeId });
    else reset();
  }, [forgeId, mutate, reset]);

  if (!forgeId) return null;
  let body: React.ReactNode;
  if (read.error) {
    body = (
      <p data-testid="forge-removal-automation-error" className="text-status-warning">
        {t('forge.history.removalAutomation.error', { org, reason: read.error })}
      </p>
    );
  } else if (!read.data || read.data.forgeId !== forgeId) {
    body = (
      <p data-testid="forge-removal-automation-loading" className="text-text-secondary">
        {t('forge.history.removalAutomation.loading', { org })}
      </p>
    );
  } else {
    const { automation, drafted } = read.data;
    const fired = firedOnRemovalOf(automation, drafted);
    const unread = automation.unread.filter((u) => UNREAD_KEYS[u.part] !== undefined);
    const held = heldBypassPermissionsOf(automation);
    const toAssign = removalBypassesOf(automation, drafted).filter((name) => !held.includes(name));
    body = (
      <>
        {fired.length > 0 ? (
          <>
            <p>{t('forge.history.removalAutomation.intro', { org })}</p>
            <ul className="ml-3 flex list-disc flex-col gap-0.5">
              {fired.map((entry) => (
                <li
                  key={`${entry.write}-${entry.objectApiName}-${entry.kind}-${entry.name}`}
                  data-testid={`forge-removal-automation-${entry.write}-${entry.objectApiName}`}
                >
                  <span className="font-mono">{entry.objectApiName}</span>
                  {': '}
                  {t(KIND_KEYS[entry.kind], { name: entry.name })}
                  <span className="text-text-secondary">
                    {' · '}
                    {entry.write === 'delete'
                      ? t(DELETE_WHEN_KEYS[entry.when])
                      : t('forge.history.removalAutomation.drafted')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          unread.length === 0 && (
            <p data-testid="forge-removal-automation-none">
              {t('forge.history.removalAutomation.none', { org })}
            </p>
          )
        )}
        {unread.map((u) => (
          <p
            key={u.part}
            data-testid={`forge-removal-automation-unread-${u.part}`}
            className="text-status-warning"
          >
            {t(UNREAD_KEYS[u.part] ?? '', { reason: u.reason })}
          </p>
        ))}
        {toAssign.length > 0 && (
          <div data-testid="forge-removal-automation-bypass">
            <p>
              {t('forge.review.automation.bypassHint', {
                count: toAssign.length,
                names: toAssign.join(', '),
              })}
            </p>
            <BypassAssistant
              assignments={bypassAssignmentsOf(automation, toAssign)}
              {...(target?.alias && target.username
                ? { target: { alias: target.alias, username: target.username } }
                : {})}
            />
          </div>
        )}
      </>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-removal-automation"
      className="mt-2 flex flex-col gap-1 text-[11px] text-text-primary"
    >
      <h4 id={headingId} className="text-[11px] font-semibold">
        {t('forge.history.removalAutomation.title', { org })}
      </h4>
      {body}
    </section>
  );
};
