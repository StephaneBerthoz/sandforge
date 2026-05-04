import type { TranslationRecord } from '../../types.js';

export const help: TranslationRecord = {
  title: 'Aide & Ressources',
  gettingStarted: 'Premiers pas',
  gettingStartedDesc: 'Tout ce dont vous avez besoin pour demarrer avec SandForge.',
  gettingStartedContent:
    "SandForge est une extension VSCode pour gerer les donnees de sandbox Salesforce.\n\n1. Connectez une org depuis la page Organisations\n2. Utilisez le Moniteur pour verifier la sante de l'org et les limites API\n3. Generez des donnees de test avec Seed ou transferez avec Sync\n4. Comparez les orgs pour detecter les ecarts de metadata\n5. Utilisez DataOps pour sauvegarder, restaurer et anonymiser\n6. Automatisez les taches recurrentes avec les pipelines d'Automation",
  monitorContent:
    "Le Moniteur offre une visibilite en temps reel sur la sante de votre org.\n\n- Suivi des appels API avec limites et tendances\n- Utilisation du stockage de donnees et de fichiers\n- Jobs batch actifs avec possibilite d'annulation\n- Predictions des limites Governor\n- Systeme d'alertes sur depassement de seuils\n- Calcul de score de sante multi-dimensions",
  seedContent:
    'Seed genere des donnees de test realistes pour votre sandbox.\n\n- Generation IA avec Claude\n- Generation Faker pour les types de champs courants\n- Generation par modeles pour des scenarios reproductibles\n- Resolution automatique des dependances entre objets\n- Detection PII avant insertion\n- Import CSV pour le chargement en masse\n- Suggestions intelligentes basees sur les metadonnees',
  syncContent:
    'Sync transfere les donnees entre orgs Salesforce avec des capacites ETL completes.\n\n- Synchronisation de donnees source vers cible\n- Mapping visuel des champs par glisser-deposer\n- Pipeline de transformation des donnees\n- Detection delta pour les syncs incrementaux\n- Strategies de resolution de conflits\n- Gestion des External IDs\n- Mapping des Record Types et utilisateurs\n- Gestion des champs polymorphiques',
  compareContent:
    "Compare detecte les differences entre deux orgs Salesforce.\n\n- Comparaison de metadata (Apex, LWC, Flows, etc.)\n- Comparaison des permissions et profils\n- Detection de derive de configuration\n- Analyse d'impact des changements\n- Construction de packages de deploiement\n- Gestion des snapshots pour comparaison historique",
  dataopsContent:
    'DataOps fournit des outils de gouvernance et protection des donnees.\n\n- Sauvegarde et restauration avec recuperation point-in-time\n- Anonymisation avec modeles configurables\n- Outils de conformite RGPD\n- Suppression en masse avec garde-fous\n- Scan de qualite des donnees\n- Optimisation du stockage\n- Gestion de la corbeille',
  automationContent:
    "Automation cree des pipelines multi-etapes pour les workflows recurrents.\n\n- Constructeur visuel avec glisser-deposer\n- Configuration de declencheurs (cron, webhook, evenement)\n- Planificateur avec vue calendrier\n- Historique d'execution et logs\n- Marketplace de modeles pre-construits\n- Generation IA de pipelines en langage naturel",
  aiContent:
    "Les fonctionnalites IA enrichissent SandForge avec une assistance intelligente.\n\n- NL2SOQL : Convertir du langage naturel en requetes SOQL\n- Suggestions intelligentes : Recommandations contextuelles\n- Resolution d'erreurs : Diagnostic IA\n- Conseiller Schema : Optimisation de schema\n- Detection d'anomalies : Scan de qualite des donnees\n- Generation de pipelines : Construire des pipelines a partir de descriptions\n\nConfigurez votre cle API dans Parametres > IA.",
  shortcuts: 'Raccourcis clavier',
  shortcutsContent:
    "Navigation :\n- Ctrl+Shift+P : Palette de commandes\n- Ctrl+1-6 : Basculer entre les modules\n- Ctrl+, : Ouvrir les Parametres\n- Ctrl+H : Ouvrir l'Aide\n\nActions :\n- Ctrl+Entree : Executer l'operation en cours\n- Ctrl+S : Sauvegarder la configuration\n- Echap : Annuler / Fermer",
  faq: 'FAQ',
  faqContent:
    "Q : Ai-je besoin d'une cle API pour les fonctionnalites IA ?\nR : Oui, les fonctionnalites IA necessitent une cle API Anthropic configuree dans Parametres > IA.\n\nQ : Mes donnees sont-elles en securite ?\nR : SandForge traite les donnees localement dans votre extension VSCode. Les cles API sont stockees dans VSCode Secret Storage.\n\nQ : Puis-je utiliser SandForge avec des orgs de production ?\nR : Oui, mais les operations en production necessitent une confirmation. Configurez les niveaux de securite dans les parametres d'org.\n\nQ : Comment signaler un bug ?\nR : Utilisez la section Aide > Depannage ou ouvrez un ticket sur GitHub.",
  troubleshooting: 'Depannage',
  troubleshootingContent:
    "Problemes courants et solutions :\n\n- Echec de connexion : Verifiez vos identifiants et la liste blanche d'IPs\n- Limite API depassee : Attendez la reinitialisation quotidienne ou contactez le support Salesforce\n- Echec Seed : Verifiez la securite au niveau des champs et les regles de validation\n- Conflits Sync : Verifiez les parametres de resolution de conflits et les External IDs\n- Extension ne charge pas : Rechargez la fenetre VSCode (Ctrl+Shift+P > Reload Window)",
  releaseNotes: 'Notes de version',
  releaseNotesContent:
    "v3.1 — Refonte UI\n- Nouveau dashboard en grille bento\n- Sidebar avec selecteur d'org et favoris\n- Support i18n complet (anglais + francais)\n- Raccourcis clavier et palette de commandes\n- Assistant de bienvenue et onboarding\n\nv3.0 — Module Forge\n- Decouverte et clonage de graphes de records\n- Remapping d'IDs entre objets\n- Detection et anonymisation PII\n- Systeme de modeles pour forges reproductibles",
  searchPlaceholder: "Rechercher dans l'aide...",
  noSearchResults: 'Aucun resultat pour votre recherche.',
  sfDocs: 'Documentation Salesforce',
  sfDocsDesc: 'Documentation officielle pour les developpeurs Salesforce',
  sfDocsUrl: 'https://developer.salesforce.com/docs',
  sfTrailhead: 'Trailhead',
  sfTrailheadDesc: 'Plateforme gratuite pour apprendre Salesforce',
  sfTrailheadUrl: 'https://trailhead.salesforce.com',
  sfStackExchange: 'Salesforce Stack Exchange',
  sfStackExchangeDesc: 'Questions-reponses communautaires pour les developpeurs Salesforce',
  sfStackExchangeUrl: 'https://salesforce.stackexchange.com',
  startTour: 'Lancer la visite guidee',
  viewDocs: 'Voir la documentation',
};
