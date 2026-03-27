import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n/index';
import { FileDropZone } from './FileDropZone';

describe('FileDropZone', () => {
  const onFileSelected = vi.fn();

  beforeEach(() => {
    onFileSelected.mockClear();
  });

  it('should render drop zone with title text and browse button', () => {
    render(<FileDropZone onFileSelected={onFileSelected} />);
    expect(screen.getByTestId('file-drop-zone')).toBeDefined();
    expect(screen.getByTestId('drop-area')).toBeDefined();
    expect(screen.getByTestId('browse-button')).toBeDefined();
    expect(screen.getByText('Drag & drop your CSV file here')).toBeDefined();
  });

  it('should call onFileSelected when a file is selected via input', () => {
    render(<FileDropZone onFileSelected={onFileSelected} />);
    const input = screen.getByTestId('file-input') as HTMLInputElement;
    const file = new File(['name,email\nJohn,john@test.com'], 'test.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFileSelected).toHaveBeenCalledWith(file);
  });

  it('should show error when file exceeds max size', () => {
    render(<FileDropZone onFileSelected={onFileSelected} maxSizeMB={0.0001} />);
    const input = screen.getByTestId('file-input') as HTMLInputElement;
    // File larger than 0.0001 MB (~104 bytes)
    const content = 'x'.repeat(200);
    const file = new File([content], 'large.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFileSelected).not.toHaveBeenCalled();
    expect(screen.getByTestId('size-error')).toBeDefined();
  });

  it('should set hover state on drag over', () => {
    render(<FileDropZone onFileSelected={onFileSelected} />);
    const dropArea = screen.getByTestId('drop-area');
    fireEvent.dragOver(dropArea, { dataTransfer: { files: [] } });
    // The hover border class should be applied
    expect(dropArea.className).toContain('border-[var(--vscode-focusBorder');
  });

  it('should call onFileSelected on file drop', () => {
    render(<FileDropZone onFileSelected={onFileSelected} />);
    const dropArea = screen.getByTestId('drop-area');
    const file = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' });
    fireEvent.drop(dropArea, {
      dataTransfer: { files: [file] },
    });
    expect(onFileSelected).toHaveBeenCalledWith(file);
  });

  it('should not accept files when disabled', () => {
    render(<FileDropZone onFileSelected={onFileSelected} disabled />);
    const dropArea = screen.getByTestId('drop-area');
    const file = new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' });
    fireEvent.drop(dropArea, {
      dataTransfer: { files: [file] },
    });
    expect(onFileSelected).not.toHaveBeenCalled();
  });
});
