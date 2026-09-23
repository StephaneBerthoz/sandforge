import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ForgeTemplate } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useForgeStore } from '../../stores/useForgeStore';

/** State and action returned by {@link useSaveForgeTemplate}. */
export interface ForgeTemplateSaver {
  /** Ask the extension to store the template (a new one, or one renamed). */
  save: (template: ForgeTemplate) => void;
  /** A save is waiting for the extension's answer. */
  saving: boolean;
  /** Why the last save failed, or null. */
  error: string | null;
  /** The template the last save stored, once the extension confirmed it. */
  saved: ForgeTemplate | null;
}

/**
 * Store a Forge template through the extension, which keeps it in the
 * workspace's `.sandforge/forge-templates.json` when a folder is open and in
 * its config store otherwise.
 *
 * The template joins the list the Template tab shows only once the extension
 * answered that it was stored: a list updated before the answer would show a
 * template that a failed write never kept.
 */
export function useSaveForgeTemplate(): ForgeTemplateSaver {
  const upsertTemplate = useForgeStore((s) => s.upsertTemplate);
  const mutation = useBridgeMutation<{ success: boolean }>('forge:templates:save', {
    errorType: 'forge:templates:save:error',
  });
  const { mutate } = mutation;
  const pending = useRef<ForgeTemplate | null>(null);
  const [saved, setSaved] = useState<ForgeTemplate | null>(null);

  useEffect(() => {
    if (mutation.data?.success && pending.current) {
      upsertTemplate(pending.current);
      setSaved(pending.current);
      pending.current = null;
    }
  }, [mutation.data, upsertTemplate]);

  const save = useCallback(
    (template: ForgeTemplate) => {
      pending.current = template;
      setSaved(null);
      mutate({ template });
    },
    [mutate],
  );

  return useMemo(
    () => ({ save, saving: mutation.loading, error: mutation.error, saved }),
    [save, mutation.loading, mutation.error, saved],
  );
}
