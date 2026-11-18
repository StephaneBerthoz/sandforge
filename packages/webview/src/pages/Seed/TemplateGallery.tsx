import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * The template a link opens Seed on, by its id: its confirmation opens as
   * soon as the gallery lists it, as if its Use this were pressed, once.
   */
  openTemplateId?: string;
  /** Told once the template named was opened, or found gone. */
  onOpenSettled?: () => void;
}

/**
 * Responsive grid gallery of pre-built and saved seed templates. Use This
 * goes straight to the run's one confirmation, where the counts and the org
 * are set: a dialog of counts came first, whose own "Start Seeding" started
 * nothing.
 */
export const TemplateGallery: React.FC<TemplateGalleryProps> = ({
  onSelectTemplate,
  openTemplateId,
  onOpenSettled,
}) => {
  const { t } = useTranslation();
  const { items, loading, listed, error, loadFullTemplate } = useTemplateGallery();

  const handleUseThis = useCallback(
    async (item: TemplateGalleryItem) => {
      const template = await loadFullTemplate(item.id);
      // A saved template that is gone or refused has its reason in the banner.
      if (!template) return;
      onSelectTemplate(template);
    },
    [loadFullTemplate, onSelectTemplate],
  );

  /*
   * The template a link names: a built-in one is listed at once, a saved one
   * once the host has listed them. Gone, it is said so, as a saved template
   * the host no longer has is when its Use this is pressed.
   */
  const [namedGone, setNamedGone] = useState(false);
  const openSettled = useRef(false);
  useEffect(() => {
    if (!openTemplateId || openSettled.current) return;
    const item = items.find((candidate) => candidate.id === openTemplateId);
    if (item) {
      openSettled.current = true;
      void handleUseThis(item);
      onOpenSettled?.();
    } else if (listed && !loading) {
      openSettled.current = true;
      setNamedGone(true);
      onOpenSettled?.();
    }
  }, [openTemplateId, items, listed, loading, handleUseThis, onOpenSettled]);

  const shownError = error ?? (namedGone ? t('seed.gallery.templateMissing') : null);

  return (
    <div className="flex flex-col gap-(--sf-space-3)" data-testid="template-gallery">
      <div>
        <h2 className="text-sm font-semibold text-(--sf-text-primary)">
          {t('seed.gallery.title')}
        </h2>
        <p className="text-xs text-(--sf-text-secondary) mt-0.5">{t('seed.gallery.subtitle')}</p>
      </div>

      {shownError && (
        <ErrorBanner message={shownError} code={null} module="seed" data-testid="gallery-error" />
      )}

      {/* The built-in templates are drawn while the saved ones load, a
          placeholder standing for those: the whole grid gave way to the
          placeholders each time the gallery asked again, and the card Back
          had just handed the keyboard to went with it. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((item) => (
          <TemplateCard key={item.id} item={item} onUseThis={handleUseThis} />
        ))}
        {loading && (
          <div data-testid="gallery-skeleton">
            <Skeleton variant="rect" height="180px" />
          </div>
        )}
      </div>
    </div>
  );
};
