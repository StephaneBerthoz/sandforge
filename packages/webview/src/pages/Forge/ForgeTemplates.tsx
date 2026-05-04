import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Flame, Trash2, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { DangerConfirm } from '../../components/ui/DangerConfirm';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeTemplate } from '../../stores/useForgeStore';
import { BUILTIN_FORGE_TEMPLATES, isBuiltinForgeTemplate } from '@sandforge/shared';
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

  /** Merged list — builtins first (with sparkle badge), then user-saved. */
  const merged = useMemo<ForgeTemplate[]>(() => {
    return [...BUILTIN_FORGE_TEMPLATES, ...templates];
  }, [templates]);

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

  return (
    <div data-testid="forge-templates" className={cn('flex flex-col gap-3', className)}>
      <h2 className="text-base font-semibold text-text-primary">{t('forge.templates')}</h2>

      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-2"
      >
        {merged.map((tpl) => {
          const isBuiltin = isBuiltinForgeTemplate(tpl.id);
          return (
            <motion.div
              key={tpl.id}
              variants={slideUp}
              className={cn(
                'flex items-center justify-between rounded-lg border px-4 py-3',
                isBuiltin ? 'border-forge/30 bg-forge/5' : 'border-subtle bg-surface-1',
              )}
              data-testid={isBuiltin ? 'forge-template-builtin' : 'forge-template-row'}
            >
              {/* Template info */}
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium text-text-primary flex items-center gap-1.5">
                  {tpl.name}
                  {isBuiltin && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-forge bg-forge/15 px-1.5 py-0.5 rounded-full">
                      <Sparkles size={10} />
                      {t('forge.starter', 'Starter')}
                    </span>
                  )}
                </span>
                {tpl.description && (
                  <span className="text-xs text-text-secondary">{tpl.description}</span>
                )}
                {!isBuiltin && (
                  <span className="text-xs text-text-muted">{t('forge.lastUsed')}: -</span>
                )}
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
                {!isBuiltin && (
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    onClick={() => handleDeleteClick(tpl.name)}
                    data-testid="forge-delete-template"
                  >
                    {t('forge.deleteTemplate')}
                  </Button>
                )}
              </div>
            </motion.div>
          );
        })}
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
