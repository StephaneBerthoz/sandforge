## Clonez des données avec Forge

Peuplez une sandbox de développement à partir d'un enregistrement réel :

1. Collez l'ID d'un enregistrement racine de votre org UAT dans **ID d'enregistrement ou URL Salesforce** — un compte fait très bien l'affaire.
2. Cliquez sur **Découvrir le graphe** — Forge parcourt le graphe de relations de l'enregistrement (contacts, opportunités, requêtes…).
3. Ajustez **Profondeur**, **Enregistrements / objet** et **Anonymiser les PII**.
4. Cliquez sur **Revoir et exécuter** vers votre sandbox de développement. Les ID sont remappés à l'écriture ; un type d'enregistrement sans type d'enregistrement actif de même nom d'API sur la cible conserve son Id source, et le journal SandForge le signale.

Pressé ? **Cloner directement**, sous **Découvrir le graphe**, lance le clonage dès que la découverte répond, sans s'arrêter sur le graphe ni sur la revue : la comparaison des métadonnées entre les deux orgs n'est alors pas lancée. Un graphe de plus de 25 objets est listé dans un tableau plutôt que dessiné ; le sélecteur **Vue graphe** / **Vue tableau** et le paramètre `sandforge.forge.graphView` en décident.

[Ouvrir Forge](command:sandforge.openForge)
