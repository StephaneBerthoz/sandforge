import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ForgeAutomationFired,
  ForgeAutomationWrite,
  ForgeFlowPath,
  ForgeMessageAction,
  ForgeRemovalRisk,
  ForgeTargetAutomation,
  ForgeTargetAutomationUnread,
  ForgeTargetObjectAutomation,
} from '@sandforge/shared';
import {
  automationByWrite,
  blindedBy,
  bypassAssignmentsOf,
  bypassPermissionsOf,
  heldBypassPermissionsOf,
  removalRisksOf,
} from '@sandforge/shared';
import { Badge } from '../../components/ui/Badge';
import { uiLocale } from '../../utils/formatters';
import { BypassAssistant, type BypassTarget } from './BypassAssistant';

/** The heading of each write, as the tab says it. */
const WRITE_KEYS: Readonly<Record<ForgeAutomationWrite, string>> = {
  insert: 'forge.review.automation.onInsert',
  update: 'forge.review.automation.onUpdate',
  delete: 'forge.review.automation.onDelete',
};

/** When a flow or a trigger runs, for a save and for a delete. */
const WHEN_KEYS: Readonly<
  Record<'save' | 'delete', Readonly<Record<ForgeAutomationFired['when'], string>>>
> = {
  save: {
    before: 'forge.review.automation.beforeSave',
    after: 'forge.review.automation.afterSave',
    beforeAndAfter: 'forge.review.automation.beforeAndAfterSave',
  },
  delete: {
    before: 'forge.review.automation.beforeDelete',
    after: 'forge.review.automation.afterDelete',
    beforeAndAfter: 'forge.review.automation.beforeAndAfterDelete',
  },
};

/** What fires, by its kind. */
const KIND_KEYS: Readonly<Record<ForgeAutomationFired['kind'], string>> = {
  flow: 'forge.review.automation.flow',
  trigger: 'forge.review.automation.trigger',
  process: 'forge.review.automation.process',
  workflowRule: 'forge.review.automation.workflowRule',
};

/** What a message action sends. */
const MESSAGE_KEYS: Readonly<Record<ForgeMessageAction['kind'], string>> = {
  email: 'forge.review.automation.messageEmail',
  notification: 'forge.review.automation.messageNotification',
  outbound: 'forge.review.automation.messageOutbound',
  sms: 'forge.review.automation.messageSms',
};

/** What could not be read, part by part. */
const UNREAD_KEYS: Readonly<Record<ForgeTargetAutomationUnread['part'], string>> = {
  flows: 'forge.review.automation.unreadFlows',
  triggers: 'forge.review.automation.unreadTriggers',
  conditions: 'forge.review.automation.unreadConditions',
  processes: 'forge.review.automation.unreadProcesses',
  workflowRules: 'forge.review.automation.unreadWorkflowRules',
  definitions: 'forge.review.automation.unreadDefinitions',
  assignmentRules: 'forge.review.automation.unreadAssignmentRules',
  duplicateRules: 'forge.review.automation.unreadDuplicateRules',
  userPermissions: 'forge.review.automation.unreadUserPermissions',
  permissionSets: 'forge.review.automation.unreadPermissionSets',
};

/** The units a scheduled path's offset is set in, as `Intl` names them. */
const OFFSET_UNITS: Readonly<Record<string, string>> = {
  Minutes: 'minute',
  Hours: 'hour',
  Days: 'day',
  Weeks: 'week',
  Months: 'month',
};

/** Props for {@link ReviewAutomationTab}. */
export interface ReviewAutomationTabProps {
  /** What the target runs, once `forge:automation:response` answered; null before. */
  automation: ForgeTargetAutomation | null;
  /** Message from `forge:automation:error`, when the read could not run at all. */
  error?: string | null;
  /**
   * The objects the user has left out of the run since the read: what the
   * target runs on them no longer fires, and is not shown.
   */
  leftOut?: ReadonlySet<string>;
  /** Whether the run lets the target's assignment rules apply (`ForgeConfig.applyAssignmentRules`). */
  applyAssignmentRules?: boolean;
  /**
   * The target org and the user the run writes as, whom the command that
   * assigns a bypass names; without them, the permission set is named and no
   * command is shown.
   */
  target?: BypassTarget;
}

/**
 * Automation tab within the Forge Review phase: what the target org runs on
 * the records the run writes, write by write — its record-triggered flows,
 * Apex triggers, processes and workflow rules, what of them sends messages
 * or runs once the save is committed — its assignment and duplicate rules,
 * and what keeps a flow from starting for the user the run writes as, with
 * the permission set that would give that user a bypass it does not hold.
 *
 * A clone fired the target's flows on every record it created, emails and
 * text messages among them, and nothing said so before the run. The request
 * lives in ForgeReview, sent once as Review opens with the metadata diff; the
 * props carry its outcome.
 */
export const ReviewAutomationTab: React.FC<ReviewAutomationTabProps> = ({
  automation,
  error = null,
  leftOut = new Set<string>(),
  applyAssignmentRules = false,
  target,
}) => {
  const { t } = useTranslation();

  if (error) {
    return (
      <div data-testid="review-automation-tab" className="py-4">
        <p data-testid="automation-error" className="text-xs text-status-error text-center">
          {error}
        </p>
      </div>
    );
  }

  if (!automation) {
    return (
      <div data-testid="review-automation-tab" className="py-4">
        <p data-testid="automation-loading" className="text-xs text-text-secondary text-center">
          {t('forge.review.automation.loading')}
        </p>
      </div>
    );
  }

  const objects = automation.objects.filter((object) => !leftOut.has(object.objectApiName));
  const written = automation.objectsRead.filter((name) => !leftOut.has(name)).length;
  const held = heldBypassPermissionsOf({ objects });
  const toAssign = bypassPermissionsOf({ objects }).filter((name) => !held.includes(name));
  // A part that could not be read leaves "nothing runs" unsaid: nothing was
  // seen there, which is not the same.
  const blind = blindedBy(automation.unread);
  const definitionsNotRead = automation.definitionsNotRead ?? 0;

  return (
    <div data-testid="review-automation-tab" className="flex flex-col gap-2 text-xs">
      <p data-testid="automation-summary" className="text-text-secondary">
        {objects.length > 0
          ? t('forge.review.automation.intro')
          : blind
            ? t('forge.review.automation.nothingSeen')
            : t('forge.review.automation.none', { count: written })}
      </p>
      {toAssign.length > 0 && (
        <div
          data-testid="automation-bypass"
          className="rounded-sm border border-subtle bg-surface-2 p-2 text-text-primary"
        >
          <p>
            {t('forge.review.automation.bypassHint', {
              count: toAssign.length,
              names: toAssign.join(', '),
            })}
          </p>
          <BypassAssistant
            assignments={bypassAssignmentsOf(automation, toAssign)}
            {...(target ? { target } : {})}
          />
        </div>
      )}
      {held.length > 0 && (
        <p
          data-testid="automation-bypass-held"
          className="rounded-sm border border-subtle bg-surface-2 p-2 text-text-primary"
        >
          {t('forge.review.automation.bypassHeld', { count: held.length, names: held.join(', ') })}
        </p>
      )}
      {objects.map((object) => (
        <section
          key={object.objectApiName}
          data-testid={`automation-object-${object.objectApiName}`}
          aria-labelledby={`automation-object-${object.objectApiName}-name`}
          className="rounded-sm border border-subtle p-2"
        >
          <h3
            id={`automation-object-${object.objectApiName}-name`}
            className="mb-1 font-medium text-text-primary"
          >
            {object.objectApiName}
          </h3>
          {automationByWrite(object).map(({ write, fired }) => (
            <div
              key={write}
              data-testid={`automation-${object.objectApiName}-${write}`}
              className="mt-1"
            >
              <p className="font-medium text-text-secondary">{t(WRITE_KEYS[write])}</p>
              <ul className="ml-3 flex list-disc flex-col gap-0.5">
                {fired.map((entry) => (
                  <FiredEntry
                    key={`${entry.kind}-${entry.flow?.apiName ?? entry.name}`}
                    entry={entry}
                    write={write}
                  />
                ))}
              </ul>
            </div>
          ))}
          <ObjectRules object={object} applyAssignmentRules={applyAssignmentRules} />
        </section>
      ))}
      <RemovalRisks automation={automation} leftOut={leftOut} blind={blind} />
      {automation.conditionsNotRead > 0 && (
        <p data-testid="automation-not-read" className="text-text-secondary">
          {t('forge.review.automation.notRead', {
            count: automation.conditionsNotRead,
            bound: automation.conditionsBound,
          })}
        </p>
      )}
      {definitionsNotRead > 0 && (
        <p data-testid="automation-definitions-not-read" className="text-text-secondary">
          {t('forge.review.automation.notReadDefinitions', {
            count: definitionsNotRead,
            bound: automation.definitionsBound ?? 0,
          })}
        </p>
      )}
      {automation.unread.map((unread) => (
        <p
          key={unread.part}
          data-testid={`automation-unread-${unread.part}`}
          className="text-status-warning"
        >
          {t(UNREAD_KEYS[unread.part], { reason: unread.reason })}
        </p>
      ))}
      <p data-testid="automation-cost" className="text-text-secondary">
        {t('forge.review.automation.cost', { count: automation.requests })}
      </p>
    </div>
  );
};

/** What may refuse a removal of the run's records, by its kind. */
const REMOVAL_RISK_KEYS: Readonly<Record<ForgeRemovalRisk['kind'], string>> = {
  flow: 'forge.review.automation.removalFlow',
  trigger: 'forge.review.automation.removalTrigger',
  packageTrigger: 'forge.review.automation.removalPackageTrigger',
  lock: 'forge.review.automation.removalLock',
};

/**
 * What may refuse a removal of the records the run creates, said before the
 * run, where no confirmation may come to say it: the flows before a delete,
 * the Apex triggers on one — a managed package's apart — and the objects
 * whose records lock past Draft. Once everything was read and none was found,
 * it says so; a part that could not be read leaves that unsaid.
 */
const RemovalRisks: React.FC<{
  automation: ForgeTargetAutomation;
  leftOut: ReadonlySet<string>;
  blind: boolean;
}> = ({ automation, leftOut, blind }) => {
  const { t } = useTranslation();
  const risks = removalRisksOf(automation, leftOut);
  if (risks.length === 0) {
    return blind ? null : (
      <p data-testid="automation-removal-none" className="text-text-secondary">
        {t('forge.review.automation.removalNone')}
      </p>
    );
  }
  return (
    <div
      data-testid="automation-removal"
      className="rounded-sm border border-subtle bg-surface-2 p-2 text-text-primary"
    >
      <p className="font-medium">{t('forge.review.automation.removalRisks')}</p>
      <ul className="ml-3 flex list-disc flex-col gap-0.5">
        {risks.map((risk) => (
          <li key={`${risk.objectApiName}-${risk.kind}-${risk.name ?? ''}`}>
            {t(REMOVAL_RISK_KEYS[risk.kind], { object: risk.objectApiName, name: risk.name })}
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * The assignment rule and the duplicate rules of an object: whether the run
 * lets the first apply, and what the second still refuse.
 */
const ObjectRules: React.FC<{
  object: ForgeTargetObjectAutomation;
  applyAssignmentRules: boolean;
}> = ({ object, applyAssignmentRules }) => {
  const { t } = useTranslation();
  const assignment = object.assignmentRules ?? [];
  const duplicates = object.duplicateRules ?? [];
  if (assignment.length === 0 && duplicates.length === 0) return null;
  // Under a heading of their own: listed straight after the writes, they read
  // as one more thing the last write fires.
  return (
    <div data-testid={`automation-${object.objectApiName}-rules`} className="mt-1">
      <p className="font-medium text-text-secondary">{t('forge.review.automation.rules')}</p>
      <ul className="ml-3 flex list-disc flex-col gap-0.5">
        {assignment.map((rule) => (
          <li key={`assignment-${rule.name}`} className="text-text-primary">
            {t('forge.review.automation.assignmentRule', { name: rule.name })}
            <span className="block text-text-secondary">
              {applyAssignmentRules
                ? t('forge.review.automation.assignmentApplied')
                : t('forge.review.automation.assignmentNotApplied')}
            </span>
          </li>
        ))}
        {duplicates.length > 0 && (
          <li className="text-text-primary">
            {t('forge.review.automation.duplicateRules', {
              count: duplicates.length,
              names: duplicates.map((rule) => rule.name).join(', '),
            })}
            <span className="block text-text-secondary">
              {t('forge.review.automation.duplicateNote')}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
};

/** A duration in the panel's language: "2 days", "2 jours", "2 日". */
function durationOf(offset: number, unit: string): string {
  const size = Math.abs(offset);
  const intlUnit = OFFSET_UNITS[unit];
  return intlUnit
    ? new Intl.NumberFormat(uiLocale(), {
        style: 'unit',
        unit: intlUnit,
        unitDisplay: 'long',
      }).format(size)
    : `${size} ${unit}`;
}

/** What runs of a flow once the save is committed, one path a line. */
const PathLine: React.FC<{ path: ForgeFlowPath }> = ({ path }) => {
  const { t } = useTranslation();
  let text: string;
  if (path.kind === 'async') {
    text = t('forge.review.automation.pathAsync');
  } else if (path.offset === undefined || path.unit === undefined) {
    text = t('forge.review.automation.pathScheduled');
  } else {
    const duration = durationOf(path.offset, path.unit);
    text =
      path.field === undefined
        ? t('forge.review.automation.pathScheduledAfterSave', { duration })
        : path.offset < 0
          ? t('forge.review.automation.pathScheduledBeforeField', { duration, field: path.field })
          : t('forge.review.automation.pathScheduledAfterField', { duration, field: path.field });
  }
  return <span className="block text-text-secondary">{text}</span>;
};

/** One flow, trigger, process or rule a write fires, with when it runs and what keeps it quiet. */
const FiredEntry: React.FC<{ entry: ForgeAutomationFired; write: ForgeAutomationWrite }> = ({
  entry,
  write,
}) => {
  const { t } = useTranslation();
  const flow = entry.flow;
  const permissions = flow?.permissions ?? [];
  const switches = flow?.switches ?? [];
  const messages = flow?.messages ?? [];
  const paths = flow?.paths ?? [];
  const startBypass = permissions.filter((p) => p.bypass && p.where !== 'decision');
  const decisionBypass = permissions.filter((p) => p.bypass && p.where === 'decision');
  const named = permissions.filter((p) => !p.bypass && p.where !== 'decision').map((p) => p.name);
  const tested = [
    ...permissions.filter((p) => !p.bypass && p.where === 'decision').map((p) => p.name),
    ...switches.filter((s) => !s.bypass).map((s) => s.reference),
  ];
  const bypassing = [...startBypass, ...decisionBypass];
  const heldNames = bypassing.filter((p) => p.held === true).map((p) => p.name);
  const notHeldNames = bypassing.filter((p) => p.held === false).map((p) => p.name);
  const when = WHEN_KEYS[write === 'delete' ? 'delete' : 'save'][entry.when];
  const isFlow = entry.kind === 'flow';
  return (
    <li className="text-text-primary">
      {t(KIND_KEYS[entry.kind], { name: entry.name })}
      <span className="text-text-secondary"> · {t(when)}</span>
      {messages.length > 0 && (
        <>
          {' '}
          <Badge variant="warning" data-testid="automation-sends-messages">
            {t('forge.review.automation.sendsMessages')}
          </Badge>
        </>
      )}
      {messages.map((message, index) => (
        <span key={`message-${index}`} className="block text-text-secondary">
          {t(MESSAGE_KEYS[message.kind], { name: message.name })}
        </span>
      ))}
      {paths.map((path, index) => (
        <PathLine key={`path-${index}`} path={path} />
      ))}
      {startBypass.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.notFor', {
            count: startBypass.length,
            names: startBypass.map((p) => p.name).join(', '),
          })}
        </span>
      )}
      {decisionBypass.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.notForDecision', {
            count: decisionBypass.length,
            names: decisionBypass.map((p) => p.name).join(', '),
          })}
        </span>
      )}
      {switches
        .filter((s) => s.bypass)
        .map((s) => (
          <span
            key={`switch-${s.where}-${s.reference}-${s.value ?? ''}`}
            className="block text-text-secondary"
          >
            {t(
              s.where === 'decision'
                ? s.value === undefined
                  ? 'forge.review.automation.switchDecisionTrue'
                  : 'forge.review.automation.switchDecisionValue'
                : s.value === undefined
                  ? 'forge.review.automation.switchStartTrue'
                  : 'forge.review.automation.switchStartValue',
              { reference: s.reference, value: s.value },
            )}
          </span>
        ))}
      {heldNames.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.heldBy', {
            count: heldNames.length,
            names: heldNames.join(', '),
          })}
        </span>
      )}
      {notHeldNames.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.notHeldBy', {
            count: notHeldNames.length,
            names: notHeldNames.join(', '),
          })}
        </span>
      )}
      {entry.keptQuiet && (
        <span className="block text-text-secondary">{t('forge.review.automation.keptQuiet')}</span>
      )}
      {named.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.named', { count: named.length, names: named.join(', ') })}
        </span>
      )}
      {tested.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.decisionsTest', {
            count: tested.length,
            names: tested.join(', '),
          })}
        </span>
      )}
      {flow?.condition === 'notRead' && (
        <span className="block text-text-secondary">
          {t(
            isFlow
              ? 'forge.review.automation.conditionNotRead'
              : 'forge.review.automation.definitionNotRead',
          )}
        </span>
      )}
      {flow?.condition === 'unreadable' && (
        <span className="block text-text-secondary">
          {t(
            isFlow
              ? 'forge.review.automation.conditionUnreadable'
              : 'forge.review.automation.definitionUnreadable',
          )}
        </span>
      )}
    </li>
  );
};
