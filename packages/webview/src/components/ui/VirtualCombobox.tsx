import React, { useState, useRef, useCallback, useMemo, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../theme';
import { Icon } from './Icon';

/** Option entry for VirtualCombobox. */
export interface VirtualComboboxOption {
  /** Unique value for the option. */
  value: string;
  /** Display label for the option. */
  label: string;
  /** Optional description shown below the label. */
  description?: string;
}

/** Props for the VirtualCombobox component. */
export interface VirtualComboboxProps {
  /** Available options to display. */
  options: VirtualComboboxOption[];
  /** Currently selected value(s). */
  value: string | string[];
  /** Callback when selection changes. */
  onChange: (value: string | string[]) => void;
  /** Placeholder text when no value is selected. */
  placeholder?: string;
  /** Whether the search input is enabled. */
  searchable?: boolean;
  /** Whether multiple options can be selected. */
  multiple?: boolean;
  /** Maximum height of the dropdown panel. */
  maxHeight?: string;
  /** Whether the combobox is disabled. */
  disabled?: boolean;
  /** Additional CSS classes for the root element. */
  className?: string;
}

/**
 * Searchable dropdown with virtualized options list.
 * Handles 1000+ options efficiently using @tanstack/react-virtual.
 * Supports single and multi-select modes with keyboard navigation.
 */
export function VirtualCombobox({
  options,
  value,
  onChange,
  placeholder,
  searchable = true,
  multiple = false,
  maxHeight = '250px',
  disabled = false,
  className,
}: VirtualComboboxProps): React.ReactElement {
  const { t } = useTranslation();
  const uid = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedSet = useMemo(() => {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    return new Set(arr);
  }, [value]);

  const filteredOptions = useMemo(() => {
    if (!search) return options;
    const lower = search.toLowerCase();
    return options.filter((opt) => opt.label.toLowerCase().includes(lower));
  }, [options, search]);

  const virtualizer = useVirtualizer({
    count: filteredOptions.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,
    overscan: 5,
  });

  const getDisplayText = useCallback((): string => {
    if (selectedSet.size === 0) {
      return placeholder ?? '';
    }
    if (multiple && selectedSet.size > 1) {
      return t('combobox.selected', '{{count}} selected', { count: selectedSet.size });
    }
    const firstVal = Array.isArray(value) ? value[0] : value;
    const option = options.find((opt) => opt.value === firstVal);
    return option?.label ?? firstVal;
  }, [selectedSet, placeholder, multiple, value, options, t]);

  const handleSelect = useCallback(
    (optionValue: string) => {
      if (multiple) {
        const currentArr = Array.isArray(value) ? value : value ? [value] : [];
        const nextArr = currentArr.includes(optionValue)
          ? currentArr.filter((v) => v !== optionValue)
          : [...currentArr, optionValue];
        onChange(nextArr);
      } else {
        onChange(optionValue);
        setIsOpen(false);
        setSearch('');
      }
    },
    [multiple, value, onChange],
  );

  const handleOpen = useCallback(() => {
    if (disabled) return;
    setIsOpen(true);
    setHighlightedIndex(0);
    setSearch('');
  }, [disabled]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setSearch('');
    triggerRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleOpen();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < filteredOptions.length - 1 ? prev + 1 : prev,
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (filteredOptions[highlightedIndex]) {
            handleSelect(filteredOptions[highlightedIndex].value);
          }
          break;
        case 'Escape':
          e.preventDefault();
          handleClose();
          break;
      }
    },
    [isOpen, filteredOptions, highlightedIndex, handleSelect, handleOpen, handleClose],
  );

  // Scroll highlighted item into view
  useEffect(() => {
    if (isOpen && filteredOptions.length > 0) {
      virtualizer.scrollToIndex(highlightedIndex);
    }
  }, [isOpen, highlightedIndex, filteredOptions.length, virtualizer]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchable) {
      // Use setTimeout to ensure the DOM has rendered
      const timer = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen, searchable]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, handleClose]);

  const listboxId = `${uid}-listbox`;
  const inputId = `${uid}-input`;

  return (
    <div
      data-testid="virtual-combobox"
      ref={containerRef}
      className={cn('relative inline-block w-full', className)}
      onKeyDown={handleKeyDown}
    >
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        data-testid="combobox-trigger"
        className={cn(
          'flex w-full items-center justify-between rounded-[var(--sf-radius-md)] border border-[var(--sf-border)] px-3 py-2 text-left',
          disabled && 'opacity-50 cursor-not-allowed',
          !disabled && 'cursor-pointer hover:border-[var(--sf-accent)]',
        )}
        style={{
          fontSize: 'var(--sf-font-size)',
          color: selectedSet.size > 0 ? 'var(--sf-text-primary)' : 'var(--sf-text-muted)',
          backgroundColor: 'var(--sf-bg-primary)',
        }}
        onClick={() => (isOpen ? handleClose() : handleOpen())}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        disabled={disabled}
      >
        <span className="truncate">{getDisplayText() || placeholder || '\u00A0'}</span>
        <Icon
          name={isOpen ? 'chevron-up' : 'chevron-down'}
          className="ml-2 flex-shrink-0 text-xs"
        />
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div
          data-testid="combobox-dropdown"
          className="absolute z-50 mt-1 w-full rounded-[var(--sf-radius-md)] border border-[var(--sf-border)] shadow-lg"
          style={{ backgroundColor: 'var(--sf-bg-primary)' }}
        >
          {/* Search input */}
          {searchable && (
            <div className="border-b border-[var(--sf-border)] p-2">
              <input
                ref={searchRef}
                id={inputId}
                data-testid="combobox-search"
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setHighlightedIndex(0);
                }}
                placeholder={t('combobox.search', 'Search...')}
                className="w-full rounded-[var(--sf-radius-sm)] border border-[var(--sf-border)] px-2 py-1 outline-none focus:border-[var(--sf-accent)]"
                style={{
                  fontSize: 'var(--sf-font-size-sm)',
                  color: 'var(--sf-text-primary)',
                  backgroundColor: 'var(--sf-bg-secondary)',
                }}
                aria-controls={listboxId}
                aria-autocomplete="list"
              />
            </div>
          )}

          {/* Virtualized options list */}
          {filteredOptions.length === 0 ? (
            <div
              data-testid="combobox-no-results"
              className="px-3 py-4 text-center"
              style={{ color: 'var(--sf-text-muted)', fontSize: 'var(--sf-font-size-sm)' }}
            >
              {t('combobox.noResults', 'No results found')}
            </div>
          ) : (
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-multiselectable={multiple || undefined}
              data-testid="combobox-listbox"
              style={{ maxHeight, overflowY: 'auto' }}
            >
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const opt = filteredOptions[virtualItem.index];
                  const isSelected = selectedSet.has(opt.value);
                  const isHighlighted = highlightedIndex === virtualItem.index;

                  return (
                    <div
                      key={opt.value}
                      role="option"
                      aria-selected={isSelected}
                      data-testid={`combobox-option-${virtualItem.index}`}
                      className={cn(
                        'flex items-center px-3 cursor-pointer',
                        isHighlighted && 'bg-[var(--sf-bg-hover)]',
                        isSelected && !isHighlighted && 'bg-[var(--sf-bg-secondary)]',
                      )}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                        color: 'var(--sf-text-primary)',
                        fontSize: 'var(--sf-font-size-sm)',
                      }}
                      onClick={() => handleSelect(opt.value)}
                      onMouseEnter={() => setHighlightedIndex(virtualItem.index)}
                    >
                      {multiple && (
                        <span className="mr-2 flex-shrink-0" style={{ width: '16px' }}>
                          {isSelected && (
                            <Icon name="check" className="text-[var(--sf-accent)]" />
                          )}
                        </span>
                      )}
                      <div className="flex flex-col overflow-hidden">
                        <span className="truncate">{opt.label}</span>
                        {opt.description && (
                          <span
                            className="truncate"
                            data-testid="option-description"
                            style={{
                              fontSize: 'var(--sf-font-size-xs)',
                              color: 'var(--sf-text-muted)',
                            }}
                          >
                            {opt.description}
                          </span>
                        )}
                      </div>
                      {!multiple && isSelected && (
                        <Icon name="check" className="ml-auto flex-shrink-0 text-[var(--sf-accent)]" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
