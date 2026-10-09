import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { assignPermsetCommand } from '@sandforge/shared';
import type { ForgeGapAssignment } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';

/** The target org by the alias SandForge knows it by, and the user a run writes to it as. */
export interface BypassTarget {
  alias: string;
  username: string;
}

/** Props for {@link BypassAssistant}. */
export interface BypassAssistantProps {
  /**
   * The bypasses the user does not hold, with what the read found to assign
   * each: a flow's, as the automation read found them, or a validation
   * rule's, as its gap holds them — the permission sets by name alone.
   */
  assignments: readonly ForgeGapAssignment[];
  /** The org and the user the command names; without them no command is shown. */
  target?: BypassTarget;
  /**
   * Read the target again, once the command has run: what the read found
   * stands until then, the bypass shown as not held. Without it, nothing
   * offers to.
   */
  onReadAgain?: () => void;
  /** The read asked for with {@link onReadAgain} is on its way. */
  readingAgain?: boolean;
}

/**
 * What would give the user a run writes as a bypass it does not hold: the
 * smallest permission set of the target that includes it, the others that
 * do, and the Salesforce CLI command that assigns it, with a button that
 * copies it and one that reads the target again once it has run — or, when
 * no permission set holds it, that an admin creates one.
 *
 * The command is shown, never run: assigning a permission is the org's
 * admin's to decide. A client's sandbox kept its flows quiet for the users
 * who held a custom permission, which no one had assigned to the user that
 * cloned into it; the tab named the permission and left finding what holds
 * it to the user.
 */
export const BypassAssistant: React.FC<BypassAssistantProps> = ({
  assignments,
  target,
  onReadAgain,
  readingAgain = false,
}) => {
  const { t } = useTranslation();
  if (assignments.length === 0) return null;
  const commanded = target !== undefined && assignments.some((a) => a.permissionSet);
  return (
    <div data-testid="bypass-assistant" className="mt-1.5 flex flex-col gap-1.5">
      <ul className="flex flex-col gap-1.5">
        {assignments.map((assignment) => (
          <AssignmentItem key={assignment.permission} assignment={assignment} target={target} />
        ))}
      </ul>
      {commanded && (
        <p className="text-text-secondary">{t('forge.review.automation.assistant.neverRun')}</p>
      )}
      {/* The command runs outside the panel, which cannot tell when it has:
          the user, having run it, asks for the target to be read again. */}
      {commanded && onReadAgain && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-text-secondary">
            {t('forge.review.automation.assistant.readAgainHint')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={12} aria-hidden="true" />}
            loading={readingAgain}
            focusableWhenDisabled
            onClick={onReadAgain}
            data-testid="bypass-assistant-read-again"
          >
            {readingAgain
              ? t('forge.review.automation.readingAgain')
              : t('forge.review.automation.assistant.readAgain')}
          </Button>
        </div>
      )}
    </div>
  );
};

/** One bypass: the permission set that holds it and its command, or that none does. */
const AssignmentItem: React.FC<{ assignment: ForgeGapAssignment; target?: BypassTarget }> = ({
  assignment,
  target,
}) => {
  const { t } = useTranslation();
  const { permission, permissionSet, others } = assignment;
  if (!permissionSet) {
    return (
      <li data-testid={`bypass-assistant-${permission}`}>
        {t('forge.review.automation.assistant.none', { permission })}
      </li>
    );
  }
  const command = target
    ? assignPermsetCommand(permissionSet.name, target.alias, target.username)
    : undefined;
  return (
    <li data-testid={`bypass-assistant-${permission}`}>
      {t('forge.review.automation.assistant.smallest', {
        permissionSet: permissionSet.name,
        permission,
      })}
      {others.length > 0 && (
        <span className="block text-text-secondary">
          {t('forge.review.automation.assistant.others', {
            count: others.length,
            names: others.map((other) => other.name).join(', '),
          })}
        </span>
      )}
      {command && <CommandLine command={command} permissionSet={permissionSet.name} />}
    </li>
  );
};

/** The command, and a button that copies it; a status line says once it was copied. */
const CommandLine: React.FC<{ command: string; permissionSet: string }> = ({
  command,
  permissionSet,
}) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
  const copy = useCallback(() => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(command).then(
      () => {
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Refused by the host: no copy is claimed that never happened.
      },
    );
  }, [command]);
  const label = t('forge.review.automation.assistant.copy', { permissionSet });
  return (
    <span className="mt-0.5 flex items-start gap-1">
      <code
        data-testid="bypass-assistant-command"
        className="min-w-0 flex-1 break-all rounded-sm bg-surface-1 px-1 py-0.5 font-mono text-text-primary"
      >
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        title={label}
        data-testid="bypass-assistant-copy"
        className="shrink-0 p-0.5 text-text-secondary hover:text-text-primary"
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      </button>
      <span role="status" className="sr-only">
        {copied ? t('forge.review.automation.assistant.copied') : ''}
      </span>
    </span>
  );
};
