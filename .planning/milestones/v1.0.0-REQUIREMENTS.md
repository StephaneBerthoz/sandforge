# Requirements: SandForge

**Defined:** 2026-03-16
**Core Value:** Sandbox provisioning and data management must be reliable, safe, and fast — a single bad operation on a production-adjacent org can cause real damage.

## v1 Requirements

Requirements for marketplace-ready release (v3.3.0). Phases 0-9 are already validated.

### E2E Testing

- [ ] **E2E-01**: Per-module Playwright specs exist for all 8 core modules (seed, sync, monitor, compare, dataops, automation, ai, autopilot)
- [ ] **E2E-02**: Scratch org fixture setup/teardown scripts work for integration tests
- [ ] **E2E-03**: Accessibility tests pass with axe-core integration
- [ ] **E2E-04**: Mock server enables offline E2E testing without a real org
- [ ] **E2E-05**: Total E2E suite runs in under 15 minutes
- [ ] **E2E-06**: HTML report generated with failure screenshots
- [ ] **E2E-07**: GitHub Actions workflow runs E2E on push/PR

### Marketplace Publication

- [ ] **MKT-01**: Banner and at least 5 module screenshots in assets/
- [ ] **MKT-02**: Getting started guide and per-module user docs
- [ ] **MKT-03**: FAQ and troubleshooting documentation
- [ ] **MKT-04**: GitHub Actions CI workflow (typecheck + lint + test + build) on 3 OS
- [ ] **MKT-05**: GitHub Actions release workflow (bump, build, publish to Marketplace)
- [ ] **MKT-06**: Version bump script synchronizing all 3 packages
- [ ] **MKT-07**: Pre-publish check script (commands documented, when-clauses valid, clean install test)
- [ ] **MKT-08**: Extension loads in < 2s on clean VSCode
- [ ] **MKT-09**: Extension published on VS Code Marketplace

## v2 Requirements

Deferred to future releases (Phase 12+). Not in current roadmap.

### Real-time Sync

- **RT-01**: Streaming API / CDC subscription management
- **RT-02**: Bidirectional real-time sync engine with < 2s latency
- **RT-03**: Real-time conflict merge

### Collaborative Editing

- **COLLAB-01**: Multi-user session management with presence tracking
- **COLLAB-02**: Concurrent change mediation
- **COLLAB-03**: Configuration and pipeline sharing

### Advanced AI

- **AI-01**: Data profiling and schema evolution suggestions
- **AI-02**: Natural language pipeline creation
- **AI-03**: Multi-LLM support (OpenAI, Anthropic, Ollama)
- **AI-04**: Migration planning assistant

### Enterprise Integrations

- **INT-01**: Slack and Teams notifications
- **INT-02**: Jira ticket linking
- **INT-03**: Git versioning for configs
- **INT-04**: CI/CD platform connectors (Jenkins, GitHub Actions, Azure DevOps)

### Performance & Governance

- **PERF-01**: Streaming processor for 1M+ records
- **PERF-02**: Parallel SOQL query engine
- **GOV-01**: Policy engine with approval workflows
- **GOV-02**: Role-based access control
- **GOV-03**: Enterprise audit trail dashboard

## Out of Scope

| Feature | Reason |
|---------|--------|
| Standalone CLI tool | VSCode extension is the delivery mechanism |
| Multi-tenant SaaS hosting | Local extension, not a hosted service |
| Non-Salesforce CRM support | Salesforce-specific by design |
| Mobile companion app | Desktop VSCode extension only |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| E2E-01 | Phase 1 (E2E Testing) | In Progress |
| E2E-02 | Phase 1 (E2E Testing) | Pending |
| E2E-03 | Phase 1 (E2E Testing) | Pending |
| E2E-04 | Phase 1 (E2E Testing) | Pending |
| E2E-05 | Phase 1 (E2E Testing) | Pending |
| E2E-06 | Phase 1 (E2E Testing) | Pending |
| E2E-07 | Phase 1 (E2E Testing) | Pending |
| MKT-01 | Phase 2 (Marketplace) | Pending |
| MKT-02 | Phase 2 (Marketplace) | Pending |
| MKT-03 | Phase 2 (Marketplace) | Pending |
| MKT-04 | Phase 2 (Marketplace) | Pending |
| MKT-05 | Phase 2 (Marketplace) | Pending |
| MKT-06 | Phase 2 (Marketplace) | Pending |
| MKT-07 | Phase 2 (Marketplace) | Pending |
| MKT-08 | Phase 2 (Marketplace) | Pending |
| MKT-09 | Phase 2 (Marketplace) | Pending |

**Coverage:**
- v1 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0

---
*Requirements defined: 2026-03-16*
*Last updated: 2026-03-16 after learnship initialization*
