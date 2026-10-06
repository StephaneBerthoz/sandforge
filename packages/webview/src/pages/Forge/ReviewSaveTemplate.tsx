import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';
import { useForgeStore } from '../../stores/useForgeStore';
import { templateFromRun } from './forgeRunConfig';
import { useSaveForgeTemplate } from './useSaveForgeTemplate';

/**
 * Save the run on Review as a template, before it writes anything: its input
 * and options, the objects it leaves out, the decisions taken on its gaps, its
 * anonymization down to the fields, its file copy and its target org — the
 * template the results save once it has run.
 *
 * A template used to be saved from the results alone: a run whose gaps had
 * been decided, then simulated, had to be run for real before its decisions
 * could be kept.
 */
export const ReviewSaveTemplate: React.FC = () => {
  const { t } = useTranslation();
  const config = useForgeStore((s) => s.config);
  const saver = useSaveForgeTemplate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameMissing, setNameMissing] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // The form opens on its first field, and a finished save hands focus back
  // to the button that opened it: the form, and its field, are gone.
  useEffect(() => {
    if (open) nameRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!saver.saved) return;
    setOpen(false);
    setName('');
    setDescription('');
    openerRef.current?.focus();
  }, [saver.saved]);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    // Enter in a field submits too, and a second save in flight would store
    // the run twice, under two ids.
    const state = useForgeStore.getState();
    if (!state.config || saver.saving) return;
    if (!name.trim()) {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    const included = (state.graph?.nodes ?? []).filter((node) => node.included);
    const savedAt = new Date().toISOString();
    saver.save(
      templateFromRun({
        id: `tpl-${Date.now()}`,
        name,
        description,
        config: state.config,
        anonymizationRules: state.anonymizationRules,
        anonymizationPresetId: state.anonymizationPresetId,
        objectCount: included.length,
        recordCount:
          state.plan?.totalRecords ?? included.reduce((sum, node) => sum + node.recordCount, 0),
        savedAt,
        graph: state.graph,
        fileCopy: state.fileCopy,
      }),
    );
  };

  const inputClass = cn(
    'px-3 py-1.5 rounded-md text-sm',
    'bg-(--sf-bg-input) text-(--sf-text-input)',
    'border',
    'focus:outline-hidden focus:border-forge/50',
  );

  return (
    <div
      data-testid="review-save-template"
      className="flex flex-col gap-2 border-t border-subtle pt-2"
    >
      <div>
        <Button
          ref={openerRef}
          variant="secondary"
          size="sm"
          icon={<Save size={12} />}
          disabled={!config}
          aria-expanded={open}
          aria-controls="review-save-template-form"
          onClick={() => setOpen((was) => !was)}
          data-testid="review-save-template-open"
        >
          {t('forge.saveTemplate')}
        </Button>
      </div>
      {open && (
        <form
          id="review-save-template-form"
          data-testid="review-save-template-form"
          aria-labelledby="review-save-template-title"
          onSubmit={handleSubmit}
          noValidate
          className="flex flex-col gap-2 rounded-lg border border-forge/30 bg-surface-1 p-3"
        >
          <p id="review-save-template-title" className="text-sm font-semibold text-text-primary">
            {t('forge.savedTemplate.formTitle')}
          </p>
          <p className="text-xs text-text-secondary">{t('forge.savedTemplate.saveHint')}</p>
          <label htmlFor="review-save-template-name" className="text-xs text-text-primary">
            {t('forge.templateName')}
          </label>
          <input
            ref={nameRef}
            id="review-save-template-name"
            data-testid="review-save-template-name"
            type="text"
            value={name}
            maxLength={120}
            aria-required="true"
            aria-invalid={nameMissing}
            aria-describedby={nameMissing ? 'review-save-template-name-error' : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim()) setNameMissing(false);
            }}
            className={cn(
              inputClass,
              nameMissing ? 'border-status-error/40' : 'border-(--sf-border-input)',
            )}
          />
          {nameMissing && (
            <p
              id="review-save-template-name-error"
              role="alert"
              data-testid="review-save-template-name-error"
              className="text-xs text-status-error"
            >
              {t('forge.savedTemplate.nameRequired')}
            </p>
          )}
          <label htmlFor="review-save-template-desc" className="text-xs text-text-primary">
            {t('forge.templateDescription')}
          </label>
          <input
            id="review-save-template-desc"
            data-testid="review-save-template-desc"
            type="text"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            className={cn(inputClass, 'border-(--sf-border-input)')}
          />
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={saver.saving}
              data-testid="review-save-template-submit"
            >
              {t('common.save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                setNameMissing(false);
                openerRef.current?.focus();
              }}
              data-testid="review-save-template-cancel"
            >
              {t('forge.cancelEdit')}
            </Button>
          </div>
          {saver.error && (
            <p
              role="alert"
              data-testid="review-save-template-error"
              className="text-xs text-status-error"
            >
              {t('forge.savedTemplate.saveFailed', { message: saver.error })}
            </p>
          )}
        </form>
      )}
      <p
        role="status"
        data-testid="review-save-template-saved"
        className="text-xs text-text-primary"
      >
        {saver.saved ? t('forge.savedTemplate.saved', { name: saver.saved.name }) : ''}
      </p>
    </div>
  );
};
