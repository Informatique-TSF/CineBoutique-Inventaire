# Déploiement sur VM (Debian, Docker Compose)

## Pré-requis sur la VM
- Docker et le plugin Docker Compose installés, utilisateur courant membre du groupe `docker`.
- Git installé, dépôt cloné dans `~/apps/CineBoutique-Inventaire`.
- Certificat TLS reconnu par les téléphones dans `./ssl/fullchain.pem` et `./ssl/privkey.pem` (voir `docs/DEMANDE_IT.md`). En prod, `./ssl` est monté en lecture seule : s'il est vide, le conteneur web ne peut pas générer de certificat auto-signé et ne démarre pas.
- Le projet Compose s'appelle `inventaire` (champ `name:` de `docker-compose.yml`), quel que soit le dossier : les données sont dans le volume `inventaire_dbdata`. Jusqu'en octobre 2026, la prod tournait depuis `~/apps/inventaire` ; ce dossier est gardé tel quel pour un retour arrière.
- Fichier `secrets.env` créé à partir de `secrets.env.example` (jeton applicatif, jamais versionné).

## Fichiers Compose
- `docker-compose.yml` : base (db, api, web).
- `docker-compose.override.yml` : chargé automatiquement, **pour le développement** (publie l'API sur 8080 et la base sur 5432).
- `docker-compose.prod.yml` : production. L'API n'est **pas** publiée sur l'hôte ; seul Nginx (80/443) l'est. Toujours le passer explicitement :

```bash
cd ~/apps/CineBoutique-Inventaire
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Vérifications après déploiement :

```bash
curl -k https://localhost/health                 # Nginx
curl -k https://localhost/api/health             # API via Nginx (jeton posé par Nginx)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/health   # doit échouer : port non publié
docker port inventory-api; docker port inventory-db   # aucune sortie attendue
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Pare-feu : Docker publie ses ports par ses propres règles iptables, que `ufw` ne filtre pas. La fermeture de 8080 et de la base repose donc sur l'absence de publication ; une règle `ufw` sur 8080 ne protège que d'un service lancé hors Docker.

## Jeton applicatif (X-App-Token)
L'API refuse toute requête `/api/*` sans le jeton `Authentication__AppToken` et refuse de démarrer en Production s'il est absent. Nginx pose l'en-tête `X-App-Token` sur chaque requête proxifiée (variable `APP_TOKEN`, substituée au démarrage dans `nginx/templates/site.conf.template`). Le navigateur ne connaît jamais le jeton.

```bash
cp secrets.env.example secrets.env
token=$(openssl rand -hex 32)
sed -i "s/^APP_TOKEN=.*/APP_TOKEN=$token/; s/^Authentication__AppToken=.*/Authentication__AppToken=$token/" secrets.env
```

## Mise à jour du code
Le script `scripts/deploy/pull_and_rebuild.sh` fait un `git reset --hard` sur la branche `BRANCH` (défaut `deploy`) puis reconstruit les images. Le dépôt n'a pas encore de branche `deploy` : utiliser `BRANCH=main` ou créer la branche. Il n'existe pas de workflow GitHub qui alimente `deploy` automatiquement.

```bash
APP_DIR=~/apps/CineBoutique-Inventaire BRANCH=main ./scripts/deploy/pull_and_rebuild.sh
```

`secrets.env` et `ssl/` ne sont pas versionnés : le `reset --hard` ne les touche pas.

## Sauvegardes
Sauvegarde quotidienne et procédure de restauration : voir `scripts/deploy/README.md` (`backup_db.sh`, `restore_db.sh`, minuteur systemd `inventaire-backup.timer`). Tester la restauration une fois avant l'inventaire.

## Certificat et téléphones
Les navigateurs n'ouvrent la caméra que sur un site HTTPS reconnu. Deux options, décrites dans `docs/DEMANDE_IT.md` :
1. nom `inventaire.tsf.fr` + certificat Let's Encrypt par validation DNS (recommandé, rien à installer sur les téléphones) ;
2. certificat de la PKI interne + racine déployée sur les téléphones par MDM (iPhone : « Réglages > Général > Informations > Réglages de confiance du certificat »).

Renouvellement : remplacer les fichiers dans `./ssl/` puis `docker exec inventory-web nginx -s reload`.

## Blue/green
`docker-compose.green.yml` et `switch_api.sh` datent d'une version où l'API était publiée sur l'hôte ; ils ne sont plus fonctionnels en l'état (le bloc `/api/` de Nginx n'inclut pas `api_upstream.conf`). À reprendre si le besoin de bascule sans coupure se confirme.
