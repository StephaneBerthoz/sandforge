# Phase 06: AI Personas & Smart Actions — Research

## Don't Hand-Roll

### Card grid layout
TemplateGallery + TemplateCard already implement the exact pattern needed for persona cards (responsive grid, card with header/body/badge/CTA). Reuse the grid layout and card structure; just change content.

### Tooltip component
`Tooltip.tsx` exists (hover-based, text-only, VSCode themed). For contextual help (i) icons, wrap it with an InfoTooltip that adds the icon + dismissible behavior via localStorage. Don't build a new tooltip from scratch.

### Field rule pre-filling
`useSeedFieldRules` manages fieldConfigs via setState. Persona application = iterate persona.dataPatterns and call handleChangeFieldRule/handleChangeFieldConfig for each matching field. Don't create a separate "persona state" — inject into existing field config state.

### Record count queries
jsforce `conn.query("SELECT COUNT() FROM Account")` returns `{ totalSize: N }`. For 5 objects, fire 5 queries in parallel via Promise.all. Don't overthink — this is a lightweight read-only operation.

### Bridge pattern
All message handlers follow DomainHandler interface with `handles()` array and `handle(msg)` dispatcher. SmartActionAnalyzer fits naturally as a new handler or a sub-command on existing OrgHandler.

## Common Pitfalls

### Popover positioning in constrained viewports
VSCode WebView panels are narrow (~400px sidebar). Popovers that assume wide viewports will overflow. Use absolute positioning with viewport boundary detection (check if popover would exceed panel width, flip to opposite side). Keep popover width to max 300px.

### Persona field matching is partial
AIPersonaManager has 10 personas with 5-8 fields each, but a Salesforce org can have hundreds of fields. Persona application will only pre-fill matching fields — the rest keep defaults. Don't show "0 fields matched" as an error; show it as "X of Y fields configured by persona, rest use defaults".

### Record count caching
Querying record counts on 5 objects takes ~1-2s total. Without caching, every HomePage mount triggers 5 SOQL queries. Use the existing CacheManager with 5-minute TTL (matches OrgInfo TTL). Also skip queries entirely if no target org is connected.

### Smart Action should not block HomePage render
Record count analysis is async. Show the HomePage immediately with a skeleton for the SmartActionCard, then fill in when data arrives. Never delay the entire BentoGrid for recommendation computation.

### Adaptive wizard auto-advance must be reversible
If the wizard auto-skips Configure Fields for <5 objects, the user must be able to go back. Use the existing SeedWizard step navigation (setCurrentStep) — don't remove the step from the steps array, just skip past it programmatically. The step is still navigable via back button.

### localStorage dismissal keys
For contextual help tooltips, use a single localStorage key (e.g., `sf-dismissed-tooltips`) storing a JSON array of dismissed tooltip IDs. Don't create one key per tooltip — that pollutes localStorage and makes "reset all" impossible.

### i18n key namespace
Persona keys: `seed.persona.*` (gallery, cards, preview, customize)
Smart action keys: `home.smartAction.*` (recommendation, execute, reason)
Help tooltip keys: `help.*` (per-module, per-step)
