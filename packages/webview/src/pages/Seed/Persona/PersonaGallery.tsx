import React, { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import type { PersonaMsg } from '@sandforge/shared';
import { Skeleton } from '../../../components/ui/Skeleton';
import { ErrorBanner } from '../../../components/ui/ErrorBanner';
import { Card, CardBody } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { usePersonas } from './usePersonas';
import { PersonaCard } from './PersonaCard';
import { PersonaPreviewPopover } from './PersonaPreviewPopover';
import { PersonaCustomizePanel } from './PersonaCustomizePanel';

/** Props for the PersonaGallery component. */
export interface PersonaGalleryProps {
  /** Called when a persona is selected and confirmed (after customization). */
  onPersonaSelected: (persona: PersonaMsg) => void;
}

/**
 * Responsive grid gallery of AI personas.
 * Shows PersonaCard for each built-in/custom persona, a "Create Custom" card,
 * a preview popover on Preview click, and a customization panel on Select click.
 */
export const PersonaGallery: React.FC<PersonaGalleryProps> = ({ onPersonaSelected }) => {
  const { t } = useTranslation();
  const hook = usePersonas();
  const [view, setView] = useState<'gallery' | 'customize'>('gallery');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handlePreview = useCallback(
    (id: string) => {
      hook.openPreview(id);
    },
    [hook],
  );

  const handleSelect = useCallback(
    (id: string) => {
      hook.selectPersona(id);
      setView('customize');
    },
    [hook],
  );

  const handleCustomizeConfirm = useCallback(
    (customized: PersonaMsg) => {
      setView('gallery');
      hook.clearSelection();
      onPersonaSelected(customized);
    },
    [hook, onPersonaSelected],
  );

  const handleCustomizeCancel = useCallback(() => {
    setView('gallery');
    hook.clearSelection();
  }, [hook]);

  const handleCreateCustom = useCallback(() => {
    hook.createCustom();
  }, [hook]);

  // Customization view replaces gallery
  if (view === 'customize' && hook.selectedPersona) {
    return (
      <PersonaCustomizePanel
        persona={hook.selectedPersona}
        onConfirm={handleCustomizeConfirm}
        onCancel={handleCustomizeCancel}
      />
    );
  }

  return (
    <div className="flex flex-col gap-[var(--sf-space-3)]" data-testid="persona-gallery">
      {/* Header */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('seed.persona.title')}
        </h2>
        <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] mt-0.5">
          {t('seed.persona.subtitle')}
        </p>
      </div>

      {/* Error state */}
      {hook.error && <ErrorBanner message={hook.error} data-testid="persona-gallery-error" />}

      {/* Loading state: skeleton cards */}
      {hook.loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="persona-gallery-loading">
          {[1, 2, 3].map((n) => (
            <Skeleton key={n} variant="rect" height="160px" />
          ))}
        </div>
      )}

      {/* Persona cards grid */}
      {!hook.loading && (
        <div className="relative">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="persona-grid">
            {hook.personas.map((persona) => (
              <PersonaCard
                key={persona.id}
                persona={persona}
                onSelect={handleSelect}
                onPreview={handlePreview}
                isCustom={persona.id.startsWith('custom-')}
              />
            ))}

            {/* Create Custom card */}
            <Card data-testid="persona-card-create-custom">
              <CardBody>
                <div className="flex flex-col gap-3 py-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-[var(--vscode-focusBorder,#007fd4)]" />
                    <span className="text-xs font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {t('seed.persona.card.createCustom')}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                    {t('seed.persona.card.createCustomDesc')}
                  </p>
                  <textarea
                    ref={textareaRef}
                    className="w-full text-xs p-2 rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#d4d4d4)] border border-[var(--vscode-input-border,#3c3c3c)] resize-none"
                    rows={3}
                    placeholder="e.g., Restaurant chain with menus, reservations, and customer loyalty..."
                    value={hook.customDescription}
                    onChange={(e) => hook.setCustomDescription(e.target.value)}
                    data-testid="custom-persona-textarea"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleCreateCustom}
                    loading={hook.isCreating}
                    disabled={hook.customDescription.trim().length === 0}
                    data-testid="custom-persona-generate-btn"
                  >
                    {hook.isCreating
                      ? t('seed.persona.card.generating')
                      : t('seed.persona.card.generateBtn')}
                  </Button>
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Preview popover - rendered as overlay within the gallery area */}
          {hook.previewedPersona && (
            <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" data-testid="preview-overlay">
              <PersonaPreviewPopover
                persona={hook.previewedPersona}
                sampleRecords={hook.generateSampleRecords(hook.previewedPersona)}
                onClose={hook.closePreview}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
