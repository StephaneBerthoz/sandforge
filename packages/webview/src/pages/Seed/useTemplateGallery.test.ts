import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTemplateGallery } from './useTemplateGallery';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const mockRefetch = vi.fn();
const mockMutate = vi.fn();
const mockReset = vi.fn();

let mockQueryState = {
  data: null as {
    templates: Array<{
      id: string;
      name: string;
      description: string;
      tags: string[];
      updatedAt: string;
      objectCount: number;
      totalRecords: number;
    }>;
  } | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

let mockMutationState = {
  mutate: mockMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => mockQueryState,
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => mockMutationState,
}));

describe('useTemplateGallery', () => {
  beforeEach(() => {
    mockRefetch.mockClear();
    mockMutate.mockClear();
    mockReset.mockClear();
    mockQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    mockMutationState = {
      mutate: mockMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockReset,
    };
  });

  it('returns pre-built templates when no saved templates exist', () => {
    const { result } = renderHook(() => useTemplateGallery());

    expect(result.current.items.length).toBe(3);
    expect(result.current.items.every((i) => i.isPrebuilt)).toBe(true);
    expect(result.current.items.map((i) => i.id)).toEqual([
      'prebuilt-sales-cloud-starter',
      'prebuilt-service-cloud-starter',
      'prebuilt-minimal-demo',
    ]);
  });

  it('merges pre-built and saved templates', () => {
    mockQueryState = {
      ...mockQueryState,
      data: {
        templates: [
          {
            id: 'saved-1',
            name: 'My Template',
            description: 'Custom template',
            tags: ['custom'],
            updatedAt: '2026-01-15T00:00:00.000Z',
            objectCount: 2,
            totalRecords: 500,
          },
        ],
      },
    };

    const { result } = renderHook(() => useTemplateGallery());

    expect(result.current.items.length).toBe(4);
    expect(result.current.items[3].id).toBe('saved-1');
    expect(result.current.items[3].isPrebuilt).toBe(false);
    expect(result.current.items[3].template).toBeNull();
  });

  it('computes correct objectCount and totalRecords for pre-built templates', () => {
    const { result } = renderHook(() => useTemplateGallery());

    const salesCloud = result.current.items.find((i) => i.id === 'prebuilt-sales-cloud-starter');
    expect(salesCloud).toBeDefined();
    expect(salesCloud?.objectCount).toBe(7);
    expect(salesCloud?.totalRecords).toBe(7601);

    const serviceCloud = result.current.items.find(
      (i) => i.id === 'prebuilt-service-cloud-starter',
    );
    expect(serviceCloud).toBeDefined();
    expect(serviceCloud?.objectCount).toBe(5);
    expect(serviceCloud?.totalRecords).toBe(3800);

    const minimal = result.current.items.find((i) => i.id === 'prebuilt-minimal-demo');
    expect(minimal).toBeDefined();
    expect(minimal?.objectCount).toBe(3);
    expect(minimal?.totalRecords).toBe(350);
  });

  it('loadFullTemplate returns pre-built template directly without bridge call', async () => {
    const { result } = renderHook(() => useTemplateGallery());

    const template = await result.current.loadFullTemplate('prebuilt-sales-cloud-starter');

    expect(template).toBeDefined();
    expect(template.id).toBe('prebuilt-sales-cloud-starter');
    expect(template.objects.length).toBe(7);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('reports loading state from bridge query', () => {
    mockQueryState = { ...mockQueryState, loading: true };

    const { result } = renderHook(() => useTemplateGallery());

    expect(result.current.loading).toBe(true);
  });

  it('reports error state from bridge query', () => {
    mockQueryState = { ...mockQueryState, error: 'Network error' };

    const { result } = renderHook(() => useTemplateGallery());

    expect(result.current.error).toBe('Network error');
  });
});
