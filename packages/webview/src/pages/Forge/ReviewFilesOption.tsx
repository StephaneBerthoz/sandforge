import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FILE_COPY_CEILING_MB } from '@sandforge/shared';
import { useForgeStore } from '../../stores/useForgeStore';
import { cn } from '../../theme';

/** Id of the sentence that says why the run waits for the files to be accepted. */
const FILES_AS_IS_WARNING_ID = 'forge-files-as-is-warning';

/** A size typed in the field, as the store takes it, or null when it is not one. */
function sizeOf(draft: string): number | null {
  if (!/^\d+$/.test(draft.trim())) return null;
  const size = Number(draft);
  return size >= 1 && size <= FILE_COPY_CEILING_MB ? size : null;
}

/**
 * Whether the run may not start for the files: it copies them, it anonymizes
 * its records, and the user has not accepted that files are copied as they are.
 */
export function filesBlockExecute(state: {
  fileCopy: { enabled: boolean; acceptedAsIs: boolean };
  config: { anonymizePII: boolean } | null;
}): boolean {
  return (
    state.fileCopy.enabled && (state.config?.anonymizePII ?? false) && !state.fileCopy.acceptedAsIs
  );
}

/**
 * The run's choice, in Review, to copy the files of the records it clones.
 *
 * Off until the user turns it on. On, it takes the size of the largest file
 * copied, and — when the run anonymizes its records — asks, in a confirmation
 * of its own, that the user accept the files are copied as they are: the
 * content of a file cannot be anonymized, and the anonymization of the
 * records says nothing about it.
 */
export const ReviewFilesOption: React.FC = () => {
  const { t } = useTranslation();
  const fileCopy = useForgeStore((s) => s.fileCopy);
  const setFileCopy = useForgeStore((s) => s.setFileCopy);
  const anonymizes = useForgeStore((s) => s.config?.anonymizePII ?? false);
  const descriptionId = useId();
  const sizeId = useId();
  const sizeHintId = useId();
  const [draft, setDraft] = useState(String(fileCopy.maxFileSizeMB));

  // A size set elsewhere — a new run starting from the default — shows here.
  useEffect(() => {
    setDraft(String(fileCopy.maxFileSizeMB));
  }, [fileCopy.maxFileSizeMB]);

  const sizeRefused = sizeOf(draft) === null;

  return (
    <fieldset
      data-testid="forge-files-option"
      className="rounded-lg border border-subtle bg-surface-1 px-3 pb-3 pt-1 flex flex-col gap-2"
    >
      <legend className="px-1 text-xs font-semibold text-text-primary">
        {t('forge.files.title')}
      </legend>
      <label className="flex items-start gap-2 text-xs text-text-primary">
        <input
          type="checkbox"
          data-testid="forge-files-toggle"
          checked={fileCopy.enabled}
          onChange={(e) => setFileCopy({ enabled: e.target.checked })}
          aria-describedby={descriptionId}
          className="mt-0.5"
        />
        <span>{t('forge.files.toggle')}</span>
      </label>
      <p id={descriptionId} className="text-[11px] text-text-secondary">
        {t('forge.files.description')}
      </p>

      {fileCopy.enabled && (
        <>
          <div className="flex items-center gap-2">
            <label htmlFor={sizeId} className="text-xs text-text-primary">
              {t('forge.files.maxSize')}
            </label>
            <input
              id={sizeId}
              type="number"
              inputMode="numeric"
              min={1}
              max={FILE_COPY_CEILING_MB}
              step={1}
              value={draft}
              data-testid="forge-files-max-size"
              aria-describedby={sizeHintId}
              aria-invalid={sizeRefused}
              onChange={(e) => setDraft(e.target.value)}
              // Taken once the field is left, never keystroke by keystroke:
              // typing 50 over 10 goes through 5, a size of its own, which
              // was kept when 50 was refused and went with the run. A size
              // refused gives the field back the last one taken.
              onBlur={() => {
                const size = sizeOf(draft);
                if (size !== null) setFileCopy({ maxFileSizeMB: size });
                setDraft(String(size ?? fileCopy.maxFileSizeMB));
              }}
              className={cn(
                'w-20 px-2 py-1 rounded-sm text-xs',
                'bg-(--sf-bg-input) text-(--sf-text-input)',
                'border',
                sizeRefused ? 'border-status-error/60' : 'border-(--sf-border-input)',
              )}
            />
          </div>
          <p id={sizeHintId} className="text-[11px] text-text-secondary">
            {t('forge.files.maxSizeHint', { max: FILE_COPY_CEILING_MB })}
          </p>

          {anonymizes && (
            <div
              data-testid="forge-files-as-is"
              className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-text-primary flex flex-col gap-1.5"
            >
              <p id={FILES_AS_IS_WARNING_ID}>{t('forge.files.asIsWarning')}</p>
              <label className="flex items-start gap-2 font-medium">
                <input
                  type="checkbox"
                  data-testid="forge-files-as-is-accept"
                  checked={fileCopy.acceptedAsIs}
                  onChange={(e) => setFileCopy({ acceptedAsIs: e.target.checked })}
                  aria-describedby={FILES_AS_IS_WARNING_ID}
                  className="mt-0.5"
                />
                <span>{t('forge.files.asIsAccept')}</span>
              </label>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
};
