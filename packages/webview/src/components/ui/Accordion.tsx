import React, { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '../../theme';

/** A single accordion section. */
export interface AccordionItem {
  title: string;
  content: React.ReactNode;
  defaultOpen?: boolean;
}

/** Accordion component props. */
export interface AccordionProps {
  items: AccordionItem[];
  /** When true, only one item can be open at a time. */
  single?: boolean;
  className?: string;
}

/** Internal panel component for each accordion section. */
const AccordionPanel: React.FC<{
  item: AccordionItem;
  isOpen: boolean;
  onToggle: () => void;
  index: number;
}> = ({ item, isOpen, onToggle, index }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    }
  }, [item.content]);

  return (
    <div className="border-b border-[var(--vscode-panel-border,#3c3c3c)] last:border-b-0">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={`accordion-panel-${index}`}
        id={`accordion-header-${index}`}
        className={cn(
          'flex items-center justify-between w-full py-2.5 px-3 text-sm text-left font-medium',
          'text-[var(--vscode-editor-foreground,#d4d4d4)]',
          'hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)] transition-colors',
        )}
        onClick={onToggle}
      >
        <span>{item.title}</span>
        <svg
          className={cn('w-4 h-4 shrink-0 transition-transform duration-200', isOpen && 'rotate-180')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div
        id={`accordion-panel-${index}`}
        role="region"
        aria-labelledby={`accordion-header-${index}`}
        className="overflow-hidden transition-[max-height] duration-200 ease-in-out"
        style={{ maxHeight: isOpen ? height : 0 }}
      >
        <div ref={contentRef} className="px-3 pb-3 text-xs text-[var(--vscode-editor-foreground,#d4d4d4)]">
          {item.content}
        </div>
      </div>
    </div>
  );
};

/** Collapsible accordion sections with CSS transitions. */
export const Accordion: React.FC<AccordionProps> = ({ items, single = false, className }) => {
  const [openIndices, setOpenIndices] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    items.forEach((item, index) => {
      if (item.defaultOpen) initial.add(index);
    });
    return initial;
  });

  const handleToggle = useCallback(
    (index: number) => {
      setOpenIndices((prev) => {
        const next = new Set(single ? [] : prev);
        if (prev.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    [single],
  );

  return (
    <div
      className={cn('border border-[var(--vscode-panel-border,#3c3c3c)] rounded-md overflow-hidden', className)}
      role="presentation"
    >
      {items.map((item, index) => (
        <AccordionPanel
          key={index}
          item={item}
          index={index}
          isOpen={openIndices.has(index)}
          onToggle={() => handleToggle(index)}
        />
      ))}
    </div>
  );
};
