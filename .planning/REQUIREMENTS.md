# Requirements: SandForge v1.1.0

**Defined:** 2026-03-17
**Core Value:** Every module must work end-to-end with a real Salesforce org. No broken wiring, no ghost features, no confusing UX.

## v1.1 Requirements

### Bridge & Message Wiring

- [ ] **BRG-01**: BridgeProvider listens for ALL response message types sent by extension handlers (~70 types)
- [ ] **BRG-02**: Request/response correlation via correlationId for reliable message matching
- [ ] **BRG-03**: useBridgeQuery and useBridgeMutation hooks use correlationId for response matching
- [ ] **BRG-04**: Unhandled message types logged as warnings (no silent drops)

### Module Execution Fixes

- [ ] **MOD-01**: Seed wizard executes end-to-end — results displayed after generation
- [ ] **MOD-02**: Sync wizard executes end-to-end — results displayed after sync
- [ ] **MOD-03**: Forge discovery + execution — graph populates, results shown
- [ ] **MOD-04**: Autopilot graph — nodes populate, progress updates, completion shown
- [ ] **MOD-05**: Compare — comparison results populate diff viewer after execution
- [ ] **MOD-06**: Monitor — refresh data populates all panels (limits, jobs, trends, alerts)
- [ ] **MOD-07**: DataOps — backup/restore/anonymize results displayed after execution
- [ ] **MOD-08**: Automation — pipeline execution tracked step-by-step in real time

### AI Module

- [ ] **AI-01**: AI status checked on BridgeProvider mount, `aiAvailable` state accurate
- [ ] **AI-02**: Conversations persisted to ConfigStore (survive extension reload)
- [ ] **AI-03**: Clear guidance when AI is not configured (API key missing)

### UX Cleanup

- [ ] **UX-01**: Grappe removed from sidebar navigation (keep GrappeProgressPanel as execution overlay)
- [ ] **UX-02**: Notifications bell button opens NotificationCenter
- [ ] **UX-03**: StatusFooter version reads from package.json or env, not hardcoded
- [ ] **UX-04**: Auto-select first connected org when no org is selected
- [ ] **UX-05**: Empty states with guidance/CTA for every module's first-launch experience

### Ghost Feature Cleanup

- [ ] **GHO-01**: Remove or implement message types with zero handlers (audit:*, governance:*, scheduler:*, team:*, realtime:*)
- [ ] **GHO-02**: messages.types.ts contains only types that have both sender and receiver
- [ ] **GHO-03**: No dead handler code (handlers that send responses nobody listens to)

### Robustness

- [ ] **ROB-01**: Bulk API 2.0 used for operations > 200 records (Seed, Sync)
- [ ] **ROB-02**: Retry logic with exponential backoff for transient API failures (max 3 retries)
- [ ] **ROB-03**: Configurable timeout for long-running operations (describe-global on large orgs)
- [ ] **ROB-04**: Field-type validation before Sync upsert (prevent type mismatches)

### Monitor Enrichment

- [ ] **MON-01**: Competitor benchmark completed (Salesforce Inspector, ORGanizer, Org Monitor)
- [ ] **MON-02**: Feature gaps identified and top 5 implemented
- [ ] **MON-03**: Dashboard refresh UX improved (visual feedback, error states)

## v2 Requirements (Deferred)

- Real-time sync (CDC/Streaming)
- Collaborative editing / multi-user sessions
- Multi-LLM support (OpenAI, Anthropic, Ollama)
- Enterprise integrations (Slack, Teams, Jira)
- Streaming processor for 1M+ records
- Role-based access control

## Out of Scope

| Feature | Reason |
|---------|--------|
| New module creation | Stabilize existing modules first |
| Rewrite bridge architecture | Fix wiring within current architecture |
| Mobile/web companion | VSCode extension only |
| Multi-org parallel execution | Complex feature, defer to v1.2+ |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| BRG-01..04 | Phase 1 (Bridge Fix) | Done |
| MOD-01..08 | Phase 2 (Module Fixes) | Done |
| AI-01..03 | Phase 2 (Module Fixes) | Done |
| UX-01..05 | Phase 3 (UX Cleanup) | Done |
| GHO-01..03 | Phase 3 (UX Cleanup) | Done |
| ROB-01..04 | Phase 4 (Robustness) | Pending |
| MON-01..03 | Phase 5 (Monitor) | Pending |

**Coverage:**
- v1.1 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0

---
*Requirements defined: 2026-03-17*
