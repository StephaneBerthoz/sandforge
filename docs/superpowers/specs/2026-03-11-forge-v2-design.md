# Forge v2 — Design Specification

## Summary

Redesign the Forge module (SandForge's killer feature) into a unified, production-ready Salesforce data cloning engine. Merges Autopilot capabilities (waves, anonymization, compliance, cycle detection) into Forge. Adds a progressive Review phase, enriched graph nodes, real batching, and persistent templates.

## Architecture

### Flow

```
Input → Discovery → Review (progressive) → Execution → Results
```

5 phases managed by `useForgeStore` (Zustand). The Review phase is new — sits between Discovery and Execution.

### Backend — Autopilot Fusion into Forge

The Autopilot module has parallel implementations of features Forge needs. Instead of maintaining two systems, merge Autopilot capabilities into Forge's pipeline:

| Autopilot Service | Merge Into | Purpose |
|---|---|---|
| `SmartAnonymizer` | `ForgeExecutor` | Apply real anonymization (fake/mask/hash/nullify/redact/shuffle/preserve_format) before insert |
| `ExecutionPlanGenerator` | `ForgeOrchestrator` | Generate execution waves (parallel groups of independent objects) |
| `ComplianceEngine` | New `ForgeComplianceService` | Generate compliance reports (GDPR/CCPA/HIPAA) |
| `DependencyGraphBuilder.detectCycles()` | `GraphDiscoveryService` | Detect cycles + propose resolution strategies (two_pass/upsert_external_id/nullable_lookup) |

Existing Forge services remain the backbone:
- `ForgeOrchestrator` — orchestrates discover → plan → execute
- `ForgeExecutor` — topological execution with batching, anonymization, pause/resume
- `GraphDiscoveryService` — BFS traversal with cycle detection
- `IdRemapper` — old→new ID mapping

### Persistence

| Data | Storage | Rationale |
|---|---|---|
| Templates | `.sandforge/forge-templates.json` (workspace file) | Shareable via git, team-friendly |
| Execution History | ConfigStore (VSCode globalState) | Personal, max 50 stored, 10 displayed in Input |

### Message Types

Add typed Forge message types to `packages/shared/src/types/messages.types.ts` (request/response pairs):

| Request (WebView → Extension) | Response (Extension → WebView) | Purpose |
|---|---|---|
| `forge:discover` | `forge:discover:response` / `forge:discover:error` | Start graph discovery (existing) |
| `forge:plan:request` | `forge:plan:response` | Generate execution plan with waves |
| `forge:compliance:request` | `forge:compliance:response` | Generate compliance report |
| `forge:metadata-diff:request` | `forge:metadata-diff:response` | Compare source/target schemas |
| `forge:execute` | `forge:execute:response` / `forge:execute:error` | Start execution (existing) |
| `forge:pause` | `forge:pause:ack` | Pause execution |
| `forge:resume` | `forge:resume:ack` | Resume execution |
| `forge:abort` | `forge:abort:ack` | Abort execution |
| `forge:template:save` | `forge:template:saved` | Save template to file |
| `forge:template:delete` | `forge:template:deleted` | Delete template |
| `forge:template:list` | `forge:template:list:response` | List templates from file |
| — | `forge:progress` | Per-node progress during execution (push only) |
| — | `forge:discover:progress` | Per-node progress during discovery (push only) |

### Autopilot Coexistence

The Autopilot module and its `autopilot:*` message types are deprecated after Forge v2. Autopilot services (`SmartAnonymizer`, `ExecutionPlanGenerator`, `ComplianceEngine`, `DependencyGraphBuilder`) are consumed by new Forge services as library code. The Autopilot UI pages and orchestrator are not removed immediately but marked deprecated — no new features.

## Phase 1: Input (existing, minor changes)

No major changes. Existing 4 tabs (Record, SOQL, Template, AI) remain.

Changes:
- Template tab reads from `.sandforge/forge-templates.json` instead of in-memory array
- History section added (collapsible, shows recent 10 executions with re-run action)

## Phase 2: Discovery (existing, minor changes)

Graph visualization switch from horizontal to **vertical top-down layout** using `@dagrejs/dagre` (npm package). Integration: compute layout with Dagre after nodes are initialized, pass positions to React Flow. Use `rankdir: 'TB'` (top-to-bottom), `nodesep: 80`, `ranksep: 120`.

No other functional changes — discovery BFS, PII detection, exclusion lists all work correctly.

## Phase 3: Review (NEW — Progressive)

### Layout

Split view: graph (60% left) + tabbed panel (40% right).

### Tabs

#### Plan tab (default, always visible)
- Execution waves displayed as ordered groups
- Each wave shows: objects in parallel, estimated time, estimated API calls
- Per-object batching strategy: Auto (REST ≤200 / Bulk >200) with override dropdown
- Total estimate: records, API calls, duration

#### Anonymization tab
- Rules grouped by UI category (not per-field)
- New type `ForgeAnonymizationCategory`:
  ```typescript
  type ForgeAnonymizationCategory = 'email' | 'phone' | 'name' | 'address' | 'ssn_id' | 'financial' | 'other';
  ```
- Mapping from existing `PIICategory` (PII/PHI/PCI/SENSITIVE/NONE) to UI categories is done by `ForgeAnonymizer` based on field name patterns and Salesforce field type (e.g., `Email` field type → `email` category, field name containing `Phone` → `phone` category)
- Each category: dropdown showing all 10 `AnonymizationMethod` values (fake/mask/hash/nullify/redact/shuffle/preserve_format/truncate/age_band/generalize)
- When user changes a category method, it overrides ALL fields in that category across ALL objects
- Intelligent defaults pre-selected based on category (see Anonymization Methods table)
- Preview table: sample before/after for each category
- Badge on tab showing PII field count
- Grayed out if `anonymizePII=false` in Input config

#### Compliance tab
- Framework selector: GDPR / CCPA / HIPAA / PCI-DSS / None
- Auto-generated report when framework selected:
  - Per-object compliance status (pass/partial/fail)
  - Fields scanned vs fields anonymized
  - Overall status with checksum
- Default: None (no compliance check)

#### Metadata tab
- Schema comparison: source org vs target org
- Displays: missing fields, type mismatches, permission differences
- Each mismatch: warning level (info/warning/error)
- Non-blocking — warnings only, user can proceed regardless
- Actions per mismatch: Skip / Acknowledge

### Behavior
- Execute button always accessible — no tab blocks execution
- Tabs show badge counts (e.g., "3 PII" on Anonymization, "2 warnings" on Metadata)
- All defaults are reasonable — user can click Execute without opening any tab

## Phase 4: Execution (enhanced)

### Batching
- REST API for ≤200 records per object (Salesforce DML limit)
- Bulk API 2.0 for >200 records
- Batch size configurable per-object in Review (override auto)
- Progress shows: `batch 3/15 — 600/3,000 records`

### Pause/Resume (real)
- Yield point between each batch (not between objects)
- State preserved: current object, current batch index, remapper state
- Resume continues from exact checkpoint
- Pause button toggles to Resume, timer pauses

### Anonymization (real)
- SmartAnonymizer applied to each record before insert
- Rules from Review tab (or defaults if not configured)
- Per-category method applied to matching fields
- Anonymization happens after ID remapping, before insert

### UI Enhancements
- Log stream with filters: All / Errors / Warnings
- KPIs live: Records inserted, API calls consumed, estimated time remaining
- Per-object progress: `scanning → running (batch X/Y) → done/error`

## Phase 5: Results (enhanced)

### KPIs
Existing: Inserted, Skipped, ID Remaps, Success Rate
New additions:
- Anonymized field count: `X fields anonymized across Y records`
- Duration breakdown per wave
- API calls consumed

### Actions
- **Save Template** (functional): saves config to `.sandforge/forge-templates.json` with name, description, object count, record count
- **Copy Report**: Markdown summary to clipboard
- **Export JSON**: Full execution result as JSON file
- **Retry Failed**: Re-run only failed objects with same graph and remapper state
- **Forge Again**: Full reset back to Input

### Compliance Report
- Downloadable if framework was selected in Review
- Includes checksum for tamper detection

## Graph Visualization

### Layout
Vertical top-down tree using Dagre layout engine for automatic positioning.
- Root at top, children below
- Each level = one horizontal row
- Dagre handles spacing, edge routing, and overlap avoidance

### Enriched Node (ProgressNode v2)

```
+---------------------------+
| [x] Account          MD   |  <- include checkbox + edge type icon (MD/LK)
| 1,234 records    ~1.2 MB  |  <- record count + size estimate
| 18 fields (12 cloneable)  |  <- total vs createable
| ==================== 55%  |  <- progress bar (execution only)
| 2 PII         1 error     |  <- badges: PII count + error count
+---------------------------+
```

### Node Interactions
- Checkbox toggle: include/exclude directly on node (no panel needed)
- Click: opens detail in right panel
- Hover: tooltip with parent/child summary

### Edge Styles
- Master-detail: solid thick line
- Lookup: dashed thin line
- Label: relationship name on edge midpoint

### Execution State Rendering
- Active: pulsing orange border animation
- Done: green border + check icon
- Error: red border + error count badge
- Skipped: 40% opacity

## Anonymization Methods

Applied per PII category with intelligent defaults:

| Category | Default Method | Description |
|---|---|---|
| Email | `fake` | Realistic generated email (Faker) |
| Phone | `mask` | Partial masking: 06****678 |
| Name (First/Last) | `fake` | Realistic generated names |
| Address | `fake` | Realistic generated addresses |
| SSN/National ID | `redact` | Replace with [REDACTED] |
| Financial | `hash` | SHA-256 truncated |
| Other | `nullify` | Set to null |

User can override any category in the Review Anonymization tab. All 10 `AnonymizationMethod` values are available in the override dropdown.

## Graph Model Alignment

Forge and Autopilot have incompatible graph models. The Forge model (`ForgeGraph`) is the canonical model for v2. Autopilot services consumed as libraries must adapt to Forge types:

| Autopilot field | Forge equivalent | Action |
|---|---|---|
| `AutopilotEdge.from/to` | `ForgeGraphEdge.sourceObject/targetObject` | Adapter in ForgeAnonymizer/ForgePlanGenerator |
| `AutopilotEdge.relationshipType` (4 values) | `ForgeGraphEdge.type` (2 values) | Map `hierarchical`→`lookup`, `polymorphic`→`lookup` |
| `AutopilotNode.estimatedApiCalls` | New field on `ForgeGraphNode` | Add to type |
| `AutopilotNode.elapsedMs` | Runtime-only, not persisted | Not added to type |
| `ExecutionWave` | New `ForgeWave` type | New type, not reuse |

New fields added to `ForgeGraphNode`:
```typescript
createableFieldCount: number;  // Fields that can be set on insert
estimatedSizeMB: number;       // Per-node estimate (recordCount * 0.001)
estimatedApiCalls: number;      // Estimated API calls for this object
batchStrategy: 'rest' | 'bulk' | 'auto';  // Override from Review, default 'auto'
```

New types:
```typescript
interface ForgeWave {
  order: number;
  objectApiNames: string[];
  totalRecords: number;
  estimatedDurationSeconds: number;
  estimatedApiCalls: number;
}

interface ForgePlan {
  waves: ForgeWave[];
  totalRecords: number;
  totalApiCalls: number;
  estimatedDurationSeconds: number;
  cycleResolutions: ForgeCycleResolution[];
}

interface ForgeCycleResolution {
  objects: string[];
  strategy: 'two_pass' | 'upsert_external_id' | 'nullable_lookup';
  description: string;
}
```

### Cycle Detection

During Discovery, `GraphDiscoveryService` detects cycles (objects with mutual dependencies). Cycles are:
1. Detected during BFS traversal (back-edges)
2. Stored as `ForgeCycleResolution[]` on the `ForgePlan`
3. Displayed in the Review Plan tab with strategy recommendation
4. User can override the strategy per cycle
5. `ForgeExecutor` applies the chosen strategy during execution (e.g., two-pass: insert with null lookups first, then update)

## Checkpoint & Recovery

### ForgeCheckpoint type
```typescript
interface ForgeCheckpoint {
  forgeId: string;
  config: ForgeConfig;
  graph: ForgeGraph;
  plan: ForgePlan;
  currentWaveIndex: number;
  currentObjectIndex: number;
  currentBatchIndex: number;
  remapperState: Record<string, string>;  // oldId → newId serialized
  completedObjects: string[];
  timestamp: string;
}
```

### Storage
- Stored in ConfigStore (globalState) under key `forge:checkpoint`
- Only one active checkpoint at a time (overwritten on each batch completion)
- Cleared on successful execution completion or explicit abort

### Recovery Flow
1. On extension activation, check for existing checkpoint
2. If found, send `forge:checkpoint:available` message to webview
3. User sees "Resume previous execution?" prompt in Input phase
4. If accepted, restore graph + remapper state, resume from checkpoint
5. If declined, clear checkpoint

### IdRemapper Serialization
Add `toJSON()` and `fromJSON()` methods to `IdRemapper`:
```typescript
toJSON(): Record<string, string>
static fromJSON(data: Record<string, string>): IdRemapper
```

## Error Handling

### Existing (keep)
- Parent failure cascade: children auto-skipped
- Partial failures: some records succeed, some fail
- Per-record error tracking

### New
- Retry failed objects from Results phase
- Governor limit monitoring via `Sforce-Limit-Info` headers
- Transient error retry: 3 attempts with exponential backoff (from shared constants)
- Checkpoint state: if extension crashes, can resume from last completed batch

## Files to Create/Modify

### New Files
- `packages/extension/src/modules/forge/ForgeAnonymizer.ts` — wraps SmartAnonymizer for Forge pipeline
- `packages/extension/src/modules/forge/ForgePlanGenerator.ts` — generates execution waves
- `packages/extension/src/modules/forge/ForgeComplianceService.ts` — compliance report generation
- `packages/extension/src/modules/forge/ForgeMetadataDiff.ts` — source/target schema comparison
- `packages/extension/src/modules/forge/ForgeBatchStrategy.ts` — REST vs Bulk API routing
- `packages/extension/src/modules/forge/ForgeTemplateStore.ts` — file-based template persistence
- `packages/extension/src/modules/forge/ForgeHistoryStore.ts` — globalState history persistence
- `packages/extension/src/modules/forge/ForgeHandler.ts` — message handler routing forge:* messages to services
- `packages/webview/src/pages/Forge/ForgeReview.tsx` — Review phase main component
- `packages/webview/src/pages/Forge/ReviewPlanTab.tsx` — execution plan visualization
- `packages/webview/src/pages/Forge/ReviewAnonymizationTab.tsx` — anonymization config by category
- `packages/webview/src/pages/Forge/ReviewComplianceTab.tsx` — compliance framework selection + report
- `packages/webview/src/pages/Forge/ReviewMetadataTab.tsx` — metadata diff display
- Tests for every new file

### Modified Files
- `packages/shared/src/types/forge.types.ts` — add ForgeWave, ForgePlan, AnonymizationCategory types
- `packages/shared/src/types/messages.types.ts` — add forge:plan, forge:compliance, forge:metadata-diff messages
- `packages/shared/src/schemas/forge.schema.ts` — add schemas for new types
- `packages/extension/src/modules/forge/ForgeOrchestrator.ts` — integrate plan generation, compliance
- `packages/extension/src/modules/forge/ForgeExecutor.ts` — add batching, anonymization, pause/resume checkpoints
- `packages/extension/src/extension.ts` — wire new services
- `packages/webview/src/stores/useForgeStore.ts` — add review phase state, plan, compliance report
- `packages/webview/src/pages/Forge/ForgePage.tsx` — add Review phase routing
- `packages/webview/src/pages/Forge/ForgeResults.tsx` — add Save Template, Retry Failed, Export JSON, compliance report
- `packages/webview/src/pages/Forge/ForgeExecution.tsx` — batch progress, log filters, real pause/resume
- `packages/webview/src/components/graph/ProgressNode.tsx` — enriched node with checkbox, badges, size estimate
- `packages/webview/src/components/graph/LiveGraph.tsx` — switch to Dagre vertical layout
- `packages/webview/src/pages/Forge/ForgeDiscovery.tsx` — use updated LiveGraph with vertical layout
- `packages/extension/src/modules/forge/IdRemapper.ts` — add toJSON()/fromJSON() for checkpoint serialization

### New Zod Schemas (in `forge.schema.ts`)
- `forgeAnonymizationCategorySchema`
- `forgeWaveSchema`
- `forgePlanSchema`
- `forgeCycleResolutionSchema`
- `forgeCheckpointSchema`

## Out of Scope

- AI input mode resolution (existing stub, future work)
- Template input mode resolution (existing stub, future work)
- Multi-org chaining (clone A→B then B→C)
- Scheduled/recurring forge executions
- Real-time collaboration on templates
