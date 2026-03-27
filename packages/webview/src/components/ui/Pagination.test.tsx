import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Pagination } from './Pagination';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue: string, opts?: Record<string, unknown>) => {
      if (!opts) return defaultValue;
      let result = defaultValue;
      for (const [k, v] of Object.entries(opts)) {
        result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
      }
      return result;
    },
  }),
}));

describe('Pagination', () => {
  const baseProps = {
    page: 2,
    pageSize: 25,
    totalItems: 100,
    totalPages: 4,
    canNext: true,
    canPrev: true,
    onPageChange: vi.fn(),
    onPageSizeChange: vi.fn(),
  };

  it('should render all elements', () => {
    render(<Pagination {...baseProps} />);

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(
      'Showing 26-50 of 100',
    );
    expect(screen.getByTestId('pagination-page-info')).toHaveTextContent(
      'Page 2 of 4',
    );
    expect(screen.getByLabelText('Previous page')).toBeInTheDocument();
    expect(screen.getByLabelText('Next page')).toBeInTheDocument();
    expect(screen.getByLabelText('Rows per page')).toBeInTheDocument();
  });

  it('should render navigation landmark', () => {
    render(<Pagination {...baseProps} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('should fire onPageChange when clicking previous', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...baseProps} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByLabelText('Previous page'));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('should fire onPageChange when clicking next', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...baseProps} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByLabelText('Next page'));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('should fire onPageSizeChange when selecting a new page size', () => {
    const onPageSizeChange = vi.fn();
    render(
      <Pagination {...baseProps} onPageSizeChange={onPageSizeChange} />,
    );

    fireEvent.change(screen.getByLabelText('Rows per page'), {
      target: { value: '50' },
    });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it('should disable previous button on first page', () => {
    render(<Pagination {...baseProps} page={1} canPrev={false} />);

    const prevBtn = screen.getByLabelText('Previous page');
    expect(prevBtn).toBeDisabled();
  });

  it('should disable next button on last page', () => {
    render(<Pagination {...baseProps} page={4} canNext={false} />);

    const nextBtn = screen.getByLabelText('Next page');
    expect(nextBtn).toBeDisabled();
  });

  it('should render custom page size options', () => {
    render(
      <Pagination {...baseProps} pageSizeOptions={[5, 15, 30]} />,
    );

    const select = screen.getByLabelText('Rows per page');
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('5');
    expect(options[1]).toHaveTextContent('15');
    expect(options[2]).toHaveTextContent('30');
  });

  it('should show 0-0 of 0 when totalItems is zero', () => {
    render(
      <Pagination
        {...baseProps}
        page={1}
        totalItems={0}
        totalPages={1}
        canNext={false}
        canPrev={false}
      />,
    );

    expect(screen.getByTestId('pagination-summary')).toHaveTextContent(
      'Showing 0-0 of 0',
    );
  });

  it('should apply custom className', () => {
    render(<Pagination {...baseProps} className="mt-4" />);

    const nav = screen.getByRole('navigation');
    expect(nav.className).toContain('mt-4');
  });
});
