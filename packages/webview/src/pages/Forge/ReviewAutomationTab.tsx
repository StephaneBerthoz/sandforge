import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ForgeAutomationFired,
  ForgeAutomationWrite,
  ForgeTargetAutomation,
  ForgeTargetAutomationUnread,
} from '@sandforge/shared';
import { automationByWrite, bypassPermissionsOf } from '@sandforge/shared';

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

/** What could not be read, part by part. */
const UNREAD_KEYS: Readonly<Record<ForgeTargetAutomationUnread['part'], string>> = {
  flows: 'forge.review.automation.unreadFlows',
  triggers: 'forge.review.automation.unreadTriggers',
  conditions: 'forge.review.automation.unreadConditions',
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
}

/**
 * Automation tab within the Forge Review phase: what the target org runs on
 * the records the run writes, write by write — its record-triggered flows and
 * Apex triggers — and the custom permissions that keep a flow from starting
 * for the user who holds them.
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
  const bypass = bypassPermissionsOf({ objects });
  // A part that could not be read leaves "nothing fires" unsaid: nothing was
  // seen there, which is not the same.
  const blind = automation.unread.some((unread) => unread.part !== 'conditions');

  return (
    <div data-testid="review-automation-tab" className="flex flex-col gap-2 text-xs">
      <p data-testid="automation-summary" className="text-text-secondary">
        {objects.length > 0
          ? t('forge.review.automation.intro')
          : blind
            ? t('forge.review.automation.nothingSeen')
            : t('forge.review.automation.none', { count: written })}
      </p>
      {bypass.length > 0 && (
        <p
          data-testid="automation-bypass"
          className="rounded-sm border border-subtle bg-surface-2 p-2 text-text-primary"
        >
          {t('forge.review.automation.bypassHint', {
            count: bypass.length,
            names: bypass.join(', '),
          })}
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
        </section>
      ))}
      {automation.conditionsNotRead > 0 && (
        <p data-testid="automation-not-read" className="text-text-secondary">
          {t('forge.review.automation.notRead', {
            count: automation.conditionsNotRead,
            bound: automation.conditionsBound,
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

/** One flow or trigger a write fires, with when it runs and what keeps it quiet. */
const FiredEntry: React.FC<{ entry: ForgeAutomationFired; write: ForgeAutomationWrite }> = ({
  entry,
  write,
}) => {
  const { t } = useTranslation();
  const permissions = entry.flow?.permissions ?? [];
  const bypass = permissions.filter((p) => p.bypass).map((p) => p.name);
  const named = permissions.filter((p) => !p.bypass).map((p) => p.name);
  const when = WHEN_KEYS[write === 'delete' ? 'delete' : 'save'][entry.when];
  return (
    <li className="text-text-primary">
      {entry.kind === 'flow'
        ? t('forge.review.automation.flow', { name: entry.name })
        : t('forge.review.automation.trigger', { name: entry.name })}
      <span className="text-text-secondary"> · {t(when)}</span>
      {bypass.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.notFor', { count: bypass.length, names: bypass.join(', ') })}
        </span>
      )}
      {named.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.named', { count: named.length, names: named.join(', ') })}
        </span>
      )}
      {entry.flow?.condition === 'notRead' && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.conditionNotRead')}
        </span>
      )}
      {entry.flow?.condition === 'unreadable' && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.conditionUnreadable')}
        </span>
      )}
    </li>
  );
};
