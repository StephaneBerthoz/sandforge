import { useCallback, useEffect, useRef } from 'react';

import { useBridgeMutation } from './useBridgeMutation';
import { useNotificationStore } from '../stores/useNotificationStore';
import { useTranslation } from 'react-i18next';

/** What the host answers to `file:save`. */
type SaveOutcome =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Save an export through the extension host, and report what actually happened.
 *
 * Every export in the product used to do this itself: build a Blob, create a
 * detached `<a>`, click it, revoke the object URL on the next line, and raise
 * a success toast with no branch and nothing to branch on. A VS Code webview
 * is sandboxed without `allow-downloads`, so the click frequently saved
 * nothing — and the user was told a file existed, was never told where, and
 * often had none.
 *
 * Only the host can open a Save dialog and write to disk. This asks it to, and
 * turns its three answers into the three things worth saying: where the file
 * went, nothing (the user cancelled), or why it failed.
 *
 * @returns `save(suggestedName, content, extensions?)`, and `saving` for
 *   disabling the control while the dialog is open.
 */
export function useFileSave(): {
  save: (suggestedName: string, content: string, extensions?: string[]) => void;
  saving: boolean;
} {
  const { t } = useTranslation();
  const addNotification = useNotificationStore((s) => s.addNotification);
  const mutation = useBridgeMutation<SaveOutcome>('file:save', {
    responseType: 'file:save:response',
  });

  // The outcome is announced once per answer, never per click.
  const announced = useRef<SaveOutcome | null>(null);
  useEffect(() => {
    const outcome = mutation.data;
    if (!outcome || announced.current === outcome) return;
    announced.current = outcome;

    if (outcome.status === 'cancelled') return; // dismissing a dialog is not news
    if (outcome.status === 'error') {
      addNotification({
        level: 'error',
        title: t('common.export'),
        message: outcome.message,
        autoDismissMs: 5000,
      });
      return;
    }
    addNotification({
      level: 'success',
      title: t('common.export'),
      // The path is the point: the toast this replaces claimed a download and
      // never said where it went.
      message: t('common.exportSaved', { path: outcome.path }),
      autoDismissMs: 4000,
    });
  }, [mutation.data, addNotification, t]);

  useEffect(() => {
    if (!mutation.error) return;
    addNotification({
      level: 'error',
      title: t('common.export'),
      message: mutation.error,
      autoDismissMs: 5000,
    });
  }, [mutation.error, addNotification, t]);

  const save = useCallback(
    (suggestedName: string, content: string, extensions?: string[]) => {
      mutation.mutate({ suggestedName, content, ...(extensions ? { extensions } : {}) });
    },
    [mutation],
  );

  return { save, saving: mutation.loading };
}
