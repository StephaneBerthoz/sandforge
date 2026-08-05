import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, AlertTriangle } from 'lucide-react';
import type { CsvValidationResult, CsvValidationError } from '@sandforge/shared';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Accordion } from '../../../components/ui/Accordion';

/** Props for the CsvValidationPanel component. */
export interface CsvValidationPanelProps {
  /** Validation result from the extension backend. */
  validationResult: CsvValidationResult;
  /** Callback to return to the mapping step for corrections. */
  onBack: () => void;
  /** Callback to proceed with execution despite errors. */
  onProceed: () => void;
}

/** Maximum number of errors to show per group before truncating. */
const MAX_ERRORS_PER_GROUP = 20;

/** Error type display key mapping. */
const ERROR_TYPE_KEYS: Record<CsvValidationError['errorType'], string> = {
  type_mismatch: 'seed.csv.validation.errorTypes.type_mismatch',
  missing_required: 'seed.csv.validation.errorTypes.missing_required',
  length_exceeded: 'seed.csv.validation.errorTypes.length_exceeded',
  duplicate_external_id: 'seed.csv.validation.errorTypes.duplicate_external_id',
  invalid_picklist: 'seed.csv.validation.errorTypes.invalid_picklist',
};

/**
 * Displays CSV validation results. When all rows are valid, shows a
 * success message with a proceed button. When errors exist, groups
 * them by error type in accordion sections with row/column details.
 * Allows "Proceed Anyway" only when errors affect less than 10% of rows.
 */
export const CsvValidationPanel: React.FC<CsvValidationPanelProps> = ({
  validationResult,
  onBack,
  onProceed,
}) => {
  const { t } = useTranslation();

  const errorGroups = useMemo(() => {
    const groups: Record<string, CsvValidationError[]> = {};
    for (const error of validationResult.errors) {
      const key = error.errorType;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(error);
    }
    return groups;
  }, [validationResult.errors]);

  /** Determine total unique rows with errors. */
  const errorRowCount = useMemo(() => {
    const rows = new Set(validationResult.errors.map((e) => e.row));
    return rows.size;
  }, [validationResult.errors]);

  /** Estimate total row count (errors + valid rows). */
  const estimatedTotalRows = useMemo(() => {
    const maxRow = validationResult.errors.reduce((max, e) => Math.max(max, e.row), 0);
    return Math.max(maxRow, 1);
  }, [validationResult.errors]);

  const errorRate = estimatedTotalRows > 0 ? errorRowCount / estimatedTotalRows : 0;
  const canProceedAnyway = !validationResult.valid && errorRate < 0.1;

  if (validationResult.valid) {
    return (
      <div className="flex flex-col items-center gap-4 py-6" data-testid="csv-validation-panel">
        <div className="flex items-center gap-2">
          <Check className="w-6 h-6 text-emerald-400" />
          <span className="text-sm font-medium text-emerald-400" data-testid="validation-success">
            {t('seed.csv.validation.valid', { count: estimatedTotalRows })}
          </span>
        </div>
        <Button variant="primary" size="sm" onClick={onProceed} data-testid="proceed-button">
          {t('seed.csv.wizard.execute')}
        </Button>
      </div>
    );
  }

  const accordionItems = Object.entries(errorGroups).map(([errorType, errors]) => {
    const typeKey = ERROR_TYPE_KEYS[errorType as CsvValidationError['errorType']] ?? errorType;
    const visible = errors.slice(0, MAX_ERRORS_PER_GROUP);
    const remaining = errors.length - MAX_ERRORS_PER_GROUP;

    return {
      title: `${t(typeKey)} (${errors.length})`,
      defaultOpen: true,
      content: (
        <div className="flex flex-col gap-1">
          {visible.map((error, i) => (
            <div
              key={`${error.row}-${error.column}-${i}`}
              className="flex gap-2 text-xs py-1 border-b border-[var(--sf-border)] last:border-b-0"
            >
              <Badge variant="default">{t('seed.csv.validation.row', { row: error.row })}</Badge>
              <span className="font-medium text-[var(--sf-text-primary)]">{error.column}</span>
              <span className="text-[var(--sf-text-secondary)] truncate">{error.message}</span>
              {error.value && (
                <code className="text-[var(--sf-error)] text-[10px]">{error.value}</code>
              )}
            </div>
          ))}
          {remaining > 0 && (
            <span
              className="text-xs text-[var(--sf-text-secondary)] py-1"
              data-testid={`more-errors-${errorType}`}
            >
              {t('seed.csv.validation.andMore', { count: remaining })}
            </span>
          )}
        </div>
      ),
    };
  });

  return (
    <div className="flex flex-col gap-4" data-testid="csv-validation-panel">
      {/* Error summary */}
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-5 h-5 text-[var(--sf-error)]" />
        <span
          className="text-sm font-medium text-[var(--sf-error)]"
          data-testid="validation-error-count"
        >
          {t('seed.csv.validation.errors', { count: validationResult.errors.length })}
        </span>
      </div>

      {/* Error groups accordion */}
      <Accordion items={accordionItems} data-testid="error-accordion" />

      {/* Action buttons */}
      <div className="flex gap-2" data-testid="validation-actions">
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="back-button">
          {t('seed.csv.validation.fixAndRevalidate')}
        </Button>
        {canProceedAnyway && (
          <div className="flex flex-col gap-1">
            <Button
              variant="primary"
              size="sm"
              onClick={onProceed}
              data-testid="proceed-anyway-button"
            >
              {t('seed.csv.validation.proceedAnyway')}
            </Button>
            <span className="text-[10px] text-amber-400">
              {t('seed.csv.validation.warningProceed')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
