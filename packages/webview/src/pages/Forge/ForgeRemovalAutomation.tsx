import React, { useCallback, useEffect, useId, useState } from 'react';
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
import { BypassAssistant, ReadAgainButton } from './BypassAssistant';

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
  flow: 'orgAutomation.flow',
  trigger: 'orgAutomation.trigger',
  process: 'orgAutomation.process',
  workflowRule: 'orgAutomation.workflowRule',
};

/** When what fires on a delete runs. */
export const DELETE_WHEN_KEYS: Readonly<Record<ForgeFiredOnWrite['when'], string>> = {
  before: 'orgAutomation.beforeDelete',
  after: 'orgAutomation.afterDelete',
  beforeAndAfter: 'orgAutomation.beforeAndAfterDelete',
};

/**
 * The parts of the read whose refusal leaves what fires unknown, and the
 * permission sets a bypass's command is read from, as the Automation tab
 * says each.
 */
const UNREAD_KEYS: Partial<Record<ForgeTargetAutomationUnread['part'], string>> = {
  flows: 'orgAutomation.unreadFlows',
  triggers: 'orgAutomation.unreadTriggers',
  processes: 'orgAutomation.unreadProcesses',
  workflowRules: 'orgAutomation.unreadWorkflowRules',
  permissionSets: 'orgAutomation.unreadPermissionSets',
};

/** The words of Forge's removal section, as the confirmation of a run's removal says them. */
const FORGE_WORDS: RemovalAutomationWords = {
  title: 'runRemoval.automation.title',
  loading: 'runRemoval.automation.loading',
  intro: 'runRemoval.automation.intro',
  none: 'runRemoval.automation.none',
  error: 'runRemoval.automation.error',
};

/** The keys of what a removal's automation section says, each taking `{{org}}`. */
export interface RemovalAutomationWords {
  title: string;
  loading: string;
  intro: string;
  none: string;
  /** Takes `{{reason}}` too. */
  error: string;
}

/** One flow, trigger, process or rule a removal fires, and why it runs. */
export interface RemovalAutomationEntry {
  /** What writes the record, as the entry's test id and key name it: the write, or the removal's step. */
  part: string;
  fired: ForgeFiredOnWrite;
  /** When it runs, or what the removal writes its record for, as a key. */
  whyKey: string;
}

/** What a read found, as {@link RemovalAutomationView} shows it. */
export interface RemovalAutomationShown {
  automation: ForgeTargetAutomation;
  entries: RemovalAutomationEntry[];
  /** The bypasses of what fires, held or not: those not held come with their command. */
  bypasses: string[];
}

/** Props for {@link RemovalAutomationView}. */
export interface RemovalAutomationViewProps {
  /** Test id of the section, and the start of each of its parts'. */
  testId: string;
  /** The org written to, as the user knows it. */
  org: string;
  /** The org written to, by its id in the registry: the user the command names is its. */
  targetOrgId: string | undefined;
  words: RemovalAutomationWords;
  /** What the last read found; undefined while none answered for what is confirmed. */
  shown: RemovalAutomationShown | undefined;
  /** Why the read failed, when it did. */
  error: string | null;
  /** Whether a read is on its way. */
  reading: boolean;
  onReadAgain: () => void;
}

/**
 * What a removal's confirmation says the target runs as the removal writes,
 * listed before the user types the org's name: each flow, trigger, process
 * and rule that fires, and why — or that nothing does; what could not be
 * read; and, for a bypass the user does not hold, the permission set that
 * would keep it quiet and the command that assigns it. The read shown stays
 * while the one asked for again is on its way.
 */
export const RemovalAutomationView: React.FC<RemovalAutomationViewProps> = ({
  testId,
  org,
  targetOrgId,
  words,
  shown,
  error,
  reading,
  onReadAgain,
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const target = useOrgStore((s) => s.orgs.find((o) => o.id === targetOrgId));
  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="flex flex-col items-start gap-1">
        <p data-testid={`${testId}-error`} className="text-status-warning">
          {t(words.error, { org, reason: error })}
        </p>
        <ReadAgainButton
          label={t('orgAutomation.readAgain')}
          onReadAgain={onReadAgain}
          reading={reading}
          testId={`${testId}-read-again`}
        />
      </div>
    );
  } else if (!shown) {
    body = (
      <p data-testid={`${testId}-loading`} className="text-text-secondary">
        {t(words.loading, { org })}
      </p>
    );
  } else {
    const { automation, entries } = shown;
    const unread = automation.unread.filter((u) => UNREAD_KEYS[u.part] !== undefined);
    const held = heldBypassPermissionsOf(automation);
    const toAssign = shown.bypasses.filter((name) => !held.includes(name));
    body = (
      <>
        {entries.length > 0 ? (
          <>
            <p>{t(words.intro, { org })}</p>
            <ul className="ml-3 flex list-disc flex-col gap-0.5">
              {entries.map(({ part, fired, whyKey }) => (
                <li
                  key={`${part}-${fired.objectApiName}-${fired.kind}-${fired.name}`}
                  data-testid={`${testId}-${part}-${fired.objectApiName}`}
                >
                  <span className="font-mono">{fired.objectApiName}</span>
                  {': '}
                  {t(KIND_KEYS[fired.kind], { name: fired.name })}
                  <span className="text-text-secondary">
                    {' · '}
                    {t(whyKey)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          unread.length === 0 && <p data-testid={`${testId}-none`}>{t(words.none, { org })}</p>
        )}
        {unread.map((u) => (
          <p
            key={u.part}
            data-testid={`${testId}-unread-${u.part}`}
            className="text-status-warning"
          >
            {t(UNREAD_KEYS[u.part] ?? '', { reason: u.reason })}
          </p>
        ))}
        {toAssign.length > 0 && (
          <div data-testid={`${testId}-bypass`}>
            <p>
              {t('orgAutomation.bypassHint', {
                count: toAssign.length,
                names: toAssign.join(', '),
              })}
            </p>
            <BypassAssistant
              assignments={bypassAssignmentsOf(automation, toAssign)}
              {...(target?.alias && target.username
                ? { target: { alias: target.alias, username: target.username } }
                : {})}
              onReadAgain={onReadAgain}
              readingAgain={reading}
            />
          </div>
        )}
      </>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="mt-2 flex flex-col gap-1 text-[11px] text-text-primary"
    >
      <h4 id={headingId} className="text-[11px] font-semibold">
        {t(words.title, { org })}
      </h4>
      {body}
    </section>
  );
};

/** Props for {@link ForgeRemovalAutomation}. */
export interface ForgeRemovalAutomationProps {
  /** The run whose removal is being confirmed; nothing is read while there is none. */
  forgeId: string | undefined;
  /** The org it wrote to, as the user knows it. */
  org: string;
  /** The org it wrote to, by its id in the registry: the user the command names is its. */
  targetOrgId: string | undefined;
  /** The removal takes every record the run created (`again`): read on the objects of each. */
  again?: boolean;
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
 *
 * The target is read again when the user asks, as Review's Automation tab
 * reads it: the confirmation showed what it read as it opened, and a bypass
 * assigned with the command it copied showed as not held until it was opened
 * again. The read shown stays until the answer lands.
 */
export const ForgeRemovalAutomation: React.FC<ForgeRemovalAutomationProps> = ({
  forgeId,
  org,
  targetOrgId,
  again = false,
}) => {
  const read = useBridgeMutation<RemovalAutomationAnswer>('forge:undo-automation:request', {
    responseType: 'forge:undo-automation:response',
    errorType: 'forge:undo-automation:error',
    timeoutMs: READ_TIMEOUT_MS,
  });
  const { mutate, reset } = read;
  // A new request clears the answer it waits on: the last one is kept, and
  // shown while the read asked for again is on its way — never once the
  // confirmation closed or turned to another run.
  const [lastRead, setLastRead] = useState<RemovalAutomationAnswer | null>(null);
  useEffect(() => {
    setLastRead(null);
    if (forgeId) mutate({ forgeId, ...(again ? { again: true } : {}) });
    else reset();
  }, [forgeId, again, mutate, reset]);
  useEffect(() => {
    if (read.data) setLastRead(read.data);
  }, [read.data]);
  const answer = read.data ?? lastRead;
  const readAgain = useCallback(() => {
    if (forgeId) mutate({ forgeId, ...(again ? { again: true } : {}) });
  }, [forgeId, again, mutate]);

  if (!forgeId) return null;
  const shown =
    answer && answer.forgeId === forgeId
      ? {
          automation: answer.automation,
          entries: firedOnRemovalOf(answer.automation, answer.drafted).map((fired) => ({
            part: fired.write,
            fired,
            whyKey:
              fired.write === 'delete'
                ? DELETE_WHEN_KEYS[fired.when]
                : 'runRemoval.automation.drafted',
          })),
          bypasses: removalBypassesOf(answer.automation, answer.drafted),
        }
      : undefined;
  return (
    <RemovalAutomationView
      testId="forge-removal-automation"
      org={org}
      targetOrgId={targetOrgId}
      words={FORGE_WORDS}
      shown={shown}
      error={read.error}
      reading={read.loading}
      onReadAgain={readAgain}
    />
  );
};
