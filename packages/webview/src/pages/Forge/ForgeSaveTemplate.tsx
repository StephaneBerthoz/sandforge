import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';
import { useForgeStore } from '../../stores/useForgeStore';
import { templateFromRun } from './forgeRunConfig';
import { useSaveForgeTemplate } from './useSaveForgeTemplate';

/** Props of {@link ForgeSaveTemplate}. */
interface ForgeSaveTemplateProps {
  /** What the ids and test ids of the form and its fields begin with: one per screen. */
  idPrefix: 'review-save-template' | 'forge-save-template';
  /** The test id of the button that opens the form. */
  openerTestId: string;
  /** The size of the button, as the buttons beside it. */
  size?: 'sm' | 'md';
  /**
   * The records the template says it holds. Absent, those of the objects the
   * run writes, as the plan counts them, or as discovery did.
   */
  recordCount?: number;
  className?: string;
}

/**
 * Save the run as a template the Template tab lists: its input and options,
 * the objects it leaves out, the decisions and controls set on Review, its
 * anonymization down to the fields, its file copy and its target org.
 *
 * One form, on Review before the run writes anything and on its results once
 * it has: the two screens each had a copy of it, and a fix made to one was
 * owed to the other.
 */
export const ForgeSaveTemplate: React.FC<ForgeSaveTemplateProps> = ({
  idPrefix,
  openerTestId,
  size = 'sm',
  recordCount,
  className,
}) => {
  const { t } = useTranslation();
  const config = useForgeStore((s) => s.config);
  const graph = useForgeStore((s) => s.graph);
  const plan = useForgeStore((s) => s.plan);
  const anonymizationRules = useForgeStore((s) => s.anonymizationRules);
  const anonymizationPresetId = useForgeStore((s) => s.anonymizationPresetId);
  const saver = useSaveForgeTemplate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nameMissing, setNameMissing] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = `${idPrefix}-form`;

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
    if (!config || saver.saving) return;
    if (!name.trim()) {
      setNameMissing(true);
      nameRef.current?.focus();
      return;
    }
    const included = (graph?.nodes ?? []).filter((node) => node.included);
    saver.save(
      templateFromRun({
        id: `tpl-${Date.now()}`,
        name,
        description,
        config,
        anonymizationRules,
        anonymizationPresetId,
        objectCount: included.length,
        recordCount:
          recordCount ??
          plan?.totalRecords ??
          included.reduce((sum, node) => sum + node.recordCount, 0),
        savedAt: new Date().toISOString(),
        graph,
        fileCopy: useForgeStore.getState().fileCopy,
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
    <div data-testid={`${idPrefix}-section`} className={cn('flex flex-col gap-2', className)}>
      <div>
        <Button
          ref={openerRef}
          variant="secondary"
          size={size}
          icon={<Save size={size === 'sm' ? 12 : 14} />}
          disabled={!config}
          aria-expanded={open}
          aria-controls={formId}
          onClick={() => setOpen((was) => !was)}
          data-testid={openerTestId}
        >
          {t('forge.saveTemplate')}
        </Button>
      </div>
      {open && (
        <form
          id={formId}
          data-testid={formId}
          aria-labelledby={`${idPrefix}-title`}
          onSubmit={handleSubmit}
          noValidate
          className="flex flex-col gap-2 rounded-lg border border-forge/30 bg-surface-1 p-3"
        >
          <p id={`${idPrefix}-title`} className="text-sm font-semibold text-text-primary">
            {t('forge.savedTemplate.formTitle')}
          </p>
          <p className="text-xs text-text-secondary">{t('forge.savedTemplate.saveHint')}</p>
          <label htmlFor={`${idPrefix}-name`} className="text-xs text-text-primary">
            {t('forge.templateName')}
          </label>
          <input
            ref={nameRef}
            id={`${idPrefix}-name`}
            data-testid={`${idPrefix}-name`}
            type="text"
            value={name}
            maxLength={120}
            aria-required="true"
            aria-invalid={nameMissing}
            aria-describedby={nameMissing ? `${idPrefix}-name-error` : undefined}
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
              id={`${idPrefix}-name-error`}
              role="alert"
              data-testid={`${idPrefix}-name-error`}
              className="text-xs text-status-error"
            >
              {t('forge.savedTemplate.nameRequired')}
            </p>
          )}
          <label htmlFor={`${idPrefix}-desc`} className="text-xs text-text-primary">
            {t('forge.templateDescription')}
          </label>
          <input
            id={`${idPrefix}-desc`}
            data-testid={`${idPrefix}-desc`}
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
              data-testid={`${idPrefix}-submit`}
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
              data-testid={`${idPrefix}-cancel`}
            >
              {t('forge.cancelEdit')}
            </Button>
          </div>
          {saver.error && (
            <p role="alert" data-testid={`${idPrefix}-error`} className="text-xs text-status-error">
              {t('forge.savedTemplate.saveFailed', { message: saver.error })}
            </p>
          )}
        </form>
      )}
      <p role="status" data-testid={`${idPrefix}-saved`} className="text-xs text-text-primary">
        {saver.saved ? t('forge.savedTemplate.saved', { name: saver.saved.name }) : ''}
      </p>
    </div>
  );
};
