# FEATURES.md — Competitive Scan for SandForge v1.3.0

**Focus:** Monitor / observability / AI features across Salesforce tooling landscape.
**Goal:** Identify what established tools do that SandForge doesn't — and where SandForge can legitimately win.

---

## Competitive Matrix (April 2026)

### 1. SF Inspector Reloaded (FREE, open source)

- **Pricing:** Free, MIT.
- **Category:** Browser extension (Chrome/Firefox).
- **Monitor-equivalent features:**
  - Debug Logs Viewer with grep-like filtering
  - Dependencies Explorer (metadata dependency graph)
  - Flow Scanner (analyzes flows for anti-patterns)
  - Limits view via REST Explorer (`/services/data/vXX.X/limits`)
- **AI features:** Agentforce-powered debug log analysis (2026 addition).
- **Gaps (where SandForge already wins):**
  - Browser-only — no VSCode integration, no ETL.
  - No historical trending / time-series.
  - No alerts / anomaly detection.
  - No multi-org dashboards.
- **Threat level to SandForge:** LOW — adjacent tool, used alongside not instead.

### 2. ORGanizer for Salesforce (Freemium)

- **Pricing:** Free with ads; paid license to remove ads (~$15/yr).
- **Category:** Browser extension.
- **Monitor-equivalent features:** Minimal — session management, quick links, describe manager.
- **AI features:** None as of April 2026.
- **Gaps:** Not a monitoring tool at all. Essentially a navigation/session helper.
- **Threat level:** NONE — different category.

### 3. Salesforce DevOps Center (FREE, native)

- **Pricing:** Free with Salesforce license.
- **Category:** Native platform capability (no managed package since 2026).
- **Monitor-equivalent features:**
  - Pipeline visualization
  - Deploy status
  - Automated quality gates pre-commit/pre-promotion (2026)
  - Agent Health Monitoring (Spring '26 GA) — uptime, latency, error rate, escalation spikes
- **AI features:** AI-generated code safety checks in quality gates.
- **Gaps (where SandForge wins):**
  - Deployment-pipeline focused, not sandbox-data focused.
  - No data seeding, no CSV/JSON sync, no compare beyond metadata.
  - No API-limits trending.
  - No VSCode-native experience.
- **Threat level:** MEDIUM — Salesforce's own push for AI features may commodify some SandForge AI bets.

### 4. Gearset ($200+/user/mo)

- **Pricing:** ~$200/user/mo; annual.
- **Category:** Cloud SaaS Salesforce DevOps.
- **Monitor-equivalent features:**
  - Metadata monitoring (daily snapshots, drift alerts)
  - Data backup / restore with PITR
  - Deployment history with rollback
  - Org Intelligence (2026 AI-powered org analysis)
  - 98% deployment success rate
- **AI features:** Org Intelligence for change impact analysis; automated test selection.
- **Gaps (where SandForge wins):**
  - Browser-based; no IDE workflow.
  - Expensive — prices out individual consultants / small teams.
  - No real-time API-limits / job monitoring dashboards (deployment-focused).
  - No in-editor "diagnose this failed bulk job" flow.
- **Threat level:** HIGH — overlap on metadata drift detection, but very different audience.

### 5. Copado (Enterprise, quote-based)

- **Pricing:** Enterprise; annual; base + add-ons (DataDeploy, testing, analytics).
- **Category:** Native Salesforce DevOps platform.
- **Monitor-equivalent features:**
  - Governance + audit trails (SOX compliance)
  - DevOps AI Assistant (guided best practices)
  - AI-powered test/code generation
  - Copado Robotic Testing (regression)
- **AI features:** Copado AI Companion — conversational assistant for release flows.
- **Gaps:** Enterprise-scale, heavy onboarding, not for individual devs or small teams.
- **Threat level:** LOW on SandForge's target audience (different segment).

### 6. Salto (Freemium → Paid)

- **Pricing:** Free tier; paid tiers for teams.
- **Category:** Configuration-as-code / NaCl language.
- **Monitor-equivalent features:**
  - Config diff across orgs (declarative diffs, not raw metadata XML)
  - Impact analysis for config changes
- **AI features:** Minimal as of 2026.
- **Gaps:** Script-heavy / declarative-config mental model. No runtime monitoring. No data tooling.
- **Threat level:** LOW — adjacent.

### 7. Salesforce Monitoring Studio / Event Monitoring (native, licensed)

- **Pricing:** Add-on license (Shield, or per-org).
- **Category:** Native event/log stream.
- **Monitor-equivalent features:**
  - Login events, API usage events, Apex execution events, report exports
  - Transaction security policies
  - Threat detection (anomaly / session hijacking)
- **AI features:** Built-in threat detection ML.
- **Gaps (where SandForge wins):**
  - Requires Shield license (expensive).
  - Raw event stream, not curated dashboards — requires building dashboards in Einstein Analytics or exporting.
  - Not developer-friendly for "what's going on in my sandbox right now?"
- **Threat level:** LOW on SandForge's sandbox-centric audience.

### 8. Elements.cloud ($$$, Freemium)

- **Pricing:** Free tier; enterprise paid tiers.
- **Category:** Metadata dictionary + documentation + analytics.
- **Monitor-equivalent features:**
  - Full org metadata dictionary with dependencies
  - Tech debt discovery / scoring
  - Process mining (actual user flow analytics)
  - Blast-radius impact analysis
- **AI features:** Conversational Org Intelligence (2026) — natural language queries over org metadata; Agentforce-aware analysis.
- **Gaps (where SandForge wins):**
  - Documentation/analytics focus; not sandbox-ETL.
  - No data seeding / sync.
  - Browser-based, not in-editor.
- **Threat level:** MEDIUM on AI-org-intelligence features (if SandForge overreaches into that space, it will lose).

---

## Table Stakes (what SandForge must match to stay competitive)

These are features that at least 3 of the above tools expose — if SandForge Monitor v2 lacks them, reviewers will notice.

1. **Historical trending of API limits** (not just current snapshot). Tools: Gearset, Copado, native Limits API.
2. **Drift detection with diff report** across a stored snapshot. Tools: Gearset, Salto, SF Inspector (manual).
3. **Failed job / deployment diagnosis** with actionable next step. Tools: Gearset, DevOps Center, SF Inspector (debug logs).
4. **Metadata dependency visualization** (which objects/fields are used where). Tools: Elements.cloud, SF Inspector Reloaded, Salto.
5. **Anomaly alerts** on key metrics (storage spike, API burn rate). Tools: Gearset Org Intelligence, SF Monitoring Studio.
6. **Export / share report** (PDF, CSV, shareable link). Tools: Gearset, Copado, Elements.cloud.
7. **Multi-org overview** — at least list + switch + compare. Tools: all of them.
8. **Status-bar / ambient presence** so the tool is felt without opening a panel. SandForge already has this — keep it.

SandForge existing coverage: 1 (partial — snapshot only), 2 (Compare module), 3 (partial — ErrorClassifier exists), 4 (SchemaAnalyzer + ObjectGraph), 5 (anomaly detection in monitor), 6 (gap), 7 (gap — org switching exists, comparison overview gap), 8 (yes).

---

## Differentiators (where SandForge can win)

These are things no competitor does well, or doesn't do in the developer's editor.

1. **"AI diagnose this failed run"** inside VSCode — model sees the actual job JSON, error classifier output, and the user's code context, and proposes a fix as a code action or workspace edit. No competitor does this in-IDE.
2. **One-command seed → validate → sync loop** — turnkey for "I just refreshed my sandbox and need it populated with my feature's data." Gearset does data deploys but not in-editor flow.
3. **Streaming execution with abort + background** (just shipped in v1.2.4) — long operations don't lock the UI. Rare among SF tooling.
4. **Local, no-cloud, no-login** — SandForge runs in VSCode with OAuth to the user's org. No SaaS account, no data-leaving-laptop compliance concerns. Gearset/Copado/Elements can't claim this.
5. **Open architecture for monitor probes** — user can add a custom metric (once we expose the extension point in a future milestone).
6. **French-first UX** — SandForge has i18n for FR, a real advantage in European consulting markets.
7. **CDC-based live monitoring** — if we subscribe to Change Data Capture streams, we can show near-real-time record-level activity. Only native Event Monitoring does this, and that's licensed.
8. **Personas / Gallery** — already shipped; none of the competitors have a curated persona concept for seed data.

---

## Anti-Features (things to NOT build in v1.3)

**Rationale:** scope control. Every item below is a rabbit hole that competitors already own.

1. **Full DevOps pipeline / CI-CD orchestration** — DevOps Center / Copado / Gearset own this. Adjacent to SandForge, not core. Stay out.
2. **Managed test generation for all Apex** — Copado AI does this; requires huge prompt/model investment. Keep AI scope to *explain / diagnose*, not *generate code for production*.
3. **Org-wide technical-debt scorecard** — Elements.cloud owns this; requires enormous metadata coverage. Maybe surface a light signal, don't claim the full product.
4. **Threat / security event monitoring** — Shield / Event Monitoring owns this, and compliance requirements make it a legal minefield.
5. **Conversational agent over full org metadata** — "Claude, why is my Account page slow?" is cool but overreach for v1.3; requires retrieval infra we don't have.
6. **Visual flow / process designer** — out of scope.
7. **Public-facing shareable dashboards / shareable links** — requires a backend. SandForge stays local-only.
8. **User-facing credential vault / SSO hub** — ORGanizer owns this; conflict of concern with VSCode's SecretStorage.
9. **Automatic refactor of user code** with AI — high blast-radius risk. AI proposes; user applies. Never auto-apply AI edits.

---

## Monitor v2 Feature Candidates (prioritized)

Based on the above scan, here's what Monitor v2 should prioritize:

| # | Feature | Source of need | Effort |
|---|---------|----------------|--------|
| 1 | Time-series storage of API limits, storage, job counts (SQLite or JSON rolling) | Table stake | M |
| 2 | Drift detection v2 with snapshot compare + diff visualization | Table stake | M |
| 3 | AI failure diagnosis for failed bulk jobs / deployments | Differentiator | L |
| 4 | CDC subscription for real-time record-level monitoring (opt-in) | Differentiator | L |
| 5 | Anomaly detection with smarter thresholds (rolling std-dev, not static %) | Competitive parity | S-M |
| 6 | Report export (PDF/CSV) | Table stake | S |
| 7 | Multi-org overview tile (consolidated health across N orgs) | Table stake | M |
| 8 | Native notifications for alerts (already partial — expand coverage) | Table stake | S |
| 9 | Governor limit predictor improvements (already exists — tune) | Existing | S |
| 10 | Cost / license-usage tracking (# sandboxes, refresh frequency) | Gap in market | M |
