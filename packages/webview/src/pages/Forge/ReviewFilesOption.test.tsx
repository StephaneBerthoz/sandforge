import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ForgeConfig } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewFilesOption, filesBlockExecute } from './ReviewFilesOption';

/** A run's config, anonymizing its records or not. */
function config(anonymizePII: boolean): ForgeConfig {
  return {
    inputMode: 'record',
    recordId: '500000000000001AAA',
    depth: 'direct',
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    anonymizePII,
    skipEmpty: true,
    batchSize: 'auto',
  };
}

describe('ReviewFilesOption', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig(config(false));
  });

  it('copies no file until the user turns the copy on', () => {
    render(<ReviewFilesOption />);

    const toggle = screen.getByRole('checkbox', { name: 'Copy the files of the cloned records' });
    expect(toggle).toHaveProperty('checked', false);
    expect(screen.queryByTestId('forge-files-max-size')).toBeNull();
    expect(screen.queryByTestId('forge-files-as-is')).toBeNull();
  });

  it('asks for the largest file once turned on, ten megabytes to start with', () => {
    render(<ReviewFilesOption />);

    fireEvent.click(screen.getByTestId('forge-files-toggle'));

    expect(useForgeStore.getState().fileCopy.enabled).toBe(true);
    const size = screen.getByLabelText('Largest file copied (MB)');
    expect(size).toHaveProperty('value', '10');
    expect(size.getAttribute('max')).toBe('35');
  });

  it('takes a size one call carries, and refuses one it does not without losing the last good one', () => {
    useForgeStore.getState().setFileCopy({ enabled: true });
    render(<ReviewFilesOption />);
    const size = screen.getByTestId('forge-files-max-size');

    fireEvent.change(size, { target: { value: '3' } });
    expect(useForgeStore.getState().fileCopy.maxFileSizeMB).toBe(3);
    expect(size.getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(size, { target: { value: '36' } });
    expect(useForgeStore.getState().fileCopy.maxFileSizeMB).toBe(3);
    expect(size.getAttribute('aria-invalid')).toBe('true');

    fireEvent.blur(size);
    expect(size).toHaveProperty('value', '3');
  });

  it('asks, in a confirmation of its own, to accept the files as they are while the run anonymizes', () => {
    useForgeStore.getState().setConfig(config(true));
    useForgeStore.getState().setFileCopy({ enabled: true });
    render(<ReviewFilesOption />);

    expect(screen.getByTestId('forge-files-as-is').textContent).toContain(
      'the content of a file cannot be anonymized',
    );
    const accept = screen.getByRole('checkbox', {
      name: 'I accept that files are copied as they are',
    });
    expect(filesBlockExecute(useForgeStore.getState())).toBe(true);

    fireEvent.click(accept);

    expect(useForgeStore.getState().fileCopy.acceptedAsIs).toBe(true);
    expect(filesBlockExecute(useForgeStore.getState())).toBe(false);
  });

  it('asks nothing more of a run that anonymizes nothing', () => {
    useForgeStore.getState().setFileCopy({ enabled: true });
    render(<ReviewFilesOption />);

    expect(screen.queryByTestId('forge-files-as-is')).toBeNull();
    expect(filesBlockExecute(useForgeStore.getState())).toBe(false);
  });
});
