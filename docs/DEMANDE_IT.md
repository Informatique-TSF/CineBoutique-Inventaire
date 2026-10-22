# Demande au service informatique : nom DNS, certificat, téléphones

Objet : permettre le scan caméra sur iPhone et Android et fermer l'accès direct à l'API de l'application d'inventaire CinéBoutique, avant l'inventaire de décembre 2026.

## Pourquoi

Les navigateurs n'autorisent la caméra que sur un site HTTPS dont le certificat est reconnu par le téléphone. Aujourd'hui l'application est jointe par son adresse IP (192.168.2.29) avec un certificat non reconnu : iPhone et Android refusent la caméra. Par ailleurs l'API est publiée en clair sur le port 8080 de la VM ; la nouvelle version ne la publie plus et exige un jeton posé par Nginx.

## Demande 1 : un nom DNS

- Créer l'enregistrement `inventaire.tsf.fr` de type A vers `192.168.2.29`.
- Il peut vivre dans la zone publique `tsf.fr` (pointer une adresse privée est autorisé) ou dans le DNS interne, du moment que les téléphones du magasin le résolvent.

## Demande 2 : un certificat reconnu pour ce nom (au choix)

**Option A, recommandée : Let's Encrypt par validation DNS.** Aucune exposition de la VM à Internet : seul le DNS sert à prouver le nom.

- Outil : certbot (ou lego, acme.sh) avec le plugin DNS du prestataire qui héberge la zone `tsf.fr`, exécuté sur la VM ou sur un poste IT.
- Nom : `inventaire.tsf.fr`. Renouvellement automatique tous les 60 jours.
- Déposer `fullchain.pem` et `privkey.pem` dans `~/apps/CineBoutique-Inventaire/ssl/` sur la VM (lecture par l'utilisateur qui lance Docker), puis `docker exec inventory-web nginx -s reload`.

**Option B : certificat de la PKI interne.**

- Certificat serveur pour `inventaire.tsf.fr` (SAN DNS, et l'IP si besoin), validité 398 jours maximum (exigence Apple et Chrome), clé RSA 2048 ou ECDSA P-256.
- Déployer la racine de la PKI sur tous les téléphones (iPhone : profil MDM avec « réglages de confiance » activés ; Android : certificat utilisateur ou MDM). Sans cette étape, la caméra reste bloquée.

## Demande 3 : téléphones

- Autoriser l'accès caméra pour Safari (iPhone) et Chrome (Android) ; sur iPhone, l'application est à ouvrir en `https://inventaire.tsf.fr` puis « Ajouter à l'écran d'accueil ».
- Si un MDM est en place, pousser le raccourci et, en option B, la racine de la PKI.

## Demande 4 : secret de déploiement

- Sur la VM, créer le fichier `~/apps/CineBoutique-Inventaire/secrets.env` à partir de `secrets.env.example` avec un jeton généré par `openssl rand -hex 32` (même valeur sur les deux lignes). Ce fichier n'est jamais versionné.
- Après mise à jour : `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`, puis vérifier que `http://192.168.2.29:8080/api/health` ne répond plus et que `https://inventaire.tsf.fr/api/health` répond.
- En complément, bloquer le port 8080 entrant sur le pare-feu de la VM.

## Vérification finale (5 minutes)

1. Sur un iPhone et un Android, ouvrir `https://inventaire.tsf.fr` : cadenas sans avertissement.
2. Choisir une boutique, un utilisateur, une zone, puis « Scanner avec la caméra » : la caméra s'ouvre et lit un code EAN-13.
3. Ouvrir `http://192.168.2.29:8080/api/health` depuis un poste du LAN : la connexion doit échouer.
