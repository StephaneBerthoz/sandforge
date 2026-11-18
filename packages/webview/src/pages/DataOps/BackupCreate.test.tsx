import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { BackupCreate } from './BackupCreate';

describe('BackupCreate', () => {
  it('names, before the click, the objects a backup reads and the template they come from', () => {
    const { rerender } = render(
      <BackupCreate objects={['Contact', 'Lead']} template="GDPR Template" onCreate={vi.fn()} />,
    );
    expect(screen.getByTestId('backup-objects').textContent).toBe(
      'Backs up Contact, Lead: the objects GDPR Template masks.',
    );

    rerender(<BackupCreate objects={['Contact', 'Lead', 'Opportunity']} onCreate={vi.fn()} />);
    expect(screen.getByTestId('backup-objects').textContent).toBe(
      'Backs up Contact, Lead, Opportunity: the objects the masking templates mask.',
    );
  });

  it('takes a backup on the click, the objects it reads describing the button', () => {
    const onCreate = vi.fn();
    render(<BackupCreate objects={['Contact']} onCreate={onCreate} />);

    const button = screen.getByTestId('create-backup-btn');
    expect(button.textContent).toBe('Create backup');
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('Backs up Contact');
    fireEvent.click(button);

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('offers a Stop while the backup reads, and none otherwise', () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <BackupCreate objects={['Contact']} onCreate={vi.fn()} onStop={onStop} />,
    );
    expect(screen.queryByTestId('backup-stop')).toBeNull();

    rerender(<BackupCreate objects={['Contact']} onCreate={vi.fn()} onStop={onStop} isCreating />);
    fireEvent.click(screen.getByTestId('backup-stop'));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  describe('in slices', () => {
    it('offers a backup in slices of the objects past one backup, never ticked for the user', () => {
      const onInSlicesChange = vi.fn();
      render(
        <BackupCreate
          objects={['Contact', 'Lead']}
          onCreate={vi.fn()}
          slicesOffered={['Contact']}
          onInSlicesChange={onInSlicesChange}
        />,
      );

      const box = screen.getByTestId('backup-slices-toggle') as HTMLInputElement;
      expect(box.checked).toBe(false);
      expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
        'Contact holds more rows than one backup does: in slices, each slice is a backup of its ' +
          'own, and Backups lists them as one set.',
      );
      fireEvent.click(box);
      expect(onInSlicesChange).toHaveBeenCalledWith(true);
    });

    it('offers none while every object fits one backup', () => {
      render(<BackupCreate objects={['Contact']} onCreate={vi.fn()} onInSlicesChange={vi.fn()} />);
      expect(screen.queryByTestId('backup-slices')).toBeNull();
    });
  });
});
