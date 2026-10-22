# CinéBoutique - Inventaire

Ce dépôt monorepo regroupe l'ensemble des composants nécessaires à la future application d'inventaire CinéBoutique.

## Guide de démarrage zéro friction

### Prérequis
- .NET SDK 8.0.415 (voir `global.json`), SDK installé via `dotnet` ou `./scripts/bootstrap-dotnet.sh`.
- Node.js ≥ 20.10 + npm ≥ 10.8 (workspaces activés), PNPM optionnel.
- PostgreSQL 16 (local) ou Docker/Compose installé pour utiliser `docker compose`.

### Configuration essentielle
- Chaîne de connexion unique : `ConnectionStrings__Default=Host=<host>;Port=5432;Database=inventory;Username=<user>;Password=<pwd>`.
- Auth : `Authentication:UseAdminHeader=true` pour le dev (entêtes `X-Admin: true` + `X-App-Token` optionnel). En production, désactivez-le et renseignez `Authentication:Authority` + `Authentication:Audience`.
- Seeds/migrations : `APPLY_MIGRATIONS=true` et `AppSettings__SeedOnStartup=true` en dev. En production, `APPLY_MIGRATIONS` ponctuel lors des montées de version et `AppSettings__SeedOnStartup=false`.
- CORS : ajouter vos origines via `AllowedOrigins__0=https://...`.
- Front : `DEV_BACKEND_ORIGIN=http://localhost:8080` (proxy Vite), `VITE_API_BASE=/api` par défaut.

### Démarrage local (sans Docker)
```bash
# 0. Dépendances
npm ci
dotnet restore

# 1. API (terminal 1) – migrations + seed de démo
export ConnectionStrings__Default='Host=localhost;Port=5432;Database=inventory;Username=postgres;Password=postgres'
export APPLY_MIGRATIONS=true
export AppSettings__SeedOnStartup=true
dotnet run --project src/inventory-api

# 2. Front (terminal 2)
DEV_BACKEND_ORIGIN=http://localhost:8080 npm -w src/inventory-web run dev
# Accès : http://localhost:5173 (proxy /api vers l'API)
```

### Démarrage via Docker Compose
```bash
export PUBLIC_HOST=localhost   # hôte public pour Nginx (front)
docker compose up --build
# Front : http://localhost (Nginx)
# API : http://localhost:8080/swagger, health : /health /ready, metrics : /metrics
```

### Tests
- Back : `./run_tests.sh` (démarre un Postgres Docker si besoin) ou `dotnet test` avec `ConnectionStrings__Default` ou `TEST_DB_CONN` renseignée. Exemple rapide sans compose : `docker run -d --name cb-inventory-tests -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=inventory_tests -p 5433:5432 postgres:16-alpine` puis `TEST_DB_CONN="Host=localhost;Port=5433;Database=inventory_tests;Username=postgres;Password=postgres" dotnet test`.
- Front unitaire : `npm -w src/inventory-web run test`.
- Front e2e (Playwright) : `npx playwright test` depuis `src/inventory-web` après `npm install` et `npx playwright install`.
- Lint front : `npm -w src/inventory-web run lint`.
- CI : tout ce qui précède est exécuté par `.github/workflows/ci.yml` ; un test .NET ignoré (base absente) ou un caractère mal encodé (U+FFFD) fait échouer la CI.

### Dépannage rapide
- Migrations bloquées : vérifier `APPLY_MIGRATIONS`/`DISABLE_MIGRATIONS` et la connectivité Postgres.
- Seed indésirable : mettre `AppSettings__SeedOnStartup=false`.
- CORS : compléter `AllowedOrigins__*` ou utiliser le proxy Vite (`DEV_BACKEND_ORIGIN`) en dev.
- Ports : 8080 (API), 5173 (Vite), 80/443 (Nginx via Docker Compose), 55432 (Postgres via Compose).

### Références
- Architecture : `docs/ARCHITECTURE.md`
- Base de données : `docs/BDD/MODELE.md`, `docs/BDD/MIGRATIONS.md`, `docs/BDD/CONVENTIONS.md`, `docs/BDD/diagramme.md`
- Audit & décisions : `docs/AUDIT.md`, `docs/DECISIONS.md`, `docs/CHANGELOG_NETTOYAGE.md`

## Structure

- `src/inventory-api` : projet ASP.NET Core minimal API exposant les endpoints d'inventaire et gérant l'authentification JWT.
- `src/inventory-infra` : infrastructure et accès aux données (FluentMigrator, Dapper, seeding de démonstration).
- `src/inventory-domain` : bibliothèque pour les règles métier.
- `src/inventory-shared` : contrats et DTO partagés.
- `src/inventory-web` : client PWA React (Vite + TypeScript).
- `tests/*` : projets de tests automatisés associés.
- `.github/workflows/ci.yml` : pipeline GitHub Actions (restore verrouillé, build, tests .NET sur Postgres avec garde « aucun test ignoré », lint, typecheck, tests Vitest, build web, audits NuGet et npm).

Chaque projet .NET cible .NET 8 et applique des analyzers configurés en avertissements bloquants.

## Environnements et configuration

| Environnement | Authentification par défaut | Migrations & seed | Observabilité | CORS |
| --- | --- | --- | --- | --- |
| Développement (`dotnet` local) | Schéma `AdminHeader` (entête `X-Admin: true` pour obtenir le rôle admin). Une clé partagée optionnelle peut être définie via `Authentication:AppToken` et transmise dans `X-App-Token`. | Migrations FluentMigrator appliquées au démarrage, `InventoryDataSeeder` insère boutiques + zones si `AppSettings:SeedOnStartup=true` | Swagger (`/swagger`), diagnostics (`/api/_diag/*`) et métriques Prometheus (`/metrics`) accessibles sans jeton | Origines `http://localhost:5173` et `http://127.0.0.1:5173` autorisées |
| Docker Compose | Identique au développement (`ASPNETCORE_ENVIRONMENT=Docker` est traité comme mode dev) | `APPLY_MIGRATIONS=true` et `AppSettings__SeedOnStartup=true` dans `docker-compose.yml` appliquent migrations + seed à chaque démarrage | Swagger exposé sur `http://localhost:8080/swagger`, `/metrics` anonyme, healthchecks prêts pour du monitoring | La PWA est servie via Nginx sur `http://localhost` |
| Production | AdminHeader + jeton `Authentication__AppToken` obligatoire (posé par Nginx), ou JWT Bearer (`Authentication:Authority` & `Authentication:Audience`) | Avec `docker-compose.prod.yml`, `APPLY_MIGRATIONS=true` : les migrations s'appliquent à chaque démarrage de l'API | Swagger désactivé; `/metrics` et `/api/_diag/*` nécessitent un rôle `Admin`; journaux Serilog + OpenTelemetry prêts à être collectés | Renseignez `AllowedOrigins` avec les domaines front |

Configurer systématiquement `ConnectionStrings__Default` (PostgreSQL). L'API s'appuie exclusivement sur FluentMigrator pour les évolutions de schéma : n'appliquez pas de scripts SQL manuels en dehors des migrations versionnées.

### Variables essentielles (production)

- `ConnectionStrings__Default=Host=<host>;Port=5432;Database=inventory;Username=<user>;Password=<pwd>` : unique connexion PostgreSQL.
- `Authentication__Authority=https://idp.exemple.com/realms/...` et `Authentication__Audience=cineboutique-inventory-api`.
- `AllowedOrigins__0=https://inventaire.exemple.com` (multipliez l'index pour plusieurs domaines).
- `APPLY_MIGRATIONS=true` / `DISABLE_MIGRATIONS=false` lors d'une montée de version (repassez `APPLY_MIGRATIONS=false` une fois l'opération terminée).
- `AppSettings__SeedOnStartup=false` (valeur par défaut) pour bloquer les seeds de démonstration en production.
- `AppSettings__CatalogEndpointsPublic=false` si vous devez forcer l'authentification sur les endpoints catalogue.
- `DISABLE_SERILOG=true` uniquement si vous déléguez entièrement la journalisation à l'hébergeur.

## Authentification et autorisations

Par défaut, l'API utilise le schéma `AdminHeader` sur tous les environnements :

- envoyer `X-Admin: true` accorde le rôle administrateur (sinon l'utilisateur est considéré comme non-admin mais tout de même authentifié) ;
- si `Authentication:AppToken` est renseigné, chaque requête doit aussi véhiculer `X-App-Token: <valeur>` pour être acceptée (permet de restreindre l'accès au frontend maison). En production ce jeton est obligatoire (l'API refuse de démarrer sans) et c'est Nginx qui le pose sur les requêtes proxifiées (`secrets.env`, voir `docs/DEPLOY_VM.md`) : le navigateur ne le connaît jamais ;
- pour revenir à un mode JWT classique, positionnez `Authentication:UseAdminHeader=false` et fournissez `Authentication:Authority` + `Authentication:Audience`. Les opérations protégées exigent alors un rôle `Admin` via la claim `role` ou `is_admin=true`.

```bash
curl https://inventaire.exemple.com/api/shops \
  -H "X-App-Token: ${APP_TOKEN}" \
  -H "X-Admin: true"
```

> Astuce : en mode JWT (`Authentication:UseAdminHeader=false`), l'exemple ci-dessus devient `Authorization: Bearer ${JWT_ADMIN}` sans les entêtes custom.

Les seeds injectent toujours des comptes `ShopUser` avec un secret vide pour permettre aux frontends de fonctionner sans fournisseur d'identité.

## CORS

Deux politiques sont définies : `AllowDev` (en développement) autorise uniquement `http://localhost:5173` et `http://127.0.0.1:5173`. `PublicApi` lit la section `AllowedOrigins` ; si la liste est vide, le code retombe sur les origines de développement (`http://localhost:5173`, `http://127.0.0.1:5173`), voir `Program.cs`. Pour définir des domaines explicitement :

```json
"AllowedOrigins": [
  "https://inventaire.exemple.com",
  "https://pwa.exemple.com"
]
```

ou, côté variables d'environnement, `AllowedOrigins__0=https://inventaire.exemple.com`. Le prévol (`OPTIONS`) est mis en cache pendant 1 heure.

## Observabilité et diagnostics

| Endpoint | Description | Authentification |
| --- | --- | --- |
| `GET /health` | Sonde liveness ASP.NET Core | Anonyme |
| `GET /ready` | Vérifie l'accès PostgreSQL (`SELECT 1`) et renvoie 503 en cas de défaillance | Anonyme |
| `GET /api/health` | Retourne un résumé applicatif (utilisateurs, runs orphelins) | Anonyme |
| `GET /api/_diag/info` | Version, environnement, chaîne de connexion masquée | Dev : anonyme, Prod : rôle `Admin` |
| `GET /api/_diag/ping-db` | Ping SQL détaillé avec temps de réponse | Dev : anonyme, Prod : rôle `Admin` |
| `GET /metrics` | Export Prometheus via `OpenTelemetry.Exporter.Prometheus.AspNetCore` | Dev/Docker : anonyme, Prod : rôle `Admin` |
| `GET /__debug/env`, `GET /__debug/db` | Helpers supplémentaires disponibles uniquement en `Development` | Anonyme |

Pour brancher un collecteur Prometheus :

```yaml
scrape_configs:
  - job_name: cineboutique-inventory
    metrics_path: /metrics
    static_configs:
      - targets: ['inventory-api:8080']
    authorization:
      type: Bearer
      credentials: ${CINEBOUTIQUE_ADMIN_JWT}
```

En mode dev ou Compose, l'autorisation peut être omise. En production, exposez `/metrics` derrière un reverse proxy qui ajoute l'entête ou fournissez un JWT d'administrateur.

## Démarrage via Docker Compose

Une stack Compose orchestre PostgreSQL (`db`), l'API (`api`) et la PWA servie par Nginx (`web`). Les fichiers `docker-compose.yml` et `docker-compose.override.yml` sont chargés automatiquement.

### Étapes

1. Valider la configuration : `docker compose config -q`.
2. Redémarrer proprement si nécessaire : `docker compose down -v --remove-orphans`.
3. Construire et lancer : `docker compose up --build -d`.
4. Contrôler l'état : `docker compose ps`.
5. Vérifier la santé :
   ```bash
   curl http://localhost:8080/ready
   curl http://localhost:8080/api/health | jq
   ```
6. Accéder à la PWA : http://localhost ; Swagger : http://localhost:8080/swagger.

Les migrations FluentMigrator et le seed de démonstration s'exécutent automatiquement grâce aux variables `APPLY_MIGRATIONS=true` et `AppSettings__SeedOnStartup=true`. Pour du développement front avec hot reload, lancer `npm -w src/inventory-web run dev` ; Vite proxe `/api` vers la variable `DEV_BACKEND_ORIGIN` (par défaut `http://localhost:8080`).

### Vérifications rapides du seed

Dans une session `psql` :

```sql
SELECT "Name" FROM "Shop" ORDER BY "Name";
SELECT "Code", "Label" FROM "Location" ORDER BY "Code";
SELECT COUNT(*) AS "ZoneCount" FROM "Location";
SELECT DISTINCT "ShopId" FROM "Location";
```

### Réamorcer les données de démonstration

```bash
docker compose down -v --remove-orphans
docker compose up --build -d
# ou, pour ne réinitialiser que les données :
docker compose exec db psql -U postgres -d inventory -c "TRUNCATE TABLE \"CountLine\" RESTART IDENTITY CASCADE;"
docker compose exec db psql -U postgres -d inventory -c "TRUNCATE TABLE \"CountingRun\" RESTART IDENTITY CASCADE;"
docker compose exec db psql -U postgres -d inventory -c "TRUNCATE TABLE \"InventorySession\" RESTART IDENTITY CASCADE;"
docker compose exec db psql -U postgres -d inventory -c "TRUNCATE TABLE \"Product\" RESTART IDENTITY CASCADE;"
```

Si le volume persiste, recréez la base :

```bash
docker exec -it inventory-db psql -U postgres -d postgres -c "CREATE DATABASE inventory;"
```

### Accès frontend

- PWA servie par Nginx : http://localhost (ports 80/443 exposés).
- Serveur de développement Vite : `npm -w src/inventory-web run dev` (http://localhost:5173). Ajustez `DEV_BACKEND_ORIGIN` si l'API n'est pas accessible sur `http://localhost:8080`.

## Endpoints essentiels

| Méthode | Chemin | Description | Auth |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Ping applicatif (utilisateurs, runs orphelins) | Anonyme |
| `GET` | `/api/locations` | Liste les zones et leur statut courant | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `GET` | `/api/inventories/summary?shopId=<uuid>` | Agrégat des sessions, runs ouverts et conflits | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `POST` | `/api/inventories/{locationId}/start` | Ouvre un comptage pour une zone donnée | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `POST` | `/api/inventories/{locationId}/complete` | Clôture un run et enregistre les quantités | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `POST` | `/api/inventories/{locationId}/restart` | Termine les runs ouverts avant relance | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `GET` | `/api/conflicts/{locationId}` | Détail des deltas à arbitrer pour une zone | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `GET` | `/api/products/search?code=<value>&limit=<n>` | Recherche combinée (SKU, EAN, digits) | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `GET` | `/api/shops/{shopId}/products` | Catalogue contextualisé par boutique | Public tant que `AppSettings__CatalogEndpointsPublic=true` |
| `POST` | `/api/shops/{shopId}/products/import` | Remplace le catalogue depuis un CSV | Rôle `Admin` requis |
| `GET` | `/api/shops/{shopId}/products/import/status` | Suivi temps réel d'un import en cours | Rôle `Admin` requis |

Les endpoints d'exploitation restent ouverts tant que `AppSettings__CatalogEndpointsPublic=true` (valeur par défaut pour faciliter les pilotes). Passez l'option à `false` pour les soumettre à l'authentification JWT.

### Finaliser un comptage d'inventaire

Le front appelle `POST /api/inventories/{locationId}/complete` pour indiquer la fin d'un comptage. Exemple de payload :

```json
{
  "runId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "countType": 1,
  "ownerUserId": "3b9934f1-4f0e-4ab3-8a2c-1f0182c2b4c8",
  "items": [
    { "ean": "3057065988108", "quantity": 3, "isManual": false },
    { "ean": "0001", "quantity": 1, "isManual": true }
  ]
}
```

La réponse contient l'identifiant du run clôturé ainsi que les agrégats utiles à l'IHM :

```json
{
  "runId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "inventorySessionId": "9f0b1a3e-1c1c-4f33-a123-78a12c1e5a2b",
  "locationId": "zone-1",
  "countType": 1,
  "completedAtUtc": "2024-05-08T12:34:56.789Z",
  "itemsCount": 2,
  "totalQuantity": 4
}
```

Les résumés retournés par `GET /api/inventories/summary` et `GET /api/locations` exposent `ownerUserId` et `ownerDisplayName` afin d'identifier l'opérateur responsable.

### Import CSV du catalogue produits

L'endpoint `POST /api/shops/{shopId}/products/import` remplace l'intégralité du catalogue de la boutique ciblée.

- Format attendu : fichier CSV encodé en `latin-1`, séparateur `;`, en-têtes `barcode_rfid;item;descr`.
- Le champ `descr` est mappé sur `Product.Name`.
- Idempotence : l'import est ignoré (`204 No Content`) si le fichier a déjà été appliqué.
- Paramètre `dryRun=true|false` (par défaut `false`) pour valider le fichier sans rien écrire.
- Verrouillage optimiste : une exécution en cours renvoie `423 Locked` avec `{ "reason": "import_in_progress" }`.
- Taille maximale : 25 Mio (`413 Payload Too Large` sinon).

```bash
curl -X POST \
     -H "Authorization: Bearer <token-admin>" \
     -F "file=@./catalogue.csv;type=text/csv" \
     http://localhost:8080/api/shops/<shop-id>/products/import | jq
```

```json
{
  "total": 1204,
  "inserted": 1204,
  "wouldInsert": 0,
  "errorCount": 0,
  "dryRun": false,
  "skipped": false,
  "errors": []
}
```

```bash
curl -s -X POST \
     -H "Authorization: Bearer <token-admin>" \
     -H "Content-Type: text/csv; charset=ISO-8859-1" \
     "http://localhost:8080/api/shops/<shop-id>/products/import?dryRun=true" \
     --data-binary @./catalogue.csv | jq
```

```json
{
  "total": 1204,
  "inserted": 0,
  "wouldInsert": 1204,
  "errorCount": 0,
  "dryRun": true,
  "skipped": false,
  "errors": []
}
```

## Configuration applicative


- Chaîne de connexion PostgreSQL : `ConnectionStrings:Default` (surchargée dans Docker via variable d'environnement `ConnectionStrings__Default`).
- Paramètres généraux : `AppSettings` (ex. `SeedOnStartup`).
- Authentification : `Authentication` (issuer, audience, secret JWT, durée, paramètres de renouvellement).

## Scripts utiles

Pour exécuter la solution en local hors conteneur :

```bash
dotnet restore
dotnet build
```

Les migrations sont exécutées automatiquement au démarrage de l'API.

### Tests automatisés

```bash
bash ./scripts/test-codex.sh
```

### Client web (React + Vite + TailwindCSS)

Installation des dépendances et exécution en mode développement :

```bash
cd src/inventory-web
npm install
npm run dev
```

Construction de la PWA et exécution de la suite de tests :

```bash
npm run build
npm run test
```

Fonctionnalités principales :

- PWA mobile-first avec manifest, service worker (vite-plugin-pwa) et icônes servies via CDN (personnalisables hors dépôt).
- Workflow guidé pour lancer un inventaire (sélection utilisateur → type → zone avec statut en temps réel → scan).
- Scan des codes-barres via caméra (getUserMedia + `@zxing/browser`) ou douchette Bluetooth simulée via champ de saisie.
- Gestion des produits hors référentiel (ajout manuel avec panneau coulissant).
- Espace administration réservé aux comptes disposant du rôle *Admin* (CRUD des zones avec interactions swipe).
- Couverture de tests Vitest + Testing Library sur l'accueil, le workflow et la saisie par douchette.

### Ressources graphiques

Les icônes et logos ne sont plus versionnés afin de permettre l'export GitHub sans binaires. Référez-vous à `src/inventory-web/assets/README.md` et `src/inventory-web/public/assets/README.md` pour connaître l'emplacement attendu des visuels locaux et la procédure de personnalisation via CDN.

### Vérifications PostgreSQL en ligne de commande

Une fois connecté au conteneur PostgreSQL (`docker exec -it cineboutique-inventaire-db-1 psql -U postgres -d cineboutique`), les commandes suivantes permettent de valider l'état de la base :

- `\dx` pour vérifier que les extensions `uuid-ossp` et `pgcrypto` sont bien installées.
- `\dt` pour lister les tables créées par la migration (`Shop`, `ShopUser`, `Product`, `Location`, `InventorySession`, `CountingRun`, `CountLine`, `Conflict`, `Audit`, `audit_logs`).
- `SELECT COUNT(*) FROM "Location";` afin de confirmer la présence des 39 emplacements (`B1` à `B20`, `S1` à `S19`).

## Gestion centralisée des packages NuGet

La solution s'appuie sur la Central Package Management de .NET via le fichier `Directory.Packages.props` situé à la racine du dépôt. Toutes les dépendances NuGet partagent ainsi un catalogue de versions unique.

Pour vérifier les mises à jour disponibles, exécutez la commande suivante :

```bash
dotnet list package --outdated
```
