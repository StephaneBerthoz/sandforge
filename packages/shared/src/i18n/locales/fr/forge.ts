import type { TranslationRecord } from '../../types.js';

export const forge: TranslationRecord = {
  subtitle: "Clonez un graphe de donnees complet entre orgs avec remapping d'IDs et anonymisation PII.",
  selectNode: 'Selectionnez un noeud pour voir les details',
  objects: 'Objets',
  records: 'Enregistrements',
  estSize: 'Taille est.',
  estDuration: 'Duree est.',
  executeForge: 'Executer le Forge',
  abortConfirm: "Voulez-vous vraiment annuler l'operation Forge en cours ?",
  aborted: "Operation Forge annulee par l'utilisateur.",
  forging: 'FORGEAGE...',
  paused: 'EN PAUSE',
  complete: 'TERMINE',
  elapsed: 'Temps ecoule',
  done: 'Termine',
  running: 'En cours',
  queued: 'En attente',
  failed: 'Echoue',
  resume: 'Reprendre',
  pause: 'Pause',
  abort: 'Annuler',
  recordIdPlaceholder: 'Entrez un ID de record Salesforce (ex: 001xx000003DGbZ)',
  soqlPlaceholder: "SELECT Id FROM Account WHERE Industry = 'Technology'",
  noTemplates: 'Aucun modele enregistre.',
  aiPlaceholder: 'Decrivez les donnees dont vous avez besoin (ex: "Tous les comptes avec leurs contacts et opportunites")...',
  depthDirect: 'Direct uniquement',
  depthFull: 'Arbre complet',
  depthCustom: 'Profondeur personnalisee',
  sourceOrg: 'Org source',
  targetOrg: 'Org cible',
  anonymizePII: 'Anonymiser les champs PII',
  skipEmpty: 'Ignorer les objets vides',
  discoverGraph: 'Decouvrir le graphe',
  includeNode: 'Inclure dans le forge',
  piiFields: 'Champs PII',
  anonymize: 'Anonymiser',
  anonymizationPreview: "Apercu de l'anonymisation",
  fieldName: 'Champ',
  before: 'Avant',
  after: 'Apres',
  inserted: 'Inseres',
  skipped: 'Ignores',
  idRemaps: "Remappages d'IDs",
  successRate: 'Taux de reussite',
  object: 'Objet',
  status: 'Statut',
  errors: 'Erreurs',
  saveTemplate: 'Enregistrer comme modele',
  copyReport: 'Copier le rapport',
  forgeAgain: 'Relancer le Forge',
  templates: 'Modeles',
  lastUsed: 'Derniere utilisation',
  useTemplate: 'Utiliser le modele',
  deleteTemplate: 'Supprimer le modele',
  metadataMismatch: 'Ecart de metadata detecte entre les orgs source et cible.',
  syncMetadata: 'Synchroniser la metadata',
  skipMetadata: 'Ignorer',

  // Review phase
  'review.planTab': 'Plan',
  'review.anonymizationTab': 'Anonymisation',
  'review.complianceTab': 'Conformite',
  'review.metadataTab': 'Metadata',
  'review.back': '← Retour a la decouverte',
  'review.wave': 'Vague',
  'review.planLoading': "Generation du plan d'execution...",
  'review.cycles': 'Resolutions de cycles',
  'review.category': 'Categorie',
  'review.method': 'Methode',
  'review.anonymizationDesc': "{count} champs PII detectes. Configurez la methode d'anonymisation par categorie.",
  'review.framework': 'Cadre reglementaire',
  'review.noCompliance': 'Aucun cadre de conformite selectionne. Selectionnez-en un pour generer un rapport.',
  'review.complianceLoading': 'Selectionnez un cadre et executez pour generer le rapport de conformite.',
  'review.complianceStatus': 'Statut',
  'review.noDiffs': 'Aucune difference de metadata detectee.',
  'review.diffsFound': '{count} differences detectees entre la source et la cible.',

  // Batch strategies
  'batch.auto': 'Auto',
  'batch.rest': 'REST API',
  'batch.bulk': 'Bulk API 2.0',

  // Anonymization categories
  'anon.email': 'Email',
  'anon.phone': 'Telephone',
  'anon.name': 'Nom (Prenom/Nom)',
  'anon.address': 'Adresse',
  'anon.ssn_id': 'NSS / Identifiant national',
  'anon.financial': 'Financier',
  'anon.other': 'Autre',

  // Input preview panel
  livePreview: 'Apercu en direct',
  estimatedGraph: 'Graphe estime',
  piiWarning: '{count} champs PII detectes',
  piiWarningHint: "Activez l'anonymisation pour proteger les donnees",
  noOrgSelected: 'Selectionnez une org',
  depth: 'Profondeur',
  recordTab: 'Enregistrement',
  soqlTab: 'SOQL',
  templateTab: 'Modele',
  aiTab: 'IA',

  // Volume cap (enregistrements par objet pendant l'execution)
  recordLimit: 'Enregistrements / objet',
  recordLimitHint: "Limite le nombre de lignes clonees par objet. Plus bas = plus rapide, plus sur sur les grosses orgs.",
  recordLimitAll: 'Tout',
  recordLimitOpt10: '10 / objet (echantillon)',
  recordLimitOpt50: '50 / objet',
  recordLimitOpt100: '100 / objet',
  recordLimitOpt500: '500 / objet',
  recordLimitOpt1000: '1000 / objet',

  // Modeles starter pre-configures
  starterBadge: 'Starter',
  starterTemplates: 'Modeles starter',
  yourTemplates: 'Vos modeles',

  // Results enhancements
  exportJson: 'Exporter JSON',
  retryFailed: 'Relancer les echecs',
  anonymizedFields: 'Champs anonymises',
  apiCallsConsumed: 'Appels API',
  logFilterAll: 'Tout',
  logFilterErrors: 'Erreurs',
  logFilterWarnings: 'Avertissements',

  // Smart error translator (Pilier 3) — surfaced inline in the errors panel.
  error: {
    duplicateValue: {
      explanation:
        "Un record avec la meme cle d'unicite existe deja sur la sandbox cible (probablement clone lors d'un run precedent).",
      action: 'Supprime le record existant ou change le mode en upsert (a venir).',
    },
    invalidCrossReferenceKey: {
      explanation:
        "Une reference (Owner, Manager, ...) pointe vers un User qui n'existe pas sur la sandbox cible. Le champ a ete mis a null automatiquement.",
      action:
        "Salesforce assignera le User courant. Pas d'action requise sauf si le record necessite un Owner specifique.",
    },
    requiredFieldMissing: {
      explanation: 'Un champ requis est manquant : {{detail}}.',
      action: 'Augmente la profondeur (depth) ou ajoute manuellement le parent reference au scope.',
    },
    invalidPicklist: {
      explanation:
        "La valeur source d'un picklist n'existe pas sur la sandbox cible (config divergente).",
      action:
        'Aligne les picklists via Salesforce Setup ou laisse le strip automatique faire son travail (silent skip).',
    },
    invalidFieldForInsert: {
      explanation:
        'Un champ ne peut pas etre set a la creation (auto-computed, FLS, ou inexistant cote target).',
      action:
        'Verifie la securite de champs (FLS) sur ton profile cible, ou aligne le schema source/target.',
    },
    fieldIntegrity: {
      explanation: "Contrainte d'integrite Salesforce non respectee : {{detail}}.",
      action: 'Lis le detail — Salesforce indique souvent le champ ou la regle metier en cause.',
    },
    cannotInsertEntity: {
      explanation:
        "Cette table est en lecture seule (audit/history/system). Salesforce n'accepte pas l'insertion.",
      action: "Cet objet est desormais skipped automatiquement par le scope (isObjectCreatable).",
    },
    insufficientAccess: {
      explanation: "Ton profile sur la sandbox cible n'a pas les droits suffisants.",
      action: 'Demande a un admin de te donner les droits ou switche vers un User admin.',
    },
    storageLimit: {
      explanation: "La sandbox cible n'a plus de stockage disponible.",
      action: 'Nettoie des donnees obsoletes ou demande une augmentation de quota Salesforce.',
    },
    invalidType: {
      explanation: "Le type d'objet n'existe pas (probablement supprime du target).",
      action: 'Aligne les schemas source/target, ou exclus cet objet du scope.',
    },
    notFound: {
      explanation: "Le record source n'a pas ete trouve.",
      action: "Verifie le record ID et l'org source.",
    },
    stringTooLong: {
      explanation: 'Une valeur depasse la longueur max du champ : {{detail}}.',
      action: 'Tronque la valeur source ou aligne la longueur des champs entre orgs.',
    },
    cycleFkUnresolved: {
      explanation:
        "Le champ '{{fieldName}}' reference un parent qui n'a jamais ete cloue (source ID {{sourceRefId}}). Le record a ete insere sans ce lien.",
      action:
        'Augmente la profondeur (depth) pour inclure le parent, ou accepte le record disconnecte.',
    },
    outOfScope: {
      explanation:
        "Cet objet n'a aucun chemin vers le record racine — pas de parent dans le scope.",
      action:
        'Ajoute manuellement cet objet en mode SOQL custom, ou ignore (probablement reference data isolee).',
    },
    unknown: {
      explanation: '{{detail}}',
      action: "Consulte la doc Salesforce sur ce code d'erreur ou copie le message au support.",
    },
  },
};
