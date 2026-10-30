#!/usr/bin/env bash
set -euo pipefail

# Répertoire d'installation sur la VM (à adapter si besoin)
APP_DIR="${APP_DIR:-$HOME/apps/CineBoutique-Inventaire}"
BRANCH="${BRANCH:-deploy}"

echo "[deploy] Working dir: ${APP_DIR}"
cd "$APP_DIR"

# S'assure que la branche locale est 'deploy' et suit origin/deploy
if [ ! -d .git ]; then
  echo "[deploy] ERROR: .git not found in $APP_DIR"
  exit 1
fi

echo "[deploy] Fetching..."
git fetch origin "$BRANCH"

echo "[deploy] Checking out $BRANCH..."
git checkout "$BRANCH"

echo "[deploy] Reset to origin/$BRANCH..."
git reset --hard "origin/$BRANCH"

echo "[deploy] Pulling submodules if any..."
git submodule update --init --recursive

# Fichiers de prod explicites : sans -f, Compose chargerait docker-compose.override.yml (dev, API sur 8080)
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

APP_VERSION="$(git rev-parse --short HEAD)"
echo "[deploy] Rebuilding images with APP_VERSION=${APP_VERSION}"
"${COMPOSE[@]}" build --build-arg "APP_VERSION=${APP_VERSION}"

# Build avant up : les anciens conteneurs servent pendant la construction
echo "[deploy] Bringing containers up (recreate if needed)..."
"${COMPOSE[@]}" up -d --remove-orphans

echo "[deploy] Pruning old images (optional)..."
docker image prune -f || true

echo "[deploy] Done."
