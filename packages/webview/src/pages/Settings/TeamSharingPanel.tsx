import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Copy, Download, Upload, AlertTriangle, CheckCircle } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Select } from '../../components/ui/Select';

/** Conflict between local and remote config values. */
export interface ConfigConflictDisplay {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
}

/** Props for the TeamSharingPanel component. */
export interface TeamSharingPanelProps {
  /** Available categories for sharing. */
  categories?: Array<{ id: string; label: string; entryCount: number }>;
  /** Whether a share/import is in progress. */
  loading?: boolean;
  /** Last share result bundle. */
  sharedBundle?: string;
  /** Import result message. */
  importResult?: { success: boolean; keysImported: number; keysSkipped: number; error?: string };
  /** Detected conflicts during import preview. */
  conflicts?: ConfigConflictDisplay[];
  /** Callback to generate a shareable bundle. */
  onShare?: (categories: string[], createdBy?: string) => void;
  /** Callback to import a bundle. */
  onImport?: (bundle: string, strategy: 'keep-local' | 'keep-remote' | 'merge') => void;
  /** Callback to preview conflicts in a bundle. */
  onPreview?: (bundle: string) => void;
}

/**
 * Team configuration sharing panel for generating and importing
 * shareable config bundles between team members.
 */
export const TeamSharingPanel: React.FC<TeamSharingPanelProps> = ({
  categories = [],
  loading = false,
  sharedBundle,
  importResult,
  conflicts = [],
  onShare,
  onImport,
  onPreview,
}) => {
  const { t } = useTranslation();
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [authorName, setAuthorName] = useState('');
  const [importText, setImportText] = useState('');
  const [mergeStrategy, setMergeStrategy] = useState<'keep-local' | 'keep-remote' | 'merge'>('keep-remote');
  const [copied, setCopied] = useState(false);

  const handleCategoryToggle = useCallback((categoryId: string) => {
    setSelectedCategories((prev) =>
      prev.includes(categoryId)
        ? prev.filter((c) => c !== categoryId)
        : [...prev, categoryId],
    );
  }, []);

  const handleShare = useCallback(() => {
    onShare?.(selectedCategories, authorName || undefined);
  }, [selectedCategories, authorName, onShare]);

  const handleCopy = useCallback(() => {
    if (sharedBundle) {
      void navigator.clipboard.writeText(sharedBundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [sharedBundle]);

  const handlePreview = useCallback(() => {
    if (importText.trim()) {
      onPreview?.(importText.trim());
    }
  }, [importText, onPreview]);

  const handleImport = useCallback(() => {
    if (importText.trim()) {
      onImport?.(importText.trim(), mergeStrategy);
    }
  }, [importText, mergeStrategy, onImport]);

  return (
    <div data-testid="team-sharing-panel" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Users className="w-5 h-5 text-[var(--vscode-editor-foreground,#d4d4d4)]" />
        <h2 className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {t('team.title', 'Team Configuration Sharing')}
        </h2>
      </div>

      {/* Share Section */}
      <Card>
        <CardHeader title={t('team.share', 'Share Configuration')} />
        <CardBody>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('team.shareDescription', 'Select categories to share with your team.')}
            </p>

            {/* Category checkboxes */}
            <div className="flex flex-col gap-1" data-testid="share-categories">
              {categories.map((cat) => (
                <label
                  key={cat.id}
                  className="flex items-center gap-2 text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]"
                >
                  <input
                    type="checkbox"
                    checked={selectedCategories.includes(cat.id)}
                    onChange={() => handleCategoryToggle(cat.id)}
                    data-testid={`category-${cat.id}`}
                  />
                  {cat.label}
                  <Badge variant="default">{cat.entryCount}</Badge>
                </label>
              ))}
            </div>

            {/* Author name */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                {t('team.authorName', 'Author (optional)')}
              </label>
              <input
                data-testid="author-input"
                type="text"
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                placeholder={t('team.authorPlaceholder', 'Your name')}
                className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)]"
              />
            </div>

            <Button
              variant="primary"
              size="sm"
              onClick={handleShare}
              disabled={selectedCategories.length === 0 || loading}
              loading={loading}
              data-testid="share-btn"
            >
              <Upload className="w-3 h-3 mr-1" />
              {t('team.generateBundle', 'Generate Bundle')}
            </Button>

            {/* Generated bundle */}
            {sharedBundle && (
              <div className="flex flex-col gap-1" data-testid="shared-bundle">
                <textarea
                  data-testid="bundle-output"
                  readOnly
                  value={sharedBundle}
                  rows={4}
                  className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)] font-mono resize-none"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCopy}
                  data-testid="copy-bundle-btn"
                >
                  {copied ? (
                    <>
                      <CheckCircle className="w-3 h-3 mr-1" />
                      {t('team.copied', 'Copied!')}
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 mr-1" />
                      {t('team.copyBundle', 'Copy to Clipboard')}
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Import Section */}
      <Card>
        <CardHeader title={t('team.import', 'Import Configuration')} />
        <CardBody>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('team.importDescription', 'Paste a config bundle from a team member to import.')}
            </p>

            <textarea
              data-testid="import-textarea"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={t('team.importPlaceholder', 'Paste config bundle here...')}
              rows={4}
              className="px-2 py-1 text-xs rounded bg-[var(--vscode-input-background,#3c3c3c)] text-[var(--vscode-input-foreground,#cccccc)] border border-[var(--vscode-input-border,#3c3c3c)] font-mono resize-none"
            />

            {/* Merge strategy */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
                {t('team.mergeStrategy', 'Merge Strategy')}
              </label>
              <Select
                data-testid="merge-strategy-select"
                options={[
                  { value: 'keep-remote', label: t('team.keepRemote', 'Keep Remote (overwrite local)') },
                  { value: 'keep-local', label: t('team.keepLocal', 'Keep Local (skip conflicts)') },
                  { value: 'merge', label: t('team.merge', 'Merge (local wins on conflicts)') },
                ]}
                value={mergeStrategy}
                onChange={(e) => setMergeStrategy(e.target.value as 'keep-local' | 'keep-remote' | 'merge')}
              />
            </div>

            <div className="flex gap-2">
              {onPreview && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePreview}
                  disabled={!importText.trim() || loading}
                  data-testid="preview-btn"
                >
                  {t('team.preview', 'Preview')}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleImport}
                disabled={!importText.trim() || loading}
                loading={loading}
                data-testid="import-btn"
              >
                <Download className="w-3 h-3 mr-1" />
                {t('team.importBundle', 'Import')}
              </Button>
            </div>

            {/* Conflicts */}
            {conflicts.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="import-conflicts">
                <div className="flex items-center gap-1 text-xs text-amber-400">
                  <AlertTriangle className="w-3 h-3" />
                  {t('team.conflictsDetected', '{{count}} conflicts detected', { count: conflicts.length })}
                </div>
                {conflicts.map((conflict) => (
                  <div
                    key={conflict.key}
                    data-testid={`conflict-${conflict.key}`}
                    className="p-2 rounded border border-amber-500/30 bg-amber-500/5 text-xs"
                  >
                    <span className="font-mono text-[var(--vscode-editor-foreground,#d4d4d4)]">
                      {conflict.key}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Import result */}
            {importResult && (
              <div
                data-testid="import-result"
                className={`p-2 rounded text-xs ${
                  importResult.success
                    ? 'bg-green-500/10 text-green-400 border border-green-500/30'
                    : 'bg-red-500/10 text-red-400 border border-red-500/30'
                }`}
              >
                {importResult.success ? (
                  <span>
                    {t('team.importSuccess', 'Imported {{imported}} keys, skipped {{skipped}}', {
                      imported: importResult.keysImported,
                      skipped: importResult.keysSkipped,
                    })}
                  </span>
                ) : (
                  <span>{importResult.error}</span>
                )}
              </div>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
