import { useState, useCallback, useMemo } from 'react';
import type { SeedTemplate } from '@sandforge/shared';
import { PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';
import { useBridgeQuery } from '../../hooks/useBridgeQuery';
import { useBridgeMutation } from '../../hooks/useBridgeMutation';

/** Item shape for the template gallery grid. */
export interface TemplateGalleryItem {
  /** Unique identifier. */
  id: string;
  /** i18n key for pre-built, plain string for saved. */
  name: string;
  /** i18n key for pre-built, plain string for saved. */
  description: string;
  /** Number of objects in the template. */
  objectCount: number;
  /** Sum of all record counts across objects. */
  totalRecords: number;
  /** Template tags. */
  tags: string[];
  /** Whether this is a pre-built (constant) template. */
  isPrebuilt: boolean;
  /** Last update timestamp. */
  updatedAt: string;
  /** Full template for pre-built, null for saved (loaded on demand). */
  template: SeedTemplate | null;
}

/** Response shape from seed:template:list bridge message. */
interface TemplateListResponse {
  templates: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    updatedAt: string;
    objectCount: number;
    totalRecords: number;
  }>;
}

/** Return type for the useTemplateGallery hook. */
export interface TemplateGalleryState {
  /** All gallery items (pre-built + saved). */
  items: TemplateGalleryItem[];
  /** Whether the saved templates are loading. */
  loading: boolean;
  /** Error from the bridge query, if any. */
  error: string | null;
  /** Load the full template by id (returns pre-built directly, fetches saved via bridge). */
  loadFullTemplate: (id: string) => Promise<SeedTemplate>;
  /** Re-fetch saved templates. */
  refresh: () => void;
}

/**
 * Hook that loads and merges pre-built and saved seed templates
 * into a unified gallery item list.
 */
export function useTemplateGallery(): TemplateGalleryState {
  const savedQuery = useBridgeQuery<TemplateListResponse>('seed:template:list', undefined, {
    responseType: 'seed:template:list:response',
  });

  const loadMutation = useBridgeMutation<SeedTemplate>('seed:template:load', {
    responseType: 'seed:template:load:response',
  });

  const [loadResolve, setLoadResolve] = useState<((t: SeedTemplate) => void) | null>(null);

  /* Map pre-built templates to gallery items */
  const prebuiltItems: TemplateGalleryItem[] = useMemo(
    () =>
      PREBUILT_SEED_TEMPLATES.map((tpl) => ({
        id: tpl.id,
        name: tpl.name,
        description: tpl.description,
        objectCount: tpl.objects.length,
        totalRecords: tpl.objects.reduce((sum, o) => sum + o.recordCount, 0),
        tags: tpl.tags,
        isPrebuilt: true,
        updatedAt: tpl.updatedAt,
        template: tpl,
      })),
    [],
  );

  /* Map saved templates to gallery items */
  const savedItems: TemplateGalleryItem[] = useMemo(
    () =>
      (savedQuery.data?.templates ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        objectCount: s.objectCount,
        totalRecords: s.totalRecords,
        tags: s.tags,
        isPrebuilt: false,
        updatedAt: s.updatedAt,
        template: null,
      })),
    [savedQuery.data],
  );

  const items = useMemo(() => [...prebuiltItems, ...savedItems], [prebuiltItems, savedItems]);

  /* Resolve the load mutation when data arrives */
  if (loadMutation.data && loadResolve) {
    loadResolve(loadMutation.data);
    setLoadResolve(null);
    loadMutation.reset();
  }

  const loadFullTemplate = useCallback(
    (id: string): Promise<SeedTemplate> => {
      /* Pre-built: return directly */
      const prebuilt = PREBUILT_SEED_TEMPLATES.find((t) => t.id === id);
      if (prebuilt) {
        return Promise.resolve(prebuilt);
      }

      /* Saved: fetch via bridge */
      return new Promise<SeedTemplate>((resolve) => {
        setLoadResolve(() => resolve);
        loadMutation.mutate({ templateId: id });
      });
    },
    [loadMutation],
  );

  const refresh = useCallback(() => {
    savedQuery.refetch();
  }, [savedQuery]);

  return {
    items,
    loading: savedQuery.loading,
    error: savedQuery.error,
    loadFullTemplate,
    refresh,
  };
}
