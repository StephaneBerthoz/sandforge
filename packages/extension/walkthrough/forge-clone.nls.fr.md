## Clonez des données avec Forge

Copiez un enregistrement réel, et ce qui s'y rattache, d'une autre org vers celle que vous remplissez :

1. Connectez les deux orgs : celle d'où vous copiez (une sandbox UAT, par exemple) et celle que vous remplissez. L'org sélectionnée dans le panneau latéral est l'**Org source**.
2. Choisissez l'**Org cible**, celle que vous remplissez : **Découvrir le graphe** reste désactivé tant qu'elle n'est pas choisie.
3. Collez l'ID ou l'URL d'un enregistrement dans **ID d'enregistrement ou URL Salesforce** — un compte fait très bien l'affaire. **Profondeur** (jusqu'à **Profond (5 niveaux)**), **Enregistrements / objet** et **Anonymiser les PII** sont au-dessus du bouton : réglez-les maintenant, car ils décident de ce que la découverte lit. **ALL**, la dernière profondeur, copie plutôt toute l'org source : aucun enregistrement à coller, et aucun plafond par objet.
4. Cliquez sur **Découvrir le graphe**, puis sur **Revoir et exécuter**.
5. Dans la revue, **Simuler** vérifie chaque enregistrement et n'envoie rien ; **Essai à blanc** fait essayer un échantillon à la cible, annulé ensuite, et coûte des appels API ; **Exécuter le Forge** écrit. **Supprimer les enregistrements créés par cette exécution**, dans les résultats ou sous **Exécutions récentes**, reprend l'exécution. Un clonage de toute l'org (**ALL**) n'offre encore ni **Simuler** ni **Essai à blanc** : la confirmation que **Exécuter le Forge** demande toujours avant d'écrire dit ce que l'exécution écrit.

Pressé ? **Cloner directement**, sous **Découvrir le graphe**, lance le clonage dès que la découverte répond, sans s'arrêter sur le graphe ni sur la revue : la comparaison des métadonnées entre les deux orgs n'est alors pas lancée. Un graphe de plus de 25 objets est listé dans un tableau plutôt que dessiné ; le sélecteur **Vue graphe** / **Vue tableau** et le paramètre `sandforge.forge.graphView` en décident.

[Ouvrir Forge](command:sandforge.openForge)
