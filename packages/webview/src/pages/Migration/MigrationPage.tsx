import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import type {
  MigrationPickFileResponse,
  MigrationSaveSyncConfigResponse,
  SyncOperation,
} from '@sandforge/shared';
import { syncConfigSchema } from '@sandforge/shared';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { Select } from '../../components/ui/Select';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { JsonViewer } from '../../components/ui/JsonViewer';
import { ObjectSetEditor } from '../Sync/ObjectSetEditor';
import type { ObjectSetEntry } from '../Sync/ObjectSetEditor';
import { ModuleHowTo } from '../../components/ui/ModuleHowTo';
import { orgOptionLabel } from '../../utils/orgFormatters';

/** Response payload of `migration:import-sfdmu:response`. */
interface MigrationImportResult {
  success: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

/** The extension the importer takes — mirrors MigrationHandler's whitelist. */
const ALLOWED_EXTENSION = '.json';

/**
 * Matches absolute paths on every supported host: POSIX (`/…`),
 * Windows drive (`C:\…` / `C:/…`) and UNC (`\\server\…`).
 */
const ABSOLUTE_PATH_RE = /^(\/|\\\\|[a-zA-Z]:[\\/])/;

/**
 * How long Browse… waits for the file picked: a person looking through
 * folders, for as long as that takes, where a request is given thirty seconds.
 */
const PICK_FILE_WAIT_MS = 60 * 60 * 1000;

/**
 * Client-side mirror of the handler's path rules (absolute path, `.json`).
 * The handler additionally enforces workspace/home containment — that error
 * surfaces through the bridge response.
 *
 * @returns An error message, or null when the path passes local validation.
 */
function validateFilePath(
  filePath: string,
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
  if (extension !== ALLOWED_EXTENSION) {
    return t('migration.validation.pathExtension', { extensions: ALLOWED_EXTENSION });
  }
  return null;
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

/** How many entries a list key of an imported object holds. */
function countOf(obj: Record<string, unknown> | undefined, key: string): number {
  const list = obj?.[key];
  return Array.isArray(list) ? list.length : 0;
}

/**
 * The config as Sync checks it, the org ids aside: the importer's are
 * placeholders the save replaces with the orgs picked here.
 */
const editedConfigSchema = syncConfigSchema.omit({ sourceOrgId: true, targetOrgId: true });

/** Why the host saved no Sync configuration, in the page's language. */
function saveRefusalMessage(
  answer: Extract<MigrationSaveSyncConfigResponse['payload'], { success: false }>,
  name: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (answer.code) {
    case 'NAME_REQUIRED':
      return t('migration.saveSync.nameRequired');
    case 'DUPLICATE_NAME':
      return t('migration.saveSync.duplicateName', { name });
    case 'SYNC_CANNOT_COPY':
      return t('migration.saveSync.cannotCopy', { objects: (answer.objects ?? []).join(', ') });
    case 'INVALID_CONFIG':
      return t('migration.saveSync.invalid', { reason: answer.reason ?? '' });
  }
}

/** Why a config edited here cannot be saved, or null when it can. */
type EditProblem =
  | { kind: 'noObjects' }
  | { kind: 'upsertNeedsKey'; objectApiName: string }
  | { kind: 'invalid'; reason: string };

/**
 * What keeps the edited config from being saved for Sync: no object left, an
 * upsert with no External ID field to match on (the extension refuses one
 * keyed on `Id`, which the target has never issued), or anything else Sync's
 * own schema refuses, by its first issue.
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
 * Migration page — converts an SFDMU export.json into a Sync configuration.
 *
 * The import itself is non-destructive: the extension reads the file,
 * converts it to a SandForge SyncConfig and returns it for preview. The
 * objects can be edited here (operation, External ID, batch size, filter, or
 * left out), on a copy of the converted config: what the editor does not show
 * (field mappings, excluded and add-on fields, transform rules, query, order)
 * is kept as the import gave it. Handing the config to the Sync wizard instead
 * would have lost those, which its draft does not hold.
 *
 * The page runs nothing. It saves the config among Sync's configurations, and
 * "Open in Sync" opens that one on Sync's execute step, where its Simulate,
 * progress, Stop, refusals, results and removal are Sync's own. Its Run sync
 * was a second way to run, poorer than the first: it waited 120 seconds, said
 * "Try again" while the run went on writing, so that a second click wrote
 * every record twice, and showed totals alone.
 */
export const MigrationPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useAppStore((s) => s.navigate);
  const [filePath, setFilePath] = useState('');

  const orgs = useOrgStore((s) => s.orgs);
  const orgOptions = orgs.map((org) => ({ value: org.id, label: orgOptionLabel(org, t) }));
  // The importer fills sourceOrgId/targetOrgId with fresh UUID placeholders,
  // so an imported config points at two orgs that do not exist. The user
  // picks the real ones before it can be saved for Sync.
  const [runSourceOrgId, setRunSourceOrgId] = useState('');
  const [runTargetOrgId, setRunTargetOrgId] = useState('');

  // Saves the migration on screen among Sync's configurations, which the Sync
  // page lists and runs, and a schedule runs by id.
  const saveSyncMutation = useBridgeMutation<MigrationSaveSyncConfigResponse['payload']>(
    'migration:save-sync-config',
  );
  const [syncConfigName, setSyncConfigName] = useState('');
  /** The name the last save was asked under: what its answer is about. */
  const [savedUnder, setSavedUnder] = useState('');
  /** What was on screen when the last save was asked: the config, the orgs. */
  const [savedFor, setSavedFor] = useState('');

  const importMutation = useBridgeMutation<MigrationImportResult>('migration:import-sfdmu');

  // Browse…: the window's open dialog, its file put in File path.
  const pickMutation = useBridgeMutation<MigrationPickFileResponse['payload']>(
    'migration:pick-file',
    { timeoutMs: PICK_FILE_WAIT_MS },
  );
  const picked = pickMutation.data;
  useEffect(() => {
    if (picked?.filePath) setFilePath(picked.filePath);
  }, [picked]);

  // Validate live once the user has typed something; the empty-path message is
  // only used to gate submission (the disabled button already covers it).
  const pathError = filePath.trim().length > 0 ? validateFilePath(filePath, t) : null;
  const canSubmit = validateFilePath(filePath, t) === null;

  const responseError =
    importMutation.data && !importMutation.data.success
      ? (importMutation.data.error ?? t('migration.unknownError'))
      : null;
  const displayedError = importMutation.error ?? responseError;
  const successResult =
    importMutation.data?.success && importMutation.data.config ? importMutation.data : null;
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

  /**
   * What an object carries that its row does not show, said under it: the
   * import listed every object a second time, read-only, for these counts.
   */
  const objectDetail = (entry: ObjectSetEntry): string => {
    const obj = workingObjects.find((kept) => kept.objectApiName === entry.objectApiName);
    return [
      t('migration.objectSummary.mappings', { count: countOf(obj, 'fieldMappings') }),
      t('migration.objectSummary.rules', { count: countOf(obj, 'transformRules') }),
      t('migration.objectSummary.excluded', { count: countOf(obj, 'excludedFields') }),
    ].join(' · ');
  };

  const handleImport = (): void => {
    if (!canSubmit || importMutation.loading) return;
    importMutation.mutate({ filePath: filePath.trim() });
  };

  const handleReset = (): void => {
    setFilePath('');
    setEdited(null);
    importMutation.reset();
    pickMutation.reset();
    saveSyncMutation.reset();
    setSyncConfigName('');
    setRunSourceOrgId('');
    setRunTargetOrgId('');
  };

  /** Both orgs picked and distinct — a sync into its own source is not a sync. */
  const orgsPicked =
    runSourceOrgId.length > 0 && runTargetOrgId.length > 0 && runSourceOrgId !== runTargetOrgId;

  /** Why the edited config cannot be saved for Sync, in the page's language. */
  const problemMessage =
    problem === null
      ? null
      : problem.kind === 'noObjects'
        ? t('migration.edit.noObjects')
        : problem.kind === 'upsertNeedsKey'
          ? t('migration.edit.upsertNeedsKey', { object: problem.objectApiName })
          : t('migration.edit.invalid', { reason: problem.reason });

  /** A name, the orgs picked, and a config Sync accepts as edited. */
  const canSaveAsSync =
    orgsPicked && problem === null && syncConfigName.trim().length > 0 && !saveSyncMutation.loading;

  /** The config on screen and the orgs picked: what a save would keep. */
  const onScreen = JSON.stringify([workingConfig ?? null, runSourceOrgId, runTargetOrgId]);

  /**
   * Save the config as edited here, between the orgs picked here, as a Sync
   * configuration. The host checks it with Sync's own schema and refuses,
   * by a code said below, a name already taken or an object Sync does not
   * copy.
   */
  const handleSaveAsSync = (): void => {
    if (!workingConfig || !canSaveAsSync) return;
    const name = syncConfigName.trim();
    setSavedUnder(name);
    setSavedFor(onScreen);
    saveSyncMutation.mutate({
      name,
      config: { ...workingConfig, sourceOrgId: runSourceOrgId, targetOrgId: runTargetOrgId },
    });
  };
  const saveAnswer = saveSyncMutation.loading ? null : saveSyncMutation.data;
  const saveError =
    saveSyncMutation.error ??
    (saveAnswer && !saveAnswer.success ? saveRefusalMessage(saveAnswer, savedUnder, t) : null);
  const saved = saveAnswer?.success ? saveAnswer : null;
  /**
   * Whether the configuration saved is the one on screen. Changed since, it
   * is another: "Open in Sync" would open what was saved, not what is shown.
   */
  const savedIsOnScreen = saved !== null && savedFor === onScreen;

  /**
   * Sync's execute step, on the configuration saved: its Simulate, its run
   * with progress and Stop, its results with the refusals and the removal.
   */
  const handleOpenInSync = (): void => {
    if (!saved || !savedIsOnScreen) return;
    navigate('sync', {
      sourceOrgId: runSourceOrgId,
      targetOrgId: runTargetOrgId,
      syncConfig: { id: saved.id, name: saved.name },
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
      <ModuleHowTo module="migration" />

      {/* Source file */}
      <Card data-testid="migration-source-card">
        <CardHeader
          title={t('migration.type.sfdmu.title')}
          subtitle={t('migration.type.sfdmu.description')}
        />
        <CardBody>
          <div className="flex flex-col gap-(--sf-space-3)">
            <Input
              label={t('migration.filePathLabel')}
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              placeholder={t('migration.filePathPlaceholderSfdmu')}
              hint={t('migration.filePathHint')}
              error={pathError ?? undefined}
              disabled={importMutation.loading}
              data-testid="migration-path-input"
            />
            <div className="flex justify-end gap-(--sf-space-2)">
              <Button
                variant="secondary"
                onClick={() => pickMutation.mutate()}
                disabled={importMutation.loading}
                loading={pickMutation.loading}
                data-testid="migration-browse-btn"
              >
                {t('migration.browse')}
              </Button>
              <Button
                variant="primary"
                onClick={handleImport}
                disabled={!canSubmit}
                loading={importMutation.loading}
                data-testid="migration-import-btn"
              >
                {importMutation.loading ? t('migration.importing') : t('migration.import')}
              </Button>
            </div>
            {pickMutation.error && (
              <ErrorBanner
                message={pickMutation.error}
                code={pickMutation.errorCode}
                onDismiss={() => pickMutation.reset()}
                data-testid="migration-browse-error"
              />
            )}
          </div>
        </CardBody>
      </Card>

      {/* A CSV file of records: the page read its column names and dropped its
          rows, under a card promising they would be mapped. Seed loads them. */}
      <div
        className="flex flex-wrap items-center gap-(--sf-space-3) rounded-lg border border-subtle bg-surface-1 p-3"
        data-testid="migration-csv-data"
      >
        <Upload className="w-4 h-4 shrink-0 text-hue-teal" aria-hidden="true" />
        <p className="flex-1 min-w-48 text-xs text-text-secondary">{t('migration.csvData.text')}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate('seed', { seedMode: 'csv' })}
          data-testid="migration-csv-data-btn"
        >
          {t('migration.csvData.action')}
        </Button>
      </div>

      {displayedError && (
        <ErrorBanner
          message={displayedError}
          code={importMutation.errorCode}
          onDismiss={() => importMutation.reset()}
          data-testid="migration-error"
        />
      )}

      {/* Import result */}
      {successResult && (
        <Card data-testid="migration-result">
          <CardHeader
            title={t('migration.successTitle')}
            subtitle={configName ?? t('migration.successDescription')}
          />
          <CardBody>
            <div className="flex flex-col gap-(--sf-space-3)">
              {/* The objects as Sync will run them, edited on a copy of the import. */}
              <div data-testid="migration-edit">
                <ObjectSetEditor
                  entries={workingObjects.map(toEntry)}
                  availableObjects={removedObjects.map((obj) => String(obj.objectApiName))}
                  onAdd={handleObjectAdd}
                  onRemove={handleObjectRemove}
                  onChange={handleObjectChange}
                  rowDetail={objectDetail}
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
              <div
                className="flex flex-col gap-(--sf-space-2) rounded-sm border border-subtle bg-surface-1 p-3"
                data-testid="migration-for-sync"
              >
                <div className="text-sm font-semibold text-text-primary">
                  {t('migration.run.title')}
                </div>
                <div className="text-xs text-text-secondary">{t('migration.run.subtitle')}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-(--sf-space-2)">
                  {/* Each org named with its type, as every other picker names
                      it, and none chosen until the user picks. */}
                  <Select
                    label={t('migration.run.sourceOrg')}
                    data-testid="migration-run-source"
                    options={orgOptions}
                    placeholder={t('common.selectOrg')}
                    value={runSourceOrgId}
                    onChange={(e) => setRunSourceOrgId(e.target.value)}
                  />
                  <Select
                    label={t('migration.run.targetOrg')}
                    data-testid="migration-run-target"
                    options={orgOptions}
                    placeholder={t('common.selectOrg')}
                    value={runTargetOrgId}
                    onChange={(e) => setRunTargetOrgId(e.target.value)}
                  />
                </div>
                {!orgsPicked && (
                  <div className="text-xs text-text-secondary" data-testid="migration-run-hint">
                    {t('migration.run.orgsRequired')}
                  </div>
                )}
                <Input
                  label={t('migration.saveSync.nameLabel')}
                  value={syncConfigName}
                  onChange={(e) => setSyncConfigName(e.target.value)}
                  hint={t('migration.saveSync.nameHint')}
                  maxLength={200}
                  disabled={saveSyncMutation.loading}
                  data-testid="migration-save-sync-name"
                />
                <Button
                  variant="primary"
                  size="sm"
                  className="self-start"
                  data-testid="migration-save-sync-btn"
                  // Saved as it is shown, a second save would only be refused
                  // its name: Open in Sync is what comes next.
                  disabled={!canSaveAsSync || savedIsOnScreen}
                  onClick={handleSaveAsSync}
                >
                  {saveSyncMutation.loading
                    ? t('migration.saveSync.saving')
                    : t('migration.saveSync.action')}
                </Button>
                {saved && savedIsOnScreen && (
                  <div className="flex flex-col gap-(--sf-space-2)">
                    <div
                      className="text-xs text-status-success"
                      role="status"
                      data-testid="migration-save-sync-saved"
                    >
                      {t('migration.saveSync.saved', { name: saved.name })}
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      className="self-start"
                      onClick={handleOpenInSync}
                      data-testid="migration-open-in-sync-btn"
                    >
                      {t('migration.saveSync.openInSync')}
                    </Button>
                  </div>
                )}
                {saved && !savedIsOnScreen && (
                  <div
                    className="text-xs text-text-secondary"
                    role="status"
                    data-testid="migration-save-sync-changed"
                  >
                    {t('migration.saveSync.changedSinceSaved', { name: saved.name })}
                  </div>
                )}
                {saveError && (
                  <ErrorBanner
                    message={saveError}
                    code={saveSyncMutation.errorCode}
                    onDismiss={() => saveSyncMutation.reset()}
                    data-testid="migration-save-sync-error"
                  />
                )}
              </div>

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
