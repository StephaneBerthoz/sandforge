import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { FrozenLoadAutomationEntry, FrozenLoadAutomationInfo } from '@sandforge/shared';

/** Props for {@link FrozenLoadAutomation}. */
export interface FrozenLoadAutomationProps {
  automation: FrozenLoadAutomationInfo;
  /** The org the load writes to, as the user knows it. */
  org: string;
  testId: string;
}

/** How each kind of automation is named, with its name. */
const KIND_KEYS: Readonly<Record<FrozenLoadAutomationEntry['kind'], string>> = {
  flow: 'orgAutomation.flow',
  trigger: 'orgAutomation.trigger',
  process: 'orgAutomation.process',
  workflowRule: 'orgAutomation.workflowRule',
};

/** How a part of the read that could not be read is said, with why. */
const UNREAD_KEYS: Readonly<
  Record<
    Exclude<NonNullable<FrozenLoadAutomationInfo['unread']>[number]['part'], 'automation'>,
    string
  >
> = {
  flows: 'orgAutomation.unreadFlows',
  triggers: 'orgAutomation.unreadTriggers',
  processes: 'orgAutomation.unreadProcesses',
  workflowRules: 'orgAutomation.unreadWorkflowRules',
};

/** One automation, its object and the writes of the load it runs on, in words. */
function entryWords(entry: FrozenLoadAutomationEntry, t: TFunction): string {
  const what = t(KIND_KEYS[entry.kind], { name: entry.name });
  const key =
    entry.writes.length > 1
      ? 'frozen.preview.automation.onInsertAndUpdate'
      : entry.writes[0] === 'update'
        ? 'frozen.preview.automation.onUpdate'
        : 'frozen.preview.automation.onInsert';
  return t(key, { object: entry.objectApiName, what });
}

/**
 * What the target runs as a load inserts its records and updates them, as
 * its preview reads it: each flow, Apex trigger, process and workflow rule,
 * what could not be read, and whether a load would be refused for it or goes
 * with the box ticked. A load read it only for its emails: a flow that sent
 * none ran unasked, and no page named it.
 */
export const FrozenLoadAutomation: React.FC<FrozenLoadAutomationProps> = ({
  automation,
  org,
  testId,
}) => {
  const { t } = useTranslation();
  const verdict = automation.refused
    ? t('frozen.preview.automation.refused', { org })
    : automation.accepted
      ? t('frozen.preview.automation.accepted', { org })
      : undefined;
  return (
    <div className="flex flex-col gap-1 text-[11px] text-text-primary" data-testid={testId}>
      <p>{t('frozen.preview.automation.title', { org })}</p>
      {automation.firing.length > 0 && (
        <ul className="flex flex-col gap-0.5 pl-3" data-testid={`${testId}-firing`}>
          {automation.firing.map((entry) => (
            <li key={`${entry.objectApiName}:${entry.kind}:${entry.name}`}>
              {entryWords(entry, t)}
            </li>
          ))}
        </ul>
      )}
      {(automation.unread ?? []).map(({ part, reason }) => (
        <p key={part} className="text-text-secondary" data-testid={`${testId}-unread-${part}`}>
          {part === 'automation'
            ? t('frozen.preview.automation.unread', { org, reason })
            : t(UNREAD_KEYS[part], { reason })}
        </p>
      ))}
      {verdict !== undefined && <p data-testid={`${testId}-verdict`}>{verdict}</p>}
    </div>
  );
};
