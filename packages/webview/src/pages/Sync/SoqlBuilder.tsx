import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

/** SoqlBuilder component props. */
export interface SoqlBuilderProps {
  objectApiName: string;
  availableFields: string[];
  selectedFields: string[];
  whereClause: string;
  orderBy: string;
  limit: number;
  onToggleField: (field: string) => void;
  onWhereChange: (where: string) => void;
  onOrderByChange: (orderBy: string) => void;
  onLimitChange: (limit: number) => void;
  className?: string;
}

/** SOQL query builder UI. */
export const SoqlBuilder: React.FC<SoqlBuilderProps> = ({
  objectApiName,
  availableFields,
  selectedFields,
  whereClause,
  orderBy,
  limit,
  onToggleField,
  onWhereChange,
  onOrderByChange,
  onLimitChange,
  className,
}) => {
  const { t } = useTranslation();

  const query = buildQuery(objectApiName, selectedFields, whereClause, orderBy, limit);

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="soql-builder">
      <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('sync.soqlQuery')}
      </span>

      {/* Generated SOQL preview */}
      <pre
        className={cn(
          'text-[10px] p-3 rounded overflow-x-auto',
          'bg-[var(--vscode-input-background,#3c3c3c)]',
          'text-[var(--vscode-editor-foreground,#d4d4d4)]',
          'border border-[var(--vscode-panel-border,#3c3c3c)]',
        )}
        data-testid="soql-preview"
      >
        {query}
      </pre>

      {/* Field selection */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-[var(--vscode-descriptionForeground,#868686)] font-medium">
          {t('sync.sourceField')}
        </span>
        <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
          {availableFields.map((field) => {
            const isSelected = selectedFields.includes(field);
            return (
              <button
                key={field}
                className={cn(
                  'px-2 py-0.5 rounded text-[10px] border transition-colors',
                  isSelected
                    ? 'bg-[var(--vscode-focusBorder,#007fd4)] text-white border-transparent'
                    : 'text-[var(--vscode-descriptionForeground,#868686)] border-[var(--vscode-panel-border,#3c3c3c)] hover:border-[var(--vscode-focusBorder,#007fd4)]',
                )}
                onClick={() => onToggleField(field)}
                role="checkbox"
                aria-checked={isSelected}
                data-testid={`field-${field}`}
              >
                {field}
              </button>
            );
          })}
        </div>
      </div>

      {/* WHERE, ORDER BY, LIMIT */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Input
          label="WHERE"
          value={whereClause}
          onChange={(e) => onWhereChange(e.target.value)}
          placeholder="IsActive = true"
        />
        <Input
          label="ORDER BY"
          value={orderBy}
          onChange={(e) => onOrderByChange(e.target.value)}
          placeholder="CreatedDate DESC"
        />
        <Input
          label="LIMIT"
          type="number"
          min={0}
          value={limit}
          onChange={(e) => onLimitChange(parseInt(e.target.value, 10) || 0)}
        />
      </div>

      <Button variant="secondary" size="sm" data-testid="copy-soql-btn" onClick={() => navigator.clipboard?.writeText(query)}>
        {t('common.copy')} SOQL
      </Button>
    </div>
  );
};

/** Build a SOQL query string from parts. */
function buildQuery(
  objectApiName: string,
  fields: string[],
  where: string,
  orderBy: string,
  limit: number,
): string {
  const fieldList = fields.length > 0 ? fields.join(', ') : 'Id';
  let soql = `SELECT ${fieldList} FROM ${objectApiName}`;
  if (where) {
    const sanitized = where.replace(/[;'"\\]/g, '');
    soql += ` WHERE ${sanitized}`;
  }
  if (orderBy) soql += ` ORDER BY ${orderBy}`;
  if (limit > 0) soql += ` LIMIT ${limit}`;
  return soql;
}
