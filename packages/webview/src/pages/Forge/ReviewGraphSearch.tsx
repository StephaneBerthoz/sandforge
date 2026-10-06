import React, { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ForgeGraph } from '@sandforge/shared';
import { Button } from '../../components/ui/Button';
import { cn } from '../../theme';
import { useForgeStore } from '../../stores/useForgeStore';
import { branchOf } from '../../utils/forgeRunControls';

/** The most matches listed: past it, the search is narrowed rather than scrolled. */
const MATCHES_LISTED = 20;

/** The objects of `graph` whose API name holds `query`, whatever its case, by name. */
export function graphMatches(graph: ForgeGraph, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  return graph.nodes
    .map((node) => node.objectApiName)
    .filter((name) => name.toLowerCase().includes(needle))
    .sort((a, b) => a.localeCompare(b));
}

/** Props of {@link ReviewGraphSearch}. */
interface ReviewGraphSearchProps {
  graph: ForgeGraph;
  /** What the search holds: the graph marks the objects it matches. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Bring an object into view in the graph; absent while the table is shown. */
  onShow?: (objectApiName: string) => void;
}

/**
 * Find an object of the graph on Review by its name, and leave out the branch
 * it heads: the object, and every object only it reaches (`branchOf`). The
 * branch goes as the boxes of the graph go, kept in the config's excluded
 * objects, and can be put back at once.
 *
 * A graph of hundreds of objects was searched with the eyes alone, and taking
 * out a part of it meant unticking each of its objects in turn.
 */
export const ReviewGraphSearch: React.FC<ReviewGraphSearchProps> = ({
  graph,
  query,
  onQueryChange,
  onShow,
}) => {
  const { t } = useTranslation();
  const id = useId();
  const setNodesIncluded = useForgeStore((s) => s.setNodesIncluded);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const matches = useMemo(() => graphMatches(graph, query), [graph, query]);
  const byName = useMemo(
    () => new Map(graph.nodes.map((node) => [node.objectApiName, node])),
    [graph],
  );

  const leaveOut = (objectApiName: string): void => {
    const branch = branchOf(graph, objectApiName).filter(
      (name) => byName.get(name)?.included === true,
    );
    setNodesIncluded(branch, false);
    setLeftOut(branch);
  };

  return (
    // The matches lie over what follows rather than push it down: pushed, the
    // graph's pane was resized under React Flow as each letter was typed.
    <div data-testid="review-graph-search" className="relative flex flex-col gap-1 text-xs">
      <label htmlFor={`${id}-query`} className="text-text-secondary">
        {t('forge.review.graphSearch.label')}
      </label>
      <input
        id={`${id}-query`}
        data-testid="review-graph-search-input"
        type="search"
        value={query}
        placeholder={t('forge.review.graphSearch.placeholder')}
        aria-describedby={`${id}-count`}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query !== '') {
            e.preventDefault();
            onQueryChange('');
          }
        }}
        className={cn(
          'w-64 rounded-sm px-2 py-1',
          'bg-(--sf-bg-input) text-(--sf-text-input) border border-(--sf-border-input)',
        )}
      />
      <p
        id={`${id}-count`}
        role="status"
        data-testid="review-graph-search-count"
        className="min-h-4 text-text-secondary"
      >
        {query.trim() === ''
          ? ''
          : matches.length === 0
            ? t('forge.review.graphSearch.none')
            : t('forge.review.graphSearch.matches', { count: matches.length })}
      </p>
      {matches.length > 0 && (
        <ul
          data-testid="review-graph-search-matches"
          className={cn(
            'absolute left-0 top-full z-20 mt-1 flex max-h-64 w-[28rem] max-w-[90vw] flex-col gap-0.5',
            'overflow-y-auto rounded-md border border-subtle bg-surface-2 p-2 shadow-lg',
          )}
        >
          {matches.slice(0, MATCHES_LISTED).map((name) => {
            const node = byName.get(name);
            const included = node?.included === true;
            const root = node?.level === 0;
            const others = branchOf(graph, name).length - 1;
            return (
              <li
                key={name}
                data-testid={`review-graph-match-${name}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-medium text-text-primary">{name}</span>
                <span className="text-text-secondary">
                  {t(included ? 'forge.review.graphSearch.inRun' : 'forge.review.graphSearch.out')}
                </span>
                {onShow && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="review-graph-show"
                    aria-label={t('forge.review.graphSearch.showLabel', { object: name })}
                    onClick={() => onShow(name)}
                  >
                    {t('forge.review.graphSearch.show')}
                  </Button>
                )}
                {included &&
                  (root ? (
                    <span className="text-text-secondary">
                      {t('forge.review.graphSearch.rootKept')}
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      data-testid="review-graph-leave-out-branch"
                      aria-label={t('forge.review.graphSearch.leaveOutLabel', {
                        object: name,
                        count: others,
                      })}
                      onClick={() => leaveOut(name)}
                    >
                      {t('forge.review.graphSearch.leaveOut')}
                    </Button>
                  ))}
              </li>
            );
          })}
          {matches.length > MATCHES_LISTED && (
            <li className="text-text-secondary">
              {t('forge.review.graphSearch.more', { count: matches.length - MATCHES_LISTED })}
            </li>
          )}
        </ul>
      )}
      <div className="flex min-h-6 flex-wrap items-center gap-2">
        <p role="status" data-testid="review-graph-left-out" className="text-text-primary">
          {leftOut.length > 0
            ? t('forge.review.graphSearch.leftOut', { objects: leftOut.join(', ') })
            : ''}
        </p>
        {leftOut.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="review-graph-put-back"
            onClick={() => {
              setNodesIncluded(leftOut, true);
              setLeftOut([]);
            }}
          >
            {t('forge.review.graphSearch.putBack')}
          </Button>
        )}
      </div>
    </div>
  );
};
