import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { TemplateCard } from './TemplateCard';
import type { TemplateGalleryItem } from './useTemplateGallery';

const mockItem: TemplateGalleryItem = {
  id: 'prebuilt-sales-cloud-starter',
  name: 'seed.templates.salesCloudStarter.name',
  description: 'seed.templates.salesCloudStarter.description',
  objectCount: 7,
  totalRecords: 7601,
  tags: ['prebuilt', 'sales'],
  isPrebuilt: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  template: null,
};

const savedItem: TemplateGalleryItem = {
  id: 'saved-1',
  name: 'My Custom Template',
  description: 'A custom template for testing',
  objectCount: 3,
  totalRecords: 500,
  tags: ['custom'],
  isPrebuilt: false,
  updatedAt: '2026-02-01T00:00:00.000Z',
  template: null,
};

describe('TemplateCard', () => {
  it('renders template name and description', () => {
    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('Sales Cloud Starter')).toBeDefined();
    expect(screen.getByText(/Pre-built template for Sales Cloud/)).toBeDefined();
  });

  it('displays correct object count and record count', () => {
    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('7 objects')).toBeDefined();
    expect(screen.getByText('7601 records')).toBeDefined();
  });

  it('calls onUseThis with the item when Use This is clicked', () => {
    const onUseThis = vi.fn();
    render(<TemplateCard item={mockItem} onUseThis={onUseThis} />);

    fireEvent.click(screen.getByTestId('btn-use-template'));

    expect(onUseThis).toHaveBeenCalledTimes(1);
    expect(onUseThis).toHaveBeenCalledWith(mockItem);
  });

  it('renders saved template name as plain text', () => {
    render(<TemplateCard item={savedItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('My Custom Template')).toBeDefined();
    expect(screen.getByText('A custom template for testing')).toBeDefined();
  });

  it('renders tag badges', () => {
    render(<TemplateCard item={mockItem} onUseThis={vi.fn()} />);

    expect(screen.getByText('prebuilt')).toBeDefined();
    expect(screen.getByText('sales')).toBeDefined();
  });
});
