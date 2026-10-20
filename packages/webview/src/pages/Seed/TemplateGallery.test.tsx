import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../i18n';
import { TemplateGallery } from './TemplateGallery';

import type { TemplateGalleryItem } from './useTemplateGallery';

/* ------------------------------------------------------------------ */
/* Mock useTemplateGallery                                             */
/* ------------------------------------------------------------------ */

const mockItems: TemplateGalleryItem[] = [
  {
    id: 'prebuilt-sales-cloud-starter',
    name: 'seed.templates.salesCloudStarter.name',
    description: 'seed.templates.salesCloudStarter.description',
    objectCount: 7,
    totalRecords: 7601,
    tags: ['prebuilt', 'sales'],
    isPrebuilt: true,
    recommended: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    template: {
      id: 'prebuilt-sales-cloud-starter',
      name: 'seed.templates.salesCloudStarter.name',
      description: 'seed.templates.salesCloudStarter.description',
      version: 1,
      strategy: 'faker',
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 500,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
        {
          objectApiName: 'Contact',
          recordCount: 1000,
          fieldRules: [],
          excludedFields: [],
          insertOrder: 1,
          batchSize: 200,
        },
      ],
      tags: ['prebuilt', 'sales'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  {
    id: 'prebuilt-minimal-demo',
    name: 'seed.templates.minimalDemo.name',
    description: 'seed.templates.minimalDemo.description',
    objectCount: 3,
    totalRecords: 350,
    tags: ['prebuilt', 'demo'],
    isPrebuilt: true,
    recommended: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    template: null,
  },
];

const mockLoadFullTemplate = vi.fn();
const mockRefresh = vi.fn();

let mockGalleryState = {
  items: mockItems,
  loading: false,
  error: null as string | null,
  loadFullTemplate: mockLoadFullTemplate,
  refresh: mockRefresh,
};

vi.mock('./useTemplateGallery', () => ({
  useTemplateGallery: () => mockGalleryState,
}));

describe('TemplateGallery', () => {
  beforeEach(() => {
    mockLoadFullTemplate.mockClear();
    mockRefresh.mockClear();
    mockGalleryState = {
      items: mockItems,
      loading: false,
      error: null,
      loadFullTemplate: mockLoadFullTemplate,
      refresh: mockRefresh,
    };
  });

  it('renders skeleton loading state', () => {
    mockGalleryState = { ...mockGalleryState, items: [], loading: true };

    render(<TemplateGallery onSelectTemplate={vi.fn()} />);

    expect(screen.getByTestId('gallery-skeleton')).toBeDefined();
  });

  it('renders template cards when loaded', () => {
    render(<TemplateGallery onSelectTemplate={vi.fn()} />);

    expect(screen.getByTestId('template-gallery')).toBeDefined();
    expect(screen.getByTestId('template-card-prebuilt-sales-cloud-starter')).toBeDefined();
    expect(screen.getByTestId('template-card-prebuilt-minimal-demo')).toBeDefined();
  });

  it('hands the template whose Use This was pressed straight to the run, with no dialog first', async () => {
    const salesTemplate = mockItems[0].template;
    mockLoadFullTemplate.mockResolvedValue(salesTemplate);
    const onSelectTemplate = vi.fn();

    render(<TemplateGallery onSelectTemplate={onSelectTemplate} />);

    const useThisButtons = screen.getAllByTestId('btn-use-template');
    fireEvent.click(useThisButtons[0]);

    await waitFor(() => {
      expect(onSelectTemplate).toHaveBeenCalledWith(salesTemplate);
    });
    expect(mockLoadFullTemplate).toHaveBeenCalledWith('prebuilt-sales-cloud-starter');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hands nothing on when the saved template could not be loaded', async () => {
    mockLoadFullTemplate.mockResolvedValue(null);
    const onSelectTemplate = vi.fn();

    render(<TemplateGallery onSelectTemplate={onSelectTemplate} />);
    fireEvent.click(screen.getAllByTestId('btn-use-template')[1]);

    await waitFor(() => {
      expect(mockLoadFullTemplate).toHaveBeenCalledWith('prebuilt-minimal-demo');
    });
    expect(onSelectTemplate).not.toHaveBeenCalled();
  });

  it('renders gallery title and subtitle', () => {
    render(<TemplateGallery onSelectTemplate={vi.fn()} />);

    expect(screen.getByText('Quick Seed from Template')).toBeDefined();
    expect(screen.getByText('Pick a template and start seeding in seconds')).toBeDefined();
  });

  it('shows error banner when error occurs', () => {
    mockGalleryState = { ...mockGalleryState, error: 'Failed to load templates' };

    render(<TemplateGallery onSelectTemplate={vi.fn()} />);

    expect(screen.getByText('Failed to load templates')).toBeDefined();
  });
});
