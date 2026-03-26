import React, { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedTemplate } from '@sandforge/shared';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

/** Props for the TemplateCustomizeModal component. */
export interface TemplateCustomizeModalProps {
  /** Template to customize. */
  template: SeedTemplate;
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Called when the modal is closed without confirming. */
  onClose: () => void;
  /** Called when the user confirms with customized record counts. */
  onConfirm: (template: SeedTemplate, customizedCounts: Record<string, number>) => void;
}

/** Modal allowing users to adjust record counts per object before seeding. */
export const TemplateCustomizeModal: React.FC<TemplateCustomizeModalProps> = ({
  template,
  isOpen,
  onClose,
  onConfirm,
}) => {
  const { t } = useTranslation();

  const initialCounts = useMemo(
    () =>
      Object.fromEntries(
        template.objects.map((obj) => [obj.objectApiName, obj.recordCount]),
      ),
    [template],
  );

  const [counts, setCounts] = useState<Record<string, number>>(initialCounts);

  const handleCountChange = useCallback((objectApiName: string, value: number) => {
    setCounts((prev) => ({ ...prev, [objectApiName]: Math.max(1, value) }));
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(template, counts);
  }, [template, counts, onConfirm]);

  const displayName = template.name.startsWith('seed.') ? t(template.name) : template.name;

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={`${displayName} - ${t('seed.gallery.customize')}`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            data-testid="btn-start-seeding"
          >
            {t('seed.gallery.startSeeding')}
          </Button>
        </>
      }
    >
      <div
        className="flex flex-col gap-2"
        data-testid="template-customize-modal"
      >
        {template.objects.map((obj) => (
          <div key={obj.objectApiName} className="flex items-center gap-3 text-xs">
            <span className="w-40 truncate text-[var(--vscode-editor-foreground,#d4d4d4)]">
              {obj.objectApiName}
            </span>
            <Input
              type="number"
              min={1}
              value={counts[obj.objectApiName] ?? obj.recordCount}
              onChange={(e) =>
                handleCountChange(obj.objectApiName, parseInt(e.target.value, 10) || 1)
              }
              className="w-24"
              data-testid={`customize-count-${obj.objectApiName}`}
            />
          </div>
        ))}
      </div>
    </Dialog>
  );
};
