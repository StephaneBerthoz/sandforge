import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileJson, FileUp } from 'lucide-react';
import { cn } from '../../theme';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { JsonViewer } from '../../components/ui/JsonViewer';

/** Import source supported by the migration bridge messages. */
type ImportType = 'sfdmu' | 'universal';

/** Response payload of `migration:import(:-sfdmu):response`. */
interface MigrationImportResult {
  success: boolean;
  config?: Record<string, unknown>;
  detectedFormat?: string;
  error?: string;
}

/** Normalized preview of one imported SyncObjectConfig. */
interface ImportedObjectPreview {
  objectApiName: string;
  operation?: string;
  externalIdField?: string;
  fieldMappingCount: number;
  transformRuleCount: number;
  excludedFieldCount: number;
}

/** Allowed extensions per importer — mirrors MigrationHandler's whitelist. */
const ALLOWED_EXTENSIONS: Record<ImportType, readonly string[]> = {
  sfdmu: ['.json'],
  universal: ['.json', '.csv'],
};

/**
 * Matches absolute paths on every supported host: POSIX (`/…`),
 * Windows drive (`C:\…` / `C:/…`) and UNC (`\\server\…`).
 */
const ABSOLUTE_PATH_RE = /^(\/|\\\\|[a-zA-Z]:[\\/])/;

/** Map a sync operation to a badge color. */
const OPERATION_VARIANTS: Record<string, BadgeVariant> = {
  insert: 'success',
  update: 'warning',
  upsert: 'info',
  delete: 'error',
};

/**
 * Client-side mirror of the handler's path rules (absolute path, extension
 * whitelist). The handler additionally enforces workspace/home containment —
 * that error surfaces through the bridge response.
 *
 * @returns An error message, or null when the path passes local validation.
 */
function validateFilePath(
  filePath: string,
  importType: ImportType,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return t('migration.validation.pathRequired');
  }
  if (!ABSOLUTE_PATH_RE.test(trimmed)) {
    return t('migration.validation.pathNotAbsolute');
  }
  const dotIndex = trimmed.lastIndexOf('.');
  const extension = dotIndex >= 0 ? trimmed.slice(dotIndex).toLowerCase() : '';
  const allowed = ALLOWED_EXTENSIONS[importType];
  if (!allowed.includes(extension)) {
    return t('migration.validation.pathExtension', { extensions: allowed.join(' / ') });
  }
  return null;
}

/**
 * Defensively extract a renderable preview from the imported SyncConfig.
 * The bridge types the config as Record<string, unknown>, so every field is
 * checked before use.
 */
function extractObjectPreviews(config: Record<string, unknown>): ImportedObjectPreview[] {
  const objects = config.objects;
  if (!Array.isArray(objects)) return [];
  const previews: ImportedObjectPreview[] = [];
  for (const raw of objects) {
    if (typeof raw !== 'object' || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.objectApiName !== 'string') continue;
    previews.push({
      objectApiName: obj.objectApiName,
      operation: typeof obj.operation === 'string' ? obj.operation : undefined,
      externalIdField: typeof obj.externalIdField === 'string' ? obj.externalIdField : undefined,
      fieldMappingCount: Array.isArray(obj.fieldMappings) ? obj.fieldMappings.length : 0,
      transformRuleCount: Array.isArray(obj.transformRules) ? obj.transformRules.length : 0,
      excludedFieldCount: Array.isArray(obj.excludedFields) ? obj.excludedFields.length : 0,
    });
  }
  return previews;
}

/**
 * Migration page — exposes the SFDMU and universal importers.
 *
 * The import itself is non-destructive: the extension reads the file, converts
 * it to a SandForge SyncConfig and returns it for preview. Nothing is
 * persisted or executed from this screen.
 */
export const MigrationPage: React.FC = () => {
  const { t } = useTranslation();
  const [importType, setImportType] = useState<ImportType>('sfdmu');
  const [filePath, setFilePath] = useState('');

  const sfdmuMutation = useBridgeMutation<MigrationImportResult>('migration:import-sfdmu');
  const universalMutation = useBridgeMutation<MigrationImportResult>('migration:import');
  const activeMutation = importType === 'sfdmu' ? sfdmuMutation : universalMutation;

  // Validate live once the user has typed something; the empty-path message is
  // only used to gate submission (the disabled button already covers it).
  const pathError =
    filePath.trim().length > 0 ? validateFilePath(filePath, importType, t) : null;
  const canSubmit = validateFilePath(filePath, importType, t) === null;

  const responseError =
    activeMutation.data && !activeMutation.data.success
      ? (activeMutation.data.error ?? t('migration.unknownError'))
      : null;
  const displayedError = activeMutation.error ?? responseError;
  const successResult =
    activeMutation.data?.success && activeMutation.data.config ? activeMutation.data : null;
  const objectPreviews = successResult?.config ? extractObjectPreviews(successResult.config) : [];
  const configName =
    successResult?.config && typeof successResult.config.name === 'string'
      ? successResult.config.name
      : undefined;

  const handleTypeChange = (type: ImportType): void => {
    if (type === importType) return;
    setImportType(type);
    sfdmuMutation.reset();
    universalMutation.reset();
  };

  const handleImport = (): void => {
    if (!canSubmit || activeMutation.loading) return;
    activeMutation.mutate({ filePath: filePath.trim() });
  };

  const handleReset = (): void => {
    setFilePath('');
    sfdmuMutation.reset();
    universalMutation.reset();
  };

  return (
    <div
      className="flex flex-col gap-[var(--sf-space-4)] p-[var(--sf-space-4)]"
      data-testid="migration-page"
    >
      <PageHeader
        title={t('migration.title')}
        subtitle={t('migration.subtitle')}
        icon="cloud-download"
        actions={
          successResult || displayedError ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              data-testid="migration-reset-btn"
            >
              {t('migration.reset')}
            </Button>
          ) : undefined
        }
      />

      {/* Import type selector */}
      <div
        className="grid grid-cols-1 sm:grid-cols-2 gap-[var(--sf-space-3)]"
        data-testid="migration-type-selector"
      >
        <button
          type="button"
          className={cn(
            'flex items-start gap-3 rounded-lg p-3 text-left transition-colors border',
            importType === 'sfdmu'
              ? 'bg-surface-2 border-active'
              : 'bg-surface-1 border-subtle hover:bg-surface-2',
          )}
          onClick={() => handleTypeChange('sfdmu')}
          aria-pressed={importType === 'sfdmu'}
          data-testid="migration-type-sfdmu"
        >
          <FileJson className="w-4 h-4 mt-0.5 shrink-0 text-teal-400" />
          <span>
            <span className="block text-sm font-semibold text-text-primary">
              {t('migration.type.sfdmu.title')}
            </span>
            <span className="block text-xs text-text-muted mt-0.5">
              {t('migration.type.sfdmu.description')}
            </span>
          </span>
        </button>
        <button
          type="button"
          className={cn(
            'flex items-start gap-3 rounded-lg p-3 text-left transition-colors border',
            importType === 'universal'
              ? 'bg-surface-2 border-active'
              : 'bg-surface-1 border-subtle hover:bg-surface-2',
          )}
          onClick={() => handleTypeChange('universal')}
          aria-pressed={importType === 'universal'}
          data-testid="migration-type-universal"
        >
          <FileUp className="w-4 h-4 mt-0.5 shrink-0 text-teal-400" />
          <span>
            <span className="block text-sm font-semibold text-text-primary">
              {t('migration.type.universal.title')}
            </span>
            <span className="block text-xs text-text-muted mt-0.5">
              {t('migration.type.universal.description')}
            </span>
          </span>
        </button>
      </div>

      {/* Source file */}
      <Card data-testid="migration-source-card">
        <CardHeader
          title={t('migration.sourceTitle')}
          subtitle={t(
            importType === 'sfdmu'
              ? 'migration.allowedExtensionsSfdmu'
              : 'migration.allowedExtensionsUniversal',
          )}
        />
        <CardBody>
          <div className="flex flex-col gap-[var(--sf-space-3)]">
            <Input
              label={t('migration.filePathLabel')}
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder={t(
                importType === 'sfdmu'
                  ? 'migration.filePathPlaceholderSfdmu'
                  : 'migration.filePathPlaceholderUniversal',
              )}
              hint={t('migration.filePathHint')}
              error={pathError ?? undefined}
              disabled={activeMutation.loading}
              data-testid="migration-path-input"
            />
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={handleImport}
                disabled={!canSubmit}
                loading={activeMutation.loading}
                data-testid="migration-import-btn"
              >
                {activeMutation.loading ? t('migration.importing') : t('migration.import')}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {displayedError && (
        <ErrorBanner
          message={displayedError}
          onDismiss={() => activeMutation.reset()}
          data-testid="migration-error"
        />
      )}

      {/* Import result preview */}
      {successResult && (
        <Card data-testid="migration-result">
          <CardHeader
            title={t('migration.successTitle')}
            subtitle={configName ?? t('migration.successDescription')}
            action={
              successResult.detectedFormat ? (
                <span data-testid="migration-detected-format">
                  <Badge variant="info">
                    {t('migration.detectedFormat', { format: successResult.detectedFormat })}
                  </Badge>
                </span>
              ) : undefined
            }
          />
          <CardBody>
            <div className="flex flex-col gap-[var(--sf-space-3)]">
              <div
                className="text-xs text-text-muted"
                data-testid="migration-objects-count"
              >
                {t('migration.objectsCount', { count: objectPreviews.length })}
              </div>
              <ul className="flex flex-col gap-[var(--sf-space-2)]" data-testid="migration-objects">
                {objectPreviews.map((obj) => (
                  <li
                    key={obj.objectApiName}
                    className="flex flex-col gap-1 rounded px-2.5 py-2 bg-surface-1 border border-subtle"
                    data-testid={`migration-object-${obj.objectApiName}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text-primary">
                        {obj.objectApiName}
                      </span>
                      {obj.operation && (
                        <Badge variant={OPERATION_VARIANTS[obj.operation] ?? 'default'}>
                          {obj.operation}
                        </Badge>
                      )}
                      {obj.externalIdField && (
                        <span className="text-xs text-text-muted">
                          {t('migration.externalId', { field: obj.externalIdField })}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-secondary">
                      {t('migration.objectSummary', {
                        mappings: obj.fieldMappingCount,
                        rules: obj.transformRuleCount,
                        excluded: obj.excludedFieldCount,
                      })}
                    </div>
                  </li>
                ))}
              </ul>
              <details data-testid="migration-raw-config">
                <summary className="text-xs text-text-muted cursor-pointer select-none">
                  {t('migration.rawConfig')}
                </summary>
                <div className="mt-2 rounded bg-surface-1 border border-subtle p-2 overflow-auto">
                  <JsonViewer data={successResult.config} collapsed />
                </div>
              </details>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
};
