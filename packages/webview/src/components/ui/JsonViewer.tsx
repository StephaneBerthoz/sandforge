import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';

/** JsonViewer component props. */
export interface JsonViewerProps {
  /** The data to display. */
  data: unknown;
  /** Maximum nesting depth before auto-collapsing. Defaults to 3. */
  maxDepth?: number;
  /** Whether all nodes start collapsed. */
  collapsed?: boolean;
  className?: string;
}

/** Color classes for different JSON value types. */
const typeColors: Record<string, string> = {
  string: 'text-hue-green',
  number: 'text-hue-blue',
  boolean: 'text-hue-amber',
  null: 'text-text-secondary',
  key: 'text-hue-purple',
};

/** Returns the display type of a value. */
function getValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Renders a primitive JSON value with syntax coloring. */
const JsonValue: React.FC<{ value: unknown }> = ({ value }) => {
  const type = getValueType(value);

  if (type === 'string') {
    return <span className={typeColors.string}>&quot;{String(value)}&quot;</span>;
  }
  if (type === 'null') {
    return <span className={typeColors.null}>null</span>;
  }
  if (type === 'boolean') {
    return <span className={typeColors.boolean}>{String(value)}</span>;
  }
  if (type === 'number') {
    return <span className={typeColors.number}>{String(value)}</span>;
  }

  return <span>{String(value)}</span>;
};

/** Recursively renders a JSON node. */
const JsonNode: React.FC<{
  keyName?: string;
  value: unknown;
  depth: number;
  maxDepth: number;
  defaultCollapsed: boolean;
  isLast: boolean;
}> = ({ keyName, value, depth, maxDepth, defaultCollapsed, isLast }) => {
  const { t } = useTranslation();
  const type = getValueType(value);
  const isExpandable = type === 'object' || type === 'array';
  const shouldStartCollapsed = defaultCollapsed || depth >= maxDepth;

  const [expanded, setExpanded] = useState(!shouldStartCollapsed);

  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  const comma = isLast ? '' : ',';

  if (!isExpandable) {
    return (
      <div className="leading-5" style={{ paddingLeft: depth * 16 }}>
        {keyName !== undefined && (
          <>
            <span className={typeColors.key}>&quot;{keyName}&quot;</span>:{' '}
          </>
        )}
        <JsonValue value={value} />
        {comma}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const nodeName = keyName ?? t(isArray ? 'a11y.jsonArray' : 'a11y.jsonObject');
  const openBracket = isArray ? '[' : '{';
  const closeBracket = isArray ? ']' : '}';

  return (
    <div>
      <div
        className="leading-5 cursor-pointer hover:bg-(--vscode-list-hoverBackground,#2a2d2e)"
        style={{ paddingLeft: depth * 16 }}
        onClick={toggle}
        role="button"
        aria-expanded={expanded}
        aria-label={t('a11y.toggleJsonNode', { name: nodeName })}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {/* The row takes the list hover, on which description text falls under AA. */}
        <span className="inline-block w-3 text-[10px] text-text-primary select-none">
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
        {keyName !== undefined && (
          <>
            <span className={typeColors.key}>&quot;{keyName}&quot;</span>:{' '}
          </>
        )}
        {expanded ? (
          <span>{openBracket}</span>
        ) : (
          <span>
            {openBracket}...{closeBracket}
            <span className="text-text-primary text-[10px] ml-1">
              {t('common.itemCount', { count: entries.length })}
            </span>
            {comma}
          </span>
        )}
      </div>
      {expanded && (
        <>
          {entries.map(([key, val], index) => (
            <JsonNode
              key={key}
              keyName={isArray ? undefined : key}
              value={val}
              depth={depth + 1}
              maxDepth={maxDepth}
              defaultCollapsed={defaultCollapsed}
              isLast={index === entries.length - 1}
            />
          ))}
          <div className="leading-5" style={{ paddingLeft: depth * 16 }}>
            {closeBracket}
            {comma}
          </div>
        </>
      )}
    </div>
  );
};

/** Interactive JSON viewer with syntax highlighting and collapsible nodes. */
export const JsonViewer: React.FC<JsonViewerProps> = ({
  data,
  maxDepth = 3,
  collapsed = false,
  className,
}) => {
  return (
    <div
      className={cn(
        'font-mono text-xs p-2 rounded-sm',
        'bg-(--vscode-editor-background,#1e1e1e)',
        'text-(--vscode-editor-foreground,#d4d4d4)',
        'border border-(--vscode-panel-border,#3c3c3c)',
        'overflow-auto',
        className,
      )}
      data-testid="json-viewer"
    >
      <JsonNode value={data} depth={0} maxDepth={maxDepth} defaultCollapsed={collapsed} isLast />
    </div>
  );
};
