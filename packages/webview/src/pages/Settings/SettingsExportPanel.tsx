import React, { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

/** Props for the SettingsExportPanel component. */
export interface SettingsExportPanelProps {
  onExport?: () => string;
  onImport?: (json: string) => boolean;
}

/** Settings import/export panel for backup and restore of configuration. */
export const SettingsExportPanel: React.FC<SettingsExportPanelProps> = ({
  onExport,
  onImport,
}) => {
  const { t } = useTranslation();
  const [importText, setImportText] = useState('');
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleExport = () => {
    if (!onExport) return;
    const json = onExport();
    setImportText(json);
    setImportStatus('idle');
  };

  const handleImport = () => {
    if (!onImport || !importText.trim()) return;
    const success = onImport(importText.trim());
    setImportStatus(success ? 'success' : 'error');
  };

  const handleCopyToClipboard = () => {
    if (!importText) return;
    void navigator.clipboard.writeText(importText);
  };

  return (
    <div data-testid="settings-export-panel">
    <Card>
      <CardHeader title={t('settings.importExport', 'Import / Export')} />
      <CardBody>
        <div className="flex flex-col gap-[var(--sf-space-3)]">
          <div className="flex gap-[var(--sf-space-2)]">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleExport}
              data-testid="export-btn"
            >
              {t('settings.exportSettings', 'Export Settings')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopyToClipboard}
              disabled={!importText}
              data-testid="copy-btn"
            >
              {t('common.copy', 'Copy')}
            </Button>
          </div>

          <textarea
            ref={textareaRef}
            className="w-full h-32 px-3 py-2 text-xs font-mono rounded border resize-none
              bg-[var(--vscode-input-background,#3c3c3c)]
              text-[var(--vscode-input-foreground,#ccc)]
              border-[var(--vscode-input-border,#3c3c3c)]
              focus:border-[var(--vscode-focusBorder,#007fd4)] outline-none"
            placeholder={t('settings.importPlaceholder', 'Paste settings JSON here...')}
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setImportStatus('idle');
            }}
            data-testid="import-textarea"
          />

          <div className="flex items-center gap-[var(--sf-space-2)]">
            <Button
              variant="primary"
              size="sm"
              onClick={handleImport}
              disabled={!importText.trim()}
              data-testid="import-btn"
            >
              {t('settings.importSettings', 'Import Settings')}
            </Button>

            {importStatus === 'success' && (
              <span
                className="text-xs text-[var(--vscode-testing-iconPassed,#73c991)]"
                data-testid="import-success"
              >
                {t('settings.importSuccess', 'Settings imported successfully')}
              </span>
            )}
            {importStatus === 'error' && (
              <span
                className="text-xs text-[var(--vscode-testing-iconFailed,#f48771)]"
                data-testid="import-error"
              >
                {t('settings.importError', 'Invalid settings JSON')}
              </span>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
    </div>
  );
};
