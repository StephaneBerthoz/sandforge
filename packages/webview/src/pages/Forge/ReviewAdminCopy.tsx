import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';

/** Props of {@link ReviewAdminCopy}. */
export interface ReviewAdminCopyProps {
  /** The list as it is copied: a heading, then a step a line. */
  text: string;
  /** What the test ids of the button and its status begin with. */
  testId: string;
  /** The words of the button; absent, those of a list for the target's admin. */
  labelKey?: string;
}

/**
 * A button that copies, for whoever administers an org, the changes to make
 * in its Setup, with the word it says once the copy is done. Nothing is
 * claimed copied when the host refuses the clipboard. Review's lists of
 * objects left out and of metadata differences said what an admin would
 * change, and the user had to write it out again to hand it over.
 */
export const ReviewAdminCopy: React.FC<ReviewAdminCopyProps> = ({
  text,
  testId,
  labelKey = 'forgeRun.gaps.admin.copy',
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
        {t(labelKey)}
      </Button>
      <span role="status" data-testid={`${testId}-copied`} className="text-text-secondary">
        {copied ? t('forgeRun.gaps.admin.copied') : ''}
      </span>
    </span>
  );
};
