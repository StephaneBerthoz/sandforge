import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileJson, FileUp } from 'lucide-react';
import type { SyncExecutionResult, SyncOperation } from '@sandforge/shared';
import { syncConfigSchema } from '@sandforge/shared';
import { cn } from '../../theme';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOrgStore } from '../../stores/useOrgStore';
import { Select } from '../../components/ui/Select';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import type { BadgeVariant } from '../../components/ui/Badge';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { JsonViewer } from '../../components/ui/JsonViewer';
import { ObjectSetEditor } from '../Sync/ObjectSetEditor';
import type { ObjectSetEntry } from '../Sync/ObjectSetEditor';

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
 * Map a sync execution status to a badge color and a label — same mapping and
 * wording as SyncPage. Keyed by `string`: the status arrives off the bridge and
 * is not narrowed at runtime, so an unknown value must still render.
 */
const RUN_STATUS_VARIANTS: Record<string, BadgeVariant> = {
  success: 'success',
  partial: 'warning',
  failure: 'error',
};
const RUN_STATUS_KEYS: Record<string, string> = {
  success: 'sync.complete',
  partial: 'sync.partial',
  failure: 'sync.failed',
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

/** The objects of a config, each the record the importer wrote. */
function configObjects(config: Record<string, unknown>): Array<Record<string, unknown>> {
  const objects = config.objects;
  if (!Array.isArray(objects)) return [];
  return objects.filter(
    (raw): raw is Record<string, unknown> =>
      typeof raw === 'object' && raw !== null && typeof raw.objectApiName === 'string',
  );
}

/** What the object set editor shows of an imported object. */
function toEntry(obj: Record<string, unknown>): ObjectSetEntry {
  return {
    objectApiName: String(obj.objectApiName),
    operation: (typeof obj.operation === 'string' ? obj.operation : 'insert') as SyncOperation,
    externalIdField: typeof obj.externalIdField === 'string' ? obj.externalIdField : '',
    batchSize: typeof obj.batchSize === 'number' ? obj.batchSize : 200,
    where: typeof obj.where === 'string' ? obj.where : '',
  };
}

/**
 * The config as Sync checks it, the org ids aside: the importer's are
 * placeholders the run replaces with the orgs picked here.
 */
const editedConfigSchema = syncConfigSchema.omit({ sourceOrgId: true, targetOrgId: true });

/** Why a config edited here cannot run, or null when it can. */
type EditProblem =
  | { kind: 'noObjects' }
  | { kind: 'upsertNeedsKey'; objectApiName: string }
  | { kind: 'invalid'; reason: string };

/**
 * What keeps the edited config from running: no object left, an upsert with
 * no External ID field to match on (the extension refuses one keyed on `Id`,
 * which the target has never issued), or anything else Sync's own schema
 * refuses, by its first issue.
 */
function editProblem(config: Record<string, unknown>): EditProblem | null {
  const objects = configObjects(config);
  if (objects.length === 0) return { kind: 'noObjects' };
  const unkeyed = objects.find(
    (obj) =>
      obj.operation === 'upsert' &&
      (typeof obj.externalIdField !== 'string' ||
        obj.externalIdField.trim() === '' ||
        obj.externalIdField === 'Id'),
  );
  if (unkeyed) return { kind: 'upsertNeedsKey', objectApiName: String(unkeyed.objectApiName) };
  const checked = editedConfigSchema.safeParse(config);
  if (checked.success) return null;
  const [issue] = checked.error.issues;
  return {
    kind: 'invalid',
    reason: issue ? `${issue.path.join('.')}: ${issue.message}` : checked.error.message,
  };
}

/**
 * Migration page — exposes the SFDMU and universal importers.
 *
 * The import itself is non-destructive: the extension reads the file, converts
 * it to a SandForge SyncConfig and returns it for preview. The objects can be
 * edited here before a run (operation, External ID, batch size, filter, or
 * left out), on a copy of the converted config: what the editor does not show
 * (field mappings, excluded and add-on fields, transform rules, query, order)
 * is sent as the import gave it. Handing the config to the Sync wizard instead
 * would have lost those, which its draft does not hold.
 */
export const MigrationPage: React.FC = () => {
  const { t } = useTranslation();
  const [importType, setImportType] = useState<ImportType>('sfdmu');
  const [filePath, setFilePath] = useState('');

  const orgs = useOrgStore((s) => s.orgs);
  // The importer fills sourceOrgId/targetOrgId with fresh UUID placeholders,
  // so an imported config is structurally runnable but points at two orgs that
  // do not exist. The user picks the real ones before it can execute.
  const [runSourceOrgId, setRunSourceOrgId] = useState('');
  const [runTargetOrgId, setRunTargetOrgId] = useState('');

  // The channel answers with the orchestrator's SyncExecutionResult (status +
  // record totals); a failure never reaches it — it settles on `sync:error`.
  const runMutation = useBridgeMutation<SyncExecutionResult>('sync:execute', {
    responseType: 'sync:execute:response',
    errorType: 'sync:error',
    // A real sync moves records in bulk; the 30 s default is far too short.
    timeoutMs: 120_000,
  });

  const sfdmuMutation = useBridgeMutation<MigrationImportResult>('migration:import-sfdmu');
  const universalMutation = useBridgeMutation<MigrationImportResult>('migration:import');
  const activeMutation = importType === 'sfdmu' ? sfdmuMutation : universalMutation;

  // Validate live once the user has typed something; the empty-path message is
  // only used to gate submission (the disabled button already covers it).
  const pathError = filePath.trim().length > 0 ? validateFilePath(filePath, importType, t) : null;
  const canSubmit = validateFilePath(filePath, importType, t) === null;

  const responseError =
    activeMutation.data && !activeMutation.data.success
      ? (activeMutation.data.error ?? t('migration.unknownError'))
      : null;
  const displayedError = activeMutation.error ?? responseError;
  const successResult =
    activeMutation.data?.success && activeMutation.data.config ? activeMutation.data : null;
  /**
   * The copy of the converted config the editor changes, kept with the import
   * it was made from: a new import starts from its own config again.
   */
  const [edited, setEdited] = useState<{
    source: Record<string, unknown>;
    config: Record<string, unknown>;
  } | null>(null);
  const importedConfig = successResult?.config;
  const workingConfig =
    importedConfig && edited?.source === importedConfig ? edited.config : importedConfig;
  const objectPreviews = workingConfig ? extractObjectPreviews(workingConfig) : [];
  const configName =
    workingConfig && typeof workingConfig.name === 'string' ? workingConfig.name : undefined;
  const workingObjects = workingConfig ? configObjects(workingConfig) : [];
  const problem = workingConfig ? editProblem(workingConfig) : null;

  /** Replace the copy's objects, every other key of the config as imported. */
  const writeObjects = (objects: Array<Record<string, unknown>>): void => {
    if (!importedConfig || !workingConfig) return;
    setEdited({ source: importedConfig, config: { ...workingConfig, objects } });
  };

  /**
   * Write one edited field back into its object. An empty External ID or
   * filter is no key and no filter, not an empty one; every key the editor
   * does not show is left as it was.
   */
  const handleObjectChange = (
    index: number,
    field: keyof ObjectSetEntry,
    value: string | number,
  ): void => {
    writeObjects(
      workingObjects.map((obj, i) => {
        if (i !== index) return obj;
        const next: Record<string, unknown> = { ...obj, [field]: value };
        if ((field === 'externalIdField' || field === 'where') && String(value).trim() === '') {
          delete next[field];
        }
        return next;
      }),
    );
  };

  const handleObjectRemove = (index: number): void => {
    writeObjects(workingObjects.filter((_, i) => i !== index));
  };

  /** The imported objects left out, which can be put back as imported. */
  const removedObjects = importedConfig
    ? configObjects(importedConfig).filter(
        (obj) => !workingObjects.some((kept) => kept.objectApiName === obj.objectApiName),
      )
    : [];

  /** Put a left-out object back, as imported, where it stood in the import. */
  const handleObjectAdd = (objectApiName: string): void => {
    if (!importedConfig) return;
    const order = configObjects(importedConfig).map((obj) => obj.objectApiName);
    const restored = configObjects(importedConfig).find(
      (obj) => obj.objectApiName === objectApiName,
    );
    if (!restored) return;
    writeObjects(
      [...workingObjects, restored].sort(
        (a, b) => order.indexOf(a.objectApiName) - order.indexOf(b.objectApiName),
      ),
    );
  };

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
    setEdited(null);
    sfdmuMutation.reset();
    universalMutation.reset();
    runMutation.reset();
    setRunSourceOrgId('');
    setRunTargetOrgId('');
  };

  /** Both orgs picked and distinct — a sync into its own source is not a sync. */
  const orgsPicked =
    runSourceOrgId.length > 0 && runTargetOrgId.length > 0 && runSourceOrgId !== runTargetOrgId;
  /** The orgs picked, and a config Sync accepts as edited. */
  const canRunImported = orgsPicked && problem === null;

  /** Why the edited config cannot run, in the page's language. */
  const problemMessage =
    problem === null
      ? null
      : problem.kind === 'noObjects'
        ? t('migration.edit.noObjects')
        : problem.kind === 'upsertNeedsKey'
          ? t('migration.edit.upsertNeedsKey', { object: problem.objectApiName })
          : t('migration.edit.invalid', { reason: problem.reason });

  /**
   * Run the imported config through the existing sync pipeline.
   *
   * `sync:execute` is declared, routed and handled end to end — production
   * guard, DML dedup, background registry, progress events, history logging.
   * The import screen simply never sent anything to it, so a converted config
   * was rendered and then dropped on unmount.
   */
  const handleRunImported = (): void => {
    if (!workingConfig || !canRunImported || runMutation.loading) return;
    runMutation.mutate({
      config: {
        // The copy as edited here: what the editor does not show is the import's.
        ...workingConfig,
        // The importer's org ids are generated placeholders; substitute the
        // orgs the user actually picked.
        sourceOrgId: runSourceOrgId,
        targetOrgId: runTargetOrgId,
      },
    });
  };

  return (
    <div className="flex flex-col gap-(--sf-space-4) p-(--sf-space-4)" data-testid="migration-page">
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
        className="grid grid-cols-1 sm:grid-cols-2 gap-(--sf-space-3)"
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
          <FileJson className="w-4 h-4 mt-0.5 shrink-0 text-hue-teal" />
          <span>
            <span className="block text-sm font-semibold text-text-primary">
              {t('migration.type.sfdmu.title')}
            </span>
            <span className="block text-xs text-text-secondary mt-0.5">
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
          <FileUp className="w-4 h-4 mt-0.5 shrink-0 text-hue-teal" />
          <span>
            <span className="block text-sm font-semibold text-text-primary">
              {t('migration.type.universal.title')}
            </span>
            <span className="block text-xs text-text-secondary mt-0.5">
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
          <div className="flex flex-col gap-(--sf-space-3)">
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
            <div className="flex flex-col gap-(--sf-space-3)">
              <div className="text-xs text-text-secondary" data-testid="migration-objects-count">
                {t('migration.objectsCount', { count: objectPreviews.length })}
              </div>
              <ul className="flex flex-col gap-(--sf-space-2)" data-testid="migration-objects">
                {objectPreviews.map((obj) => (
                  <li
                    key={obj.objectApiName}
                    className="flex flex-col gap-1 rounded-sm px-2.5 py-2 bg-surface-1 border border-subtle"
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
                        <span className="text-xs text-text-secondary">
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
              {/* The objects as they will run, edited on a copy of the import. */}
              <div data-testid="migration-edit">
                <ObjectSetEditor
                  entries={workingObjects.map(toEntry)}
                  availableObjects={removedObjects.map((obj) => String(obj.objectApiName))}
                  onAdd={handleObjectAdd}
                  onRemove={handleObjectRemove}
                  onChange={handleObjectChange}
                />
              </div>
              {problemMessage !== null && (
                <div
                  className="text-xs text-status-error"
                  role="alert"
                  data-testid="migration-edit-problem"
                >
                  {problemMessage}
                </div>
              )}
              {/* Until now the import ended here: the converted config was
                  rendered as JSON and dropped when the page unmounted, with no
                  way to save or run what had just been imported. */}
              {successResult.config && (
                <div
                  className="flex flex-col gap-(--sf-space-2) rounded-sm border border-subtle bg-surface-1 p-3"
                  data-testid="migration-run"
                >
                  <div className="text-sm font-semibold text-text-primary">
                    {t('migration.run.title')}
                  </div>
                  <div className="text-xs text-text-secondary">{t('migration.run.subtitle')}</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-(--sf-space-2)">
                    <Select
                      label={t('migration.run.sourceOrg')}
                      data-testid="migration-run-source"
                      options={orgs.map((o) => ({ value: o.id, label: o.alias || o.username }))}
                      value={runSourceOrgId}
                      onChange={(e) => setRunSourceOrgId(e.target.value)}
                    />
                    <Select
                      label={t('migration.run.targetOrg')}
                      data-testid="migration-run-target"
                      options={orgs.map((o) => ({ value: o.id, label: o.alias || o.username }))}
                      value={runTargetOrgId}
                      onChange={(e) => setRunTargetOrgId(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    data-testid="migration-run-btn"
                    disabled={!canRunImported || runMutation.loading}
                    onClick={handleRunImported}
                  >
                    {runMutation.loading ? t('migration.run.running') : t('migration.run.action')}
                  </Button>
                  {!orgsPicked && (
                    <div className="text-xs text-text-secondary" data-testid="migration-run-hint">
                      {t('migration.run.orgsRequired')}
                    </div>
                  )}
                  {/* The run used to be fire-and-forget: records moved for real
                      and neither the outcome nor the failure was ever read back
                      off the mutation. Both are rendered here now. */}
                  {runMutation.error && (
                    <ErrorBanner
                      message={runMutation.error}
                      onDismiss={() => runMutation.reset()}
                      data-testid="migration-run-error"
                    />
                  )}
                  {/* `data` survives a new mutate(), so a re-run would show the
                      previous outcome as if it were the new one. */}
                  {runMutation.data && !runMutation.loading && (
                    <div
                      className="flex flex-wrap items-center gap-3 text-xs"
                      data-testid="migration-run-result"
                    >
                      {/* A run a cancel stopped reads as cancelled, as on the Sync tab. */}
                      {runMutation.data.cancelled ? (
                        <Badge variant="default">{t('home.opStatus.cancelled')}</Badge>
                      ) : (
                        <Badge variant={RUN_STATUS_VARIANTS[runMutation.data.status] ?? 'default'}>
                          {t(RUN_STATUS_KEYS[runMutation.data.status] ?? 'sync.failed')}
                        </Badge>
                      )}
                      <span>
                        {t('sync.totalProcessed')}:{' '}
                        <strong>{runMutation.data.totalProcessed}</strong>
                      </span>
                      <span>
                        {t('sync.totalSuccess')}: <strong>{runMutation.data.totalSuccess}</strong>
                      </span>
                      {runMutation.data.totalFailed > 0 && (
                        <span className="text-status-error">
                          {t('sync.totalFailed')}: <strong>{runMutation.data.totalFailed}</strong>
                        </span>
                      )}
                      {runMutation.data.totalSkipped > 0 && (
                        <span className="text-text-secondary">
                          {t('sync.totalSkipped')}: <strong>{runMutation.data.totalSkipped}</strong>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <details data-testid="migration-raw-config">
                <summary className="text-xs text-text-secondary cursor-pointer select-none">
                  {t('migration.rawConfig')}
                </summary>
                <div className="mt-2 rounded-sm bg-surface-1 border border-subtle p-2 overflow-auto">
                  <JsonViewer data={workingConfig ?? successResult.config} collapsed />
                </div>
              </details>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
};
