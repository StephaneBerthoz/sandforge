# Requirements: v1.2.2 — Adoption-First: Sync & Seed Polish

## v1 — Must Ship

### Quick Sync (QSYNC-01..06)

- [ ] **QSYNC-01** — Quick Sync entry point: single "Quick Sync" button/card on SyncPage that bypasses the full wizard
- [ ] **QSYNC-02** — Quick Sync flow: pick source org → pick target org → multi-select objects → go (3 screens max)
- [ ] **QSYNC-03** — Auto-field mapping: when Quick Sync starts, auto-match all same-name fields (no manual mapping step)
- [ ] **QSYNC-04** — Smart defaults: direction=source_to_target, mode=full, conflict=source_wins, batchSize=200, operation=upsert (ExternalId auto-detected or fallback to insert)
- [ ] **QSYNC-05** — Quick Sync preview: before execution, show object count + estimated records + estimated API calls (1-screen summary, not full review)
- [ ] **QSYNC-06** — Quick Sync results: reuse existing Step6 results component with per-object success/fail breakdown

### Sync Wizard Polish (SWIZ-01..06)

- [ ] **SWIZ-01** — Persist sync configs to ConfigStore: save, load, list, delete named sync configurations
- [ ] **SWIZ-02** — Config auto-save: wizard state auto-saved to draft on every step change (survives page refresh)
- [ ] **SWIZ-03** — Sync templates: pre-built configs for common patterns ("Full Account hierarchy", "Opportunities + Products", "Cases + Attachments")
- [ ] **SWIZ-04** — Step reduction: merge Steps 0+1 (org selection + object selection on same screen), making wizard 6 steps instead of 7
- [ ] **SWIZ-05** — Smart object suggestions: after org selection, suggest top 5 most-used objects (Account, Contact, Opportunity, Case, Lead) with one-click add
- [ ] **SWIZ-06** — Relationship auto-detection: when user adds "Opportunity", automatically suggest adding "Account" as parent dependency with correct insertOrder

### Seed Templates (STPL-01..06)

- [ ] **STPL-01** — Pre-built template: "Sales Cloud Starter" (Account + Contact + Opportunity + OpportunityLineItem + Product2 + Pricebook2, 500+1000+2000+4000+50+1 records)
- [ ] **STPL-02** — Pre-built template: "Service Cloud Starter" (Account + Contact + Case + CaseComment + Knowledge__kav, 200+500+1000+2000+100 records)
- [ ] **STPL-03** — Pre-built template: "Minimal Demo" (Account + Contact + Opportunity, 50+100+200 records — for trailblazers / small orgs)
- [ ] **STPL-04** — Template picker UI: gallery/card view on SeedPage with template name, description, object count, total records, "Use This" button
- [ ] **STPL-05** — Template customization: after selecting a template, user can adjust record counts per object before execution (pre-filled with defaults)
- [ ] **STPL-06** — Persist seed templates to ConfigStore: save custom templates from wizard, list/load/delete saved templates

### Seed Quality (SQUAL-01..05)

- [ ] **SQUAL-01** — Locale-aware Faker: FakerFallback generates data matching user's locale (fr_FR: French names/addresses, de_DE: German, etc.)
- [ ] **SQUAL-02** — Field-value coherence: BillingCity + BillingState + BillingCountry use consistent geo data (not random mix of "Paris" + "Texas" + "Japan")
- [ ] **SQUAL-03** — Picklist-aware defaults: when Smart Suggest runs, picklist fields automatically use picklist_random with ALL active values (not subset)
- [ ] **SQUAL-04** — VR-aware generation: if VRPreChecker finds high-risk rules, auto-adjust field rules to satisfy them (e.g., required Status field → use valid picklist value)
- [ ] **SQUAL-05** — Realistic amounts/dates: Currency fields use ranges matching object context (Opportunity.Amount: 5K-500K, not 0.01-999999), Date fields use business-relevant ranges (CloseDate: +30 to +180 days)

### Quick Seed (QSEED-01..03)

- [ ] **QSEED-01** — 1-click seed from template: select template from gallery → select target org → execute (no field config step)
- [ ] **QSEED-02** — Quick Seed uses Smart Suggest defaults for all field rules (user never sees field config unless they choose "Customize")
- [ ] **QSEED-03** — Quick Seed progress + results: reuse existing Step7/Step8 components

### Onboarding & First-Run (ONBO-01..04)

- [ ] **ONBO-01** — Sandbox detection: when a connected org is a sandbox, show a contextual banner "Your sandbox is empty — populate it with Seed or Sync"
- [ ] **ONBO-02** — Welcome wizard Step 4 update: for sandbox orgs, suggest Seed/Sync instead of only Forge/Monitor
- [ ] **ONBO-03** — Home dashboard: add "Populate Sandbox" quick action card that links to Quick Seed template gallery
- [ ] **ONBO-04** — Empty state improvements: SyncPage and SeedPage show guided first-step cards when no configs/templates exist (not just wizard)

## v2 — Next Milestone Candidates

- [ ] Sync scheduling with cron (backend exists, UI not wired)
- [ ] Sync history / audit log (past executions with timestamps + results)
- [ ] Seed from CSV upload (backend ruleType exists, UI not built)
- [ ] Seed clone mode (copy existing records from one org to another via Seed)
- [ ] AI persona marketplace (community-shared personas for data generation)
- [ ] Sync conflict resolution UI (manual merge screen for bidirectional conflicts)
- [ ] CDC real-time sync (backend exists, frontend "Coming Soon")

## Out of Scope

- Monitor module changes (v1.2.1 just shipped)
- Forge module changes (v1.2.0 just shipped)
- New modules (Compare, DataOps, Automation polish is future milestone)
- Enterprise integrations (Slack, Datadog, PagerDuty)
- Architecture refactoring (bridge, Grappe system)
