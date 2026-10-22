import React, { useCallback, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, AlertTriangle, X, ArrowRight } from 'lucide-react';
import type { CsvColumnMapping, SeedFieldInfo } from '@sandforge/shared';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';

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

/** Props of one column's row. */
interface MappingRowProps {
  header: string;
  /** The column's mapping, the same object until it changes. */
  mapping: CsvColumnMapping | undefined;
  /** The field it is mapped to, when the object has one of that name. */
  mappedField: SeedFieldInfo | undefined;
  /** Whether the field it is mapped to is one the object described. */
  known: boolean;
  /** The id of the shared list of the object's fields. */
  listId: string;
  /** The API name of the field a typed text names, '' to leave unmapped, or undefined. */
  resolve: (typed: string) => string | undefined;
  onMappingChange: (csvHeader: string, sfFieldApiName: string) => void;
}

/**
 * One CSV column and the field it goes to: a text box over the object's
 * shared list of fields, which takes a field's API name or label, and an
 * empty box for a column left unmapped. Drawn again only when its own mapping
 * changes.
 */
const MappingRow = React.memo(function MappingRow({
  header,
  mapping,
  mappedField,
  known,
  listId,
  resolve,
  onMappingChange,
}: MappingRowProps) {
  const { t } = useTranslation();
  const mapped = mapping?.sfFieldApiName ?? '';
  const [draft, setDraft] = useState(mapped);
  // The mapping can change from outside the box, as the columns are matched
  // to the fields once the object is described: the box follows it.
  const [shownMapping, setShownMapping] = useState(mapped);
  if (shownMapping !== mapped) {
    setShownMapping(mapped);
    setDraft(mapped);
  }

  /** Map the column to what `typed` names; false when it names no field. */
  const commit = (typed: string): boolean => {
    const apiName = resolve(typed);
    if (apiName === undefined) return false;
    setDraft(apiName);
    if (apiName !== mapped) onMappingChange(header, apiName);
    return true;
  };

  const status =
    mapped === '' ? (
      <AlertTriangle
        className="w-4 h-4 text-status-warning"
        aria-label={t('seed.csv.mapper.unmapped')}
      />
    ) : !known ? (
      <X className="w-4 h-4 text-status-error" aria-label={t('seed.csv.mapper.incompatible')} />
    ) : (
      <Check className="w-4 h-4 text-status-success" aria-label={t('a11y.mapped', 'Mapped')} />
    );

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-sm border border-(--sf-border) bg-(--sf-bg-primary)"
      data-testid={`mapping-row-${header}`}
    >
      {/* CSV column name */}
      <div className="w-40 shrink-0">
        <span className="text-sm font-medium text-(--sf-text-primary) truncate block">
          {header}
        </span>
      </div>

      <ArrowRight className="w-4 h-4 text-(--sf-text-secondary) shrink-0" aria-hidden="true" />

      {/* The field: picked from the list, or typed by API name or label. A
          name that is no field's is taken back as the box is left. */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <Input
          list={listId}
          value={draft}
          onChange={(event) => {
            const typed = event.target.value;
            setDraft(typed);
            // A pick from the list writes the field's API name whole.
            if (typed === '' || resolve(typed) === typed) commit(typed);
          }}
          onBlur={() => {
            if (!commit(draft)) setDraft(mapped);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !commit(draft)) setDraft(mapped);
            if (event.key === 'Escape') setDraft(mapped);
          }}
          placeholder={t('seed.csv.mapper.unmapped')}
          aria-label={t('seed.csv.mapper.fieldFor', { column: header })}
          autoComplete="off"
          spellCheck={false}
          data-testid={`mapping-select-${header}`}
        />
        {mappedField && (
          <span
            className="text-xs text-text-secondary truncate"
            data-testid={`mapping-field-${header}`}
          >
            {mappedField.label} · {mappedField.type}
          </span>
        )}
      </div>

      {/* Status icon */}
      <div className="shrink-0" data-testid={`mapping-status-${header}`}>
        {status}
      </div>
    </div>
  );
});

/**
 * Column mapping UI that displays each CSV header alongside the Salesforce
 * field it goes to. Shows auto-matched fields filled in and visual
 * indicators for match status (green check, yellow warning, red X).
 *
 * The object's fields are listed once, in a list every column's box shares.
 * Each column drew a select of every field: a 300-column export onto an
 * 800-field Account was 240 000 options, every one of them drawn again at
 * each change, as every row was.
 */
export const CsvColumnMapper: React.FC<CsvColumnMapperProps> = ({
  headers,
  columnMappings,
  describeFields,
  onMappingChange,
}) => {
  const { t } = useTranslation();
  const listId = useId();

  const createableFields = useMemo(
    () => describeFields.filter((f) => !SYSTEM_FIELDS.has(f.apiName.toLowerCase())),
    [describeFields],
  );

  /** Each field a column can be mapped to, by API name. */
  const fieldByApiName = useMemo(
    () => new Map(createableFields.map((field) => [field.apiName, field])),
    [createableFields],
  );

  /** Each field by its API name and its label, as one types them, case aside. */
  const fieldByTyped = useMemo(() => {
    const byTyped = new Map<string, string>();
    for (const field of createableFields) {
      byTyped.set(field.label.toLowerCase(), field.apiName);
    }
    // An API name wins over a label spelled the same.
    for (const field of createableFields) {
      byTyped.set(field.apiName.toLowerCase(), field.apiName);
    }
    return byTyped;
  }, [createableFields]);

  const resolve = useCallback(
    (typed: string): string | undefined => {
      const trimmed = typed.trim();
      if (trimmed === '') return '';
      if (fieldByApiName.has(trimmed)) return trimmed;
      return fieldByTyped.get(trimmed.toLowerCase());
    },
    [fieldByApiName, fieldByTyped],
  );

  /** Every field the object described, system ones too: a mapping to another is wrong. */
  const describedNames = useMemo(
    () => new Set(describeFields.map((field) => field.apiName)),
    [describeFields],
  );

  const mappingByHeader = useMemo(
    () => new Map(columnMappings.map((mapping) => [mapping.csvHeader, mapping])),
    [columnMappings],
  );

  const mappedCount = useMemo(
    () => columnMappings.filter((m) => m.sfFieldApiName !== '').length,
    [columnMappings],
  );

  return (
    <div className="flex flex-col gap-3" data-testid="csv-column-mapper">
      {/* Summary */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-(--sf-text-primary)">
          {t('seed.csv.mapper.title')}
        </span>
        <Badge variant={mappedCount === headers.length ? 'success' : 'warning'}>
          {t('seed.csv.mapper.mapped', { count: mappedCount, total: headers.length })}
        </Badge>
      </div>
      <p className="text-xs text-text-secondary">{t('seed.csv.mapper.howTo')}</p>

      <datalist id={listId} data-testid="mapping-fields">
        {createableFields.map((field) => (
          <option
            key={field.apiName}
            value={field.apiName}
            label={`${field.label} [${field.type}]`}
          />
        ))}
      </datalist>

      {/* Mapping rows */}
      <div className="flex flex-col gap-2" data-testid="mapping-rows">
        {headers.map((header) => {
          const mapping = mappingByHeader.get(header);
          const mapped = mapping?.sfFieldApiName ?? '';
          return (
            <MappingRow
              key={header}
              header={header}
              mapping={mapping}
              mappedField={fieldByApiName.get(mapped)}
              known={describedNames.has(mapped)}
              listId={listId}
              resolve={resolve}
              onMappingChange={onMappingChange}
            />
          );
        })}
      </div>
    </div>
  );
};
