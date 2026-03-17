# SandForge v3 UI Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform SandForge from a functional ETL tool into a 1-click sandbox provisioning platform with a stunning, modern UI inspired by Linear/Supabase/Figma.

**Architecture:** 4-wave incremental delivery. Wave 1 lays the design system and layout foundations. Wave 2 builds the killer "Smart Clone" feature. Wave 3 overhauls all existing modules. Wave 4 polishes everything to production quality.

**Tech Stack:** React 18, Tailwind CSS 3, Framer Motion 11, React Flow 11, Recharts 2.12, Zustand 4, cmdk (new), d3-sankey (new via existing d3), Radix UI, i18next.

**Design doc:** `docs/plans/2026-03-07-v3-ui-redesign-design.md`

**Branch:** `feat/v3-autopilot`

**Validation after each task group:** `pnpm validate` (typecheck + lint + test + build)

---

## Pre-Flight: Install New Dependencies

**Step 1:** Install cmdk in webview package

```bash
cd packages/webview && pnpm add cmdk
```

**Step 2:** Verify reactflow is installed (already `reactflow@^11` in package.json)

**Step 3:** Commit

```bash
git add packages/webview/package.json pnpm-lock.yaml
git commit -m "chore: add cmdk dependency for command palette"
```

---

# WAVE 1 — FOUNDATIONS (Tasks 1-12)

## Task 1: Design Tokens — Tailwind Config & Theme

**Files:**
- Modify: `packages/webview/tailwind.config.ts`
- Modify: `packages/webview/src/theme/index.ts`
- Modify: `packages/webview/src/theme/index.test.ts`

**What to do:**

1. Update `tailwind.config.ts` — add dark-mode surface scale, new module colors, border tokens, typography:

```typescript
const config: Config = {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // Surface scale (dark-mode-first)
        surface: {
          0: '#0A0A0F',
          1: '#12121A',
          2: '#1C1C28',
          3: '#262635',
        },
        // Module accent colors (more saturated for dark)
        forge: { DEFAULT: '#F97316', light: '#FFEDD5', dark: '#9A3412' },
        seed: { DEFAULT: '#22C55E', light: '#D1FAE5', dark: '#065F46' },
        sync: { DEFAULT: '#3B82F6', light: '#DBEAFE', dark: '#1E40AF' },
        monitor: { DEFAULT: '#EAB308', light: '#FEF3C7', dark: '#92400E' },
        compare: { DEFAULT: '#A855F7', light: '#EDE9FE', dark: '#5B21B6' },
        dataops: { DEFAULT: '#06B6D4', light: '#CFFAFE', dark: '#0E7490' },
        automation: { DEFAULT: '#F43F5E', light: '#FFE4E6', dark: '#9F1239' },
        // Text
        'text-primary': '#F2F2F2',
        'text-secondary': '#A3A3A3',
        'text-muted': '#6B6B7B',
      },
      borderColor: {
        subtle: 'rgba(255,255,255,0.06)',
        DEFAULT: 'rgba(255,255,255,0.10)',
        active: 'rgba(255,255,255,0.16)',
      },
      borderRadius: {
        xl: '12px',
        lg: '8px',
      },
      fontFamily: {
        display: ['Inter Display', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

2. Update `theme/index.ts` — add new module colors for Forge, update existing module colors to match design, keep `cn()` and `vsCodeTokens` and `safetyTierColors`, update `moduleColors`:

```typescript
export const moduleColors = {
  forge: '#F97316',
  seed: '#22C55E',
  sync: '#3B82F6',
  monitor: '#EAB308',
  compare: '#A855F7',
  dataops: '#06B6D4',
  automation: '#F43F5E',
} as const;
```

3. Update tests to match new color values.

4. Run `pnpm validate` in webview package.

5. Commit: `feat(design): add Forge design tokens and dark-mode surface scale`

---

## Task 2: Animation System — MotionProvider & Presets

**Files:**
- Create: `packages/webview/src/motion/presets.ts`
- Create: `packages/webview/src/motion/presets.test.ts`
- Create: `packages/webview/src/motion/MotionProvider.tsx`
- Create: `packages/webview/src/motion/MotionProvider.test.tsx`

**What to do:**

1. Create `motion/presets.ts` with all animation presets from the design doc:

```typescript
import type { Variants, Transition } from 'framer-motion';

export const SPRING: Transition = { type: 'spring', stiffness: 300, damping: 30 };

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: SPRING },
};

export const slideUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: SPRING },
};

export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};

export const cardHover = { whileHover: { scale: 1.01, y: -2 }, transition: SPRING };
export const buttonPress = { whileTap: { scale: 0.97 } };

export function pageTransition(direction: 1 | -1): Variants {
  return {
    enter: { opacity: 0, x: direction * 20 },
    center: { opacity: 1, x: 0, transition: SPRING },
    exit: { opacity: 0, x: direction * -20, transition: { duration: 0.15 } },
  };
}
```

2. Create `MotionProvider.tsx` — wraps app with `LazyMotion` for reduced bundle:

```typescript
import { LazyMotion, domAnimation } from 'framer-motion';

export const MotionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <LazyMotion features={domAnimation} strict>
    {children}
  </LazyMotion>
);
```

3. Tests: verify presets export correct shapes, MotionProvider renders children.

4. Commit: `feat(motion): add animation presets and MotionProvider`

---

## Task 3: Glassmorphism Utility Class

**Files:**
- Create: `packages/webview/src/styles/glass.css`
- Modify: `packages/webview/src/main.tsx` (import the CSS)

**What to do:**

1. Create `glass.css`:

```css
.glass-overlay {
  backdrop-filter: blur(16px) saturate(150%);
  background: rgba(10, 10, 15, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
```

2. Import in `main.tsx` after Tailwind imports.

3. Commit: `feat(styles): add glassmorphism utility class`

---

## Task 4: BentoGrid Component

**Files:**
- Create: `packages/webview/src/components/ui/BentoGrid.tsx`
- Create: `packages/webview/src/components/ui/BentoGrid.test.tsx`

**What to do:**

1. Create `BentoGrid` — responsive grid container + `BentoTile` card wrapper:

```typescript
export interface BentoGridProps {
  columns?: 1 | 2 | 3 | 4;
  gap?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
  className?: string;
}

export interface BentoTileProps {
  colSpan?: 1 | 2 | 3 | 4;
  rowSpan?: 1 | 2;
  children: React.ReactNode;
  className?: string;
}
```

- BentoGrid: CSS grid with responsive columns (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-{columns}`).
- BentoTile: `bg-surface-1 rounded-xl border border-subtle` + Framer Motion `cardHover` preset. `col-span-{colSpan}`.

2. Tests: renders children, applies correct grid classes, tile hover animation.

3. Commit: `feat(ui): add BentoGrid and BentoTile components`

---

## Task 5: MetricCard Component (Enhance existing KPICard)

**Files:**
- Modify: `packages/webview/src/components/ui/KPICard.tsx`
- Modify: `packages/webview/src/components/ui/KPICard.test.tsx`

**What to do:**

1. Read existing `KPICard.tsx` to understand current implementation.

2. Enhance with: module accent color prop, Framer Motion `slideUp` entrance, trend arrow icon (Lucide `TrendingUp`/`TrendingDown`/`Minus`), optional `Sparkline` integration, `tabular-nums` on value.

3. Ensure it uses new design tokens (`bg-surface-1`, `rounded-xl`, `border-subtle`).

4. Update tests.

5. Commit: `feat(ui): enhance KPICard with design system tokens and animations`

---

## Task 6: Generic Wizard Component (Refactoring: eliminate duplication)

**Files:**
- Create: `packages/webview/src/components/ui/Wizard.tsx`
- Create: `packages/webview/src/components/ui/Wizard.test.tsx`
- Modify: `packages/webview/src/pages/Seed/SeedWizard.tsx` (thin wrapper)
- Modify: `packages/webview/src/pages/Seed/SeedWizard.test.tsx`
- Modify: `packages/webview/src/pages/Sync/SyncWizard.tsx` (thin wrapper)
- Modify: `packages/webview/src/pages/Sync/SyncWizard.test.tsx`

**What to do:**

1. Create generic `Wizard` component from the design doc:

```typescript
export interface WizardStep {
  id: string;
  labelKey: string;
  descriptionKey?: string;
}

export interface WizardProps {
  steps: WizardStep[];
  currentStep: number;
  onStepChange: (step: number) => void;
  children: React.ReactNode;
  canGoNext?: boolean;
  canGoBack?: boolean;
  onFinish?: () => void;
  isFinished?: boolean;
  testIdPrefix?: string;
  className?: string;
}
```

- **Vertical sidebar step navigator** (left side) instead of horizontal top stepper.
- **AnimatePresence** with `pageTransition` for step content transitions.
- Steps: checkmark when completed, accent color when current, muted when future.
- Visited steps are clickable.

2. Refactor `SeedWizard.tsx` to be a thin wrapper:

```typescript
export const SeedWizard: React.FC<SeedWizardProps> = (props) => (
  <Wizard {...props} testIdPrefix="seed" />
);
```

3. Same for `SyncWizard.tsx` with `testIdPrefix="sync"`.

4. Update all tests to use the new component. Ensure existing test IDs still work via `testIdPrefix`.

5. Commit: `refactor(ui): extract generic Wizard, eliminate SeedWizard/SyncWizard duplication`

---

## Task 7: SplitView Component

**Files:**
- Create: `packages/webview/src/components/ui/SplitView.tsx`
- Create: `packages/webview/src/components/ui/SplitView.test.tsx`

**What to do:**

1. Create `SplitView` — master/detail layout:

```typescript
export interface SplitViewProps {
  left: React.ReactNode;
  right: React.ReactNode;
  ratio?: '50/50' | '60/40' | '70/30';
  rightCollapsed?: boolean;
  onToggleRight?: () => void;
  className?: string;
}
```

- Flexbox layout with configurable ratio.
- Right panel can collapse with animation (Framer Motion width transition).
- Collapse button icon (Lucide `PanelRightClose`/`PanelRightOpen`).

2. Tests: renders both panels, collapse toggles right panel, correct ratio classes.

3. Commit: `feat(ui): add SplitView master/detail component`

---

## Task 8: LogStream Component

**Files:**
- Create: `packages/webview/src/components/ui/LogStream.tsx`
- Create: `packages/webview/src/components/ui/LogStream.test.tsx`

**What to do:**

1. Create `LogStream` — real-time log console:

```typescript
export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

export interface LogStreamProps {
  entries: LogEntry[];
  filter?: 'all' | 'error' | 'warn';
  maxEntries?: number;    // default 500
  autoScroll?: boolean;   // default true
  className?: string;
}
```

- JetBrains Mono font, color by level (info=text-secondary, warn=monitor, error=red).
- Auto-scroll to bottom on new entries (via `useRef` + `scrollIntoView`).
- Filter tabs: All / Errors / Warnings.
- Timestamps in `HH:mm:ss` format.

2. Tests: renders entries, filters by level, auto-scrolls, respects maxEntries buffer.

3. Commit: `feat(ui): add LogStream real-time log component`

---

## Task 9: ConfirmDialog Enhancement

**Files:**
- Modify: `packages/webview/src/components/ui/DangerConfirm.tsx`
- Modify: `packages/webview/src/components/ui/DangerConfirm.test.tsx`

**What to do:**

1. Read existing `DangerConfirm.tsx`.

2. Enhance with:
   - Focus trap (use Radix Dialog `<Dialog.Portal>` + `<Dialog.Overlay>` + `<Dialog.Content>`)
   - Glassmorphism overlay (`glass-overlay` class)
   - Framer Motion entrance animation (`fadeIn` + `slideUp`)
   - `variant` prop: `'danger' | 'warning' | 'info'`
   - Keyboard: Esc to cancel, Enter to confirm

3. Update tests: verify focus trap, keyboard handling, animation.

4. Commit: `feat(ui): enhance ConfirmDialog with focus trap and animations`

---

## Task 10: Command Palette Redesign (cmdk)

**Files:**
- Modify: `packages/webview/src/components/CommandPalette/CommandPalette.tsx`
- Modify: `packages/webview/src/components/CommandPalette/CommandPalette.test.tsx`
- Create: `packages/webview/src/stores/useCommandStore.ts`
- Create: `packages/webview/src/stores/useCommandStore.test.ts`

**What to do:**

1. Read existing `CommandPalette.tsx` to understand current implementation.

2. Create `useCommandStore` — Zustand store for command registry:

```typescript
interface CommandItem {
  id: string;
  label: string;
  group: 'actions' | 'orgs' | 'recent' | 'navigate';
  icon?: string;
  action: () => void;
  keywords?: string[];
}

interface CommandState {
  open: boolean;
  items: CommandItem[];
  setOpen: (open: boolean) => void;
  registerItems: (items: CommandItem[]) => void;
  removeItems: (ids: string[]) => void;
}
```

3. Rewrite `CommandPalette.tsx` using `cmdk`:

```typescript
import { Command } from 'cmdk';
```

- Glassmorphism overlay (`glass-overlay`)
- Groups: Quick Actions (Forge, New Seed, New Sync, Compare), Orgs, Recent, Navigate
- Fuzzy search across all items
- Keyboard: `Ctrl+K` to open, Arrow keys to navigate, Enter to select, Esc to close
- Framer Motion entrance: `fadeIn` + scale from 0.95

4. Wire `Ctrl+K` global listener (check if already exists in current implementation).

5. Register default navigation commands from `ALL_ROUTES`.

6. Tests: opens on Ctrl+K, fuzzy search filters, keyboard navigation, groups render.

7. Commit: `feat(ui): redesign CommandPalette with cmdk and glassmorphism`

---

## Task 11: Layout Redesign — TopBar, Sidebar, AppShell

**Files:**
- Modify: `packages/webview/src/layouts/TopBar/TopBar.tsx`
- Modify: `packages/webview/src/layouts/TopBar/TopBar.test.tsx`
- Modify: `packages/webview/src/layouts/Sidebar/Sidebar.tsx`
- Modify: `packages/webview/src/layouts/Sidebar/Sidebar.test.tsx`
- Modify: `packages/webview/src/layouts/AppShell.tsx`
- Modify: `packages/webview/src/layouts/AppShell.test.tsx`
- Modify: `packages/webview/src/layouts/StatusFooter/StatusFooter.tsx`
- Modify: `packages/webview/src/layouts/StatusFooter/StatusFooter.test.tsx`
- Create: `packages/webview/src/components/OrgSwitcher/OrgSwitcher.tsx`
- Create: `packages/webview/src/components/OrgSwitcher/OrgSwitcher.test.tsx`
- Create: `packages/webview/src/stores/useRecentOpsStore.ts`
- Create: `packages/webview/src/stores/useRecentOpsStore.test.ts`

**What to do:**

1. **OrgSwitcher** — new component: dropdown with connected orgs, safety tier badge (colored dot), online status. Uses `useOrgStore`. Changing org = `useOrgStore.setActiveOrg()` + triggers global data refresh.

2. **TopBar redesign** — per design:
   - Logo (Lucide `Flame` icon + "SandForge")
   - Search trigger button (Lucide `Search` icon + "Search... Ctrl+K") — opens CommandPalette on click
   - OrgSwitcher (new component)
   - Notification bell (Lucide `Bell` icon + badge count from `useNotificationStore`)
   - Settings gear (Lucide `Settings` icon)
   - Height: `h-12`
   - Background: `bg-surface-0` with bottom border

3. **Sidebar redesign** — per design:
   - Replace emoji Unicode icons with Lucide React icons (`Flame`, `Sprout`, `RefreshCw`, `Activity`, `GitCompare`, `Shield`, `Zap`, `Rocket`, `Bot`, `BarChart3`, `Settings`, `HelpCircle`)
   - **Forge hero section** at top: visually distinct with `bg-forge/10 border-forge/20` background, separated by dividers
   - Module section: Lucide icons, labels, badge counts
   - Bottom section: Reports, Settings, Help
   - Width: `w-56` expanded, `w-14` collapsed (currently `w-52`/`w-12`)
   - Collapse: `Ctrl+B` keyboard shortcut
   - **Recent Operations section**: Connect to new `useRecentOpsStore` instead of showing placeholder

4. **useRecentOpsStore** — Zustand store tracking last 10 operations:

```typescript
interface RecentOp {
  id: string;
  type: 'forge' | 'seed' | 'sync' | 'compare' | 'dataops' | 'automation';
  label: string;
  status: 'success' | 'running' | 'failed';
  timestamp: number;
  recordCount?: number;
  targetOrg?: string;
}
```

5. **AppShell** — wrap `<Router />` in `<AnimatePresence mode="wait">` for page transitions. Add `<MotionProvider>` wrapping in `App.tsx`.

6. **StatusFooter** — show active org name, API limit %, storage %, last operation time (from `useRecentOpsStore`).

7. Update all tests.

8. Commit: `feat(layout): redesign TopBar, Sidebar, AppShell with Forge design system`

---

## Task 12: Dashboard Hub — HomePage Redesign

**Files:**
- Modify: `packages/webview/src/pages/Home/HomePage.tsx`
- Modify: `packages/webview/src/pages/Home/HomePage.test.tsx`

**What to do:**

1. Read existing `HomePage.tsx`.

2. Rewrite as bento command center per design:
   - **KPI row** (4 MetricCards): Orgs connected, Active jobs, Ops (7 days), Limit warnings
   - **Forge hero card**: Large card with orange accent border, Record ID/SOQL input (Tabs: Record | SOQL | Template | AI), target sandbox selector (OrgSwitcher mini), "Start Forge" button. On submit → `navigate('forge')` with params.
   - **Sandbox Health tile**: Per-org health bars with scores. Uses `useBridgeQuery('monitor:health-summary')`.
   - **Recent Operations tile**: From `useRecentOpsStore`, clickable items.
   - **Trends tile**: Sparkline Recharts for 7-day governor limits.
   - All tiles: BentoGrid layout, Framer Motion stagger entrance.

3. Add `'forge'` to `ModuleRoute` type in `useAppStore.ts` and add to router.

4. Tests: renders KPIs, forge card, health, recent ops.

5. Commit: `feat(home): redesign HomePage as bento command center with Forge hero`

---

## Wave 1 Checkpoint

```bash
pnpm validate
git tag v3.0.0-wave1
```

---

# WAVE 2 — SMART CLONE "FORGE" (Tasks 13-22)

## Task 13: Forge Types & Shared Schema

**Files:**
- Create: `packages/shared/src/types/forge.types.ts`
- Create: `packages/shared/src/types/forge.types.test.ts`
- Modify: `packages/shared/src/types/index.ts` (re-export)

**What to do:**

1. Define all Forge-related types:

```typescript
export type ForgeInputMode = 'record' | 'soql' | 'template' | 'ai';
export type ForgeDepth = 'direct' | 'full' | 'custom';
export type ForgeNodeStatus = 'idle' | 'scanning' | 'running' | 'done' | 'error' | 'skipped';

export interface ForgeConfig {
  inputMode: ForgeInputMode;
  recordId?: string;
  soqlQuery?: string;
  templateId?: string;
  aiPrompt?: string;
  depth: ForgeDepth;
  customDepth?: number;
  sourceOrgId: string;
  targetOrgId: string;
  anonymizePII: boolean;
  skipEmpty: boolean;
  batchSize: 'auto' | number;
}

export interface ForgeGraphNode {
  objectApiName: string;
  recordCount: number;
  fieldCount: number;
  status: ForgeNodeStatus;
  progress: number;  // 0-100
  included: boolean;
  piiFields: string[];
  anonymizeFields: string[];
  errors: string[];
}

export interface ForgeGraphEdge {
  sourceObject: string;
  targetObject: string;
  relationshipName: string;
  type: 'master-detail' | 'lookup';
}

export interface ForgeGraph {
  nodes: ForgeGraphNode[];
  edges: ForgeGraphEdge[];
  totalRecords: number;
  estimatedSizeMB: number;
  estimatedDurationSeconds: number;
}

export interface ForgeExecutionResult {
  forgeId: string;
  status: 'success' | 'partial' | 'failure';
  graph: ForgeGraph;
  duration: number;
  timestamp: string;
  idRemapCount: number;
}

export interface ForgeTemplate {
  id: string;
  name: string;
  description: string;
  config: Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'>;
  objectCount: number;
  recordCount: number;
  createdAt: string;
  lastUsedAt: string;
}
```

2. Tests: Zod schemas validate, types export correctly.

3. Commit: `feat(shared): add Forge types and schemas`

---

## Task 14: Forge Store (Zustand)

**Files:**
- Create: `packages/webview/src/stores/useForgeStore.ts`
- Create: `packages/webview/src/stores/useForgeStore.test.ts`

**What to do:**

1. Create Zustand store for Forge state machine:

```typescript
interface ForgeState {
  phase: 'input' | 'discovery' | 'review' | 'execution' | 'results';
  config: ForgeConfig | null;
  graph: ForgeGraph | null;
  result: ForgeExecutionResult | null;
  templates: ForgeTemplate[];
  history: ForgeExecutionResult[];
  // Actions
  setConfig: (config: ForgeConfig) => void;
  setGraph: (graph: ForgeGraph) => void;
  setPhase: (phase: ForgeState['phase']) => void;
  updateNodeStatus: (objectName: string, status: ForgeNodeStatus, progress?: number) => void;
  toggleNodeIncluded: (objectName: string) => void;
  toggleAnonymizeField: (objectName: string, fieldName: string) => void;
  setResult: (result: ForgeExecutionResult) => void;
  reset: () => void;
}
```

2. Tests: all state transitions, node toggle, field toggle.

3. Commit: `feat(store): add useForgeStore for Smart Clone state management`

---

## Task 15: LiveGraph Component (React Flow Wrapper)

**Files:**
- Create: `packages/webview/src/components/graph/LiveGraph.tsx`
- Create: `packages/webview/src/components/graph/LiveGraph.test.tsx`
- Create: `packages/webview/src/components/graph/ProgressNode.tsx`
- Create: `packages/webview/src/components/graph/ProgressNode.test.tsx`
- Create: `packages/webview/src/components/graph/AnimatedEdge.tsx`
- Create: `packages/webview/src/components/graph/AnimatedEdge.test.tsx`

**What to do:**

1. **ProgressNode** — custom React Flow node:
   - Object name, record count, inline progress bar
   - Color states: green (included), grey (excluded), orange (PII), red (error)
   - Status icon: checkmark (done), spinner (running), clock (waiting), X (error)
   - Click handler → emits `onNodeSelect`

2. **AnimatedEdge** — custom React Flow edge:
   - Animated dash pattern for "data flow" effect
   - Color by relationship type (solid for master-detail, dashed for lookup)
   - Label with relationship name

3. **LiveGraph** — wrapper:
   - Accepts `ForgeGraph` data, converts to React Flow `nodes[]` and `edges[]`
   - Auto-layout using dagre or elk (topological sort layout)
   - Minimap, zoom controls, pan
   - `onNodeClick` callback
   - Framer Motion stagger on initial node appearance

4. Tests: renders nodes from ForgeGraph, click selects node, progress updates.

5. Commit: `feat(graph): add LiveGraph, ProgressNode, AnimatedEdge components`

---

## Task 16: Forge Page — Phase 1 (Input)

**Files:**
- Create: `packages/webview/src/pages/Forge/ForgePage.tsx`
- Create: `packages/webview/src/pages/Forge/ForgePage.test.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeInput.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeInput.test.tsx`
- Modify: `packages/webview/src/stores/useAppStore.ts` (add 'forge' route)
- Modify: `packages/webview/src/router.tsx` (add Forge route)

**What to do:**

1. Add `'forge'` to `ModuleRoute` union type and `ALL_ROUTES` array in `useAppStore.ts`.
2. Add `forge: ForgePage` to `routeComponents` in `router.tsx`.
3. Create `ForgeInput` — the 4-tab input form:
   - Tabs (Radix Tabs): Record | SOQL | Template | AI
   - Record tab: Input field for ID/URL
   - SOQL tab: Monaco editor (already installed `@monaco-editor/react`) for SOQL
   - Template tab: List of saved templates from `useForgeStore.templates`
   - AI tab: Textarea for natural language prompt
   - Depth selector: Radio group (Direct / Full tree / Custom with number input)
   - Source/Target org selectors (reuse OrgSwitcher pattern)
   - "Discover Graph" CTA button (orange, `bg-forge`)
4. Create `ForgePage` — orchestrates phases based on `useForgeStore.phase`.
5. Tests: renders input tabs, submits config, navigates to discovery phase.
6. Commit: `feat(forge): add ForgePage with 4-mode input (record/soql/template/ai)`

---

## Task 17: Forge Page — Phase 2 (Graph Discovery)

**Files:**
- Create: `packages/webview/src/pages/Forge/ForgeDiscovery.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeDiscovery.test.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeNodeDetail.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeNodeDetail.test.tsx`
- Create: `packages/webview/src/pages/Forge/MetadataDiffBanner.tsx`
- Create: `packages/webview/src/pages/Forge/MetadataDiffBanner.test.tsx`

**What to do:**

1. **ForgeDiscovery** — SplitView (60/40):
   - Left: `LiveGraph` showing discovered dependency graph
   - Right: `ForgeNodeDetail` for selected node
   - Bottom stats bar: objects, records, size, ETA
   - Options row: Anonymize PII toggle, Skip empty toggle, Batch size dropdown
   - CTA: "Execute Forge" button
   - Back button to return to input

2. **ForgeNodeDetail** — right panel showing selected object:
   - Object name + record count + field count
   - Relations list (children objects with counts)
   - PII fields detected with anonymization toggles per field
   - Anonymization preview (before/after on sample data)

3. **MetadataDiffBanner** — conditional banner:
   - Shows if metadata differences detected between source/target
   - Lists missing Custom Fields, RecordTypes, PermissionSets
   - Actions: "Sync Metadata First" or "Skip"
   - Uses `useBridgeMutation('compare:quick-diff')`

4. Tests: renders graph, selects node shows detail, toggles PII, metadata banner appears.

5. Commit: `feat(forge): add graph discovery phase with node detail and metadata diff`

---

## Task 18: Forge Page — Phase 3 (Execution)

**Files:**
- Create: `packages/webview/src/pages/Forge/ForgeExecution.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeExecution.test.tsx`

**What to do:**

1. **ForgeExecution** — SplitView (60/40):
   - Left: LiveGraph with real-time progress bars filling per node
   - Right: LogStream component with live log entries
   - Top: Global progress bar + timer + "FORGING..." status
   - Bottom: KPI row (Done/Running/Queued/Failed counters)
   - Controls: Pause/Resume/Abort buttons

2. Listen to bridge messages `forge:progress` to update node statuses in store.

3. On error: node turns red, dependent children turn orange (skipped), log shows error with AI suggestion link.

4. On complete: transition to results phase.

5. Tests: renders progress, updates nodes, handles errors, shows completion.

6. Commit: `feat(forge): add execution phase with mission control progress`

---

## Task 19: Forge Page — Phase 4 & 5 (Results + Templates)

**Files:**
- Create: `packages/webview/src/pages/Forge/ForgeResults.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeResults.test.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeTemplates.tsx`
- Create: `packages/webview/src/pages/Forge/ForgeTemplates.test.tsx`

**What to do:**

1. **ForgeResults** — summary report:
   - KPI row: Inserted, Skipped, ID Remaps, Success Rate (MetricCards)
   - Per-object results DataTable (sortable)
   - Click object row → expand with created record IDs
   - Actions: Save as Template, Copy Report (Markdown), Forge Again

2. **ForgeTemplates** — template management:
   - List of saved templates with name, object count, record count, last used
   - One-click "Forge" button per template
   - Edit button → opens config editor
   - Delete with ConfirmDialog

3. Tests: renders results, save template, forge again navigation.

4. Commit: `feat(forge): add results report and template management`

---

## Task 20: Forge Extension Backend — Orchestrator

**Files:**
- Create: `packages/extension/src/modules/forge/ForgeOrchestrator.ts`
- Create: `packages/extension/src/modules/forge/ForgeOrchestrator.test.ts`
- Create: `packages/extension/src/modules/forge/GraphDiscoveryService.ts`
- Create: `packages/extension/src/modules/forge/GraphDiscoveryService.test.ts`
- Create: `packages/extension/src/modules/forge/ForgeExecutor.ts`
- Create: `packages/extension/src/modules/forge/ForgeExecutor.test.ts`
- Create: `packages/extension/src/modules/forge/IdRemapper.ts`
- Create: `packages/extension/src/modules/forge/IdRemapper.test.ts`

**What to do:**

1. **GraphDiscoveryService** — given a record ID or SOQL results:
   - Query source org for the record's object type
   - Use `SchemaAnalyzer` to get relationships (master-detail, lookup)
   - Walk the dependency tree (BFS with depth limit)
   - Count records per object (SOQL `COUNT()`)
   - Detect PII fields using existing `PIIDetector`
   - Return `ForgeGraph`

2. **IdRemapper** — track old ID → new ID mappings:
   - After inserting parent records, remap lookup fields in child records
   - Support polymorphic lookups
   - Return remap count

3. **ForgeExecutor** — execute the forge plan:
   - Topological sort of graph nodes
   - Insert records in order (using existing `BulkApiManager` or `CompositeApiManager`)
   - Emit progress events per object
   - Handle errors per object (skip dependents)
   - Use existing `SmartAnonymizer` for PII if enabled

4. **ForgeOrchestrator** — coordinates the full flow:
   - Uses DI pattern (interface for deps)
   - Extends `TypedEventEmitter` (refactoring item: use existing emitter)
   - Phases: discover → execute → report

5. Tests for each service with mocked dependencies.

6. Commit: `feat(forge): add ForgeOrchestrator, GraphDiscovery, ForgeExecutor, IdRemapper`

---

## Task 21: Forge Message Handlers

**Files:**
- Create: `packages/extension/src/bridge/handlers/ForgeHandler.ts`
- Create: `packages/extension/src/bridge/handlers/ForgeHandler.test.ts`
- Modify: `packages/extension/src/bridge/ExtensionHandlers.ts` (register forge routes)

**What to do:**

1. Create `ForgeHandler` — domain handler for forge messages:
   - `forge:discover` → calls GraphDiscoveryService, returns ForgeGraph
   - `forge:execute` → calls ForgeExecutor, streams progress events
   - `forge:pause` / `forge:resume` / `forge:abort` → control execution
   - `forge:templates:list` / `forge:templates:save` / `forge:templates:delete` → template CRUD
   - `forge:history:list` → return recent forge operations

2. This is part of the P0 refactoring: instead of adding more methods to the 2,696-line ExtensionHandlers, create a separate handler class. Register its routes in `ExtensionHandlers.registerAll()`.

3. Tests with mocked orchestrator.

4. Commit: `feat(forge): add ForgeHandler for webview-extension bridge`

---

## Task 22: Side Panel Mini

**Files:**
- Create: `packages/webview/src/SidePanel.tsx`
- Create: `packages/webview/src/SidePanel.test.tsx`
- Modify: `packages/webview/src/main.tsx` (detect panel vs full mode)
- Modify: `packages/extension/src/providers/SidebarProvider.ts` (serve SidePanel)

**What to do:**

1. Read existing `SidebarProvider.ts` to understand current webview sidebar setup.

2. Create `SidePanel.tsx` — minimal persistent sidebar:
   - Org badge (active org + health %)
   - Quick metrics (API %, Storage %)
   - 3 Quick Action buttons: Forge, Monitor, Quick Sync
   - Last Operation (from `useRecentOpsStore`)
   - Running operation progress bar (if any)
   - "Open Full UI" link → posts message to open WebviewPanel

3. Modify `main.tsx` to detect if running as side panel (via URL param or env) and render `SidePanel` instead of full `App`.

4. Tests: renders org badge, quick actions, running progress.

5. Commit: `feat(sidepanel): add mini side panel for persistent VSCode sidebar`

---

## Wave 2 Checkpoint

```bash
pnpm validate
git tag v3.0.0-wave2
```

---

# WAVE 3 — MODULE OVERHAUL (Tasks 23-28)

## Task 23: Monitor Page — Bento Command Center

**Files:**
- Modify: `packages/webview/src/pages/Monitor/MonitorPage.tsx`
- Modify: `packages/webview/src/pages/Monitor/MonitorPage.test.tsx`
- Create: `packages/webview/src/pages/Monitor/HealthGauge.tsx`
- Create: `packages/webview/src/pages/Monitor/HealthGauge.test.tsx`
- Create: `packages/webview/src/pages/Monitor/TrendChart.tsx`
- Create: `packages/webview/src/pages/Monitor/TrendChart.test.tsx`
- Create: `packages/webview/src/pages/Monitor/PredictionsTile.tsx`
- Create: `packages/webview/src/pages/Monitor/PredictionsTile.test.tsx`

**What to do:**

1. Decompose 671-line MonitorPage into subcomponents:
   - **HealthGauge**: Animated SVG arc gauge (0-100%, color gradient green→amber→red)
   - **TrendChart**: Recharts AreaChart with period selector (24h/7d/30d), hover tooltips
   - **PredictionsTile**: Time-to-limit estimates + AI recommendations
   - Keep existing `LimitsPanel`, `JobsPanel`, `HealthScoreGauge` but restyle

2. Rewrite `MonitorPage` as BentoGrid layout:
   - Row 1: HealthGauge + API MetricCard + Storage MetricCard + Alerts tile
   - Row 2: TrendChart (colSpan=2) + Active Jobs panel (colSpan=2)
   - Row 3: All Limits table (full width, paginated)
   - Row 4: AI Anomaly Scan + Predictions tile

3. Extract hooks: `useAutoRefresh`, `useTrendTransformation`, `useMonitorLimitsColumns`.

4. Also applies refactoring: decompose `handleMonitorTrends()` sub-functions (in extension side — can be a separate sub-task).

5. Tests: renders bento layout, KPIs show data, trend chart renders.

6. Commit: `feat(monitor): redesign as bento command center with health gauge and trends`

---

## Task 24: Seed Page — 4-Step Wizard

**Files:**
- Modify: `packages/webview/src/pages/Seed/SeedPage.tsx`
- Modify: `packages/webview/src/pages/Seed/SeedPage.test.tsx`

**What to do:**

1. Rewrite SeedPage from 8 steps to 4 using the generic `<Wizard>`:
   - Step 1 (SELECT): Org selector + object multi-select with inline volume inputs + NL2SOQL optional textarea + auto PII scan (badge warnings on objects)
   - Step 2 (CONFIGURE): Collapsible field tree per object + Accordion for Advanced (batch size, relations, PII toggles)
   - Step 3 (EXECUTE): Live progress per object with progress bars
   - Step 4 (RESULTS): Summary table + Save + Export CSV + Seed Again

2. Extract state into `useSeedWizardState()` hook.

3. Use Accordion component (already exists) for progressive disclosure.

4. Tests: 4 steps navigate correctly, PII badges appear, progressive disclosure works.

5. Commit: `feat(seed): simplify wizard from 8 to 4 steps with progressive disclosure`

---

## Task 25: Sync Page — Field Mapping Canvas

**Files:**
- Create: `packages/webview/src/components/graph/FieldMapper.tsx`
- Create: `packages/webview/src/components/graph/FieldMapper.test.tsx`
- Modify: `packages/webview/src/pages/Sync/SyncPage.tsx`
- Modify: `packages/webview/src/pages/Sync/SyncPage.test.tsx`
- Modify: `packages/webview/src/pages/Sync/SankeyFlow.tsx`
- Modify: `packages/webview/src/pages/Sync/SankeyFlow.test.tsx`

**What to do:**

1. **FieldMapper** — visual field mapping component:
   - Two columns: Source fields (left) + Target fields (right)
   - SVG Bezier curves connecting mapped fields (colored by mapping type)
   - Drag from source field → drop on target field to create mapping
   - Auto-match button: matches by name + type with confidence %
   - AI suggestion badges on non-obvious matches
   - Click a connection → popover for transform config

2. **SankeyFlow** — fix to show real data:
   - Accept actual node/link data from sync config
   - Use d3-sankey layout (d3 v7 already installed)
   - Show record counts at each pipeline stage

3. Update SyncPage to use `<Wizard>` component and integrate FieldMapper + SankeyFlow with real data.

4. Tests: renders field columns, drag creates mapping, auto-match works.

5. Commit: `feat(sync): add interactive FieldMapper canvas and fix SankeyFlow`

---

## Task 26: Compare Page — Complete All Tabs

**Files:**
- Modify: `packages/webview/src/pages/Compare/ComparePage.tsx`
- Modify: `packages/webview/src/pages/Compare/ComparePage.test.tsx`
- Modify: `packages/webview/src/pages/Compare/PermissionMatrix.tsx` (implement)
- Modify: `packages/webview/src/pages/Compare/PermissionMatrix.test.tsx`
- Modify: `packages/webview/src/pages/Compare/SnapshotTimeline.tsx` (implement)
- Modify: `packages/webview/src/pages/Compare/SnapshotTimeline.test.tsx`
- Modify: `packages/webview/src/pages/Compare/DriftDashboard.tsx` (implement)
- Modify: `packages/webview/src/pages/Compare/DriftDashboard.test.tsx`
- Modify: `packages/webview/src/pages/Compare/ImpactGraph.tsx` (implement via LiveGraph)

**What to do:**

1. **Diff tab** — enhance existing DiffViewer with SplitView: tree (left) + side-by-side detail (right). Color-coded changes.

2. **PermissionMatrix** — implement: DataTable with profiles as rows, permissions as columns. Checkbox cells: green (granted in both), red (source only), blue (target only). Filterable.

3. **SnapshotTimeline** — implement: Timeline component (already exists!) showing chronological snapshots. Click any two → diff between them.

4. **DriftDashboard** — implement: Timeline of detected changes with severity badges. "Who changed what, when" format.

5. **ImpactGraph** — implement using LiveGraph: React Flow graph showing dependency chains of modified components.

6. Tests for each tab with mock data.

7. Commit: `feat(compare): implement all 6 tabs (permissions, drift, impact, snapshots, deploy)`

---

## Task 27: Bridge Hook Refactoring

**Files:**
- Create: `packages/webview/src/hooks/useMessageResponse.ts`
- Create: `packages/webview/src/hooks/useMessageResponse.test.ts`
- Modify: `packages/webview/src/hooks/useBridgeQuery.ts`
- Modify: `packages/webview/src/hooks/useBridgeQuery.test.ts`
- Modify: `packages/webview/src/hooks/useBridgeMutation.ts`
- Modify: `packages/webview/src/hooks/useBridgeMutation.test.ts`

**What to do:**

1. Extract shared response-handling logic (timeout, listener, cleanup) into `useMessageResponse` hook.

2. Refactor `useBridgeQuery` and `useBridgeMutation` to use it internally. Keep public API unchanged.

3. Tests: both hooks still work identically, shared hook handles timeout/listener correctly.

4. Commit: `refactor(hooks): extract shared useMessageResponse, eliminate bridge hook duplication`

---

## Task 28: Extension Refactoring — ExtensionHandlers Split + Shared Utils

**Files:**
- Create: `packages/extension/src/bridge/handlers/MonitorHandler.ts`
- Create: `packages/extension/src/bridge/handlers/MonitorHandler.test.ts`
- Create: `packages/extension/src/bridge/handlers/SeedHandler.ts`
- Create: `packages/extension/src/bridge/handlers/SyncHandler.ts`
- Create: `packages/extension/src/bridge/ServiceFactory.ts`
- Create: `packages/extension/src/bridge/ServiceFactory.test.ts`
- Create: `packages/shared/src/utils/execution-result.ts`
- Create: `packages/shared/src/utils/execution-result.test.ts`
- Modify: `packages/extension/src/bridge/ExtensionHandlers.ts` (thin dispatcher)
- Modify: `packages/extension/src/modules/monitor/MonitorOrchestrator.ts` (use TypedEventEmitter)
- Modify: `packages/extension/src/modules/autopilot/AutopilotOrchestrator.ts` (use TypedEventEmitter)
- Modify: `packages/extension/src/modules/seed/FieldMapper.ts` (Strategy pattern)

**What to do:**

This task bundles the P0-P2 technical refactoring items:

1. **ServiceFactory** — centralized dependency wiring for all orchestrators.

2. **Domain handlers** — extract Monitor, Seed, Sync handler logic from ExtensionHandlers into separate handler classes. ExtensionHandlers becomes a thin dispatcher (~200 lines).

3. **execution-result.ts** — shared `determineExecutionStatus()` + `aggregateResults()`. Update SyncOrchestrator and SeedOrchestrator to use them.

4. **TypedEventEmitter adoption** — refactor AutopilotOrchestrator and MonitorOrchestrator to extend TypedEventEmitter instead of reimplementing.

5. **FieldMapper Strategy** — replace `generateValue()` switch with strategy registry.

6. Tests for each extracted handler and utility.

7. Commit: `refactor(extension): split ExtensionHandlers, adopt TypedEventEmitter, Strategy pattern`

---

## Wave 3 Checkpoint

```bash
pnpm validate
git tag v3.0.0-wave3
```

---

# WAVE 4 — POLISH & POWER (Tasks 29-34)

## Task 29: DataOps / Automation / Reports Visual Lift

**Files:**
- Modify: `packages/webview/src/pages/DataOps/DataOpsPage.tsx` + subcomponents
- Modify: `packages/webview/src/pages/Automation/AutomationPage.tsx` + subcomponents
- Modify: `packages/webview/src/pages/Reports/ReportsPage.tsx` + subcomponents

**What to do:**

1. **DataOps** — apply BentoGrid layout, add Recharts quality dashboard, anonymize preview panel.
2. **Automation** — enhance PipelineCanvas with LiveGraph, add drag & drop from StepPalette.
3. **Reports** — BentoGrid analytics dashboard, enhance LineageGraph with LiveGraph component.
4. Apply design system tokens (surface colors, rounded-xl, animations) to all three.
5. Update tests.
6. Commit: `feat(modules): visual lift for DataOps, Automation, Reports`

---

## Task 30: Skeleton Loading States Everywhere

**Files:**
- Modify: All page components that fetch data

**What to do:**

1. Ensure every page using `useBridgeQuery` shows `<Skeleton>` components during loading.
2. Use `AnimatePresence` to crossfade from skeleton → data.
3. Skeleton shapes match the exact layout of loaded content.
4. Pages to update: HomePage, MonitorPage, SeedPage, SyncPage, ComparePage, DataOpsPage, ForgePage.
5. Commit: `feat(ui): add consistent skeleton loading states across all pages`

---

## Task 31: Accessibility Pass

**Files:**
- Modify: `packages/webview/src/components/ui/Dialog.tsx` (focus trap)
- Modify: `packages/webview/src/components/ui/DataTable.tsx` (keyboard nav)
- Modify: `packages/webview/src/components/ui/FloatingToasts.tsx` (aria-live)
- Modify: `packages/webview/src/components/ui/Spinner.tsx` (aria-live)
- Modify: `packages/webview/src/layouts/AppShell.tsx` (SkipLink integration)

**What to do:**

1. **Dialog** — ensure Radix Dialog's focus trap is properly configured.
2. **DataTable** — add keyboard navigation: Arrow keys for rows, Tab for columns, Enter to select.
3. **FloatingToasts** — add `aria-live="polite"` region.
4. **Spinner** — wrap in `aria-live="polite"` region.
5. **AppShell** — add `<SkipLink>` component (already exists) before Sidebar.
6. **LiveGraph** — ensure nodes are tab-focusable with aria-labels.
7. Update tests to verify keyboard interactions.
8. Commit: `feat(a11y): complete accessibility pass — focus traps, keyboard nav, aria-live`

---

## Task 32: Micro-Interactions & Glassmorphism

**Files:**
- Modify: `packages/webview/src/components/ui/Button.tsx` (press feedback)
- Modify: `packages/webview/src/components/ui/Card.tsx` (hover lift)
- Modify: `packages/webview/src/layouts/NotificationCenter/NotificationCenter.tsx` (glassmorphism)
- Modify: `packages/webview/src/router.tsx` (page transitions)

**What to do:**

1. **Button** — add Framer Motion `whileTap={{ scale: 0.97 }}` to all buttons.
2. **Card** — add Framer Motion `whileHover={{ scale: 1.01, y: -2 }}` to all cards.
3. **NotificationCenter** — apply `glass-overlay` class to backdrop.
4. **Router** — wrap `<Component />` in `<motion.div>` with `pageTransition` variants + `AnimatePresence`.
5. **List stagger** — add `staggerContainer` to DataTable rows, BentoGrid tiles.
6. Update tests where needed.
7. Commit: `feat(polish): add micro-interactions, glassmorphism, page transitions`

---

## Task 33: Constants & Magic Numbers Cleanup

**Files:**
- Create: `packages/shared/src/constants/ai-config.ts`
- Create: `packages/shared/src/constants/ai-config.test.ts`
- Modify: `packages/extension/src/extension.ts` (use ai-config constants)
- Modify: `packages/extension/src/core/precheck/PerformanceCheck.ts` (extract thresholds)
- Modify: `packages/webview/src/stores/useSettingsStore.ts` (use shared constants)

**What to do:**

1. Extract Anthropic API constants to `ai-config.ts`.
2. Extract PerformanceCheck magic numbers to named config object.
3. Standardize timeout values across webview and extension.
4. Fix numeric formatting inconsistency (`30000` → `30_000`).
5. Commit: `refactor: extract magic numbers and hardcoded values to named constants`

---

## Task 34: Final i18n Keys + Remaining Refactoring

**Files:**
- Modify: `packages/webview/src/i18n/locales/en.json`
- Modify: `packages/webview/src/i18n/locales/fr.json`
- Modify: Other locale files as needed

**What to do:**

1. Add all new i18n keys for Forge module, redesigned Home, new components.
2. Ensure no hardcoded strings remain — search for missing `t()` calls.
3. Add French translations for all new keys.
4. Run `pnpm validate`.
5. Commit: `feat(i18n): add Forge and redesign i18n keys for en + fr`

---

## Wave 4 Checkpoint — Final Validation

```bash
pnpm validate
pnpm build
pnpm package
git tag v3.0.0-wave4
```

---

# Summary

| Wave | Tasks | Key Deliverables |
|------|-------|-----------------|
| **1 Foundations** | 1-12 | Design system, animations, BentoGrid, Wizard, CommandPalette, Layout redesign, Dashboard Hub |
| **2 Smart Clone** | 13-22 | Forge types, store, LiveGraph, 5 phases (input/discovery/execution/results/templates), Side Panel, Extension backend |
| **3 Module Overhaul** | 23-28 | Monitor bento, Seed 4-step, Sync FieldMapper, Compare 6 tabs, bridge refactoring, extension split |
| **4 Polish** | 29-34 | DataOps/Automation/Reports lift, skeletons, a11y, micro-interactions, constants cleanup, i18n |

**Total: 34 tasks across 4 waves.**

Each task follows the pattern: write tests → implement → validate → commit.
