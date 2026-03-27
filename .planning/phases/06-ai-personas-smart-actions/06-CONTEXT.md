# Phase 06: AI Personas & Smart Actions - Context

**Gathered:** 2026-03-27
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers the persona gallery UI for seed data generation, smart action recommendations on the HomePage, a "Just Do It" one-click provisioning flow, adaptive wizard behavior for AI seed, and contextual help tooltips. All features build on existing backend (AIPersonaManager, SmartSuggestions) and existing UI (SeedPage mode selector, HomePage BentoGrid).

</domain>

<decisions>
## Implementation Decisions

### Persona Gallery Placement & Flow
- Gallery lives inside the AI seed mode, but NOT as a sub-step on the crowded step 0 (which already has TemplateGallery)
- Restructure AI mode entry as 2 sub-choices: "Choose a Persona" (opens persona gallery) or "Start from Scratch" (current wizard flow)
- Persona cards: industry icon (lucide — Building2/Insurance, Heart/Healthcare, ShoppingCart/Retail, etc.), name, description, locale badge, field count
- Preview 5 sample records via popover anchored on the card (not inline expansion — avoids layout shifts in the card grid)
- Preview is pure client-side generation from field patterns (no API call)
- After picking a persona → wizard pre-fills field rules for matching fields, user can still edit
- "Create Custom" card at end of gallery grid → textarea for AI description → calls createCustomPersona() → new card appears

### Smart Action Recommender
- Conditional card displayed ABOVE the BentoGrid on HomePage (not as a BentoTile — too easy to miss in the dense grid)
- Subtle gradient background to distinguish from regular tiles; hidden when no recommendation available (no noise)
- Org signals analyzed: record counts on 5 standard objects (Account, Contact, Opportunity, Case, Lead)
  - All zero → recommend Quick Seed
  - Source populated + target empty → recommend Clone
  - Both populated but target stale (>30 days since last modified) → recommend Sync
  - Fallback → no recommendation shown
- Single recommendation with confidence score + "Why?" tooltip explaining reasoning
- Computed on HomePage mount + after any operation completes, cached 5 minutes (matches OrgInfo TTL)

### "Just Do It" Mode
- NOT a separate button — it IS the CTA of the Smart Action recommendation card ("Execute" button)
- This avoids confusion: one place, one message: "We recommend X → [Execute]"
- Confirmation step before execution: shows what will happen ("Seed 350 records using Minimal Demo into [org]") + Execute/Cancel
- Decision logic:
  - Empty sandbox (0 records on standard objects) → Quick Seed with Minimal Demo template
  - Source populated + target empty → Clone
  - Both populated but stale → Quick Sync source→target
  - Fallback → show recommendation without auto-execute
- No "Forge" branding on this button — "Forge" is the dependency graph module, using it generically causes confusion

### Adaptive Wizard
- Scope: AI seed wizard only (CSV and Clone wizards are already lean 4-step sequential flows)
- Small config (<5 objects): auto-advance past Configure Fields to Execute, but show compact summary with "Customize" link to go back. Step exists but is not forced.
- Large config (>20 objects): object grouping by category (Standard / Custom / Managed Package) with expand/collapse + search filter + bulk "Apply template to all" action
- Sync wizard unchanged (6 steps, already optimized in v1.2.2)

### Contextual Help Tooltips
- Tooltip component wrapping an (i) icon next to key labels in wizard steps and major UI elements
- Content from i18n keys (help.seed.step1, help.sync.direction, etc.)
- Dismissible per-user via localStorage (key: sf-dismissed-tooltips)
- No external "Learn more" links (docs aren't hosted externally)

### Claude's Discretion
- Industry icon mapping for all 10 personas (pick best lucide icon per industry)
- Exact gradient style for the Smart Action card (should feel "highlighted" but not garish)
- Popover positioning strategy for persona preview (auto-flip if near viewport edge)
- Exact threshold for "stale" data (30 days suggested, can adjust)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AIPersonaManager` (extension/src/modules/ai/): 10 built-in personas, createCustomPersona(), applyPersona() — full backend ready
- `SmartSuggestions` (extension/src/modules/ai/): Module-rule engine with condition functions — extend for smart action
- `TemplateGallery` (webview/src/pages/Seed/): Card grid pattern for templates — reuse layout pattern for persona gallery
- `KPICard`, `BentoGrid`, `BentoTile` (webview/src/components/ui/): HomePage layout components
- `useSeedWizardState`: Manages field configs, can receive pre-filled rules from persona application
- `QuickSeedFlow` + `useQuickSeed`: One-click seed from template — reuse for "Just Do It" seed path
- `Pagination`, `VirtualCombobox`: Already built for large list handling (Phase 01)
- `Card`, `Badge`, `Button`, `Tooltip` (Shadcn/ui): Standard UI primitives

### Established Patterns
- SeedPage mode selector: local React state (`SeedMode`), card-based selection — add persona sub-flow within AI mode
- Bridge queries: `useBridgeQuery` for org data fetching — use for record count analysis
- i18n: All text via `t('key')`, en+fr primary, 4 other locales added after
- Popover: Shadcn/ui Popover component available (used in other panels)

### Integration Points
- `SeedPage.tsx` line 117-128: AI mode card → restructure to show persona/scratch sub-choice
- `SeedPage.tsx` line 172-551: AI mode content → conditionally show PersonaGallery or existing wizard
- `HomePage.tsx` line 155: Before BentoGrid → insert SmartActionCard
- `useSeedWizardState.ts`: Add persona application method (pre-fill fieldConfigs from persona.dataPatterns)
- `messages.types.ts`: May need `org:record-counts` message type for smart action analysis
- `SeedOpsHandler.ts` or new `SmartActionHandler.ts`: Backend for record count queries

</code_context>

<specifics>
## Specific Ideas

- Persona sub-choice in AI mode should feel like a "fork" — two clear paths, not nested menus
- Smart Action card should disappear gracefully (fade) when no recommendation, not leave a blank gap
- "Just Do It" confirmation should show the org name prominently to avoid wrong-org mistakes
- Adaptive wizard "Customize" link should be subtle but visible — don't hide it

</specifics>

<deferred>
## Deferred Ideas

- Custom persona creation via chat (conversational builder) — v2 candidate per REQUIREMENTS.md
- Smart Action learning from user preferences (ML-based) — v2 candidate
- Broader smart analysis (metadata drift, limit warnings) — keep focused on seed/sync/clone for now

</deferred>

---
*Phase: 06-ai-personas-smart-actions*
*Context gathered: 2026-03-27*
