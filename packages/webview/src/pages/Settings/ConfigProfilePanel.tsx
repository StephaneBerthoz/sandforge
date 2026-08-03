import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload, FileCheck, AlertTriangle, CheckCircle } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { cn } from '../../theme';

/** Available configuration categories for export/import. */
const CONFIG_CATEGORIES = [
  {
    key: 'syncMappings',
    labelKey: 'config.categories.syncMappings',
    defaultLabel: 'Sync Mappings',
  },
  { key: 'forgePlans', labelKey: 'config.categories.forgePlans', defaultLabel: 'Forge Plans' },
  { key: 'pipelines', labelKey: 'config.categories.pipelines', defaultLabel: 'Pipelines' },
  {
    key: 'anonymizationTemplates',
    labelKey: 'config.categories.anonymizationTemplates',
    defaultLabel: 'Anonymization Templates',
  },
  { key: 'settings', labelKey: 'config.categories.settings', defaultLabel: 'Settings' },
] as const;

type CategoryKey = (typeof CONFIG_CATEGORIES)[number]['key'];

/** Panel for exporting and importing SandForge configuration profiles. */
export const ConfigProfilePanel: React.FC = () => {
  const { t } = useTranslation();
  const [selectedCategories, setSelectedCategories] = useState<Set<CategoryKey>>(
    new Set(['syncMappings', 'forgePlans', 'pipelines', 'anonymizationTemplates', 'settings']),
  );
  const [importJson, setImportJson] = useState('');
  const [overwrite, setOverwrite] = useState(true);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    error?: string;
  } | null>(null);

  // Bridge queries/mutations
  const categoriesQuery = useBridgeQuery<{
    categories: Array<{ category: string; entryCount: number }>;
  }>('config:categories', undefined, { responseType: 'config:categories:response' });

  const exportMutation = useBridgeMutation<{
    success: boolean;
    json?: string;
    categoriesExported: number;
    entriesExported: number;
    error?: string;
  }>('config:export', { responseType: 'config:export:response' });

  const importMutation = useBridgeMutation<{
    success: boolean;
    categoriesImported: number;
    entriesImported: number;
    warnings: string[];
    error?: string;
  }>('config:import', { responseType: 'config:import:response' });

  const validateMutation = useBridgeMutation<{
    valid: boolean;
    categories?: string[];
    error?: string;
  }>('config:validate', { responseType: 'config:validate:response' });

  /** Toggle a category in the selection set. */
  const toggleCategory = useCallback((key: CategoryKey) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  /** Get entry count for a category from the query data. */
  const getEntryCount = useCallback(
    (key: string): number => {
      const cat = categoriesQuery.data?.categories.find((c) => c.category === key);
      return cat?.entryCount ?? 0;
    },
    [categoriesQuery.data],
  );

  /** Handle export action. */
  const handleExport = useCallback(() => {
    if (selectedCategories.size === 0) return;
    exportMutation.mutate({ categories: Array.from(selectedCategories) });
  }, [selectedCategories, exportMutation]);

  /** Copy exported JSON to clipboard. */
  const handleCopyExport = useCallback(async () => {
    if (exportMutation.data?.json) {
      await navigator.clipboard.writeText(exportMutation.data.json);
    }
  }, [exportMutation.data]);

  /** Download exported JSON as a file. */
  const handleDownloadExport = useCallback(() => {
    if (!exportMutation.data?.json) return;
    const blob = new Blob([exportMutation.data.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sandforge-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportMutation.data]);

  /** Validate the import JSON. */
  const handleValidate = useCallback(() => {
    if (!importJson.trim()) return;
    validateMutation.mutate({ json: importJson });
  }, [importJson, validateMutation]);

  /** Handle import action. */
  const handleImport = useCallback(() => {
    if (!importJson.trim()) return;
    importMutation.mutate({ json: importJson, overwrite });
  }, [importJson, overwrite, importMutation]);

  // Update validation result when validate response arrives
  React.useEffect(() => {
    if (validateMutation.data) {
      setValidationResult(validateMutation.data);
    }
  }, [validateMutation.data]);

  return (
    <div className="flex flex-col gap-4" data-testid="config-profile-panel">
      <h2 className="text-sm font-semibold text-text-primary">
        {t('config.profiles.title', 'Configuration Profiles')}
      </h2>
      <p className="text-xs text-text-secondary">
        {t(
          'config.profiles.description',
          'Export and import your SandForge configuration to share with team members or backup your setup.',
        )}
      </p>

      {/* ── Export Section ── */}
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="config-export-section"
      >
        <div className="flex items-center gap-2 mb-3">
          <Download className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('config.profiles.export', 'Export')}
          </h3>
        </div>

        <div className="flex flex-wrap gap-2 mb-3">
          {CONFIG_CATEGORIES.map((cat) => {
            const count = getEntryCount(cat.key);
            const selected = selectedCategories.has(cat.key);
            return (
              <button
                key={cat.key}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-all',
                  selected
                    ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
                    : 'border-subtle bg-surface-2 text-text-muted hover:border-active',
                )}
                onClick={() => toggleCategory(cat.key)}
                data-testid={`cat-toggle-${cat.key}`}
              >
                <span>{t(cat.labelKey, cat.defaultLabel)}</span>
                {count > 0 && <Badge variant="default">{count}</Badge>}
              </button>
            );
          })}
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={handleExport}
          disabled={selectedCategories.size === 0}
          loading={exportMutation.loading}
          data-testid="export-btn"
        >
          <Download className="w-3.5 h-3.5 mr-1" />
          {t('config.profiles.exportBtn', 'Export Profile')}
        </Button>

        {exportMutation.data?.success && (
          <div className="mt-3 flex flex-col gap-2" data-testid="export-result">
            <div className="flex items-center gap-2 text-xs text-green-400">
              <CheckCircle className="w-3.5 h-3.5" />
              <span>
                {t('config.profiles.exportSuccess', {
                  defaultValue: 'Exported {{entries}} entries from {{categories}} categories',
                  entries: exportMutation.data.entriesExported,
                  categories: exportMutation.data.categoriesExported,
                })}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyExport}
                data-testid="copy-export-btn"
              >
                {t('common.copy', 'Copy')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDownloadExport}
                data-testid="download-export-btn"
              >
                {t('config.profiles.download', 'Download JSON')}
              </Button>
            </div>
          </div>
        )}

        {exportMutation.error && (
          <div className="mt-2 text-xs text-red-400">{exportMutation.error}</div>
        )}
      </div>

      {/* ── Import Section ── */}
      <div
        className="rounded-lg border border-subtle bg-surface-1 p-4"
        data-testid="config-import-section"
      >
        <div className="flex items-center gap-2 mb-3">
          <Upload className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">
            {t('config.profiles.import', 'Import')}
          </h3>
        </div>

        <textarea
          className={cn(
            'w-full h-32 rounded-md border border-subtle bg-surface-2 p-3',
            'text-xs font-mono text-text-primary placeholder:text-text-muted',
            'focus:outline-none focus:border-active resize-none',
          )}
          placeholder={t(
            'config.profiles.importPlaceholder',
            'Paste configuration profile JSON here...',
          )}
          value={importJson}
          onChange={(e) => {
            setImportJson(e.target.value);
            setValidationResult(null);
          }}
          data-testid="import-textarea"
        />

        <div className="flex items-center gap-3 mt-3">
          <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="rounded"
              data-testid="overwrite-checkbox"
            />
            {t('config.profiles.overwrite', 'Overwrite existing entries')}
          </label>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleValidate}
            disabled={!importJson.trim()}
            loading={validateMutation.loading}
            data-testid="validate-btn"
          >
            <FileCheck className="w-3.5 h-3.5 mr-1" />
            {t('config.profiles.validate', 'Validate')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleImport}
            disabled={!importJson.trim()}
            loading={importMutation.loading}
            data-testid="import-btn"
          >
            <Upload className="w-3.5 h-3.5 mr-1" />
            {t('config.profiles.importBtn', 'Import Profile')}
          </Button>
        </div>

        {/* Validation result */}
        {validationResult && (
          <div
            className={cn(
              'mt-3 flex items-center gap-2 text-xs',
              validationResult.valid ? 'text-green-400' : 'text-red-400',
            )}
            data-testid="validation-result"
          >
            {validationResult.valid ? (
              <CheckCircle className="w-3.5 h-3.5" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5" />
            )}
            <span>
              {validationResult.valid
                ? t('config.profiles.validProfile', 'Valid profile')
                : (validationResult.error ??
                  t('config.profiles.invalidProfile', 'Invalid profile'))}
            </span>
          </div>
        )}

        {/* Import result */}
        {importMutation.data?.success && (
          <div className="mt-3 flex flex-col gap-1" data-testid="import-result">
            <div className="flex items-center gap-2 text-xs text-green-400">
              <CheckCircle className="w-3.5 h-3.5" />
              <span>
                {t('config.profiles.importSuccess', {
                  defaultValue: 'Imported {{entries}} entries from {{categories}} categories',
                  entries: importMutation.data.entriesImported,
                  categories: importMutation.data.categoriesImported,
                })}
              </span>
            </div>
            {importMutation.data.warnings.length > 0 && (
              <div className="flex flex-col gap-0.5 mt-1">
                {importMutation.data.warnings.map((w, i) => (
                  <div key={i} className="flex items-center gap-1 text-[10px] text-amber-400">
                    <AlertTriangle className="w-3 h-3" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {importMutation.data && !importMutation.data.success && (
          <div className="mt-2 text-xs text-red-400" data-testid="import-error">
            {importMutation.data.error}
          </div>
        )}
      </div>
    </div>
  );
};
