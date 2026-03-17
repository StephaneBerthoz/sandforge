# Decisions Log

Ce fichier documente toutes les decisions techniques prises pendant le developpement.

## Format

### [DATE] — Titre de la decision

**Contexte** : Pourquoi cette decision a ete necessaire
**Decision** : Ce qui a ete choisi
**Alternatives** : Ce qui a ete considere et rejete
**Consequences** : Impact de la decision

---

### 2026-02-20 — Phase 0 — Bundler pour l'extension

**Contexte** : Choix du bundler pour l'extension VSCode
**Decision** : esbuild (pas webpack)
**Alternatives** : webpack 5 (plus lent, plus de config)
**Consequences** : Build < 1s, config minimale, tree-shaking efficace

### 2026-02-20 — Phase 0 — Module resolution pour shared

**Contexte** : Le package shared utilise Node16 module resolution avec .js extensions dans les imports
**Decision** : Utiliser les extensions .js dans les imports TypeScript (requis par Node16 moduleResolution)
**Alternatives** : Passer a bundler moduleResolution (incompatible avec le build tsc direct)
**Consequences** : Les imports dans shared utilisent .js meme si les fichiers sources sont .ts

---

### 2026-02-26 — Phase A — CheckpointManager avec TTL et compression

**Contexte** : Les operations longues (seed 100K records, sync) peuvent etre interrompues par un crash ou redemarrage
**Decision** : CheckpointManager avec auto-save toutes les 30s, stockage ConfigStore, TTL 24h, compression JSON
**Alternatives** : SQLite local (trop lourd), fichier JSON direct (pas de TTL/cleanup)
**Consequences** : Recovery automatique au redemarrage, cleanup des checkpoints expires, empreinte minimale

### 2026-02-26 — Phase A — TokenRefresher avec circuit breaker

**Contexte** : Les tokens OAuth expirent et les operations longues echouent silencieusement
**Decision** : Refresh proactif 5min avant expiration, circuit breaker apres 3 echecs, EventEmitter pour token:refreshed/expired
**Alternatives** : Refresh reactif (trop tard), refresh a chaque requete (trop de calls API)
**Consequences** : Operations longues fiables, detection rapide des problemes d'auth, notification automatique

### 2026-02-26 — Phase A — OfflineManager avec queue persistee

**Contexte** : Les environnements entreprise ont des connexions instables, les operations doivent survivre
**Decision** : HealthProbe ping 30s, queue FIFO max 50 ops persistee ConfigStore, replay auto a la reconnexion
**Alternatives** : Retry simple (pas suffisant), mode offline complet (trop complexe pour v1)
**Consequences** : Mode degrade consultable, queue d'operations, indicateur visuel online/offline

### 2026-02-26 — Phase A — ConnectionPool avec health check et metriques

**Contexte** : Les connexions jsforce stagnent et les performances se degradent
**Decision** : Pool max 5 par org, recyclage 15min, idle timeout 5min, metriques latence (min/max/avg/p95/p99)
**Alternatives** : Connexion unique (bottleneck), pool illimite (resource leak)
**Consequences** : Connexions toujours fraiches, metriques pour diagnostic, retry avec backoff exponentiel

### 2026-02-26 — Phase B — NL2SOQL avec validation schema

**Contexte** : Les utilisateurs non-techniques veulent interroger Salesforce sans ecrire du SOQL
**Decision** : Traduction NL→SOQL avec validation contre le schema cache de l'org, support FR/EN, scoring de confiance
**Alternatives** : SOQL builder visuel seul (moins intuitif), requetes predefinees (pas flexible)
**Consequences** : Requetes valides generees par IA, historique sauvegardable, alternatives proposees

### 2026-02-26 — Phase B — ErrorResolver avec apprentissage

**Contexte** : Les erreurs Salesforce sont cryptiques et les utilisateurs perdent du temps
**Decision** : Analyse contextuelle des erreurs SF, suggestions classees par probabilite, auto-fix quand possible, memorisation des resolutions
**Alternatives** : Simple mapping erreur→message (pas contextuel), documentation statique (pas actionnable)
**Consequences** : Resolution plus rapide, apprentissage progressif, auto-fix pour les erreurs courantes

### 2026-02-26 — Phase B — AIPersonaManager avec 10 personas built-in

**Contexte** : Les donnees generees par le Seed doivent etre realistes et contextuellement appropriees
**Decision** : 10 personas metier pre-configurees + persona custom, influence sur noms/adresses/montants/vocabulaire
**Alternatives** : Configuration manuelle de chaque champ (tedieux), random generique (pas realiste)
**Consequences** : Donnees metier realistes en un clic, extensible via persona custom

### 2026-02-26 — Phase B — AnomalyDetector avec detection statistique

**Contexte** : Les donnees Salesforce peuvent contenir des anomalies invisibles manuellement
**Decision** : Detection multi-critere : outliers IQR, patterns temporels, incoherences, champs vides, doublons fuzzy
**Alternatives** : Regles manuelles uniquement (pas scalable), ML complexe (overkill pour v1)
**Consequences** : Rapport d'anomalies automatique, scoring par severite, actionnable

### 2026-02-26 — Phase C — BatchOptimizer avec ajustement dynamique

**Contexte** : La taille de batch optimale depend de l'objet SF (nombre de champs, triggers, flows)
**Decision** : Calcul initial base sur le describe, ajustement dynamique pendant l'execution, memorisation par objet
**Alternatives** : Taille fixe (sous-optimal), configuration manuelle (expertise requise)
**Consequences** : Performance optimale automatique, adaptation aux changements de config

### 2026-02-26 — Phase C — Web Workers pour calculs lourds

**Contexte** : Les calculs de diff et recherche full-text bloquent le thread principal de la WebView
**Decision** : Workers dedies (diffWorker, searchWorker) avec fallback synchrone, communication typee
**Alternatives** : Tout dans le main thread (UI freeze), WASM (complexite excessive)
**Consequences** : UI fluide pendant les calculs lourds, fallback gracieux

### 2026-02-26 — Phase C — PerformanceTracker avec detection de degradation

**Contexte** : Les performances des operations varient et les degradations passent inapercues
**Decision** : Tracking automatique (duree, records/sec, API calls, memoire), historique, alerte si < 80% moyenne
**Alternatives** : Monitoring externe (pas integre), logs uniquement (pas actionnable)
**Consequences** : Detection proactive des degradations, historique pour diagnostic

### 2026-02-26 — Phase D — EncryptionManager AES-256-GCM

**Contexte** : Les donnees sensibles (tokens, configs avec credentials) sont stockees en clair
**Decision** : AES-256-GCM avec cle derivee PBKDF2 (100K iterations, SHA-512) du master key
**Alternatives** : AES-CBC (pas d'authentification), RSA (trop lent pour le chiffrement de masse)
**Consequences** : Chiffrement transparent, authentifie (GCM), performant, cle derivee securisee

### 2026-02-26 — Phase D — PIIDetector multi-methodes

**Contexte** : Les operations sur des donnees PII sans anonymisation posent des risques compliance
**Decision** : Detection triple : noms de champs courants + regex patterns (SSN, CC, IBAN, email, phone) + echantillonnage contenu
**Alternatives** : Detection par nom seul (faux negatifs), ML (complexite)
**Consequences** : Detection fiable des PII, classification (PII/PHI/PCI), integration PreCheck

### 2026-02-26 — Phase D — ProductionGuard avec safety tiers

**Contexte** : Les operations sur Production doivent etre fortement protegees
**Decision** : 3 tiers (critical/standard/read-only), double confirmation pour ecritures Prod, blocage DELETE/HARD_DELETE, logging renforce
**Alternatives** : Simple confirmation (insuffisant), blocage total (trop restrictif)
**Consequences** : Protection graduee selon la dangerosite, audit trail complet

### 2026-02-26 — Phase E — 12 composants UI supplementaires

**Contexte** : Le design system manquait de composants pour les interactions avancees
**Decision** : Stepper, Timeline, Accordion, Drawer, ContextMenu, Breadcrumb, Avatar, StatusDot, Chip, Divider, CopyButton, JsonViewer
**Alternatives** : Utiliser des librairies tierces (inconsistance visuelle), tout custom (trop de travail)
**Consequences** : Design system complet et coherent, tous les composants suivent les CSS variables VSCode

### 2026-02-26 — Phase E — Card component avec spread props

**Contexte** : Le composant Card ne transmettait pas les attributs HTML comme data-testid
**Decision** : Etendre CardProps avec React.HTMLAttributes<HTMLDivElement> et spread ...rest
**Alternatives** : Ajouter data-testid explicitement (pas extensible)
**Consequences** : Card accepte tous les attributs HTML standard, retrocompatible

### 2026-02-26 — Phase F — PipelineMarketplace avec 15 templates

**Contexte** : Les utilisateurs debutants ne savent pas comment structurer leurs pipelines
**Decision** : 15 templates pre-configures couvrant 5 categories, import/export JSON avec validation Zod
**Alternatives** : Documentation seule (pas actionnable), assistant IA uniquement (pas deterministe)
**Consequences** : Demarrage rapide, templates importables/exportables, communaute de partage

### 2026-02-26 — Phase F — ApprovalGate avec multi-approbateur

**Contexte** : Les pipelines sur Production necessitent une validation humaine
**Decision** : Step special pause + approbation, timeout configurable, support multi-approbateur (N sur M)
**Alternatives** : Email externe (pas integre), approbation unique (risque)
**Consequences** : Workflow d'approbation integre, historique, timeout avec action par defaut

### 2026-02-26 — Phase F — PipelineVersioning Git-like

**Contexte** : Les modifications de pipeline doivent etre tracables et reversibles
**Decision** : Versioning avec historique complet, diff entre versions, rollback, tags et annotations
**Alternatives** : Sauvegarde simple (pas de diff), Git reel (trop complexe pour des configs JSON)
**Consequences** : Historique complet, rollback en un clic, comparaison visuelle des versions

---

### 2026-02-26 — Phase G — Onboarding 5-step wizard

**Contexte** : Les nouveaux utilisateurs ne savent pas par ou commencer
**Decision** : Wizard 5 etapes (bienvenue, connexion, choix module, personnalisation, pret), progress bar, skip, "don't show again"
**Alternatives** : Documentation seule (taux d'adoption bas), video tutoriel (pas interactif)
**Consequences** : Onboarding guide interactif, preferences utilisateur capturees des le depart

### 2026-02-26 — Phase G — GuidedTour spotlight system

**Contexte** : Les features avancees sont decouvertes tardivement
**Decision** : Systeme de tour guide avec tooltip spotlight, 7 tours pre-configures, persistence localStorage
**Alternatives** : Overlays statiques (pas contextuels), assistant IA (trop lourd)
**Consequences** : Decouverte progressive des features, chaque tour ne s'affiche qu'une fois

### 2026-02-26 — Phase G — EmptyState avec illustrations SVG

**Contexte** : Les etats vides des modules n'incitent pas a l'action
**Decision** : 6 illustrations SVG specifiques par module, texte d'encouragement, boutons action/documentation/tour
**Alternatives** : Message texte simple (peu engageant), GIFs animes (trop lourds)
**Consequences** : Taux d'engagement plus eleve, chemin d'action clair pour chaque module

### 2026-02-26 — Phase H — SfdmuImporter et GearsetImporter

**Contexte** : Les utilisateurs existants de SFDMU/Gearset veulent migrer sans reconfigurer
**Decision** : Parseurs dedies avec validation Zod, mapping vers SyncConfig/CompareConfig natifs
**Alternatives** : Import manuel (tedieux), format unifie generique (perte de contexte)
**Consequences** : Migration en un clic depuis les outils concurrents, validation des configs importees

### 2026-02-26 — Phase H — PluginManager avec 6 extension points

**Contexte** : Les utilisateurs avances veulent etendre SandForge sans modifier le core
**Decision** : Plugin system avec manifest Zod, 6 hooks (beforeSeed, afterSync, onError, transform, validate, notify), chargement dynamique
**Alternatives** : Configuration seule (pas flexible), scripting integ (securite), webhooks seuls (pas de transformation)
**Consequences** : Extensibilite sans modification du code source, validation stricte des plugins

### 2026-02-26 — Phase H — TelemetryService opt-in anonymous

**Contexte** : Besoin de comprendre l'usage pour prioriser les features
**Decision** : Telemetrie opt-in, anonymisation complete (hash IDs), 8 types d'evenements module, batch buffering, pas de PII
**Alternatives** : Pas de telemetrie (development a l'aveugle), telemetrie obligatoire (privacy concern)
**Consequences** : Donnees d'usage respectueuses de la vie privee, meilleure priorisation

### 2026-02-26 — Phase I — 6 langues i18n

**Contexte** : SandForge ne supportait que EN et FR, limitant l'adoption internationale
**Decision** : Ajout de DE, ES, JA, PT-BR avec traduction complete de toutes les cles, detection automatique via VSCode
**Alternatives** : Traduction communautaire (qualite variable), anglais seul (frein a l'adoption)
**Consequences** : 6 langues completes, detection automatique de la locale, formatage locale-aware

### 2026-02-26 — Phase I — Logo SVG avec animations

**Contexte** : L'identite visuelle de SandForge manquait de coherence
**Decision** : Logo SVG (enclume + particules de sable + etincelles), 3 tailles, mode monochrome, animation hover respectant prefers-reduced-motion
**Alternatives** : PNG statique (pas scalable), icon font (pas de couleurs), logo externe (cout)
**Consequences** : Branding coherent partout (sidebar, welcome, about, loading), accessibilite respectee

### 2026-02-26 — Phase I — Locale-aware formatters via Intl API

**Contexte** : Les nombres, dates et devises etaient affiches sans respect de la locale
**Decision** : 6 fonctions utilitaires utilisant Intl.NumberFormat, Intl.DateTimeFormat, Intl.RelativeTimeFormat
**Alternatives** : Librairie externe (moment, date-fns), formatage maison (incomplet)
**Consequences** : Formatage natif, zero dependance, support complet de toutes les locales
