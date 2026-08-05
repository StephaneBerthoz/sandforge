import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, AlertTriangle, X, ArrowRight } from 'lucide-react';
import type { CsvColumnMapping, SeedFieldInfo } from '@sandforge/shared';
import { Badge } from '../../../components/ui/Badge';
import { Select } from '../../../components/ui/Select';

/** Props for the CsvColumnMapper component. */
export interface CsvColumnMapperProps {
  /** CSV column header names. */
  headers: string[];
  /** Current column mappings. */
  columnMappings: CsvColumnMapping[];
  /** Salesforce field metadata for the target object. */
  describeFields: SeedFieldInfo[];
  /** Callback when a mapping is changed. */
  onMappingChange: (csvHeader: string, sfFieldApiName: string) => void;
}

/** Non-createable system field API names to exclude from dropdown. */
const SYSTEM_FIELDS = new Set([
  'id',
  'createddate',
  'lastmodifieddate',
  'systemmodstamp',
  'createdbyid',
  'lastmodifiedbyid',
  'isdeleted',
]);

/**
 * Column mapping UI that displays each CSV header alongside a Salesforce
 * field dropdown. Shows auto-matched fields pre-selected and visual
 * indicators for match status (green check, yellow warning, red X).
 */
export const CsvColumnMapper: React.FC<CsvColumnMapperProps> = ({
  headers,
  columnMappings,
  describeFields,
  onMappingChange,
}) => {
  const { t } = useTranslation();

  const createableFields = useMemo(
    () => describeFields.filter((f) => !SYSTEM_FIELDS.has(f.apiName.toLowerCase())),
    [describeFields],
  );

  const fieldOptions = useMemo(
    () => [
      { value: '', label: `-- ${t('seed.csv.mapper.unmapped')} --` },
      ...createableFields.map((f) => ({
        value: f.apiName,
        label: `${f.label} (${f.apiName}) [${f.type}]`,
      })),
    ],
    [createableFields, t],
  );

  const mappedCount = useMemo(
    () => columnMappings.filter((m) => m.sfFieldApiName !== '').length,
    [columnMappings],
  );

  /** Detect the first non-empty value type from preview context. */
  const getStatusIcon = (mapping: CsvColumnMapping): React.ReactNode => {
    if (mapping.sfFieldApiName === '') {
      return (
        <AlertTriangle
          className="w-4 h-4 text-amber-400"
          aria-label={t('seed.csv.mapper.unmapped')}
        />
      );
    }
    // Check basic type compatibility
    const field = describeFields.find((f) => f.apiName === mapping.sfFieldApiName);
    if (!field) {
      return (
        <X
          className="w-4 h-4 text-[var(--sf-error)]"
          aria-label={t('seed.csv.mapper.incompatible')}
        />
      );
    }
    return <Check className="w-4 h-4 text-emerald-400" aria-label="Mapped" />;
  };

  return (
    <div className="flex flex-col gap-3" data-testid="csv-column-mapper">
      {/* Summary */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-[var(--sf-text-primary)]">
          {t('seed.csv.mapper.title')}
        </span>
        <Badge variant={mappedCount === headers.length ? 'success' : 'warning'}>
          {t('seed.csv.mapper.mapped', { count: mappedCount, total: headers.length })}
        </Badge>
      </div>

      {/* Mapping rows */}
      <div className="flex flex-col gap-2" data-testid="mapping-rows">
        {headers.map((header) => {
          const mapping = columnMappings.find((m) => m.csvHeader === header);
          const selectedValue = mapping?.sfFieldApiName ?? '';

          return (
            <div
              key={header}
              className="flex items-center gap-3 px-3 py-2 rounded border border-[var(--sf-border)] bg-[var(--sf-bg-primary)]"
              data-testid={`mapping-row-${header}`}
            >
              {/* CSV column name */}
              <div className="w-40 shrink-0">
                <span className="text-sm font-medium text-[var(--sf-text-primary)] truncate block">
                  {header}
                </span>
              </div>

              {/* Arrow */}
              <ArrowRight
                className="w-4 h-4 text-[var(--sf-text-secondary)] shrink-0"
                aria-hidden="true"
              />

              {/* Salesforce field dropdown */}
              <div className="flex-1 min-w-0">
                <Select
                  options={fieldOptions}
                  value={selectedValue}
                  onChange={(e) => onMappingChange(header, e.target.value)}
                  data-testid={`mapping-select-${header}`}
                />
              </div>

              {/* Status icon */}
              <div className="shrink-0" data-testid={`mapping-status-${header}`}>
                {mapping ? (
                  getStatusIcon(mapping)
                ) : (
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
