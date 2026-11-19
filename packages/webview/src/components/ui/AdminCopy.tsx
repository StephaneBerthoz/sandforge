import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';

/** Props of {@link AdminCopy}. */
export interface AdminCopyProps {
  /** The list as it is copied: a heading, then a step a line. */
  text: string;
  /** What the test ids of the button and its status begin with. */
  testId: string;
  /** The words of the button; absent, those of a list for the target's admin. */
  labelKey?: string;
  /** What the words of the button are given, such as how many objects the list names. */
  labelValues?: Record<string, string | number>;
}

/**
 * A button that copies, for whoever administers an org, the changes to make
 * in its Setup, with the word it says once the copy is done. Nothing is
 * claimed copied when the host refuses the clipboard. Forge's Review, Seed's
 * clone, Autopilot's objects and Frozen's load said what an admin would
 * change, and the user had to write it out again to hand it over.
 *
 * Its words are in `adminCopy`, a namespace each page that draws it loads
 * (PanelRouter, forgeSteps.ts).
 */
export const AdminCopy: React.FC<AdminCopyProps> = ({
  text,
  testId,
  labelKey = 'adminCopy.copy',
  labelValues,
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
    void clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (resetTimer.current) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {
        // Refused by the host: no copy is claimed that never happened.
      },
    );
  }, [text]);
  return (
    <span className="flex items-center gap-2">
      <Button variant="secondary" size="sm" data-testid={testId} onClick={copy}>
        {t(labelKey, labelValues)}
      </Button>
      <span role="status" data-testid={`${testId}-copied`} className="text-text-secondary">
        {copied ? t('adminCopy.copied') : ''}
      </span>
    </span>
  );
};
