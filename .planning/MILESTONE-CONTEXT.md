---
version: v1.2.2
created: 2026-03-26
status: ready
---

# Milestone Context: v1.2.2 — Adoption-First: Sync & Seed Polish

## Goals

- **Maximize adoption** across all Salesforce personas (trailblazers, admins, devs) regardless of project size
- **Solve the universal pain point**: dev orgs / sandboxes are empty, everyone needs data
- **Sync is the primary lever**: everyone has a prod org — copying data to sandbox must be dead simple
- **Seed is the secondary lever**: generate realistic test data when prod copy isn't an option or desired
- **Polish, don't add**: improve what exists rather than building new modules

## Must-Have Features

### Sync — "Prod to Sandbox in 3 clicks"
- Quick Sync mode AND polish on existing wizard (both, not either/or)
- Quick Sync: simplified flow for the common case (pick objects → pick target → go)
- Full wizard: reduce friction, smarter steps, less overwhelming for basic use cases
- Smart defaults: auto-detect relationships, suggest field mappings, skip unnecessary config
- Better onboarding: first-run guidance for a user who just installed SandForge
- Reliability: edge cases and error handling that break trust

### Seed — "Realistic data, zero effort"
- Pre-built templates: "Sales Cloud starter", "Service Cloud demo data", etc.
- Better data realism: names, addresses, phone numbers, emails that look real (not lorem ipsum)
- 1-click seed: pick a template, pick a target org, go
- Schema-aware generation: respect validation rules, required fields, picklist values

### Cross-cutting
- First-run experience: install → connect org → useful data in sandbox within minutes
- UX polish: fewer clicks, better guidance, clearer feedback
- Performance: fast on typical volumes (100-10K records)
- Trust: clear progress, good error messages, no silent failures

## Anti-Goals

- None imposed by the user — go all out on quality, intelligence, and polish
- Self-imposed guardrails: don't break what works, don't add complexity for complexity's sake

## Constraints

- **Scope**: Solo developer, production-grade quality
- **Quality bar**: Production-grade — Marketplace publish at the end
- **Off-limits areas**: Monitor module, bridge infrastructure, Grappe system (all stable)
- **Architecture constraints**: Existing WebView React UI, jsforce v3, pnpm monorepo — all locked
- **Testing**: Every file gets a test, build stays green

## Open Questions

- What's the current state of Sync wizard UX? How many steps? Where are the friction points?
- What's the current Seed data quality? How realistic is the AI generation?
- Are there existing templates in Seed, or is it fully custom config each time?
- What validation rules / picklist handling exists in Seed today?
- How does first-run / onboarding currently work? Is there any guided experience?
