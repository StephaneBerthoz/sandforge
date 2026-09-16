## Clonez des données avec Forge

Peuplez une sandbox de développement à partir d'un enregistrement réel :

1. Collez l'ID d'un enregistrement racine de votre org UAT dans **ID d'enregistrement ou URL Salesforce** — un compte fait très bien l'affaire.
2. Cliquez sur **Découvrir le graphe** — Forge parcourt le graphe de relations de l'enregistrement (contacts, opportunités, requêtes…).
3. Ajustez **Profondeur**, **Enregistrements / objet** et **Anonymiser les PII**.
4. Cliquez sur **Revoir et exécuter** vers votre sandbox de développement. Les ID sont remappés à l'écriture ; un type d'enregistrement sans type d'enregistrement actif de même nom d'API sur la cible conserve son Id source, et le journal SandForge le signale.

[Ouvrir Forge](command:sandforge.openForge)
