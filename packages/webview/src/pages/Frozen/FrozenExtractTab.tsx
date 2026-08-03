import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Plus, Save, Trash2 } from 'lucide-react';
import type {
  FrozenControlCheck,
  FrozenExtractResponse,
  FrozenManifestInfo,
  FrozenProjectConfig,
  FrozenSelectResponse,
} from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { useFrozenStore } from '../../stores/useFrozenStore';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Card, CardBody } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ErrorBanner } from '../../components/ui/ErrorBanner';
import { useFrozenMutation } from './useFrozenBridge';

/** Draft row for one coverage axis. */
interface AxisDraft {
  name: string;
  label: string;
  filterField: string;
  valuesSoql: string;
}

/** Draft row for one edge case. */
interface EdgeCaseDraft {
  name: string;
  label: string;
  whereFragment: string;
}

/** Keys of FrozenProjectConfig edited through the simple form fields. */
const FORM_KEYS = new Set(['rootObject', 'budgetMaxRecords', 'axes', 'edgeCases']);

const EMPTY_AXIS: AxisDraft = { name: '', label: '', filterField: '', valuesSoql: '' };
const EMPTY_EDGE: EdgeCaseDraft = { name: '', label: '', whereFragment: '' };

const inputClass =
  'w-full bg-surface-1 border border-subtle rounded px-2 py-1 text-xs text-text-primary';

/** Split a saved config into form fields + the advanced JSON remainder. */
function splitConfig(config: FrozenProjectConfig): {
  rootObject: string;
  budget: string;
  axes: AxisDraft[];
  edgeCases: EdgeCaseDraft[];
  advancedJson: string;
} {
  const advanced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!FORM_KEYS.has(key) && value !== undefined) advanced[key] = value;
  }
  return {
    rootObject: config.rootObject,
    budget: String(config.budgetMaxRecords ?? 2500),
    axes: config.axes.map((a) => ({ ...a })),
    edgeCases: config.edgeCases.map((e) => ({ ...e })),
    advancedJson: JSON.stringify(advanced, null, 2),
  };
}

/** Props for the extract tab. */
export interface FrozenExtractTabProps {
  /** Refetch the module status after a mutation completed. */
  onRefetchStatus: () => void;
}

/**
 * Extract tab: coverage-axes/budget configuration, coverage-matrix
 * selection, then extraction + pseudonymization + 4-point gate + manifest.
 */
export const FrozenExtractTab: React.FC<FrozenExtractTabProps> = ({ onRefetchStatus }) => {
  const { t } = useTranslation();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const selection = useFrozenStore((s) => s.selection);
  const setSelection = useFrozenStore((s) => s.setSelection);
  const controlReport = useFrozenStore((s) => s.controlReport);
  const setConfig = useFrozenStore((s) => s.setConfig);
  const setExtractSummary = useFrozenStore((s) => s.setExtractSummary);
  const setManifest = useFrozenStore((s) => s.setManifest);
  const lastError = useFrozenStore((s) => s.lastError);

  const [rootObject, setRootObject] = useState('');
  const [budget, setBudget] = useState('2500');
  const [axes, setAxes] = useState<AxisDraft[]>([]);
  const [edgeCases, setEdgeCases] = useState<EdgeCaseDraft[]>([]);
  const [advancedJson, setAdvancedJson] = useState('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const configQuery = useBridgeQuery<{
    config: FrozenProjectConfig | null;
    sasDir: string;
    datasetDir: string;
  }>('frozen:config:get');

  useEffect(() => {
    const config = configQuery.data?.config;
    if (!config) return;
    setConfig(config);
    const draft = splitConfig(config);
    setRootObject(draft.rootObject);
    setBudget(draft.budget);
    setAxes(draft.axes);
    setEdgeCases(draft.edgeCases);
    setAdvancedJson(draft.advancedJson);
  }, [configQuery.data, setConfig]);

  const saveMutation = useFrozenMutation<{ success: boolean }>('frozen:config:save');
  const selectMutation = useFrozenMutation<FrozenSelectResponse['payload']>('frozen:select', {
    timeoutMs: 600_000,
  });
  const extractMutation = useFrozenMutation<FrozenExtractResponse['payload']>('frozen:extract', {
    timeoutMs: 900_000,
  });

  useEffect(() => {
    if (selectMutation.data?.selection) {
      setSelection(selectMutation.data.selection);
      onRefetchStatus();
    }
  }, [selectMutation.data, setSelection, onRefetchStatus]);

  useEffect(() => {
    const data = extractMutation.data;
    if (!data) return;
    setExtractSummary({
      datasetDir: data.datasetDir,
      recordCount: data.recordCount,
      fileCount: data.files.length,
    });
    setManifest(data.manifest as FrozenManifestInfo);
    onRefetchStatus();
  }, [extractMutation.data, setExtractSummary, setManifest, onRefetchStatus]);

  const handleSaveConfig = (): void => {
    setJsonError(null);
    let advanced: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(advancedJson || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setJsonError(t('frozen.config.invalidJson'));
        return;
      }
      advanced = parsed as Record<string, unknown>;
    } catch {
      setJsonError(t('frozen.config.invalidJson'));
      return;
    }
    const budgetNum = Number.parseInt(budget, 10);
    const config: FrozenProjectConfig = {
      ...advanced,
      rootObject: rootObject.trim(),
      axes: axes.filter((a) => a.name.trim() !== '' && a.valuesSoql.trim() !== ''),
      edgeCases: edgeCases.filter((e) => e.name.trim() !== ''),
      ...(Number.isFinite(budgetNum) && budgetNum > 0 ? { budgetMaxRecords: budgetNum } : {}),
    } as FrozenProjectConfig;
    saveMutation.mutate({ config } as unknown as Record<string, unknown>);
  };

  const updateAxis = (index: number, patch: Partial<AxisDraft>): void => {
    setAxes((prev) => prev.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  };
  const updateEdgeCase = (index: number, patch: Partial<EdgeCaseDraft>): void => {
    setEdgeCases((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  };

  const combinationRows = (selection?.combinations ?? []).map((c) => ({
    combinationKey: c.combinationKey,
    axes: Object.entries(c.axisValues)
      .map(([k, v]) => `${k}=${v ?? '∅'}`)
      .join(' | '),
    edgeCase: c.edgeCase ?? '',
  }));

  const checkColumns = [
    { key: 'name', header: t('frozen.control.check'), sortable: true },
    {
      key: 'passed',
      header: t('frozen.control.result'),
      render: (row: Record<string, unknown>) => (
        <Badge variant={row.passed ? 'success' : 'error'}>
          {row.passed ? t('frozen.control.pass') : t('frozen.control.fail')}
        </Badge>
      ),
    },
    { key: 'violations', header: t('frozen.control.violations'), align: 'right' as const },
  ];

  const checkRows = (controlReport?.checks ?? []).map((c: FrozenControlCheck) => ({
    name: c.name,
    passed: c.passed,
    violations: c.violations.length,
  }));

  const failedViolations = (controlReport?.checks ?? []).flatMap((c) =>
    c.violations.slice(0, 5).map((v) => ({
      key: `${c.name}:${v.objectApiName}:${v.referenceId}:${v.field ?? ''}`,
      check: c.name,
      object: v.objectApiName,
      referenceId: v.referenceId,
      field: v.field ?? '',
      detail: v.detail,
    })),
  );

  return (
    <div className="flex flex-col gap-4" data-testid="frozen-extract-tab">
      {lastError && (
        <ErrorBanner
          message={`${lastError.code}: ${lastError.message}`}
          data-testid="frozen-error"
        />
      )}

      {/* ── Configuration ─────────────────────────────────────────────── */}
      <Card className="border border-subtle bg-surface-1">
        <CardBody className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-text-primary">{t('frozen.config.title')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">{t('frozen.config.rootObject')}</span>
              <input
                className={inputClass}
                value={rootObject}
                onChange={(e) => setRootObject(e.target.value)}
                placeholder="Case"
                data-testid="frozen-config-root-object"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-text-muted">{t('frozen.config.budget')}</span>
              <input
                className={inputClass}
                type="number"
                min={1}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                data-testid="frozen-config-budget"
              />
            </label>
          </div>

          {/* Coverage axes */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-primary">
                {t('frozen.config.axes')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus className="w-3 h-3" />}
                onClick={() => setAxes((prev) => [...prev, { ...EMPTY_AXIS }])}
                data-testid="frozen-axis-add"
              >
                {t('frozen.config.addAxis')}
              </Button>
            </div>
            {axes.map((axis, index) => (
              <div
                key={index}
                className="grid grid-cols-[1fr_1fr_1fr_2fr_auto] gap-2 items-center"
                data-testid={`frozen-axis-row-${index}`}
              >
                <input
                  className={inputClass}
                  value={axis.name}
                  placeholder={t('frozen.config.axisName')}
                  onChange={(e) => updateAxis(index, { name: e.target.value })}
                />
                <input
                  className={inputClass}
                  value={axis.label}
                  placeholder={t('frozen.config.axisLabel')}
                  onChange={(e) => updateAxis(index, { label: e.target.value })}
                />
                <input
                  className={inputClass}
                  value={axis.filterField}
                  placeholder={t('frozen.config.axisField')}
                  onChange={(e) => updateAxis(index, { filterField: e.target.value })}
                />
                <input
                  className={inputClass}
                  value={axis.valuesSoql}
                  placeholder={t('frozen.config.axisSoql')}
                  onChange={(e) => updateAxis(index, { valuesSoql: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 className="w-3 h-3" />}
                  aria-label={t('frozen.config.removeAxis')}
                  onClick={() => setAxes((prev) => prev.filter((_, i) => i !== index))}
                />
              </div>
            ))}
          </div>

          {/* Edge cases */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-primary">
                {t('frozen.config.edgeCases')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus className="w-3 h-3" />}
                onClick={() => setEdgeCases((prev) => [...prev, { ...EMPTY_EDGE }])}
                data-testid="frozen-edge-add"
              >
                {t('frozen.config.addEdgeCase')}
              </Button>
            </div>
            {edgeCases.map((edge, index) => (
              <div
                key={index}
                className="grid grid-cols-[1fr_1fr_2fr_auto] gap-2 items-center"
                data-testid={`frozen-edge-row-${index}`}
              >
                <input
                  className={inputClass}
                  value={edge.name}
                  placeholder={t('frozen.config.edgeName')}
                  onChange={(e) => updateEdgeCase(index, { name: e.target.value })}
                />
                <input
                  className={inputClass}
                  value={edge.label}
                  placeholder={t('frozen.config.edgeLabel')}
                  onChange={(e) => updateEdgeCase(index, { label: e.target.value })}
                />
                <input
                  className={inputClass}
                  value={edge.whereFragment}
                  placeholder={t('frozen.config.edgeWhere')}
                  onChange={(e) => updateEdgeCase(index, { whereFragment: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 className="w-3 h-3" />}
                  aria-label={t('frozen.config.removeEdgeCase')}
                  onClick={() => setEdgeCases((prev) => prev.filter((_, i) => i !== index))}
                />
              </div>
            ))}
          </div>

          {/* Advanced config (JSON) */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-text-muted">{t('frozen.config.advanced')}</span>
            <textarea
              className={`${inputClass} font-mono h-28`}
              value={advancedJson}
              onChange={(e) => setAdvancedJson(e.target.value)}
              spellCheck={false}
              data-testid="frozen-config-advanced"
            />
          </label>
          {jsonError && <p className="text-xs text-red-400">{jsonError}</p>}

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Save className="w-3 h-3" />}
              loading={saveMutation.loading}
              onClick={handleSaveConfig}
              data-testid="frozen-config-save"
            >
              {t('frozen.config.save')}
            </Button>
            {saveMutation.data?.success && (
              <span className="text-xs text-green-400" data-testid="frozen-config-saved">
                {t('frozen.config.saved')}
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      {/* ── Selection ─────────────────────────────────────────────────── */}
      <Card className="border border-subtle bg-surface-1">
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('frozen.selection.title')}
            </h2>
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="w-3 h-3" />}
              loading={selectMutation.loading}
              disabled={!selectedOrgId}
              onClick={() => selectMutation.mutate({ sourceOrgId: selectedOrgId })}
              data-testid="frozen-select-run"
            >
              {t('frozen.selection.run')}
            </Button>
          </div>
          {selectMutation.error && <ErrorBanner message={selectMutation.error} />}
          {selection && (
            <>
              <p className="text-xs text-text-secondary" data-testid="frozen-selection-volumetry">
                {t('frozen.selection.volumetry', {
                  total: selection.volumetry.total,
                  budget: selection.volumetry.budgetMax,
                })}
              </p>
              <DataTable
                columns={[
                  {
                    key: 'combinationKey',
                    header: t('frozen.selection.combination'),
                    sortable: true,
                  },
                  { key: 'axes', header: t('frozen.selection.axes') },
                  {
                    key: 'edgeCase',
                    header: t('frozen.selection.edgeCase'),
                    render: (row: Record<string, unknown>) =>
                      row.edgeCase ? <Badge variant="info">{String(row.edgeCase)}</Badge> : null,
                  },
                ]}
                data={combinationRows}
                keyExtractor={(row) => row.combinationKey as string}
                emptyMessage={t('frozen.selection.empty')}
              />
              {selection.uncovered.length > 0 && (
                <div data-testid="frozen-selection-uncovered">
                  <span className="text-xs font-medium text-amber-400">
                    {t('frozen.selection.uncovered', { count: selection.uncovered.length })}
                  </span>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {selection.uncovered.map((u) => (
                      <li key={u.combinationKey} className="text-[11px] text-text-muted">
                        {u.combinationKey} — {u.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {/* ── Extraction + control ──────────────────────────────────────── */}
      <Card className="border border-subtle bg-surface-1">
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">{t('frozen.extract.title')}</h2>
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="w-3 h-3" />}
              loading={extractMutation.loading}
              disabled={!selectedOrgId || !selection}
              onClick={() => extractMutation.mutate({ sourceOrgId: selectedOrgId })}
              data-testid="frozen-extract-run"
            >
              {t('frozen.extract.run')}
            </Button>
          </div>
          {extractMutation.error && <ErrorBanner message={extractMutation.error} />}
          {extractMutation.data && (
            <p className="text-xs text-text-secondary" data-testid="frozen-extract-summary">
              {t('frozen.extract.summary', {
                count: extractMutation.data.recordCount,
                files: extractMutation.data.files.length,
              })}
            </p>
          )}
          {controlReport && (
            <div className="flex flex-col gap-2" data-testid="frozen-control-result">
              <div className="flex items-center gap-2">
                <Badge variant={controlReport.passed ? 'success' : 'error'}>
                  {controlReport.passed ? t('frozen.control.pass') : t('frozen.control.fail')}
                </Badge>
                <span className="text-[10px] text-text-muted">{controlReport.checkedAt}</span>
              </div>
              <DataTable
                columns={checkColumns}
                data={checkRows}
                keyExtractor={(row) => row.name as string}
              />
              {failedViolations.length > 0 && (
                <DataTable
                  columns={[
                    { key: 'check', header: t('frozen.control.check') },
                    { key: 'object', header: t('frozen.control.object'), sortable: true },
                    { key: 'referenceId', header: 'referenceId' },
                    { key: 'field', header: t('frozen.control.field') },
                    { key: 'detail', header: t('frozen.control.detail') },
                  ]}
                  data={failedViolations}
                  keyExtractor={(row) => row.key as string}
                />
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
