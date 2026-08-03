# SandForge v3.0 "Autopilot" - Design Document

> Date: 2026-03-07
> Status: Approved
> Author: Claude Opus 4.6 + StephaneBerthoz

## 1. Vision

**"Connect two orgs, pick your objects, click Go -- SandForge handles dependencies, anonymizes PII, respects compliance, and seeds your sandbox in minutes, not days."**

SandForge Autopilot is a zero-config, AI-driven sandbox seeding engine that automatically resolves object dependencies, detects and anonymizes sensitive data per compliance framework (GDPR/CCPA/HIPAA/PCI-DSS), and executes the transfer with a real-time interactive graph. The user can intervene at any moment (Tesla Autopilot model) but doesn't have to.

## 2. Design Choices

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| Direction | Sandbox Seeding Autopilot | Biggest gap in SF ecosystem -- no tool does zero-config seeding |
| Intelligence | Hybrid Tesla Autopilot | Full auto by default, manual override anytime |
| Anonymization | Compliance-first with AI | 4 frameworks (GDPR/CCPA/HIPAA/PCI-DSS) + AI PII detection |
| Visual | Interactive live graph | ReactFlow nodes animate in real-time during execution |

## 3. User Flow

```
Step 1: CONNECT      Step 2: SELECT       Step 3: COMPLIANCE    Step 4: EXECUTE
Source + Target org   Root objects or ALL   Framework selection   Live graph + Tesla panel
Auto-detect schema    Auto-resolve deps     AI PII scan          Pause/Skip/Override
                                            Preview rules         Compliance report
```

## 4. Architecture

### 4.1 New Module: modules/autopilot/

```
packages/extension/src/modules/autopilot/
  AutopilotOrchestrator.ts       # Entry point -- orchestrates the full flow
  SchemaScanner.ts               # Deep schema analysis (source + target)
  DependencyGraphBuilder.ts      # Full dependency graph (objects + relations)
  ExecutionPlanGenerator.ts      # Optimal plan (order, batches, estimation)
  ComplianceEngine.ts            # GDPR/CCPA/HIPAA/PCI-DSS profiles + rules engine
  SmartAnonymizer.ts             # AI contextual anonymization (cross-object coherence)
  AutopilotExecutor.ts           # Executes plan with real-time events
  AutopilotGrappeAdapter.ts      # Parallel execution via Grappe if > threshold
  RecordIdRemapper.ts            # Source -> Target ID remapping (lookups)
  *.test.ts                      # Tests for each file
```

### 4.2 Composes Existing Modules

- DependencyResolver -> object graph resolution
- SyncOrchestrator -> data extraction/insertion
- AnonymizationEngine -> anonymization execution
- PIIDetector -> AI field detection
- BatchProcessor + BulkApiManager -> performant execution
- GrappeAdapter -> parallelization if > threshold
- CheckpointManager -> crash recovery
- PreCheckEngine -> pre-execution validation
- AuditTrailEnhanced -> compliance traceability

### 4.3 Data Flow

```
SchemaScanner (source + target)
        |  DescribeResult[]
        v
DependencyGraphBuilder + Cycle breaker (Tarjan SCC)
        |  AutopilotGraph
        v
ComplianceEngine + SmartAnonymizer (PersonaRegistry)
        |  AnonymizationPlan
        v
ExecutionPlanGenerator
        |  ExecutionPlan (ordered waves)
        v
AutopilotExecutor (BatchProcessor + BulkAPI + RecordIdRemapper + Checkpoint)
        |  real-time events
        v
WebView Graph (ReactFlow)
```

## 5. Key Types

### AutopilotGraph
```typescript
interface AutopilotGraph {
  nodes: AutopilotNode[];
  edges: AutopilotEdge[];
  cycles: CycleResolution[];
  stats: GraphStats;
}
```

### AutopilotNode
```typescript
interface AutopilotNode {
  objectApiName: string;
  recordCount: number;
  estimatedApiCalls: number;
  piiFields: PIIFieldDetection[];
  anonymizationRules: AnonymizationRule[];
  status: 'pending' | 'queued' | 'extracting' | 'anonymizing' | 'loading' | 'completed' | 'failed' | 'skipped';
  progress: number;              // 0-100
  insertOrder: number;           // topological order
  level: number;                 // depth in graph (for layout)
}
```

### AutopilotEdge
```typescript
interface AutopilotEdge {
  from: string;                  // parent object
  to: string;                    // child object
  fieldApiName: string;          // the lookup field
  relationshipType: 'lookup' | 'master_detail' | 'hierarchical' | 'polymorphic';
  required: boolean;
}
```

### ExecutionPlan
```typescript
interface ExecutionPlan {
  waves: ExecutionWave[];
  totalRecords: number;
  estimatedDuration: number;
  estimatedApiCalls: number;
  complianceProfile: ComplianceProfile;
  anonymizationSummary: AnonymizationSummary;
}

interface ExecutionWave {
  order: number;
  objects: string[];             // parallelizable objects
  dependsOn: number[];           // previous waves required
}
```

### ComplianceProfile
```typescript
interface ComplianceProfile {
  framework: 'gdpr' | 'ccpa' | 'hipaa' | 'pci_dss' | 'custom';
  rules: ComplianceRule[];
  autoDetectedPII: PIIFieldDetection[];
  userOverrides: AnonymizationOverride[];
  auditRequired: boolean;
}
```

### AnonymizedPersona (cross-object coherence)
```typescript
interface AnonymizedPersona {
  sourceRecordId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  company: string;
}
```

## 6. Cycle Resolution Strategy

1. **Detection** -- DependencyGraphBuilder identifies SCCs via Tarjan's algorithm
2. **Self-referencing** (Account -> Account): Insert without lookup, update in 2nd pass
3. **Mutual** (A -> B -> A): Insert A without B lookup, insert B with A lookup, update A
4. **Complex** (A -> B -> C -> A): Decomposition into waves with upsert + external ID
5. **Visual** -- Cycles shown in orange with "cycle resolved" icon

## 7. Compliance Engine -- 4 Profiles

| Framework | Target Fields | Default Rule | Report |
|-----------|--------------|--------------|--------|
| GDPR | Name, email, phone, address, IP, DOB | fake | Art. 25, Art. 32 |
| CCPA | Personal identifiers, commercial, biometric, geolocation | fake + mask | Categories of PI |
| HIPAA | 18 Safe Harbor identifiers (name, dates, SSN, MRN, etc.) | hash + nullify dates | Safe Harbor attestation |
| PCI-DSS | PAN, CVV, expiration, magnetic strip | mask (last 4) + nullify | Requirement 3 |

### Anonymization Methods
fake, mask, hash, nullify, redact, shuffle, truncate, preserve_format, age_band, generalize

### PersonaRegistry
Generates coherent fictional personas per source record. Same persona across related objects (Contact.FirstName + Contact.Email + Account.Name). Deterministic hash ensures reproducibility.

## 8. WebView UI -- Tesla Control Panel

### Page Structure
```
pages/Autopilot/
  AutopilotPage.tsx              # Main layout (wizard + graph)
  AutopilotWizard/               # 4-step wizard
    Step1_Connect.tsx
    Step2_Objects.tsx
    Step3_Compliance.tsx
    Step4_Review.tsx
  AutopilotGraph/                # ReactFlow interactive graph
    AutopilotGraph.tsx
    ObjectNode.tsx               # Custom node with progress
    RelationEdge.tsx             # Custom edge (lookup/master-detail)
    CycleOverlay.tsx
    GraphControls.tsx
    GraphLegend.tsx
  ControlPanel/                  # Tesla-style side panel
    ControlPanel.tsx
    NodeDetail.tsx
    LiveStats.tsx
    AnonymizationPreview.tsx
    ComplianceStatus.tsx
  ComplianceReport/
    ComplianceReport.tsx
    ComplianceTimeline.tsx
```

### Node Design
- Progress bar colored by status phase
- Record count (done/total)
- Timer + API call counter
- PII lock icon if anonymized fields
- Pulse animation when active
- Shake + red glow on failure

### Edge Design
- master_detail: solid thick line (required)
- lookup: dashed line (optional)
- hierarchical: curved self-referencing
- polymorphic: diamond icon
- Active edges: animated dash stroke

### Tesla Control Panel Interactions
- Pause/Resume global execution
- Skip a node (with dependency check)
- Override anonymization rules live
- Retry failed nodes from checkpoint
- Preview 10 records (before/after anonymization)
- Zoom on cycle resolution
- Export compliance report (PDF/HTML/JSON)

### Animations
- Pulse on active nodes
- Smooth progress bar transitions (300ms ease)
- Dash animation on active edges
- Confetti on completion (Framer Motion)
- Shake on failure

## 9. Message Protocol (new types)

```
autopilot:scan-schema         # Start schema scan
autopilot:schema-result       # Scan result
autopilot:generate-plan       # Generate execution plan
autopilot:plan-ready          # Plan ready with graph
autopilot:execute             # Start execution
autopilot:node-progress       # Node progress (real-time)
autopilot:node-completed      # Node completed
autopilot:node-failed         # Node failed
autopilot:pause               # Pause (Tesla control)
autopilot:resume              # Resume
autopilot:skip-node           # Skip a node
autopilot:override-rule       # Override anonymization rule
autopilot:completed           # Plan completed
autopilot:compliance-report   # Compliance report generated
```

## 10. Bug Fixes (49 Issues)

### Critical (8)
- A1-A3: Align 3 Zod enums with automation.types.ts
- A4: Isolate listeners with TypedEventEmitter (new shared component)
- A5: try/catch JSON.parse in SecretVault.getObject
- A6: try/catch in BatchProcessor.runWorker
- A7: Fix SeedPage infinite loop (extract .mutate ref)
- A8: Fix FloatingToasts cleanup (split unmount-only)

### Moderate (26)
- Schema alignment: sync-config, seed-config, settings, grappe schemas
- Extension fixes: OrgManager.clear events, ExecutionPipeline guards, RetryStrategy jitter, RateLimiter sliding window, CircuitBreaker half-open, DependencyResolver SCCs
- WebView fixes: useKonamiCode refs, Zustand selectors, Dialog useId, useCallback stability, importSettings Zod validation, messageHelpers IDs, DataTable hover, router dead code, SoqlBuilder sanitization

### Suggestions (15)
- Utils hardening: isValidApiName, formatBytes, estimateApiCalls, truncate, isValidCron
- i18n: all hardcoded labels (6+ files)
- Architecture: I18nManager merge, NotificationCenter static counter, BulkApiManager purge
- Security: credentials postMessage documentation, typed message payloads

## 11. Refactoring: TypedEventEmitter

New shared component replacing manual listener patterns in 5+ classes:

```typescript
class TypedEventEmitter<TEventMap extends Record<string, unknown>> {
  on<K extends keyof TEventMap>(type: K, listener: (event: TEventMap[K]) => void): () => void;
  protected emit<K extends keyof TEventMap>(type: K, event: TEventMap[K]): void;
  // Built-in try/catch isolation + logger.warn
}
```

Applied to: OrgManager, NotificationCenter, ExecutionPipeline, AutopilotExecutor, BulkApiManager

## 12. Deliverables

| Component | New Files | Modified Files |
|-----------|----------|---------------|
| shared/types | 2 | 3 |
| shared/schemas | 2 | 5 |
| shared/utils | 0 | 5 |
| extension/common | 2 | 0 |
| extension/autopilot | 10 | 0 |
| extension/core fixes | 0 | 12 |
| extension/bridge | 0 | 1 |
| webview/Autopilot | ~20 | 0 |
| webview/fixes | 0 | ~15 |
| webview/i18n | 0 | 6+ |
| i18n translations | 0 | 6 |
| **Total** | **~36** | **~47** |

## 13. Version

**v3.0.0** -- Major version bump:
- Breaking: TypedEventEmitter changes event subscription API
- Breaking: Zod schema enum values aligned with types
- Feature: Autopilot module (zero-config sandbox seeding)
- Feature: ComplianceEngine (GDPR/CCPA/HIPAA/PCI-DSS)
- Feature: Interactive live graph (ReactFlow Tesla panel)
- Fix: 49 issues corrected across all packages

## 14. Testing Strategy

| Layer | Scope | Tool |
|-------|-------|------|
| Unit | Every new .ts has .test.ts | Vitest |
| Integration | AutopilotOrchestrator e2e with jsforce mocks | Vitest |
| Snapshot | React components (ObjectNode, ControlPanel, ComplianceReport) | Vitest + RTL |
| Edge cases | All C-pass cases (negatives, null, cycles, volumes) | Vitest |
| Regression | Each of 49 fixes has a test reproducing the original bug | Vitest |

### Critical test scenarios
- Graph: 0 objects, 1 object, 50+ objects
- Cycles: self-ref, mutual, complex (A->B->C->A)
- Polymorphic lookups (WhatId, WhoId)
- Standard-only org (no custom objects)
- PII scan: 0 PII fields, PII in unexpected fields
- Cross-object persona coherence
- Pause/Resume mid-execution
- Skip node with required dependents
- Checkpoint + recovery after simulated crash
