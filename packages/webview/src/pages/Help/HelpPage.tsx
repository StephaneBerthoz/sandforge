import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { useAppStore } from '../../stores/useAppStore';

/** Accordion section definition. */
interface HelpSection {
  id: string;
  titleKey: string;
  contentKey: string;
  /** Optional icon displayed next to the section title. */
  icon?: string;
}

/** Salesforce documentation link. */
interface SfDocLink {
  titleKey: string;
  descKey: string;
  urlKey: string;
}

const HELP_SECTIONS: HelpSection[] = [
  { id: 'getting-started', titleKey: 'help.gettingStarted', contentKey: 'help.gettingStartedContent', icon: '\uD83D\uDE80' },
  { id: 'monitor', titleKey: 'nav.monitor', contentKey: 'help.monitorContent', icon: '\uD83D\uDCCA' },
  { id: 'seed', titleKey: 'nav.seed', contentKey: 'help.seedContent', icon: '\uD83C\uDF31' },
  { id: 'sync', titleKey: 'nav.sync', contentKey: 'help.syncContent', icon: '\uD83D\uDD04' },
  { id: 'compare', titleKey: 'nav.compare', contentKey: 'help.compareContent', icon: '\uD83D\uDD0D' },
  { id: 'dataops', titleKey: 'nav.dataops', contentKey: 'help.dataopsContent', icon: '\uD83D\uDEE1' },
  { id: 'automation', titleKey: 'nav.automation', contentKey: 'help.automationContent', icon: '\u26A1' },
  { id: 'ai', titleKey: 'nav.ai', contentKey: 'help.aiContent', icon: '\uD83E\uDD16' },
  { id: 'shortcuts', titleKey: 'help.shortcuts', contentKey: 'help.shortcutsContent', icon: '\u2328\uFE0F' },
  { id: 'faq', titleKey: 'help.faq', contentKey: 'help.faqContent', icon: '\u2753' },
  { id: 'troubleshooting', titleKey: 'help.troubleshooting', contentKey: 'help.troubleshootingContent', icon: '\uD83D\uDD27' },
  { id: 'release-notes', titleKey: 'help.releaseNotes', contentKey: 'help.releaseNotesContent', icon: '\uD83D\uDCDD' },
];

const SF_DOC_LINKS: SfDocLink[] = [
  { titleKey: 'help.sfDocs', descKey: 'help.sfDocsDesc', urlKey: 'help.sfDocsUrl' },
  { titleKey: 'help.sfTrailhead', descKey: 'help.sfTrailheadDesc', urlKey: 'help.sfTrailheadUrl' },
  { titleKey: 'help.sfStackExchange', descKey: 'help.sfStackExchangeDesc', urlKey: 'help.sfStackExchangeUrl' },
];

/**
 * Help page with full-text search, accordion sections for each module,
 * Salesforce documentation links, and troubleshooting resources.
 */
export const HelpPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const [openSection, setOpenSection] = useState<string | null>('getting-started');
  const [searchQuery, setSearchQuery] = useState('');

  const toggleSection = (id: string): void => {
    setOpenSection((prev) => (prev === id ? null : id));
  };

  /** Filter sections based on search query matching title or content. */
  const filteredSections = useMemo(() => {
    if (!searchQuery.trim()) {
      return HELP_SECTIONS;
    }
    const query = searchQuery.toLowerCase();
    return HELP_SECTIONS.filter((section) => {
      const title = t(section.titleKey).toLowerCase();
      const content = t(section.contentKey).toLowerCase();
      return title.includes(query) || content.includes(query);
    });
  }, [searchQuery, t]);

  const hasSearchResults = filteredSections.length > 0;

  return (
    <div
      className="flex flex-col p-6 max-w-3xl mx-auto"
      data-testid="help-page"
    >
      <h1
        className="text-2xl font-bold mb-1"
        style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
      >
        {t('help.title')}
      </h1>
      <p
        className="text-sm mb-4"
        style={{ color: 'var(--sf-text-secondary, #868686)' }}
      >
        {t('help.gettingStartedDesc')}
      </p>

      {/* Search input */}
      <div className="mb-4">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('help.searchPlaceholder')}
          className="w-full px-3 py-2 text-sm rounded"
          style={{
            background: 'var(--vscode-input-background, #3c3c3c)',
            border: '1px solid var(--vscode-input-border, #3c3c3c)',
            color: 'var(--vscode-input-foreground, #d4d4d4)',
          }}
          data-testid="help-search"
          aria-label={t('help.searchPlaceholder')}
        />
      </div>

      {/* No search results */}
      {!hasSearchResults && searchQuery.trim() && (
        <p
          className="text-sm mb-4 text-center"
          style={{ color: 'var(--sf-text-muted, #6a6a6a)' }}
          data-testid="help-no-results"
        >
          {t('help.noSearchResults')}
        </p>
      )}

      {/* Accordion */}
      <div className="flex flex-col gap-1">
        {filteredSections.map((section) => {
          const isOpen = openSection === section.id;
          return (
            <div
              key={section.id}
              className="rounded-lg overflow-hidden"
              style={{
                border: '1px solid var(--vscode-panel-border, #3c3c3c)',
              }}
              data-testid={`help-section-${section.id}`}
            >
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-medium transition-colors"
                style={{
                  background: isOpen
                    ? 'var(--vscode-list-activeSelectionBackground, #094771)'
                    : 'var(--vscode-editorWidget-background, #252526)',
                  color: isOpen
                    ? 'var(--vscode-list-activeSelectionForeground, #fff)'
                    : 'var(--vscode-editor-foreground, #d4d4d4)',
                }}
                onClick={() => toggleSection(section.id)}
                aria-expanded={isOpen}
                aria-controls={`help-content-${section.id}`}
              >
                <span className="flex items-center gap-2">
                  {section.icon && <span aria-hidden="true">{section.icon}</span>}
                  <span>{t(section.titleKey)}</span>
                </span>
                <span
                  className="transition-transform"
                  style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  {'\u25BC'}
                </span>
              </button>
              {isOpen && (
                <div
                  id={`help-content-${section.id}`}
                  className="px-4 py-3 text-xs leading-relaxed"
                  role="region"
                  aria-labelledby={section.id}
                  style={{
                    background: 'var(--vscode-editor-background, #1e1e1e)',
                    color: 'var(--sf-text-secondary, #868686)',
                    whiteSpace: 'pre-line',
                  }}
                >
                  {t(section.contentKey)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Salesforce Documentation Links */}
      <div className="mt-6">
        <h2
          className="text-lg font-semibold mb-3"
          style={{ color: 'var(--vscode-editor-foreground, #d4d4d4)' }}
        >
          {t('help.sfDocs')}
        </h2>
        <div className="flex flex-col gap-2">
          {SF_DOC_LINKS.map((link) => (
            <a
              key={link.titleKey}
              href={t(link.urlKey)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-3 rounded-lg transition-colors"
              style={{
                background: 'var(--vscode-editorWidget-background, #252526)',
                border: '1px solid var(--vscode-panel-border, #3c3c3c)',
                color: 'var(--vscode-textLink-foreground, #3794ff)',
                textDecoration: 'none',
              }}
              data-testid={`sf-link-${link.titleKey}`}
            >
              <div>
                <h3
                  className="text-sm font-medium"
                  style={{ color: 'var(--vscode-textLink-foreground, #3794ff)' }}
                >
                  {t(link.titleKey)}
                </h3>
                <p
                  className="text-xs mt-0.5"
                  style={{ color: 'var(--sf-text-secondary, #868686)' }}
                >
                  {t(link.descKey)}
                </p>
              </div>
            </a>
          ))}
        </div>
      </div>

      {/* Bottom actions */}
      <div className="flex gap-3 mt-6">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate('settings')}
          data-testid="help-open-settings"
        >
          {t('onboarding.openSettings')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate('welcome')}
          data-testid="help-start-tour"
        >
          {t('help.startTour')}
        </Button>
      </div>
    </div>
  );
};
