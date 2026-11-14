import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { ReviewAdminCopy } from './ReviewAdminCopy';

describe('ReviewAdminCopy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('copies the list as given, and says so once the host took it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<ReviewAdminCopy text={'Heading\n- a step'} testId="admin-copy" />);

    expect(screen.getByTestId('admin-copy').textContent).toBe("Copy for the target's admin");
    await act(async () => {
      fireEvent.click(screen.getByTestId('admin-copy'));
    });

    expect(writeText).toHaveBeenCalledWith('Heading\n- a step');
    expect(screen.getByTestId('admin-copy-copied').textContent).toBe('Copied');
  });

  it('claims no copy the host refused', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<ReviewAdminCopy text="x" testId="admin-copy" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('admin-copy'));
    });

    expect(screen.getByTestId('admin-copy-copied').textContent).toBe('');
  });

  it('says the words it is given', () => {
    render(
      <ReviewAdminCopy text="x" testId="admin-copy" labelKey="forgeRun.review.leftOutAdmin.copy" />,
    );

    expect(screen.getByTestId('admin-copy').textContent).not.toBe("Copy for the target's admin");
  });
});
