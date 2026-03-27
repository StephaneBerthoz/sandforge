import React, { useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload } from 'lucide-react';
import { cn } from '../../theme';
import { Button } from './Button';
import { ErrorBanner } from './ErrorBanner';

/** Props for the FileDropZone component. */
export interface FileDropZoneProps {
  /** Callback invoked when a valid file is selected (via drag-and-drop or file picker). */
  onFileSelected: (file: File) => void;
  /** Accepted file types (e.g. ".csv"). Defaults to ".csv". */
  accept?: string;
  /** Maximum file size in megabytes. Defaults to 50. */
  maxSizeMB?: number;
  /** Whether the drop zone is disabled. */
  disabled?: boolean;
}

/** Default maximum file size in MB. */
const DEFAULT_MAX_SIZE_MB = 50;

/**
 * Drag-and-drop file upload zone with browse fallback.
 *
 * Renders a bordered dashed area that accepts files via HTML5
 * drag-and-drop events or a hidden file input triggered by a
 * "Browse" button. Validates file size against `maxSizeMB`.
 */
export const FileDropZone: React.FC<FileDropZoneProps> = ({
  onFileSelected,
  accept = '.csv',
  maxSizeMB = DEFAULT_MAX_SIZE_MB,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const maxSizeBytes = maxSizeMB * 1024 * 1024;

  const processFile = useCallback(
    (file: File) => {
      setSizeError(null);
      if (file.size > maxSizeBytes) {
        setSizeError(
          t('seed.csv.dropzone.maxSize', { max: maxSizeMB }),
        );
        return;
      }
      onFileSelected(file);
    },
    [maxSizeBytes, maxSizeMB, onFileSelected, t],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) {
        setIsDragOver(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) {
        processFile(file);
      }
    },
    [disabled, processFile],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        processFile(file);
      }
      // Reset value so the same file can be re-selected
      e.target.value = '';
    },
    [processFile],
  );

  const handleBrowseClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return (
    <div className="flex flex-col gap-2" data-testid="file-drop-zone">
      <div
        className={cn(
          'border-2 border-dashed rounded-lg p-8 text-center transition-colors',
          'border-[var(--vscode-input-border,#3c3c3c)]',
          isDragOver && !disabled && 'border-[var(--vscode-focusBorder,#007fd4)] bg-[var(--vscode-focusBorder,#007fd4)]/5',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="drop-area"
      >
        <div className="flex flex-col items-center gap-3">
          <Upload
            className="w-10 h-10 text-[var(--vscode-descriptionForeground,#868686)]"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-[var(--vscode-editor-foreground,#d4d4d4)]">
              {t('seed.csv.dropzone.title')}
            </p>
            <p className="text-xs text-[var(--vscode-descriptionForeground,#868686)]">
              {t('seed.csv.dropzone.subtitle')}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleBrowseClick}
            disabled={disabled}
            data-testid="browse-button"
          >
            {t('seed.csv.dropzone.browse')}
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleInputChange}
          disabled={disabled}
          data-testid="file-input"
        />
      </div>
      {sizeError && (
        <ErrorBanner
          message={sizeError}
          onDismiss={() => setSizeError(null)}
          data-testid="size-error"
        />
      )}
    </div>
  );
};
