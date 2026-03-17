import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { Card, CardHeader, CardBody } from '../../components/ui/Card';

/** CRUD permission set. */
export interface CrudPermissions {
  create: boolean;
  read: boolean;
  update: boolean;
  delete: boolean;
}

/** A row in the permission matrix. */
export interface PermissionMatrixRow {
  objectName: string;
  source: CrudPermissions;
  target: CrudPermissions;
  hasDifference: boolean;
}

/** PermissionMatrix component props. */
export interface PermissionMatrixProps {
  rows: PermissionMatrixRow[];
  sourceLabel?: string;
  targetLabel?: string;
  className?: string;
}

/** Permission cell indicator. */
const PermCell: React.FC<{ allowed: boolean; differs: boolean }> = ({ allowed, differs }) => (
  <span
    className={cn(
      'inline-block w-4 h-4 rounded-sm text-center text-[10px] font-bold leading-4',
      allowed
        ? 'bg-[rgba(16,185,129,0.2)] text-[var(--sf-success)]'
        : 'bg-[rgba(239,68,68,0.1)] text-[var(--sf-error)]',
      differs && 'ring-1 ring-[var(--sf-warning)]',
    )}
    data-testid={allowed ? 'perm-yes' : 'perm-no'}
  >
    {allowed ? '\u2713' : '\u2717'}
  </span>
);

/** Side-by-side permission comparison matrix. */
export const PermissionMatrix: React.FC<PermissionMatrixProps> = ({
  rows,
  sourceLabel = 'Source',
  targetLabel = 'Target',
  className,
}) => {
  const { t } = useTranslation();
  const crudKeys: (keyof CrudPermissions)[] = ['create', 'read', 'update', 'delete'];
  const [filter, setFilter] = useState('');

  /** Filtered rows based on text search by object name. */
  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    const lower = filter.toLowerCase();
    return rows.filter((r) => r.objectName.toLowerCase().includes(lower));
  }, [rows, filter]);

  return (
    <Card className={className}>
      <CardHeader title={t('compare.permissions')} subtitle={t('common.objectCount', { count: filteredRows.length })} />
      <CardBody className="overflow-x-auto max-h-80">
        {/* Filter input */}
        {rows.length > 0 && (
          <div className="mb-2">
            <input
              data-testid="perm-filter"
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('compare.filterObjects')}
              className={cn(
                'w-full px-2 py-1.5 text-sm rounded',
                'bg-[var(--vscode-input-background,#3c3c3c)]',
                'text-[var(--vscode-input-foreground,#d4d4d4)]',
                'border border-[var(--vscode-input-border,#3c3c3c)]',
                'placeholder:text-[var(--vscode-input-placeholderForeground,#6b6b6b)]',
                'focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)]',
              )}
            />
          </div>
        )}
        {filteredRows.length === 0 ? (
          <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)] text-center py-4">
            {t('common.noData')}
          </p>
        ) : (
          <table className="w-full text-[10px]" data-testid="perm-matrix">
            <thead>
              {/* Profile/role column grouping headers */}
              <tr className="text-[var(--vscode-descriptionForeground,#868686)] border-b border-[var(--vscode-panel-border,#3c3c3c)]">
                <th className="pb-2 pr-3 text-left font-medium" rowSpan={2}>{t('common.object')}</th>
                <th className="pb-1 text-center font-medium border-b border-[var(--vscode-panel-border,#3c3c3c)]" colSpan={4} data-testid="perm-group-source">
                  {sourceLabel}
                </th>
                <th className="pb-1 text-center font-medium border-b border-[var(--vscode-panel-border,#3c3c3c)]" colSpan={4} data-testid="perm-group-target">
                  {targetLabel}
                </th>
              </tr>
              <tr className="text-[var(--vscode-descriptionForeground,#868686)] border-b border-[var(--vscode-panel-border,#3c3c3c)]">
                {[sourceLabel, targetLabel].map((label) =>
                  crudKeys.map((k) => (
                    <th key={`${label}-${k}`} className="pb-1 text-center font-normal w-8">
                      {k[0].toUpperCase()}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr
                  key={row.objectName}
                  className={cn(
                    'border-b border-[var(--vscode-panel-border,#3c3c3c)] last:border-0',
                    row.hasDifference && 'bg-[rgba(245,158,11,0.05)]',
                  )}
                  data-testid={`perm-row-${row.objectName}`}
                >
                  <td className="py-1 pr-3 text-[var(--vscode-editor-foreground,#d4d4d4)] font-mono truncate max-w-[120px]">
                    {row.objectName}
                  </td>
                  {crudKeys.map((k) => (
                    <td key={`src-${k}`} className="py-1 text-center">
                      <PermCell
                        allowed={row.source[k]}
                        differs={row.source[k] !== row.target[k]}
                      />
                    </td>
                  ))}
                  {crudKeys.map((k) => (
                    <td key={`tgt-${k}`} className="py-1 text-center">
                      <PermCell
                        allowed={row.target[k]}
                        differs={row.source[k] !== row.target[k]}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
};
