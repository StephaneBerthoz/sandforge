import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';

/** Section header with optional collapse toggle. */
export const SectionHeader: React.FC<{
  title: string;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  actions?: React.ReactNode;
}> = ({ title, count, collapsed, onToggle, actions }) => (
  <div className="flex items-center gap-2 mb-3">
    {onToggle && (
      <button className="text-text-muted hover:text-text-secondary" onClick={onToggle}>
        {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
    )}
    <h3 className="text-sm font-semibold text-text-primary flex-1">{title}</h3>
    {count !== undefined && <Badge variant="default">{count}</Badge>}
    {actions}
  </div>
);
