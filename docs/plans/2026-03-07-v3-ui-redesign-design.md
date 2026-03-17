# SandForge v3 — UI/UX Redesign Design Document

> **Date**: 2026-03-07
> **Status**: Approved
> **Approach**: Wave (4 vagues incrementales)
> **Branch**: `feat/v3-autopilot` (extends to full v3)

---

## 1. Vision

SandForge becomes the **1-click sandbox provisioning tool** for Salesforce teams.

**Killer feature — Smart Clone ("Forge")**: Point a record or write SOQL, SandForge discovers the full dependency tree, remaps IDs, anonymizes PII, syncs missing metadata, and injects everything into the target sandbox — ready to work.

**Audience**: Admins (simple, guided) + Developers (power user) via progressive disclosure.

**Aesthetic**: Supabase (data-dense, bento grids) x Figma (drag & drop, canvas) x Tesla Mission Control (real-time monitoring).

**Distribution**: Hybrid — VSCode Side Panel mini (persistent) + Full Tab WebView (complete app).

---

## 2. Design System "Forge"

### 2.1 Color Palette — Dark-Mode-First

```
Surface 0 (app background)  : #0A0A0F    -- near-black blue tint
Surface 1 (cards)            : #12121A    -- slightly elevated
Surface 2 (hover/active)     : #1C1C28    -- interactive
Surface 3 (elevated)         : #262635    -- modals, popovers
Border subtle                : rgba(255,255,255,0.06)
Border default               : rgba(255,255,255,0.10)
Border active                : rgba(255,255,255,0.16)
Text primary                 : #F2F2F2
Text secondary               : #A3A3A3
Text muted                   : #6B6B7B
```

### 2.2 Module Accent Colors

```
Forge (Smart Clone)  : #F97316  -- orange fire (signature)
Seed                 : #22C55E  -- neon green
Sync                 : #3B82F6  -- electric blue
Monitor              : #EAB308  -- amber alert
Compare              : #A855F7  -- violet diff
DataOps              : #06B6D4  -- cyan data
Automation           : #F43F5E  -- rose pipeline
```

### 2.3 Typography

```
Headings  : Inter Display, semi-bold, tracking -0.02em
Body      : Inter, regular, 13px (VSCode native size)
Mono      : JetBrains Mono (SOQL, code, IDs)
Numbers   : Inter, tabular-nums (table alignment)
```

### 2.4 Corners & Spacing

```
Cards/Panels     : rounded-xl (12px) -- bento feel
Buttons/Inputs   : rounded-lg (8px)
Badges/Tags      : rounded-full
Spacing          : 4px base (Tailwind default)
```

### 2.5 Glassmorphism (overlays only)

```css
.glass-overlay {
  backdrop-filter: blur(16px) saturate(150%);
  background: rgba(10, 10, 15, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
```

Applied to: CommandPalette, NotificationCenter, modals.

### 2.6 Animations — Framer Motion

Global spring config: `{ type: "spring", stiffness: 300, damping: 30 }`

| Pattern | Values | Duration |
|---------|--------|----------|
| Page transition | `opacity: [0,1], y: [8,0]` | 200ms |
| List stagger | `staggerChildren: 0.04` | 40ms/item |
| Card hover | `scale: 1.01, y: -2` | spring |
| Button press | `scale: 0.97` | spring |
| Skeleton to data | AnimatePresence crossfade | 150ms |
| Wizard step | slideX directional +/-300px | 250ms |

---

## 3. Layout & Navigation

### 3.1 Global Layout

```
+------------------------------------------------------------+
| TopBar (h-12): Logo | Search (cmdk) | OrgSwitcher | Bell | Gear |
+--------+-----------------------------------------------+---+
| Sidebar| Main Content (BentoGrid)                       |
| w-56   |                                                |
| or     |                                                |
| w-14   |                                                |
| (icon) |                                                |
+--------+-----------------------------------------------+---+
| StatusBar (h-6): connected org - limits - last operation    |
+------------------------------------------------------------+
```

### 3.2 TopBar

- **Search bar** (central): `Ctrl+K` opens cmdk, always visible as shortcut. Placeholder: "Search orgs, objects, records... (Ctrl+K)"
- **OrgSwitcher**: Dropdown with connected orgs, safety tier badge, online status. Switch = global data refresh.
- **Notification bell**: Badge with count, opens NotificationCenter slide-over (glass overlay).
- **Settings gear**: Quick access.

### 3.3 Sidebar

Inspired by shadcn Sidebar + Linear:

- **Hero section**: "Forge" (Smart Clone) — visually separated, accent orange background, always on top.
- **Modules**: Seed, Sync, Monitor, Compare, DataOps, Automation — Lucide icons, labels, badge counts.
- **Utilities**: Reports, Settings — bottom.
- **Collapse**: `w-56` to `w-14` (icon-only) with tooltip on hover. Shortcut `Ctrl+B`.
- **Recent Operations**: Collapsible section showing last 5 ops with status — actually populated from store.

### 3.4 Command Palette (cmdk)

`Ctrl+K` opens glassmorphism overlay:

- **Groups**: Quick Actions (Forge, New Seed, New Sync, Compare), Orgs (connected list), Recent (last 10 ops), Navigate (all modules)
- **Fuzzy search** across all: module names, org names, SF object names, recent operations.
- **Keyboard**: Arrow keys, Enter, Escape.
- **Extensible**: Each module registers its own commands.

### 3.5 Dashboard Hub (Home)

The landing page is a **command center**:

- **KPI row** (top): 4 cards — Orgs connected, Active jobs, Ops (7 days), Limit warnings. Z-pattern scanning.
- **Forge hero card** (prominent): Record ID / SOQL input + target sandbox selector + "Start Forge" button. Orange accent. The primary CTA.
- **Sandbox Health**: Per-org health bars with scores (from Governor Limits).
- **Recent Operations**: Real data from store, clickable to detail.
- **Trends**: Sparkline Recharts interactive (7-day governor limits).
- **Bento layout**: All tiles rounded-xl, Surface-1, subtle borders, hover lift.

---

## 4. Smart Clone "Forge" — Killer Feature

### 4.1 Phase 1: Input

4 input modes via tabs:

- **Record**: Paste record ID or SF URL. SandForge resolves the object + loads the tree.
- **SOQL**: Write a query. Results = root records.
- **Template**: Reuse a saved Forge config.
- **AI**: Natural language ("50 tech accounts with contacts and opportunities") via NL2SOQL + auto-graph.

Additional inputs:
- **Depth**: Direct (1 level), Full tree (infinite), Custom (N levels).
- **Source / Target org selectors** with safety tier badges.
- **CTA**: "Discover Graph" button.

### 4.2 Phase 2: Graph Discovery

React Flow interactive canvas showing the dependency graph built in real-time:

- **Nodes** = SF objects with record count. Appear with cascade animation (stagger + spring).
- **Edges** = relationships (master-detail, lookup). Animated pulsing to show data flow direction.
- **Node colors**: Green (included), Grey (excluded), Orange (PII detected), Red (error/missing).
- **Interactions**: Zoom/Pan (mouse wheel + drag), click node (detail panel), uncheck node (exclude with ref-break warning), drag to reorganize.
- **Right panel** (SplitView 60/40): Selected object detail — fields list, types, PII auto-detection with anonymization toggles, preview before/after on sample record.
- **Smart Metadata Diff banner**: If Custom Fields, RecordTypes, or PermissionSets exist in source but not target, warning banner with "Sync Metadata First" or "Skip" options.

Stats bar: `N objects - M records - ~X.X MB - ETA: Ys`
Options: Anonymize PII (toggle), Skip empty objects (toggle), Batch size (Auto dropdown).

### 4.3 Phase 3: Execution (Mission Control)

- **Live graph**: Each node's progress bar fills in real-time. Topological order (parents before children).
- **ID Remapping**: Automatic relinking of lookups to new IDs.
- **Log stream** (right panel): Scrolling, filterable (all/errors/warnings), timestamped, JetBrains Mono.
- **Status KPIs** (bottom): Done / Running / Queued / Failed — live counters.
- **Controls**: Pause / Resume / Abort.
- **Error handling**: Failed node turns red, dependent children turn orange (skipped), log shows error + AI Error Resolver suggestion.

### 4.4 Phase 4: Results

- **Summary KPIs**: Inserted, Skipped, ID Remaps, Success Rate.
- **Per-object table**: Object name, Created count, Skipped count, Status icon. Clickable for detail (created record IDs, links to sandbox).
- **Actions**: Save as Template, Copy Report (Markdown), Forge Again (same config, different target).

### 4.5 Phase 5: Templates & History

- **Templates**: Saved Forge configs (objects, depth, anonymization rules). Reusable with one click.
- **History**: Last 30 days of Forge operations with status, timestamp, record counts. Filterable.

---

## 5. Module Overhaul

### 5.1 Monitor — Bento Command Center

Transformation from 671-line flat page to bento dashboard:

- **Health gauge** (animated SVG arc) + API sparkline + Storage sparkline + Active alerts — top KPI row.
- **Governor Limits Trends**: Recharts interactive area chart, period selector (24h/7d/30d), hover tooltips.
- **Active Jobs panel**: Live progress bars + ETA per job.
- **All Limits table**: Paginated, inline progress bars, trend arrows, color-coded severity.
- **AI Anomaly Scan**: Object selector dropdown (not hardcoded), last scan timestamp, results inline.
- **Predictions tile**: Time-to-limit estimates + AI recommendations.

### 5.2 Seed — Wizard Simplified (8 to 4 steps)

| Old (8 steps) | New (4 steps) |
|---------------|---------------|
| 1. Select Org | 1. SELECT: Org + Objects + Volumes (inline) + NL2SOQL optional |
| 2. Select Objects | |
| 3. Configure Fields | 2. CONFIGURE: Fields (collapsible tree) + Advanced accordion (batch, relations, PII) |
| 4. PII Scan | (PII auto-scanned at step 1, shown as inline badges) |
| 5. Set Volumes | (merged into step 1) |
| 6. Review Plan | (removed — step 2 IS the review) |
| 7. Execute | 3. EXECUTE: Live progress per object |
| 8. Results | 4. RESULTS: Summary + Save + Export CSV + Seed Again |

Progressive disclosure: Advanced options in accordions, closed by default.
Sidebar step navigator (vertical) replaces horizontal stepper.
Framer Motion slideX transitions between steps.

### 5.3 Sync — Field Mapping Canvas

- **FieldMapper component**: Source fields (left) + Target fields (right) + Bezier curve connections via drag & drop.
- **Auto-match**: Intelligent matching by name + type with confidence indicators.
- **AI suggestions**: For non-obvious mappings, inline suggestions with Apply/Reject.
- **Transform rules**: Click a connection to configure transformation (type conversion, value mapping, concatenation).
- **Sankey diagram** (d3-sankey): Data flow visualization showing volumes at each pipeline stage (Source Records -> Filter -> Transform -> Target).
- Sync wizard steps remain but with the new generic `<Wizard>` component.

### 5.4 Compare — Gearset-style Diff Viewer

All 6 tabs become functional:

- **Diff**: Tree view (left) + side-by-side detail (right). Color-coded (green=added, red=removed, yellow=modified). Visual rendering for Flows/Layouts + raw XML diff toggle.
- **Permissions**: Matrix — profiles/permission sets (rows) x permissions (columns). Checkbox-style cells, color-coded, filterable by profile or permission type.
- **Drift**: Timeline of detected changes between snapshots. "Who changed what, when."
- **Impact**: React Flow graph showing dependencies of modified components. "If I deploy this, what's affected?"
- **Snapshots**: Chronological timeline of state captures. Diff between any pair.
- **Deploy**: Select items to deploy + pre-deploy scan (severity: critical/warning/info) + rollback plan. Inline with "Sync to Target" action.

Risk score card visible across all tabs.

### 5.5 Other Modules (Quick Lift)

**DataOps**:
- Quality dashboard with Recharts (completeness, duplicate rate, format compliance).
- Anonymize panel with live before/after preview (5 sample records).
- Backup/Restore with visual timeline of snapshots.

**Automation**:
- Pipeline Canvas: React Flow with drag & drop from step palette. Step types: Seed, Sync, Compare, DataOps, Custom SOQL, Wait, Condition.
- Scheduler: Interactive calendar view.
- History: Timeline of runs with status.

**Reports**:
- Analytics Dashboard: Bento grid of Recharts (executions/day, durations, success rates).
- Lineage Graph: React Flow interactive (data flow between orgs).
- Audit Trail: Paginated DataTable with advanced filters.

---

## 6. Shared Components (New)

### 6.1 Layout Components

| Component | Usage |
|-----------|-------|
| `<BentoGrid>` | Responsive tile layout (1-4 cols), rounded-xl, hover lift |
| `<SplitView>` | Master/detail layout (60/40), right panel collapsible |
| `<Wizard>` | Generic wizard replacing SeedWizard + SyncWizard. Sidebar step nav, slideX transitions |

### 6.2 Data Display

| Component | Usage |
|-----------|-------|
| `<MetricCard>` | KPI card with sparkline, trend arrow, icon, color |
| `<ProgressNode>` | React Flow node with inline progress bar. States: idle/running/done/error/skipped |
| `<LogStream>` | Real-time log console (monospace, filterable, auto-scroll, 500-line buffer, exportable) |
| `<FieldMapper>` | Drag & drop field mapping canvas with Bezier curves and AI suggestions |

### 6.3 Interaction

| Component | Usage |
|-----------|-------|
| `<CommandPalette>` | cmdk wrapper. Ctrl+K. Fuzzy search, groups, keyboard nav |
| `<ConfirmDialog>` | Missing currently. For destructive actions. Focus trap + Esc |
| `<LiveGraph>` | React Flow wrapper. Used by: Forge, Compare Impact, Automation Pipeline, Reports Lineage |

### 6.4 Animation System

`MotionProvider` global + `motion/presets.ts` with reusable animation configs:
`fadeIn`, `slideUp`, `cardHover`, `buttonPress`, `stagger`, `pageTransition`.

`AnimatePresence` in router for page transitions.

---

## 7. Side Panel Mini (VSCode Sidebar)

Persistent in VSCode sidebar, visible while coding:

- **Org badge**: Active org with health percentage.
- **Quick metrics**: API % and Storage % from Monitor.
- **Quick Actions**: 3 buttons — Forge, Monitor, Quick Sync. Click opens full tab on correct module.
- **Last Operation**: Most recent op with status and relative time. Clickable.
- **Running**: If an operation is in progress, shows live progress bar.
- **"Open Full UI" link**: Opens the WebviewPanel editor tab.
- **Updates in real-time** via the same MessageBroker as the full tab.

---

## 8. Accessibility (Built-in)

| Component | Requirement |
|-----------|-------------|
| ConfirmDialog / Dialog | Focus trap + Esc + restore focus on close |
| DataTable | Keyboard nav (Arrow keys rows, Tab columns) |
| CommandPalette | Full keyboard (up/down/Enter/Esc), aria-live |
| FloatingToasts | `aria-live="polite"`, auto-dismiss 5s, action buttons |
| Spinner | `aria-live="polite"` region |
| LiveGraph | Nodes tab-focusable, aria-label per node |
| Wizard | `aria-current="step"`, step announce on change |
| AppShell | Skip-to-content link |

---

## 9. New Dependencies

| Library | Usage | Size |
|---------|-------|------|
| `cmdk` | Command palette | ~5KB |
| `@xyflow/react` v12 | All graphs (Forge, Impact, Pipeline, Lineage) | ~50KB |
| `d3-sankey` | Sankey diagram for Sync data flow | ~8KB |
| `framer-motion` v11 | Already installed | -- |
| `recharts` | Already installed | -- |

---

## 10. Technical Refactoring (Integrated)

The 28 refactoring items from the code analysis are integrated into the waves:

**Wave 1 (P0)**:
- Split `ExtensionHandlers.ts` (2,696 lines) into domain handlers + ServiceFactory
- Refactor orchestrators to use existing `TypedEventEmitter`
- Decompose `handleMonitorTrends()` (CC=15 to CC=3)

**Wave 2**:
- Create generic `<Wizard>` (eliminates SeedWizard/SyncWizard duplication)
- Extract `determineExecutionStatus()` + `aggregateResults()` to shared utils
- Consolidate `formatBytes`/`formatFileSize` duplication

**Wave 3**:
- Extract `useBridgeQuery`/`useBridgeMutation` shared response handler
- Fix OCP violation in `generateValue()` switch statement (Strategy pattern)
- Centralize magic numbers in `PerformanceCheck.ts`
- Extract Anthropic API constants

**Wave 4**:
- ISP: Split oversized Deps interfaces
- Standardize Zustand store patterns
- Standardize retry logic via RetryStrategy
- Complete accessibility fixes

---

## 11. Wave Execution Plan

| Wave | Scope | Duration | Deliverable |
|------|-------|----------|-------------|
| **1 - Foundations** | Design system, layout, shared components, dashboard hub, P0 refactoring | 2-3 days | New look & feel, command palette, dashboard |
| **2 - Smart Clone** | Forge feature (5 phases), LiveGraph, LogStream, SplitView, templates, Side Panel Mini | 3-4 days | The killer feature end-to-end |
| **3 - Module Overhaul** | Monitor bento, Seed 4-step, Sync canvas, Compare 6 tabs | 3-4 days | All core modules modernized |
| **4 - Polish & Power** | DataOps/Automation/Reports lift, skeletons, glassmorphism, a11y, virtual scroll, micro-interactions | 2 days | Production-ready polish |

---

## 12. Success Criteria

- [ ] Smart Clone: record ID to forged sandbox in under 3 clicks
- [ ] Dashboard loads with real data (health, recent ops, trends) in under 2 seconds
- [ ] Command palette navigates to any module/org in under 1 second
- [ ] All shared components have tests
- [ ] All pages use skeleton loading states
- [ ] Accessibility: focus traps, keyboard nav, aria-live on all interactive elements
- [ ] Zero placeholder/stub components in shipped modules
- [ ] `pnpm validate` passes after each wave
