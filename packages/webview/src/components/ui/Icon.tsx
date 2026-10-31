import React from 'react';
import {
  Activity,
  Archive,
  ArrowLeftRight,
  ArrowUpDown,
  BadgeCheck,
  Bell,
  Bot,
  Building2,
  Calendar,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  CircuitBoard,
  Clock,
  CloudDownload,
  CloudUpload,
  Database,
  Diff,
  EyeOff,
  File,
  FileOutput,
  Flame,
  GitCompare,
  HelpCircle,
  History,
  House,
  Key,
  Lightbulb,
  Link,
  ListChecks,
  ListFilter,
  ListTodo,
  Lock,
  MessagesSquare,
  Package,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  Save,
  Server,
  Settings,
  Shield,
  SkipForward,
  Snowflake,
  Trash2,
  TriangleAlert,
  Trophy,
  Undo2,
  Workflow,
  Wrench,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../theme';

/**
 * Every icon the panel draws, under the codicon name its callers already
 * used.
 *
 * The component drew `<span class="codicon codicon-…">` and counted on VS
 * Code's icon font, which never reaches a webview: every icon on every page
 * was an empty span, and the buttons holding nothing else — Dismiss, the Edit
 * and Delete of a Sync schedule, Refresh — showed as blank boxes. The glyphs
 * come from lucide, which the side panel already draws its own with. A name
 * missing from this table does not compile, where it used to paint nothing.
 */
const ICONS = {
  add: Plus,
  archive: Archive,
  'arrow-swap': ArrowLeftRight,
  'arrow-up-down': ArrowUpDown,
  bell: Bell,
  calendar: Calendar,
  check: Check,
  checklist: ListChecks,
  'chevron-down': ChevronDown,
  'chevron-up': ChevronUp,
  'circuit-board': CircuitBoard,
  clock: Clock,
  close: X,
  'cloud-download': CloudDownload,
  'cloud-upload': CloudUpload,
  'comment-discussion': MessagesSquare,
  database: Database,
  'debug-restart': RotateCcw,
  'debug-step-over': SkipForward,
  'debug-stop': CircleStop,
  diff: Diff,
  discard: Undo2,
  edit: Pencil,
  error: XCircle,
  export: FileOutput,
  'eye-closed': EyeOff,
  file: File,
  flame: Flame,
  gear: Settings,
  'git-compare': GitCompare,
  graph: ChartColumn,
  history: History,
  home: House,
  hubot: Bot,
  key: Key,
  lightbulb: Lightbulb,
  link: Link,
  'list-selection': ListFilter,
  lock: Lock,
  organization: Building2,
  package: Package,
  plug: Plug,
  project: Workflow,
  pulse: Activity,
  question: HelpCircle,
  refresh: RotateCw,
  rocket: Rocket,
  save: Save,
  server: Server,
  shield: Shield,
  snowflake: Snowflake,
  sync: RefreshCw,
  tasklist: ListTodo,
  trash: Trash2,
  trophy: Trophy,
  verified: BadgeCheck,
  warning: TriangleAlert,
  // Not `tools`, the codicon's name: shipped code holds no member of that
  // name, which is how a request hands the model tools (docs/product-claims).
  wrench: Wrench,
  zap: Zap,
} as const satisfies Record<string, LucideIcon>;

/** The name of an icon the panel can draw. */
export type IconName = keyof typeof ICONS;

/** Every name in the table, for the test that walks them. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Props for the Icon component. */
export interface IconProps {
  /** Which icon, by its codicon name ("database", "sync", "trash"…). */
  name: IconName;
  /** Additional CSS classes. A text size class sizes the icon, as it sized the glyph. */
  className?: string;
  /** Whether the icon should spin (e.g., for loading states). */
  spin?: boolean;
  /**
   * Accessible label, for an icon that says something no text beside it
   * says. If omitted, the icon is decorative (aria-hidden).
   */
  label?: string;
}

/**
 * Renders an icon as an inline SVG one em square, so the text size of its
 * class or its parent sizes it as it sized the font glyph, drawn in the
 * current text colour. It never goes under 12px: the Edit and Delete of a
 * Sync schedule sit in 10px text, where the strokes thinned to a blur.
 */
export const Icon: React.FC<IconProps> = ({ name, className, spin, label }) => {
  const Glyph: LucideIcon | undefined = ICONS[name];
  // A name that reached here around the type, from a cast or a stored
  // value, draws nothing rather than taking the page down with it.
  if (Glyph === undefined) return null;
  return (
    <Glyph
      size="1em"
      className={cn(
        'inline-block min-h-3 min-w-3 shrink-0 align-[-0.125em]',
        spin && 'sf-spin',
        className,
      )}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid={`icon-${name}`}
    />
  );
};
