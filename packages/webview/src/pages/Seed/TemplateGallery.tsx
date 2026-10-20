import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SeedTemplate } from '@sandforge/shared';
import { Skeleton } from '../../components/ui/Skeleton';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { useTemplateGallery } from './useTemplateGallery';
import type { TemplateGalleryItem } from './useTemplateGallery';
import { TemplateCard } from './TemplateCard';

/** Props for the TemplateGallery component. */
export interface TemplateGalleryProps {
  /** Called with the template whose Use This was pressed, loaded whole. */
  onSelectTemplate: (template: SeedTemplate) => void;
}

/**
 * Responsive grid gallery of pre-built and saved seed templates. Use This
 * goes straight to the run's one confirmation, where the counts and the org
 * are set: a dialog of counts came first, whose own "Start Seeding" started
 * nothing.
 */
export const TemplateGallery: React.FC<TemplateGalleryProps> = ({ onSelectTemplate }) => {
  const { t } = useTranslation();
  const { items, loading, error, loadFullTemplate } = useTemplateGallery();

  const handleUseThis = useCallback(
    async (item: TemplateGalleryItem) => {
      const template = await loadFullTemplate(item.id);
      // A saved template that is gone or refused has its reason in the banner.
      if (!template) return;
      onSelectTemplate(template);
    },
    [loadFullTemplate, onSelectTemplate],
  );

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="template-gallery">
      <div>
        <h2 className="text-sm font-semibold text-(--sf-text-primary)">
          {t('seed.gallery.title')}
        </h2>
        <p className="text-xs text-(--sf-text-secondary) mt-0.5">{t('seed.gallery.subtitle')}</p>
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
    </div>
  );
};
