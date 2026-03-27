import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Shield, Heart, ShoppingCart, Landmark, Cpu,
  Building2, GraduationCap, Truck, Users, HandHeart,
  HelpCircle,
} from 'lucide-react';
import type { PersonaMsg } from '@sandforge/shared';
import { Card, CardHeader, CardBody } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';

/** Maps persona industry strings to Lucide icon components. */
const INDUSTRY_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Insurance: Shield,
  Healthcare: Heart,
  Retail: ShoppingCart,
  Banking: Landmark,
  Technology: Cpu,
  'Real Estate': Building2,
  Education: GraduationCap,
  Logistics: Truck,
  'Human Resources': Users,
  'Non-Profit': HandHeart,
};

/**
 * Get the Lucide icon component for a given industry string.
 * Falls back to HelpCircle for unknown industries.
 *
 * @param industry - The industry name from the persona
 * @returns A React icon component
 */
export function getIndustryIcon(industry: string): React.ComponentType<{ className?: string }> {
  return INDUSTRY_ICON_MAP[industry] ?? HelpCircle;
}

/** Maps locale codes to flag emoji strings. */
const LOCALE_FLAG_MAP: Record<string, string> = {
  'fr-FR': '\u{1F1EB}\u{1F1F7}',
  'en-US': '\u{1F1FA}\u{1F1F8}',
  'de-DE': '\u{1F1E9}\u{1F1EA}',
  'es-ES': '\u{1F1EA}\u{1F1F8}',
  'it-IT': '\u{1F1EE}\u{1F1F9}',
  'pt-BR': '\u{1F1E7}\u{1F1F7}',
};

/**
 * Get a flag emoji for a given locale code.
 * Falls back to a globe emoji for unknown locales.
 */
function getLocaleFlag(locale: string): string {
  return LOCALE_FLAG_MAP[locale] ?? '\u{1F310}';
}

/** Props for the PersonaCard component. */
export interface PersonaCardProps {
  /** The persona to render. */
  persona: PersonaMsg;
  /** Called when the user clicks "Select". */
  onSelect: (id: string) => void;
  /** Called when the user clicks "Preview". */
  onPreview: (id: string) => void;
  /** Whether this is a custom persona. */
  isCustom?: boolean;
}

/**
 * Renders a single persona as a card in the gallery grid.
 * Displays industry icon, persona name, description, locale badge, field count,
 * and Preview/Select action buttons.
 */
export const PersonaCard: React.FC<PersonaCardProps> = ({
  persona,
  onSelect,
  onPreview,
  isCustom = false,
}) => {
  const { t } = useTranslation();
  const IconComponent = getIndustryIcon(persona.industry);
  const fieldCount = Object.keys(persona.dataPatterns).length;
  const localeFlag = getLocaleFlag(persona.locale);

  return (
    <Card data-testid={`persona-card-${persona.id}`}>
      <CardHeader
        title={persona.name}
        action={
          <div className="flex items-center gap-2">
            <IconComponent className="w-4 h-4 text-[var(--vscode-focusBorder,#007fd4)]" />
            {isCustom && <Badge variant="info">{t('seed.persona.card.custom')}</Badge>}
          </div>
        }
      />
      <CardBody>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] line-clamp-2">
            {persona.description}
          </p>

          <div className="flex gap-2 flex-wrap">
            <Badge variant="default">
              {localeFlag} {persona.locale}
            </Badge>
            <Badge variant="default">
              {t('seed.persona.card.fields', { count: fieldCount })}
            </Badge>
          </div>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onPreview(persona.id)}
              data-testid={`persona-preview-${persona.id}`}
            >
              {t('seed.persona.card.preview')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSelect(persona.id)}
              data-testid={`persona-select-${persona.id}`}
            >
              {t('seed.persona.card.select')}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
};
