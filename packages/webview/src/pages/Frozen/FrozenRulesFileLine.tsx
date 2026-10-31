import React, { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FilePlus, FileText } from 'lucide-react';
import type { FrozenRulesCreateResponse, FrozenRulesFileInfo } from '@sandforge/shared';

import { Button } from '../../components/ui/Button';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';

/** The Frozen Dataset page of the docs, at the address the README links it by. */
const FROZEN_DOCS_URL =
  'https://github.com/StephaneBerthoz/sandforge/blob/master/docs/modules/frozen-dataset.md';

/** The docs' section on the rules file: its keys, its generators, an example. */
export const RULES_FORMAT_URL = `${FROZEN_DOCS_URL}#the-rules-file`;

/** The docs' table of the configuration keys the advanced JSON takes. */
export const CONFIGURATION_KEYS_URL = `${FROZEN_DOCS_URL}#configuration`;

/** Props for {@link FrozenRulesFileLine}. */
export interface FrozenRulesFileLineProps {
  /** The rules file as `frozen:status` read it; nothing is drawn before it is read. */
  rules: FrozenRulesFileInfo | undefined;
  /** Id of the sentence saying why Run extraction cannot run: the file missing, or unreadable. */
  blockingId: string;
  /** Read the status again once the file is written. */
  onCreated: () => void;
}

/**
 * The pseudonymization rules file on the Extraction card: where it is, what
 * it holds, a button that writes it when it is missing — empty, which clears
 * every field without a rule — or opens it when it is there, and a link to
 * its format.
 *
 * An extraction is refused without the file, and the card showed only the
 * salt: nothing said where the file goes, what it holds, or made one. A
 * first-time user picked Frozen from the tour and was stuck after the
 * selection.
 */
export const FrozenRulesFileLine: React.FC<FrozenRulesFileLineProps> = ({
  rules,
  blockingId,
  onCreated,
}) => {
  const { t } = useTranslation();
  const hintId = useId();
  const create = useBridgeMutation<FrozenRulesCreateResponse['payload']>('frozen:rules:create', {
    errorType: 'frozen:rules:create:error',
  });
  const written = create.data;
  const answered = written?.rulesPath;
  useEffect(() => {
    if (answered !== undefined) onCreated();
  }, [answered, onCreated]);

  if (!rules) return null;
  const valid = rules.found && rules.invalid === undefined;

  return (
    <div className="flex flex-col gap-1" data-testid="frozen-rules-file">
      {valid ? (
        <p className="text-xs text-text-secondary wrap-break-word" data-testid="frozen-rules-found">
          {t('frozen.rulesFile.found', {
            path: rules.path,
            version: rules.rulesVersion ?? '',
            count: rules.ruleCount ?? 0,
          })}
        </p>
      ) : (
        <p
          id={blockingId}
          className="text-xs text-status-warning wrap-break-word"
          data-testid={rules.found ? 'frozen-rules-invalid' : 'frozen-rules-missing'}
        >
          {rules.found
            ? t('frozen.rulesFile.invalid', { path: rules.path, reason: rules.invalid ?? '' })
            : t('frozen.rulesFile.missing', { path: rules.path })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {rules.found ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="w-3 h-3" />}
            loading={create.loading}
            onClick={() => create.mutate()}
            data-testid="frozen-rules-open"
          >
            {t('frozen.rulesFile.open')}
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<FilePlus className="w-3 h-3" />}
              loading={create.loading}
              aria-describedby={hintId}
              onClick={() => create.mutate()}
              data-testid="frozen-rules-create"
            >
              {t('frozen.rulesFile.create')}
            </Button>
            <span id={hintId} className="text-[11px] text-text-secondary">
              {t('frozen.rulesFile.createHint')}
            </span>
          </>
        )}
        {/* In the text's own colour, told apart by its underline and its
            icon, as the error hints' links are: the theme's link blue does
            not read 4.5:1 on every surface. */}
        <a
          href={RULES_FORMAT_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-text-primary underline"
          data-testid="frozen-rules-format"
        >
          {t('frozen.rulesFile.format')}
          <ExternalLink size={10} aria-hidden="true" className="shrink-0" />
        </a>
      </div>
      {written && !written.opened && (
        <p
          role="status"
          className="text-[11px] text-text-secondary"
          data-testid="frozen-rules-not-opened"
        >
          {t('frozen.rulesFile.notOpened', { path: written.rulesPath })}
        </p>
      )}
      {create.error && (
        <p role="alert" className="text-[11px] text-status-error" data-testid="frozen-rules-failed">
          {t('frozen.rulesFile.failed', { reason: create.error })}
        </p>
      )}
    </div>
  );
};
