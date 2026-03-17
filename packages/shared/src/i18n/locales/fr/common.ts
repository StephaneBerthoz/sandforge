import type { TranslationRecord } from '../../types.js';

export const common: TranslationRecord = {
  save: 'Enregistrer',
  cancel: 'Annuler',
  confirm: 'Confirmer',
  delete: 'Supprimer',
  edit: 'Modifier',
  close: 'Fermer',
  back: 'Retour',
  next: 'Suivant',
  loading: 'Chargement...',
  error: 'Erreur',
  success: 'Succes',
  warning: 'Avertissement',
  noData: 'Aucune donnee disponible',
  search: 'Rechercher',
  filter: 'Filtrer',
  refresh: 'Actualiser',
  retry: 'Reessayer',
  copy: 'Copier',
  export: 'Exporter',
};

export const nav: TranslationRecord = {
  home: 'Accueil',
  orgs: 'Organisations',
  seed: 'Seed',
  sync: 'Sync',
  monitor: 'Moniteur',
  compare: 'Comparer Org',
  dataops: 'DataOps',
  automation: 'Automatisation',
  autopilot: 'Autopilot',
  forge: 'Forge',
  ai: 'Assistant IA',
  reports: 'Rapports',
  settings: 'Parametres',
  help: 'Aide',
};

export const org: TranslationRecord = {
  title: 'Organisations',
  connect: 'Connecter Org',
  disconnect: 'Deconnecter',
  edit: 'Modifier Org',
  noOrgs: 'Aucune organisation connectee',
  status_connected: 'Connectee',
  status_expired: 'Session expiree',
  status_error: 'Erreur de connexion',
  status_refreshing: 'Actualisation...',
  safetyTier: 'Niveau de securite',
  bannerConnected: '{{count}} sur {{total}} orgs connectees',
  bannerEmpty: 'Importez vos orgs depuis Salesforce CLI ou connectez-vous manuellement',
  alias: 'Alias',
  username: "Nom d'utilisateur",
  instanceUrl: "URL de l'instance",
  orgType: "Type d'org",
  production: 'Production',
  sandbox: 'Sandbox',
  scratch: 'Scratch',
  developer: 'Developpeur',
  tier_critical: 'Critique',
  tier_high: 'Eleve',
  tier_medium: 'Moyen',
  tier_low: 'Faible',
};

export const precheck: TranslationRecord = {
  title: 'Pre-verification',
  running: 'Verification en cours...',
  passed: 'Reussi',
  failed: 'Echoue',
  warnings: 'Avertissements',
  score: 'Score',
  canProceed: 'Peut continuer',
  blocked: 'Bloque',
  autoFix: 'Correction automatique disponible',
  applyFix: 'Appliquer la correction',
  confirmation: 'Confirmation requise',
};

export const notifications: TranslationRecord = {
  title: 'Notifications',
  markAllRead: 'Tout marquer comme lu',
  clearAll: 'Tout effacer',
  noNotifications: 'Aucune notification',
};

export const bridge: TranslationRecord = {
  connecting: "Connexion a l'extension...",
  connected: "Connecte a l'extension",
  disconnected: "Deconnecte de l'extension",
  syncReceived: 'Etat synchronise',
  notYetConnected: "Pas encore connecte a l'API Salesforce",
  orgConnected: 'Organisation connectee',
  orgDisconnected: 'Organisation deconnectee',
  settingsSaved: "Parametres enregistres dans l'extension",
};

export const auth: TranslationRecord = {
  method: "Methode d'authentification",
  loginUrl: 'URL de connexion',
  username: "Nom d'utilisateur",
  password: 'Mot de passe',
  securityToken: 'Token de securite',
  securityTokenHint: "Optionnel — requis si l'IP n'est pas en liste blanche",
  importAll: 'Importer tout depuis SF CLI',
  openBrowser: 'Ouvrir le navigateur',
  notSupported: "Cette methode d'authentification n'est pas encore supportee.",
  sfdxHint: 'Toutes les orgs connectees dans Salesforce CLI seront importees automatiquement.',
};
