#!/usr/bin/env bash
# Sauvegarde quotidienne de la base PostgreSQL de l'inventaire (format custom pg_dump), rétention 14 jours.
# Usage : ./scripts/deploy/backup_db.sh            (variables : DB_CONTAINER, BACKUP_DIR, RETENTION_DAYS)
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-inventory-db}"
DB_NAME="${DB_NAME:-inventory}"
DB_USER="${DB_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/inventaire}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/inventory-${stamp}.dump"
tmp="${out}.part"

echo "[backup] pg_dump de ${DB_NAME} depuis le conteneur ${DB_CONTAINER} -> ${out}"
docker exec -i "$DB_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$tmp"

# Vérification : l'archive doit être lisible par pg_restore (table des matières)
docker exec -i "$DB_CONTAINER" pg_restore --list < "$tmp" > /dev/null
mv "$tmp" "$out"

# Rétention
find "$BACKUP_DIR" -maxdepth 1 -name 'inventory-*.dump' -mtime +"$RETENTION_DAYS" -print -delete | sed 's/^/[backup] supprimé : /' || true

echo "[backup] OK : ${out} ($(du -h "$out" | cut -f1))"
