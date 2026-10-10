# Budget

Application web de suivi des dépenses mensuelles, pensée pour le téléphone et utilisée à deux en temps réel.

**Application en ligne :** https://TON-NOM.github.io/budget-app/

## Fonctionnalités

- Saisie d'une dépense : catégorie, date, montant, note facultative (le nom de la personne est enregistré automatiquement)
- Seuils de dépense par catégorie **et par mois** (reprise automatique des seuils du mois précédent)
- Résumé par catégorie : total dépensé, reste, barre de progression (verte, orange dès 80 %, rouge en cas de dépassement)
- Total par jour et total du mois
- Historique : sélecteur de mois pour consulter les mois passés
- Modification et suppression d'une dépense
- Connexion par compte, accès limité à deux personnes
- Synchronisation en temps réel, fonctionnement hors ligne, installation sur l'écran d'accueil
- Export CSV

## Technologies

- HTML, CSS et JavaScript (une seule page, sans framework)
- [Firebase](https://firebase.google.com/) : Cloud Firestore (base de données temps réel) et Authentication (e-mail / mot de passe)
- [GitHub Pages](https://pages.github.com/) pour l'hébergement
- PWA : `manifest.json` et service worker (`sw.js`)

## Structure du dépôt

```
index.html       l'application (interface et logique)
manifest.json    description de l'application installable
sw.js            service worker (mode hors ligne)
icon-192.png     icône
icon-512.png     icône
```

## Installer l'application sur un téléphone

- **Android (Chrome)** : menu ⋮, puis « Installer l'application ».
- **iPhone (Safari)** : bouton Partager, puis « Sur l'écran d'accueil ».

## Reprendre le projet pour soi

1. Créer un projet Firebase, activer **Firestore** et **Authentication** (e-mail / mot de passe), puis créer les comptes.
2. Remplacer l'objet `firebaseConfig` dans `index.html` par celui de son projet.
3. Publier des règles de sécurité Firestore limitant l'accès aux identifiants (`uid`) des comptes autorisés :

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null
        && request.auth.uid in ["UID_PERSONNE_1", "UID_PERSONNE_2"];
    }
  }
}
```

4. Activer GitHub Pages (Settings, Pages, branche `main`, dossier racine).

## Sécurité

La configuration Firebase présente dans `index.html` (dont `apiKey`) est publique par conception : elle identifie le projet mais ne protège rien. La protection des données repose sur l'authentification et sur les règles de sécurité Firestore ci-dessus.

## Évolutions envisagées

- Graphiques (répartition par catégorie, évolution dans le mois)
- Comparaison entre mois
- Catégories personnalisables
