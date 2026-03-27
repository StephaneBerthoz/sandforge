import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../theme';

/** Props for the VirtualList component. */
export interface VirtualListProps<T> {
  /** Items to render in the virtualized list. */
  items: T[];
  /** Render function for each item. */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Function to extract a unique key from each item. */
  keyExtractor: (item: T, index: number) => string;
  /** Estimated height of each item in pixels. */
  estimatedItemHeight?: number;
  /** Maximum height of the scroll container. */
  maxHeight?: string;
  /** Number of items to render outside the visible area. */
  overscan?: number;
  /** Additional CSS classes for the root element. */
  className?: string;
  /** Message displayed when items array is empty. */
  emptyMessage?: string;
}

/**
 * Generic virtualized list component using @tanstack/react-virtual.
 * Renders only visible items for efficient handling of large datasets (1000+ items).
 */
export function VirtualList<T>({
  items,
  renderItem,
  keyExtractor,
  estimatedItemHeight = 36,
  maxHeight = '300px',
  overscan = 5,
  className,
  emptyMessage,
}: VirtualListProps<T>): React.ReactElement {
  const { t } = useTranslation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => estimatedItemHeight,
    overscan,
  });

  if (items.length === 0) {
    return (
      <div
        data-testid="virtual-list"
        role="list"
        className={cn('flex items-center justify-center', className)}
        style={{
          padding: 'var(--sf-space-4)',
          color: 'var(--sf-text-muted)',
        }}
      >
        {emptyMessage ?? t('list.empty', 'No items')}
      </div>
    );
  }

  return (
    <div
      data-testid="virtual-list"
      ref={scrollContainerRef}
      className={cn('overflow-y-auto', className)}
      style={{ maxHeight }}
      role="list"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index];
          return (
            <div
              key={keyExtractor(item, virtualItem.index)}
              role="listitem"
              data-testid={`virtual-list-item-${virtualItem.index}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {renderItem(item, virtualItem.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
