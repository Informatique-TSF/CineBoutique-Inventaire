#!/usr/bin/env bash
# Restaure une sauvegarde produite par backup_db.sh dans la base de l'inventaire.
# ATTENTION : écrase les données actuelles. Arrête l'API pendant la restauration.
# Usage : ./scripts/deploy/restore_db.sh ~/backups/inventaire/inventory-20261201-023000.dump
set -euo pipefail

DUMP="${1:?chemin du fichier .dump requis}"
DB_CONTAINER="${DB_CONTAINER:-inventory-db}"
API_CONTAINER="${API_CONTAINER:-inventory-api}"
DB_NAME="${DB_NAME:-inventory}"
DB_USER="${DB_USER:-postgres}"

[ -f "$DUMP" ] || { echo "[restore] fichier introuvable : $DUMP" >&2; exit 1; }

read -r -p "[restore] Écraser la base ${DB_NAME} avec ${DUMP} ? (oui/non) " answer
[ "$answer" = "oui" ] || { echo "[restore] annulé"; exit 1; }

echo "[restore] arrêt de l'API (${API_CONTAINER})"
docker stop "$API_CONTAINER" >/dev/null || true

echo "[restore] restauration (clean + if-exists)"
docker exec -i "$DB_CONTAINER" pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner < "$DUMP"

echo "[restore] redémarrage de l'API"
docker start "$API_CONTAINER" >/dev/null

echo "[restore] OK. Vérifiez : curl -k https://localhost/api/health"
