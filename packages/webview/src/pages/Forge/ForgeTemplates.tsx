import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Flame, Trash2, FileText } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeTemplate } from '../../stores/useForgeStore';
import { staggerContainer, slideUp } from '../../motion/presets';
import { cn } from '../../theme';

/** Props for the ForgeTemplates component. */
export interface ForgeTemplatesProps {
  /** Additional CSS classes for the root element. */
  className?: string;
}

/**
 * Forge template management list.
 *
 * Lists saved forge templates with name, object count, record count,
 * and last-used timestamp. Provides actions to use or delete each template.
 */
export const ForgeTemplates: React.FC<ForgeTemplatesProps> = ({ className }) => {
  const { t } = useTranslation();
  const templates = useForgeStore((s) => s.templates);
  const setConfig = useForgeStore((s) => s.setConfig);
  const setPhase = useForgeStore((s) => s.setPhase);
  const removeTemplate = useForgeStore((s) => s.removeTemplate);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  /** Use a template: set its config and navigate to discovery. */
  const handleUseTemplate = useCallback(
    (template: ForgeTemplate) => {
      setConfig({
        ...template.config,
        sourceOrgId: '',
        targetOrgId: '',
      });
      setPhase('input');
    },
    [setConfig, setPhase],
  );

  /** Open the delete confirmation dialog. */
  const handleDeleteClick = useCallback((name: string) => {
    setDeleteTarget(name);
  }, []);

  /** Close the delete confirmation dialog. */
  const handleDeleteClose = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  /** Confirm template deletion. */
  const handleDeleteConfirm = useCallback(() => {
    if (deleteTarget) {
      removeTemplate(deleteTarget);
    }
    setDeleteTarget(null);
  }, [deleteTarget, removeTemplate]);

  if (templates.length === 0) {
    return (
      <div
        data-testid="forge-templates"
        className={cn(
          'flex flex-col items-center justify-center gap-3 py-16 text-text-secondary',
          className,
        )}
      >
        <FileText size={40} className="opacity-40" />
        <p className="text-sm">{t('forge.noTemplates')}</p>
      </div>
    );
  }

  return (
    <div data-testid="forge-templates" className={cn('flex flex-col gap-3', className)}>
      <h2 className="text-base font-semibold text-text-primary">{t('forge.templates')}</h2>

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-2"
      >
        {templates.map((tpl) => (
          <motion.div
            key={tpl.name}
            variants={slideUp}
            className="flex items-center justify-between rounded-lg border border-subtle bg-surface-1 px-4 py-3"
            data-testid="forge-template-row"
          >
            {/* Template info */}
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-text-primary">{tpl.name}</span>
              {tpl.description && (
                <span className="text-xs text-text-secondary">{tpl.description}</span>
              )}
              <span className="text-xs text-text-muted">
                {t('forge.lastUsed')}: -
              </span>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                icon={<Flame size={12} />}
                onClick={() => handleUseTemplate(tpl)}
                data-testid="forge-use-template"
              >
                {t('forge.useTemplate')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={12} />}
                onClick={() => handleDeleteClick(tpl.name)}
                data-testid="forge-delete-template"
              >
                {t('forge.deleteTemplate')}
              </Button>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Delete confirmation dialog */}
      <DangerConfirm
        open={deleteTarget !== null}
        onClose={handleDeleteClose}
        onConfirm={handleDeleteConfirm}
        title={t('common.delete')}
        description={t('forge.deleteTemplate')}
        confirmText={deleteTarget ?? ''}
      />
    </div>
  );
};
