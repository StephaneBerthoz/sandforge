import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedTemplate } from '@sandforge/shared';
import { Skeleton } from '../../components/ui/Skeleton';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { useTemplateGallery } from './useTemplateGallery';
import type { TemplateGalleryItem } from './useTemplateGallery';
import { TemplateCard } from './TemplateCard';
import { TemplateCustomizeModal } from './TemplateCustomizeModal';

/** Props for the TemplateGallery component. */
export interface TemplateGalleryProps {
  /** Called when user confirms a template with customized record counts. */
  onSelectTemplate: (template: SeedTemplate, customizedCounts: Record<string, number>) => void;
}

/** Responsive grid gallery of pre-built and saved seed templates. */
export const TemplateGallery: React.FC<TemplateGalleryProps> = ({ onSelectTemplate }) => {
  const { t } = useTranslation();
  const { items, loading, error, loadFullTemplate } = useTemplateGallery();

  const [selectedTemplate, setSelectedTemplate] = useState<SeedTemplate | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleUseThis = useCallback(
    async (item: TemplateGalleryItem) => {
      const template = await loadFullTemplate(item.id);
      setSelectedTemplate(template);
      setIsModalOpen(true);
    },
    [loadFullTemplate],
  );

  const handleModalConfirm = useCallback(
    (template: SeedTemplate, customizedCounts: Record<string, number>) => {
      setIsModalOpen(false);
      setSelectedTemplate(null);
      onSelectTemplate(template, customizedCounts);
    },
    [onSelectTemplate],
  );

  const handleModalClose = useCallback(() => {
    setIsModalOpen(false);
    setSelectedTemplate(null);
  }, []);

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="template-gallery">
      <div>
        <h2 className="text-sm font-semibold text-[var(--sf-text-primary)]">
          {t('seed.gallery.title')}
        </h2>
        <p className="text-xs text-[var(--sf-text-secondary)] mt-0.5">
          {t('seed.gallery.subtitle')}
        </p>
      </div>

      {error && <ErrorBanner message={error} data-testid="gallery-error" />}

      {loading ? (
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          data-testid="gallery-skeleton"
        >
          <Skeleton variant="rect" height="180px" />
          <Skeleton variant="rect" height="180px" />
          <Skeleton variant="rect" height="180px" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item) => (
            <TemplateCard key={item.id} item={item} onUseThis={handleUseThis} />
          ))}
        </div>
      )}

      {selectedTemplate && (
        <TemplateCustomizeModal
          template={selectedTemplate}
          isOpen={isModalOpen}
          onClose={handleModalClose}
          onConfirm={handleModalConfirm}
        />
      )}
    </div>
  );
};
