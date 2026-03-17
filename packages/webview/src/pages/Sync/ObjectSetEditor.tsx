import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SyncOperation } from '@sandforge/shared';
import { cn } from '../../theme';
import { Select } from '../../components/ui/Select';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';

/** Object set entry for editing. */
export interface ObjectSetEntry {
  objectApiName: string;
  operation: SyncOperation;
  externalIdField: string;
  batchSize: number;
  where: string;
}

/** ObjectSetEditor component props. */
export interface ObjectSetEditorProps {
  entries: ObjectSetEntry[];
  availableObjects: string[];
  onAdd: (objectApiName: string) => void;
  onRemove: (index: number) => void;
  onChange: (index: number, field: keyof ObjectSetEntry, value: string | number) => void;
  className?: string;
}

const OPERATIONS: SyncOperation[] = ['insert', 'update', 'upsert', 'delete'];

/** Object set management editor. */
export const ObjectSetEditor: React.FC<ObjectSetEditorProps> = ({
  entries,
  availableObjects,
  onAdd,
  onRemove,
  onChange,
  className,
}) => {
  const { t } = useTranslation();
  const [newObject, setNewObject] = React.useState('');

  const usedObjects = new Set(entries.map((e) => e.objectApiName));
  const objectOptions = availableObjects
    .filter((o) => !usedObjects.has(o))
    .map((o) => ({ value: o, label: o }));
  const opOptions = OPERATIONS.map((op) => ({ value: op, label: t(`sync.operations.${op}`) }));

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="object-set-editor">
      <span className="text-xs font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
        {t('sync.objectSet')} ({entries.length})
      </span>

      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
        {entries.map((entry, i) => (
          <div
            key={entry.objectApiName}
            className={cn(
              'flex flex-wrap items-center gap-2 px-2 py-2 rounded text-xs',
              'border border-[var(--vscode-panel-border,#3c3c3c)]',
            )}
            data-testid={`object-entry-${entry.objectApiName}`}
          >
            <Badge variant="default">{entry.objectApiName}</Badge>
            <Select
              options={opOptions}
              value={entry.operation}
              onChange={(e) => onChange(i, 'operation', e.target.value)}
              className="w-24"
            />
            <Input
              placeholder={t('sync.externalId')}
              value={entry.externalIdField}
              onChange={(e) => onChange(i, 'externalIdField', e.target.value)}
              className="w-28"
            />
            <Input
              type="number"
              min={1}
              max={10000}
              placeholder={t('sync.batchSize')}
              value={entry.batchSize}
              onChange={(e) => onChange(i, 'batchSize', parseInt(e.target.value, 10) || 200)}
              className="w-20"
            />
            <Input
              placeholder="WHERE clause"
              value={entry.where}
              onChange={(e) => onChange(i, 'where', e.target.value)}
              className="flex-1"
            />
            <button
              className="text-[var(--vscode-errorForeground,#f48771)] hover:opacity-70 px-1"
              onClick={() => onRemove(i)}
              data-testid={`remove-obj-${entry.objectApiName}`}
            >
              x
            </button>
          </div>
        ))}
      </div>

      {entries.length === 0 && (
        <p className="text-xs text-center text-[var(--vscode-descriptionForeground,#868686)] py-2">
          {t('sync.noObjects')}
        </p>
      )}

      {/* Add new object */}
      <div className="flex items-center gap-2" data-testid="add-object-row">
        <Select
          options={objectOptions}
          value={newObject}
          onChange={(e) => setNewObject(e.target.value)}
          placeholder={t('sync.addObject')}
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => { onAdd(newObject); setNewObject(''); }}
          disabled={!newObject}
          data-testid="add-object-btn"
        >
          {t('sync.addObject')}
        </Button>
      </div>
    </div>
  );
};
