import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import type { TemplateGalleryItem } from './useTemplateGallery';

/** Props for the TemplateCard component. */
export interface TemplateCardProps {
  /** Gallery item to display. */
  item: TemplateGalleryItem;
  /** Callback when user clicks "Use This". */
  onUseThis: (item: TemplateGalleryItem) => void;
}

/** Renders a single seed template as a card in the gallery grid. */
export const TemplateCard: React.FC<TemplateCardProps> = ({ item, onUseThis }) => {
  const { t } = useTranslation();

  const displayName = item.isPrebuilt ? t(item.name) : item.name;
  const displayDescription = item.isPrebuilt ? t(item.description) : item.description;

  return (
    <Card data-testid={`template-card-${item.id}`}>
      <CardHeader
        title={displayName}
        action={
          <div className="flex gap-1">
            {item.tags.map((tag) => (
              <Badge key={tag} variant="default">
                {tag}
              </Badge>
            ))}
          </div>
        }
      />
      <CardBody>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-[var(--sf-text-secondary)]">{displayDescription}</p>

          <div className="flex gap-2">
            <Badge variant="default">
              {t('seed.gallery.objects', { count: item.objectCount })}
            </Badge>
            <Badge variant="default">
              {t('seed.gallery.records', { count: item.totalRecords })}
            </Badge>
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={() => onUseThis(item)}
            data-testid="btn-use-template"
          >
            {t('seed.gallery.useThis')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
};
